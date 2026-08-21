// Recheck every stored price against the extractor's own reading of the message
// it came from, and correct the one class of failure that is correctable
// without re-reading the message: a per-tonne price stored as the price of a
// case that is not a tonne.
//
// The capture-time gates (DATA-14/15/16) run at capture, so they cannot reach a
// row written before they existed. This is the backward pass. The reconciliation
// itself lives in src/lib/price-reconcile.ts and is the same function the
// client's Overview tab counts with, so a row this script leaves behind is
// visible rather than forgotten.
//
// Prints and changes nothing without --apply.
//
// Usage: tsx scripts/repair-unreconciled-quotes.mts [--apply] [--org slug]
import { createAdminClient } from "../src/lib/supabase/admin";
import { reconcileQuoteRow, expectedCasePrice } from "../src/lib/price-reconcile";

const apply = process.argv.includes("--apply");
const orgArg = process.argv.indexOf("--org");
const ORG_SLUG = orgArg > -1 ? process.argv[orgArg + 1] : null;

async function main() {
  const admin = createAdminClient();

  const { data: orgs, error: orgErr } = await admin.from("orgs").select("id, slug");
  if (orgErr) throw new Error(orgErr.message);
  const slugById = new Map((orgs ?? []).map((o: any) => [o.id, o.slug]));

  let q = admin
    .from("staged_quotes")
    .select(
      "id, org_id, supplier_name, material_name, price, case_size, unit_of_measurement, currency, unit_price, native_price, native_currency, fx_rate, raw_extract, extraction_notes, status, created_at"
    )
    .neq("status", "dismissed")
    .not("price", "is", null);
  if (ORG_SLUG) {
    const id = (orgs ?? []).find((o: any) => o.slug === ORG_SLUG)?.id;
    if (!id) throw new Error(`no org with slug ${ORG_SLUG}`);
    q = q.eq("org_id", id);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const failed = rows.map((r: any) => ({ r, issues: reconcileQuoteRow(r) })).filter((x) => x.issues.length);
  console.log(`${rows.length} priced rows examined, ${failed.length} do not reconcile`);

  let corrected = 0;
  let reported = 0;

  for (const { r, issues } of failed) {
    const slug = slugById.get(r.org_id) ?? r.org_id;
    console.log(`\n${slug} | ${r.supplier_name ?? "?"} × ${r.material_name ?? "?"} | ${r.id}`);
    for (const i of issues) console.log(`  - ${i}`);

    const raw = r.raw_extract && typeof r.raw_extract === "object" ? (r.raw_extract as any) : {};
    const rawPrice = Number(raw.price);
    const rawUnit = String(raw.unit_of_measurement ?? "").trim().toUpperCase();
    const caseSize = Number(r.case_size);

    // Correct only what the extract itself determines. A conversion happened
    // between the extract and the row, or the currency disagrees, or the case
    // is a volume: none of those can be settled without re-reading the message,
    // so they are reported and the row is left exactly as found.
    const expected = expectedCasePrice(r);
    const correctable =
      expected.value !== null &&
      Number.isFinite(caseSize) &&
      caseSize > 0 &&
      ["", "USD"].includes(String(r.native_currency ?? "").trim().toUpperCase()) &&
      issues.length === 1;

    if (!correctable) {
      reported++;
      console.log("  → left as found: this needs the original message, not arithmetic");
      continue;
    }

    const nextPrice = Number((expected.value as number).toFixed(4));
    const nextUnitPrice = (nextPrice / caseSize).toFixed(4);
    const note =
      `Corrected ${new Date().toISOString().slice(0, 10)}: the supplier quoted ` +
      `${rawPrice} ${r.currency ?? ""}/${rawUnit} and the packing is ${caseSize} ` +
      `${r.unit_of_measurement}, so the case price is ${nextPrice}, not ${r.price}. ` +
      `The per-tonne figure had been stored as the case price, reading ${r.unit_price} per ` +
      `${r.unit_of_measurement} instead of ${nextUnitPrice}.`;

    console.log(`  → price ${r.price} becomes ${nextPrice} for the ${caseSize} ${r.unit_of_measurement} case`);
    if (!apply) continue;

    const { error: upErr } = await admin
      .from("staged_quotes")
      .update({
        price: nextPrice,
        native_price: nextPrice,
        captured_price: nextPrice,
        status: "pending_review",
        extraction_notes: `${(r.extraction_notes ?? "").trim()} ${note}`.trim(),
      })
      .eq("id", r.id);
    if (upErr) {
      console.log(`  !! update failed: ${upErr.message}`);
      continue;
    }
    corrected++;
  }

  console.log(
    `\n${apply ? "applied" : "dry run"}: ${corrected} corrected, ${reported} reported and left as found`
  );
  if (!apply) console.log("re-run with --apply to write the corrections");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
