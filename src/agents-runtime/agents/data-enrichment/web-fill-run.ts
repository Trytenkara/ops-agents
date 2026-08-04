import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupplierProfiles, type SupplierProfile } from "@/lib/supplier-profiles";
import { webFillSupplierProfile } from "./supplier-web-fill";

// Long-tail completion for suppliers Tenkara has never dealt with and whose
// leads carry no contact: read their own site. Capped per run and per org, and
// each supplier is attempted once — a field the site does not publish is
// recorded as not_published so we never pay to look for it twice.

const WEB_FILLABLE = [
  "poc_email", "poc_phone", "poc_name", "shipping_address",
  "shipping_terms", "shipping_email", "billing_email", "billing_poc_name",
  "payment_upfront_pct", "payment_net_days", "payment_completion", "payment_credit_line",
] as const;

const CONCURRENCY = 3;

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
}

export async function runSupplierWebFill(
  admin: SupabaseClient,
  orgId: string,
  cap: number,
  deadline: number
): Promise<WebFillStats> {
  const stats: WebFillStats = { attempted: 0, fieldsFilled: 0, exhausted: 0 };
  if (cap <= 0 || Date.now() >= deadline) return stats;

  const profiles = await getSupplierProfiles(admin, orgId);
  const candidates = profiles
    .filter((p) => !p.field_sources?.web_checked_at)
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

      const host = result.source_url ? `web:${hostOf(result.source_url)}` : "web";
      const updates: Record<string, any> = {};
      const sources: Record<string, string> = { web_checked_at: new Date().toISOString() };
      for (const f of missing) {
        const v = (result as any)[f];
        if (isEmpty(v)) {
          sources[f] = "not_published";
          stats.exhausted += 1;
        } else {
          updates[f] = v;
          sources[f] = host;
          stats.fieldsFilled += 1;
        }
      }
      if (result.source_url) sources.web_source_url = result.source_url;

      await admin
        .from("supplier_profiles")
        .update({ ...updates, field_sources: { ...(p.field_sources ?? {}), ...sources } })
        .eq("id", p.id);
    }
  });
  await Promise.all(workers);
  return stats;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}
