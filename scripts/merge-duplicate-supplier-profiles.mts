// One supplier ends up with TWO supplier_profiles rows when it is first seen as a
// name-only lead (Scout/discovery, no supplier_id) and later linked to a Tenkara
// supplier_id: seedSupplierProfiles looks the existing row up by supplier_id only
// (`existingById`), misses the name-only row, and inserts a second profile. The
// partial unique indexes allow it — one covers (org, supplier_id) where the id is
// present, the other (org, lower(name)) where it is NULL — so the two never collide.
//
// The second row is also almost always mislabelled: it is built from the id-bearing
// lead, whose payload usually carries no site_type, and `leadMarketKind(...) ?? "direct"`
// then defaults it to DIRECT. That default outranks everything downstream, because
// supplierKind() checks supplier_id before name, so a marketplace supplier routes to
// the direct lane and its drafts land on a direct-lane operator.
//
// This merges the pair into the id-bearing row (the id is what links to Tenkara),
// keeps the real market kind, fills blanks from the row being dropped, re-points
// marketplace_accounts, then deletes it. Market kind is never flattened: a pair is
// only merged when both rows are the same company, and the surviving kind comes from
// evidence (operator tick > lead site_type > the non-default type), so marketplace,
// aggregator and direct stay distinct.
//
// Run:
//   npx tsx scripts/merge-duplicate-supplier-profiles.mts [--apply] [--org=slug]
import { appendFileSync } from "node:fs";
import { createAdminClient } from "@/lib/supabase/admin";
import { leadMarketKind, type MarketKind } from "@/lib/lead-market";

const apply = process.argv.includes("--apply");
const orgFilter = process.argv.find((a) => a.startsWith("--org="))?.split("=")[1] ?? null;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Fill-only columns: copied from the dropped row where the kept row has nothing.
// Operator verification ticks and fee overrides are deliberately NOT in here — they
// are someone's judgement about the row they were looking at, not facts about the
// company — they are reported instead.
const FILL_COLUMNS = [
  "poc_email", "poc_phone", "poc_name", "shipping_address", "shipping_terms", "shipping_email",
  "billing_email", "billing_poc_name", "payment_upfront_pct", "payment_net_days",
  "payment_completion", "payment_credit_line", "notes", "generated_notes",
] as const;
// An operator tick verifies the fields it sits next to on the validation card. It
// carries to the surviving row only when that row ends up holding the same values
// the operator was looking at; if the rows disagree on any of them, the tick is
// dropped and reported so it gets re-checked rather than silently re-asserted.
const TICK_COLUMNS = {
  contact_info_complete: ["poc_email", "poc_name", "poc_phone"],
  marketplace_type_correct: ["supplier_type"],
  address_accurate: ["shipping_address"],
  shipping_terms_correct: ["shipping_terms"],
  billing_verified: ["billing_email", "billing_poc_name"],
  payment_info_verified: ["payment_upfront_pct", "payment_net_days", "payment_completion", "payment_credit_line"],
  payment_terms_confirmed: ["payment_upfront_pct", "payment_net_days", "payment_completion"],
} as const;

const nk = (s: string) => s.trim().toLowerCase();
const emailDomain = (v: unknown): string | null => {
  const s = String(v ?? "").trim().toLowerCase();
  if (!EMAIL_SHAPE.test(s)) return null; // prose channel notes ("via IndiaMART inquiry") are not addresses
  return s.split("@")[1] ?? null;
};
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

// Deletes are one-way, so every dropped row is written out in full first.
const backupPath = `/workspace/backups/supplier-profile-merge-${process.env.RUN_STAMP ?? "run"}.jsonl`;

const admin = createAdminClient();

async function pageAll<T>(table: string, select: string, orgId: string, extra: (q: any) => any = (q) => q): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await extra(admin.from(table).select(select).eq("org_id", orgId)).order("id").range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

const { data: orgs } = await admin.from("orgs").select("id, slug, is_internal").order("slug");
const totals = { merged: 0, skipped: 0, kindFixed: 0, filled: 0, accountsRepointed: 0 };

