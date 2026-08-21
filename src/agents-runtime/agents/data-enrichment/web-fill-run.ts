import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupplierProfiles, type SupplierProfile } from "@/lib/supplier-profiles";
import { webFillSupplierProfile } from "./supplier-web-fill";
import { advanceDryPass, passOutcome, DRY_PASS_LIMITS } from "@/lib/dry-pass";

// Long-tail completion for suppliers Tenkara has never dealt with and whose
// leads carry no contact: read their own site. Capped per run and per org.
//
// A supplier whose site we actually read AND that printed at least one field is
// done: the fields it did not print are recorded as not_published so we never
// pay to look for them twice. A read that printed nothing is not that; it is a
// dry pass, and it is retried on the same counter. A supplier
// whose site we could not reach is NOT done — that attempt found nothing about
// them, so it is retried on a cooldown up to RETRY_LIMIT before we give up. The
// difference matters because a lead often gains a website days after the
// profile exists.

const WEB_FILLABLE = [
  "poc_email", "poc_phone", "poc_name", "shipping_address",
  "shipping_terms", "shipping_email", "billing_email", "billing_poc_name",
  "payment_upfront_pct", "payment_net_days", "payment_completion", "payment_credit_line",
] as const;

const CONCURRENCY = 3;
const RETRY_LIMIT = DRY_PASS_LIMITS.supplier_web_fill;
const RETRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const isEmpty = (v: any): boolean => v === null || v === undefined || v === "";

function websiteFor(profile: SupplierProfile, leadSites: Map<string, string>): string | null {
  const fromNotes = profile.generated_notes?.match(/Website:\s*(\S+?)\.?(?:\s|$)/);
  if (fromNotes?.[1]) return fromNotes[1];
  const key = profile.supplier_id ?? profile.supplier_name.trim().toLowerCase();
  return leadSites.get(key) ?? null;
}

export interface WebFillStats {
  attempted: number;
  fieldsFilled: number;
  exhausted: number;
  unreachable: number;
}

export async function runSupplierWebFill(
  admin: SupabaseClient,
  orgId: string,
  cap: number,
  deadline: number
): Promise<WebFillStats> {
  const stats: WebFillStats = { attempted: 0, fieldsFilled: 0, exhausted: 0, unreachable: 0 };
  if (cap <= 0 || Date.now() >= deadline) return stats;

  const profiles = await getSupplierProfiles(admin, orgId);
  const candidates = profiles
    // Freeze: once a supplier leaves draft an operator owns it; agents stop writing.
    .filter((p) => p.approval_status === "draft")
    .filter((p) => !p.field_sources?.web_checked_at)
    .filter((p) => retryable(p))
    .filter((p) => WEB_FILLABLE.some((f) => isEmpty((p as any)[f])))
    // Contact-less suppliers first: an un-emailable supplier blocks outreach,
    // a missing billing address only blocks the final approval.
    .sort((a, b) => Number(!isEmpty(a.poc_email)) - Number(!isEmpty(b.poc_email)))
    .slice(0, cap);
  if (!candidates.length) return stats;

  const { data: leads } = await admin
    .from("leads_in_flight")
    .select("supplier_id, supplier_name, payload")
    .eq("org_id", orgId)
    .eq("status", "active");
  const leadSites = new Map<string, string>();
  for (const l of (leads ?? []) as any[]) {
    const site = l.payload?.supplier_website ?? l.payload?.source_url;
    if (typeof site !== "string" || !site.trim()) continue;
    for (const k of [l.supplier_id, (l.supplier_name ?? "").trim().toLowerCase()].filter(Boolean)) {
      if (!leadSites.has(k)) leadSites.set(k, site.trim());
    }
  }

  const queue = [...candidates];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length && Date.now() < deadline) {
      const p = queue.shift();
      if (!p) return;
      const missing = WEB_FILLABLE.filter((f) => isEmpty((p as any)[f]));
      let result;
      try {
        result = await webFillSupplierProfile({
          supplier_name: p.supplier_name,
          website: websiteFor(p, leadSites),
          known_email: p.poc_email,
          missing: [...missing],
        });
      } catch {
        continue; // transient: leave unmarked so the next run retries
      }
      stats.attempted += 1;

      // Never reached their site: bank the attempt and come back later rather
      // than freezing every field as "not published by supplier".
      const priorPasses = { dry: Number(p.field_sources?.web_attempts ?? 0), done: false };
      if (!result.site_found) {
        const pass = advanceDryPass(priorPasses, "dry", "supplier_web_fill");
        const sources: Record<string, string> = {
          ...(p.field_sources ?? {}),
          web_attempts: String(pass.dry),
          web_last_attempt: new Date().toISOString(),
        };
        if (pass.done) sources.web_checked_at = new Date().toISOString();
        stats.unreachable += 1;
        await admin.from("supplier_profiles").update({ field_sources: sources }).eq("id", p.id);
        continue;
      }

      const host = result.source_url ? `web:${hostOf(result.source_url)}` : "web";
      const updates: Record<string, any> = {};
      const sources: Record<string, string> = {};
      let filled = 0;
      for (const f of missing) {
        const v = (result as any)[f];
        if (isEmpty(v)) continue;
        updates[f] = v;
        sources[f] = host;
        filled += 1;
        stats.fieldsFilled += 1;
      }
      if (result.source_url) sources.web_source_url = result.source_url;

      // PERS-03. `site_found` is the model's own word for "I read a page of
      // theirs, even if it stated none of the fields". A cookie wall, an
      // interstitial and a half-rendered page all satisfy that while printing
      // nothing. Stamping `web_checked_at` on such a pass froze all twelve
      // fields as never-published on the FIRST read and dropped the profile out
      // of every future run — and `supplier-profile-fill` then reads that stamp
      // as proof the supplier's own site was exhausted and promotes the profile
      // to pending_review. A read that printed nothing is a dry pass. The other
      // branch three lines up already knew that; this one did not.
      const pass = advanceDryPass(priorPasses, passOutcome(filled > 0, false), "supplier_web_fill");
      if (!pass.done) {
        await admin
          .from("supplier_profiles")
          .update({
            ...updates,
            field_sources: {
              ...(p.field_sources ?? {}),
              ...sources,
              web_attempts: String(pass.dry),
              web_last_attempt: new Date().toISOString(),
            },
          })
          .eq("id", p.id);
        continue;
      }

      // Either the site printed something, or it has printed nothing on
      // DRY_PASS_LIMITS.supplier_web_fill separate reads. Now "not published" is
      // a reading rather than a guess.
      sources.web_checked_at = new Date().toISOString();
      for (const f of missing) {
        if (!isEmpty((result as any)[f])) continue;
        sources[f] = "not_published";
        stats.exhausted += 1;
      }

      await admin
        .from("supplier_profiles")
        .update({ ...updates, field_sources: { ...(p.field_sources ?? {}), ...sources } })
        .eq("id", p.id);
    }
  });
  await Promise.all(workers);
  return stats;
}

function retryable(p: SupplierProfile): boolean {
  const attempts = Number(p.field_sources?.web_attempts ?? 0);
  if (attempts >= RETRY_LIMIT) return false;
  const last = p.field_sources?.web_last_attempt;
  return !last || Date.now() - Date.parse(last) > RETRY_COOLDOWN_MS;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}
