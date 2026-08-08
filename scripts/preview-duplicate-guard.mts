// Dry run of the duplicate guard against live data: what would Agent 20 park, and why.
// No writes. Usage: npx tsx scripts/preview-duplicate-guard.mts [--org=slug] [--kind=lead_pair]
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { findDuplicateBoundLeads, PROMOTABLE_STAGES } from "../src/lib/lead-dupe-guard";

const orgFilter = process.argv.find((a) => a.startsWith("--org="))?.split("=")[1];
const kindFilter = process.argv.find((a) => a.startsWith("--kind="))?.split("=")[1];

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.OA_SUPABASE_SERVICE_ROLE_KEY!);
const tk = new pg.Pool({ connectionString: process.env.TENKARA_READONLY_DATABASE_URL });

const { data: orgs } = await admin.from("orgs").select("id, slug, tenkara_org_id").not("tenkara_org_id", "is", null);
const byKind: Record<string, number> = {};
for (const org of orgs ?? []) {
  if (orgFilter && org.slug !== orgFilter) continue;
  const leads: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_name, material_id, material_name, stage, payload")
      .eq("org_id", org.id).eq("status", "active")
      .in("stage", PROMOTABLE_STAGES as unknown as string[])
      .order("id", { ascending: true }).range(from, from + 999);
    const page = data ?? [];
    leads.push(...page);
    if (page.length < 1000) break;
  }
  if (!leads.length) continue;
  const { rows: suppliers } = await tk.query(
    "select name, website, coalesce(is_marketplace,false) as is_marketplace from suppliers where organization_ids[1] = $1",
    [org.tenkara_org_id]
  );
  if (!suppliers.length) continue;
  const verdicts = findDuplicateBoundLeads(leads as any, suppliers as any);
  for (const v of verdicts) {
    byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
    if (kindFilter && v.kind !== kindFilter) continue;
    console.log(`${org.slug} | ${v.kind} | ${v.lead.supplier_name} → ${v.existingNames.slice(0, 2).join(" / ")} | ${v.domain} | keep-as: ${v.canonicalName}`);
  }
}
console.log("\ncounts:", byKind);
await tk.end();
