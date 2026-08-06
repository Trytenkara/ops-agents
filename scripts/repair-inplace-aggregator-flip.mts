// Repair aggregator listings that were flipped to "direct" IN PLACE.
//
// Before splitDirectLeadFromMarketplace existed, capturing a seller's own email
// off an aggregator listing rewrote that lead's site_type to "N" and stamped
// aggregator_direct_contact. That is the wrong shape twice over: the row is still
// a listing on an aggregator host, and site_type is what the price-pull queue
// selects on ("payload->>site_type.in.(M,MS,A)"), so every flipped lead silently
// left the price index and its stored marketplace_pull / price_tiers stopped
// being refreshed.
//
// No second lead is created here. Outreach already reads an aggregator lead that
// holds a non-platform email as direct (directContactCaptured in agent 04), so
// these rows stay cold-emailable at site_type "A" exactly as their unflipped
// siblings off the same index page are. Splitting them would instead put the same
// address on two cold-emailable rows.
//
// Run:
//   npx tsx -r dotenv/config scripts/repair-inplace-aggregator-flip.mts [--org=<slug>] [--dry-run]
import { createAdminClient } from "@/lib/supabase/admin";

const dryRun = process.argv.includes("--dry-run");
const orgArg = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;

async function main() {
  const admin = createAdminClient();

  let orgId: string | null = null;
  if (orgArg) {
    const { data: org } = await admin.from("orgs").select("id, name, slug").eq("slug", orgArg).maybeSingle();
    if (!org) throw new Error(`no org with slug ${orgArg}`);
    orgId = org.id;
    console.log(`Scoped to ${org.name} (${org.slug})`);
  }

  let q = admin
    .from("leads_in_flight")
    .select("id, org_id, supplier_name, material_name, stage, payload")
    .eq("status", "active")
    .eq("payload->>site_type", "N")
    .eq("payload->>aggregator_direct_contact", "true");
  if (orgId) q = q.eq("org_id", orgId);
  const { data: leads, error } = await q;
  if (error) throw new Error(error.message);

  // A row that carries the link to a split-out direct lead (either side of the
  // pair) is the CORRECT shape, not a flip: leave it alone.
  const flipped = (leads ?? []).filter(
    (l: any) => !l.payload?.origin_marketplace_lead_id && !l.payload?.direct_lead_id,
  );
  console.log(`${flipped.length} flipped lead(s) of ${(leads ?? []).length} candidate(s)`);

  let repaired = 0;
  for (const lead of flipped as any[]) {
    const payload = (lead.payload ?? {}) as Record<string, any>;
    // The platform the listing lives on is what makes this an aggregator row. No
    // aggregator on the payload means the flip did not come from a listing and
    // this script has no basis to reclassify it.
    if (!payload.aggregator) {
      console.log(`  SKIP ${lead.id} ${lead.supplier_name}: no aggregator on payload`);
      continue;
    }
    const next = { ...payload };
    next.site_type = "A";
    delete next.aggregator_direct_contact;
    next.site_type_repair = {
      at: new Date().toISOString(),
      from: "N",
      to: "A",
      reason: "in-place aggregator→direct flip; listing restored so the price pull picks it up again",
    };
    console.log(
      `  ${dryRun ? "WOULD REPAIR" : "REPAIR"} ${lead.id} ${lead.supplier_name} (${lead.material_name}, ${lead.stage}) via ${payload.aggregator}` +
        `${payload.marketplace_pull ? ` · keeps pull=${payload.marketplace_pull.status}` : ""}${Array.isArray(payload.price_tiers) ? ` · ${payload.price_tiers.length} tier(s)` : ""}`,
    );
    if (dryRun) continue;
    const { error: upErr } = await admin.from("leads_in_flight").update({ payload: next }).eq("id", lead.id);
    if (upErr) {
      console.log(`    FAILED: ${upErr.message}`);
      continue;
    }
    repaired++;
  }
  console.log(dryRun ? "dry run, nothing written" : `repaired ${repaired} lead(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
