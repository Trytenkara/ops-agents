// Preview / apply canonical-name dedup on leads_in_flight (OA Supabase).
// Groups ACTIVE leads by (material_id | normalizeCompanyName(supplier_name)) and,
// for any group with >1 row, keeps the "best" row and marks the rest as dropped.
// Keep order: furthest stage, then highest confidence, then earliest created_at.
//
//   node scripts/dedup-leads-preview.mjs          # read-only preview
//   node scripts/dedup-leads-preview.mjs --apply  # soft-drop the duplicates
//
// normalizeCompanyName is copied verbatim from src/lib/tenkara-sourcing-exclusions.ts
// so the cleanup matches exactly what the deployed code now prevents.
import pg from "pg";

function normalizeCompanyName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,/#!$%^*;:{}=\-_`~()'"]/g, " ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|co|corp|corporation|company|gmbh|sa|se|ag|nv|kg|kk|srl|bv|plc|pvt|pte|group)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STAGE_RANK = { raw: 0, enriched: 1, ready_for_outreach: 2, ready_for_approval: 3, terminal: 4 };
const APPLY = process.argv.includes("--apply");

const PASSWORD = process.env.OA_SUPABASE_DB_PASSWORD;
if (!PASSWORD) { console.error("OA_SUPABASE_DB_PASSWORD not set"); process.exit(1); }

const client = new pg.Client({
  host: "aws-1-us-west-2.pooler.supabase.com",
  port: 5432,
  user: "postgres.aiyzpjnvenfmurhyamge",
  password: PASSWORD,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
});

function betterToKeep(a, b) {
  // returns the row that should be KEPT
  const sa = STAGE_RANK[a.stage] ?? 0, sb = STAGE_RANK[b.stage] ?? 0;
  if (sa !== sb) return sa > sb ? a : b;
  const ca = a.confidence_score ?? -1, cb = b.confidence_score ?? -1;
  if (ca !== cb) return ca > cb ? a : b;
  return new Date(a.created_at) <= new Date(b.created_at) ? a : b;
}

const main = async () => {
  await client.connect();
  const { rows } = await client.query(
    `select id, material_id, material_name, supplier_name, stage, status, confidence_score, created_at
       from public.leads_in_flight
      where status = 'active'`
  );

  const groups = new Map();
  for (const r of rows) {
    const norm = normalizeCompanyName(r.supplier_name);
    if (!r.material_id || !norm) continue; // unkeyable rows are never touched
    const key = `${r.material_id}|${norm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const dropIds = [];
  const examples = [];
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    let keep = g[0];
    for (const r of g.slice(1)) keep = betterToKeep(keep, r);
    const drops = g.filter((r) => r.id !== keep.id);
    for (const d of drops) dropIds.push(d.id);
    if (examples.length < 15) {
      examples.push({
        supplier: keep.supplier_name,
        material: keep.material_name,
        total: g.length,
        keep: `${keep.stage}/${keep.confidence_score ?? "—"}`,
        drop: drops.length,
      });
    }
  }

  console.log(`Active leads scanned:        ${rows.length}`);
  console.log(`Duplicate groups (>1 row):   ${[...groups.values()].filter((g) => g.length > 1).length}`);
  console.log(`Rows that would be dropped:  ${dropIds.length}`);
  console.log(`\nSample groups (supplier · material · total → keep[stage/conf], drop N):`);
  for (const e of examples) {
    console.log(`  ${e.supplier}  ·  ${e.material}  ·  ${e.total} rows → keep[${e.keep}], drop ${e.drop}`);
  }

  if (!APPLY) {
    console.log(`\n(read-only preview — re-run with --apply to soft-drop the ${dropIds.length} rows)`);
    await client.end();
    return;
  }

  if (dropIds.length === 0) { console.log("\nNothing to drop."); await client.end(); return; }
  const res = await client.query(
    `update public.leads_in_flight
        set status = 'dropped',
            drop_reason = 'dedup_canonical_name',
            updated_at = now()
      where id = any($1::uuid[]) and status = 'active'`,
    [dropIds]
  );
  console.log(`\nAPPLIED: soft-dropped ${res.rowCount} duplicate rows (status='dropped', drop_reason='dedup_canonical_name').`);
  await client.end();
};

main().catch((e) => { console.error(e); process.exit(1); });
