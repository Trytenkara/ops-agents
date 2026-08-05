import type { createAdminClient } from "@/lib/supabase/admin";
import { normalizeCompanyName } from "@/lib/tenkara-sourcing-exclusions";
import { isSameCompanyName } from "@/lib/fuzzy";
import { aggregatorNameOf, isAggregatorPlatformName } from "@/lib/aggregator-hosts";
import type { ReferredSupplier } from "@/lib/reply-quote-extract";

// A supplier who cannot help often names someone who can: the manufacturer they
// resell for, a sister concern, their own distributor. That is the top of their
// funnel and it is a better lead than anything a scout finds, because a supplier
// in the trade vouched for it. This stages those referrals as ordinary leads on
// the referring lead's material, so Agent 06 enriches them and Agent 04 emails
// them through the normal path. Nothing bespoke downstream.

type Admin = ReturnType<typeof createAdminClient>;

export interface StageReferralsInput {
  orgId: string;
  materialId: string;
  materialName: string | null;
  referrals: ReferredSupplier[];
  // The lead whose reply named them, for provenance and for self-reference checks.
  fromLeadId: string;
  fromSupplierName: string | null;
  conversationId: string | null;
  assignedOperatorId: string | null;
}

export interface StageReferralsResult {
  staged: { id: string; name: string }[];
  duplicates: string[];
  // company_name → why it was not staged (self-reference, unusable name).
  rejected: { name: string; reason: string }[];
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw) return null;
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Referred names arrive as free text, so a name that is really a description
// ("their factory", "the manufacturer") would stage a lead nobody can act on.
const NON_COMPANY = /^(the |their |our |a |an )?(manufacturer|factory|mill|producer|supplier|trader|distributor|agent|company|plant|refinery|sister concern|group)s?\.?$/i;

export async function stageReferredSuppliers(
  admin: Admin,
  input: StageReferralsInput
): Promise<StageReferralsResult> {
  const out: StageReferralsResult = { staged: [], duplicates: [], rejected: [] };
  const referrals = (input.referrals ?? []).filter((r) => r && r.company_name && r.company_name.trim());
  if (!referrals.length) return out;

  // Same dedup key the discovery agents use: (material_id, canonical company
  // name), with a fuzzy pass for name variants and a website-host check, read
  // over the active leads for this material.
  const { data: existing } = await admin
    .from("leads_in_flight")
    .select("supplier_name, payload")
    .eq("status", "active")
    .eq("material_id", input.materialId);
  const names: string[] = [];
  const hosts = new Set<string>();
  for (const r of (existing ?? []) as { supplier_name: string | null; payload: any }[]) {
    const norm = normalizeCompanyName(r.supplier_name);
    if (norm) names.push(norm);
    const host = hostOf(r.payload?.supplier_website ?? r.payload?.source_url);
    if (host) hosts.add(host);
  }
  const selfNorm = normalizeCompanyName(input.fromSupplierName);

  for (const r of referrals) {
    const name = r.company_name.trim();
    if (NON_COMPANY.test(name) || name.length < 3) {
      out.rejected.push({ name, reason: "not a company name" });
      continue;
    }
    if (isAggregatorPlatformName(name, input.materialName)) {
      out.rejected.push({ name, reason: "names the platform, not a company on it" });
      continue;
    }
    const norm = normalizeCompanyName(name);
    if (!norm) {
      out.rejected.push({ name, reason: "name normalizes to nothing" });
      continue;
    }
    if (selfNorm && (norm === selfNorm || isSameCompanyName(norm, selfNorm))) {
      out.rejected.push({ name, reason: "the referring supplier itself" });
      continue;
    }
    const host = hostOf(r.website);
    if ((host && hosts.has(host)) || names.includes(norm) || names.some((e) => isSameCompanyName(norm, e))) {
      out.duplicates.push(name);
      continue;
    }

    // A referral pointing at a marketplace storefront is still a lead, it just
    // belongs on the marketplace track: its channel is the platform's form, and
    // its host must never be used to guess an email.
    const aggregator = host ? aggregatorNameOf(r.website) : null;
    const email = aggregator ? null : r.email;
    const { data: inserted, error } = await admin
      .from("leads_in_flight")
      .insert({
        org_id: input.orgId,
        supplier_name: name,
        supplier_id: null,
        material_id: input.materialId,
        material_name: input.materialName,
        stage: "raw",
        status: "active",
        source: "supplier_referral",
        confidence_score: email ? 0.5 : 0.4,
        assigned_operator_id: input.assignedOperatorId,
        payload: {
          site_type: aggregator ? "A" : "N",
          supplier_role: "Supplier",
          supplier_website: r.website ?? null,
          source_url: r.website ?? null,
          aggregator,
          supplier_contact_email: email,
          supplier_contact_name: r.contact_name ?? null,
          supplier_phone: r.phone ?? null,
          needs_contact_resolution: !email,
          referred_by: {
            lead_id: input.fromLeadId,
            supplier_name: input.fromSupplierName,
            conversation_id: input.conversationId,
            note: r.note ?? null,
            at: new Date().toISOString(),
          },
          scout_notes: input.fromSupplierName
            ? `Referred by ${input.fromSupplierName}${r.note ? `: ${r.note}` : ""}`
            : r.note ?? null,
        },
      })
      .select("id")
      .maybeSingle();
    if (error || !inserted) {
      out.rejected.push({ name, reason: error?.message ?? "insert returned no row" });
      continue;
    }
    // Register it so two referrals to the same company in one reply, or a later
    // reply on the same thread, cannot stage it twice.
    names.push(norm);
    if (host) hosts.add(host);
    out.staged.push({ id: inserted.id as string, name });
  }
  return out;
}