for (const org of orgs ?? []) {
  if (orgFilter && org.slug !== orgFilter) continue;
  const profiles = await pageAll<any>("supplier_profiles", "*", org.id);
  const byName = new Map<string, any[]>();
  for (const p of profiles) {
    if (!p.supplier_name?.trim()) continue;
    const k = nk(p.supplier_name);
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const groups = [...byName.entries()].filter(([, v]) => v.length > 1);
  if (!groups.length) continue;

  // Market kind as the leads themselves report it, which is the evidence the
  // id-bearing profile lost when its payload had no site_type.
  const leads = await pageAll<any>("leads_in_flight", "supplier_name, st:payload->>site_type", org.id, (q) => q.eq("status", "active"));
  const leadKind = new Map<string, MarketKind>();
  for (const l of leads) {
    if (!l.supplier_name?.trim()) continue;
    const kind = leadMarketKind(l.st);
    if (!kind) continue;
    const key = nk(l.supplier_name);
    // marketplace/aggregator is a positive observation; "direct" is also what the
    // absence of a site_type looks like, so never let it overwrite one.
    if (kind !== "direct" || !leadKind.has(key)) leadKind.set(key, kind);
  }

  console.log(`\n### ${org.slug}${org.is_internal ? " (internal)" : ""} — ${groups.length} duplicated names`);
  for (const [key, rows] of groups) {
    const withId = rows.filter((r) => r.supplier_id);
    const withoutId = rows.filter((r) => !r.supplier_id);
    const domains = new Set(rows.map((r) => emailDomain(r.poc_email)).filter(Boolean) as string[]);
    const types = [...new Set(rows.map((r) => r.supplier_type).filter(Boolean))];

    let skip: string | null = null;
    if (withId.length > 1) skip = `${withId.length} distinct Tenkara supplier_ids under one name`;
    else if (withId.length === 0) skip = "no id-bearing row (nothing to merge into)";
    else if (rows.length > 2) skip = `${rows.length} rows in the group`;
    else if (domains.size > 1) skip = `different contact domains (${[...domains].join(" vs ")})`;
    if (skip) {
      totals.skipped++;
      console.log(`  SKIP  ${key}  [${types.join(",")}] — ${skip}`);
      for (const r of rows) console.log(`          ${r.id.slice(0, 8)} type=${r.supplier_type} sid=${r.supplier_id?.slice(0, 8) ?? "-"} poc=${r.poc_email ?? "-"}`);
      continue;
    }

    const keep = withId[0];
    const drop = withoutId[0];

    // Kind, in evidence order. An operator tick is a person's verdict and wins.
    const ticked = rows.find((r) => r.marketplace_type_correct && r.supplier_type);
    const fromLeads = leadKind.get(key) ?? null;
    const nonDefault = types.find((t) => t !== "direct") ?? null;
    const kind: MarketKind | null = ticked?.supplier_type ?? fromLeads ?? nonDefault ?? keep.supplier_type ?? null;
    const kindSource = ticked ? "operator tick" : fromLeads ? "lead site_type" : nonDefault ? "scouted row" : "unchanged";

    const patch: Record<string, unknown> = {};
    if (kind && kind !== keep.supplier_type) patch.supplier_type = kind;
    for (const col of FILL_COLUMNS) if (blank(keep[col]) && !blank(drop[col])) patch[col] = drop[col];
    const fs = { ...(drop.field_sources ?? {}), ...(keep.field_sources ?? {}) };
    if (JSON.stringify(fs) !== JSON.stringify(keep.field_sources ?? {})) patch.field_sources = fs;

    // Where both rows carry a contact, the kept one stands and the other would just
    // vanish. It is a real, same-domain contact for the same company, so keep it
    // readable on the surviving profile instead of deleting it.
    const alt = ["poc_name", "poc_email", "poc_phone"]
      .filter((f) => !blank(drop[f]) && String(drop[f]) !== String(f in patch ? patch[f] : keep[f]))
      .map((f) => drop[f]);
    if (alt.length) {
      patch.generated_notes = `${String(patch.generated_notes ?? keep.generated_notes ?? "").trim()} Alternate contact (merged duplicate profile): ${alt.join(", ")}.`.trim();
    }

    const carriedTicks: string[] = [];
    const lostTicks: string[] = [];
    for (const [tick, fields] of Object.entries(TICK_COLUMNS)) {
      if (!drop[tick] || keep[tick]) continue;
      const merged = (f: string) => (f in patch ? patch[f] : keep[f]);
      const conflicts = fields.some((f) => !blank(merged(f)) && !blank(drop[f]) && String(merged(f)) !== String(drop[f]));
      if (conflicts) lostTicks.push(tick);
      else {
        carriedTicks.push(tick);
        patch[tick] = true;
      }
    }
    const lostApproval = drop.approval_status !== "draft" && drop.approval_status !== keep.approval_status ? drop.approval_status : null;

    const { data: accounts } = await admin.from("marketplace_accounts").select("id").eq("supplier_profile_id", drop.id);
    const accountIds = (accounts ?? []).map((a: any) => a.id);

    console.log(
      `  MERGE ${key}\n` +
        `          keep ${keep.id.slice(0, 8)} sid=${keep.supplier_id.slice(0, 8)} type=${keep.supplier_type}` +
        (patch.supplier_type ? ` -> ${patch.supplier_type} (${kindSource})` : ` (unchanged)`) + `\n` +
        `          drop ${drop.id.slice(0, 8)} type=${drop.supplier_type} poc=${drop.poc_email ?? "-"}\n` +
        `          fills: ${Object.keys(patch).filter((k) => k !== "supplier_type" && !(k in TICK_COLUMNS)).join(", ") || "none"}` +
        (carriedTicks.length ? ` · ticks carried: ${carriedTicks.join(",")}` : "") +
        (accountIds.length ? ` · repoint ${accountIds.length} marketplace_account(s)` : "") +
        (lostTicks.length ? ` · NOTE tick not carried (values disagree): ${lostTicks.join(",")}` : "") +
        (lostApproval ? ` · NOTE dropped row approval_status=${lostApproval}` : "")
    );

    totals.merged++;
    if (patch.supplier_type) totals.kindFixed++;
    if (Object.keys(patch).some((k) => k !== "supplier_type" && !(k in TICK_COLUMNS))) totals.filled++;
    totals.accountsRepointed += accountIds.length;

    if (apply) {
      appendFileSync(backupPath, `${JSON.stringify({ org: org.slug, keptId: keep.id, patch, dropped: drop })}\n`);
      if (accountIds.length) {
        const { error } = await admin.from("marketplace_accounts").update({ supplier_profile_id: keep.id }).in("id", accountIds);
        if (error) throw error;
      }
      if (Object.keys(patch).length) {
        const { error } = await admin.from("supplier_profiles").update(patch).eq("id", keep.id);
        if (error) throw error;
      }
      const { error: delError } = await admin.from("supplier_profiles").delete().eq("id", drop.id);
      if (delError) throw delError;
    }
  }
}

console.log(
  `\n${apply ? "APPLIED" : "DRY RUN"} — merge ${totals.merged}, skip ${totals.skipped}, ` +
    `market kind corrected on ${totals.kindFixed}, blanks filled on ${totals.filled}, ` +
    `marketplace_accounts re-pointed ${totals.accountsRepointed}`
);
