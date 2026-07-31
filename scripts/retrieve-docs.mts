// Retrieve SDS/CoA/TDS/spec documents from the product/checkout URLs already on
// an org's quote_profiles (source_url) and store them in supplier_documents so
// they surface on the extraction "bench". Reuses src/lib/document-retrieve.ts.
//
// Run:
//   npx tsx -r dotenv/config scripts/retrieve-docs.mts --org california-chemicals [--limit 50] dotenv_config_path=.env.local
import { createAdminClient } from "@/lib/supabase/admin";
import { retrieveDocumentsFromUrl } from "@/lib/document-retrieve";

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const slug = argOf("--org");
const limit = Number(argOf("--limit") ?? "100");
if (!slug) {
  console.error("usage: retrieve-docs.mts --org <slug> [--limit N]");
  process.exit(1);
}

const admin = createAdminClient();

const { data: org } = await admin.from("orgs").select("id, slug").eq("slug", slug).single();
if (!org) {
  console.error(`org not found: ${slug}`);
  process.exit(1);
}

const { data: rows } = await admin
  .from("quote_profiles")
  .select("supplier_id, supplier_name, material_id, source_url")
  .eq("org_id", org.id)
  .not("source_url", "is", null)
  .order("supplier_name")
  .limit(limit);

const targets = (rows ?? []).filter((r: any) => /^https?:\/\//i.test(r.source_url ?? ""));
console.error(`[${slug}] ${targets.length} quote(s) with a source_url to scan`);

let totalDocs = 0;
for (const r of targets as any[]) {
  const res = await retrieveDocumentsFromUrl(admin, {
    orgId: org.id,
    pageUrl: r.source_url,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    materialId: r.material_id,
  });
  totalDocs += res.inserted;
  const tag = res.inserted ? "OK " : "-- ";
  console.error(
    `  ${tag}${r.supplier_name}: ${res.inserted} new / ${res.candidates} candidate doc(s)` +
      (res.note ? ` (${res.note})` : "") +
      (res.docs.length ? ` [${res.docs.map((d) => d.docType).join(",")}]` : "")
  );
}
console.error(`\ndone: ${totalDocs} document(s) stored across ${targets.length} page(s)`);
