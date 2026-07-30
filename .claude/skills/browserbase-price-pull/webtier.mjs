// Glue for Tier A (the web_fetch/web_search workflow, webfetch-workflow.js).
//
//   node webtier.mjs worklist --org <slug> [--mode all|residue] [--limit N]
//       → prints the lead worklist as JSON (pass it to Workflow as `args`).
//         mode=all (default): every marketplace lead (daily refresh).
//         mode=residue: only leads still needs_manual_pull (post-Browserbase gaps).
//
//   node webtier.mjs write <workflow-result.json>
//       → persists the workflow's results via writePull (same keep-best merge as
//         every other tier: updates changed prices, keeps a good price if a lead
//         now fails, flags the WHY). Results are tagged source="web_fetch".
//
//   node webtier.mjs orgs
//       → prints active/sourcing_only real-client orgs as JSON.
//
//   node webtier.mjs coverage
//       → prints one priced/total coverage line per eligible real client.
//
// Reuses src/accounts.mjs so the write path is identical to the Browserbase tiers.
import { readFileSync } from "node:fs";
import { getOrg, listLoginRequiredLeads, writePull } from "./src/accounts.mjs";

const OA_REF = "aiyzpjnvenfmurhyamge";
const BASE = `https://${OA_REF}.supabase.co/rest/v1`;
function key() {
  const k = process.env.OA_SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("OA_SUPABASE_SERVICE_ROLE_KEY not set");
  return k;
}
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function listingUrlOf(p) {
  return p?.marketplace_pull?.source_url ?? p?.enrichment?.contact?.contact_url ?? p?.supplier_website ?? p?.source_url ?? null;
}
async function getLead(id) {
  const r = await fetch(`${BASE}/leads_in_flight?id=eq.${id}&select=id,org_id,supplier_name,material_name,payload&limit=1`, {
    headers: { apikey: key(), Authorization: `Bearer ${key()}` },
  });
  const rows = await r.json();
  return rows?.[0] ?? null;
}
async function eligibleOrgs() {
  const r = await fetch(
    `${BASE}/orgs?select=id,slug,name&sourcing_status=in.(active,sourcing_only)&is_internal=eq.false&order=slug`,
    { headers: { apikey: key(), Authorization: `Bearer ${key()}` } },
  );
  const rows = await r.json();
  if (!r.ok) throw new Error(`org query failed: ${JSON.stringify(rows)}`);
  return rows;
}

const cmd = process.argv[2];

if (cmd === "orgs") {
  process.stdout.write(JSON.stringify(await eligibleOrgs()));
} else if (cmd === "coverage") {
  for (const org of await eligibleOrgs()) {
    const r = await fetch(
      `${BASE}/leads_in_flight?org_id=eq.${org.id}&payload->marketplace_pull=not.is.null&select=payload`,
      { headers: { apikey: key(), Authorization: `Bearer ${key()}` } },
    );
    const leads = await r.json();
    if (!r.ok) throw new Error(`coverage query failed for ${org.slug}: ${JSON.stringify(leads)}`);
    const priced = leads.filter((lead) => lead.payload?.marketplace_pull?.status === "pulled").length;
    console.log(`${org.slug}: ${priced}/${leads.length} priced`);
  }
} else if (cmd === "worklist") {
  const orgRef = arg("org");
  if (!orgRef) throw new Error("worklist requires --org <slug>");
  const mode = arg("mode", "all");
  const limit = Number(arg("limit")) || 100000;
  const org = await getOrg(orgRef);
  if (!org) throw new Error(`no org: ${orgRef}`);
  const leads = await listLoginRequiredLeads(org.id, { all: mode !== "residue", reasons: ["login_required", "needs_review"] });
  const out = leads.slice(0, limit).map((l) => ({ id: l.id, material: l.material_name, supplier: l.supplier_name, url: l.url }));
  process.stdout.write(JSON.stringify(out));
} else if (cmd === "write") {
  const path = process.argv[3];
  if (!path) throw new Error("write requires a <workflow-result.json> path");
  const data = JSON.parse(readFileSync(path, "utf8"));
  const results = Array.isArray(data) ? data : (data.results ?? []);
  let wrote = 0;
  let priced = 0;
  for (const r of results) {
    if (!r?.id) continue;
    const lead = await getLead(r.id);
    if (!lead) continue;
    lead.url = listingUrlOf(lead.payload);
    const result = {
      classification: r.classification,
      current_price: r.current_price ?? null,
      currency: r.currency ?? null,
      pack_size: r.pack_size ?? null,
      unit_price: null,
      tiers: (r.tiers ?? []).map((t) => ({ pack_size: t.pack_size ?? "", price: t.price, unit_price: null })),
      notes: r.notes ?? null,
      source: "web_fetch",
      source_url: r.source_url ?? lead.url,
    };
    const got = await writePull(lead, result);
    wrote++;
    if (got) priced++;
  }
  console.log(JSON.stringify({ wrote, priced }));
} else {
  console.error("usage: node webtier.mjs orgs | coverage | worklist --org <slug> [--mode all|residue] [--limit N] | write <results.json>");
  process.exit(1);
}
