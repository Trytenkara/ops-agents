// Which rung of a supplier's price ladder a reply quoted. The extractor writes
// it as free text ("tier: >=1000kg; package: 1000kg IBC") because a per-kg
// ladder carries case_size 1 on every rung, so case_size alone cannot tell two
// rungs apart. The tier threshold wins over the package: it is the thing that
// distinguishes the rungs, and it is what an operator needs to read next to the
// price.
//
// Its own module (not quote-profiles) so client components can render the label
// without pulling the supabase client into the browser bundle.
// The extractor occasionally writes a whole sentence into the tier field. Keep
// the label short enough to read as a badge; the full text stays in
// extraction_notes.
const trim = (s: string) => (s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s);

export function stagedPackLabel(row: {
  extraction_notes?: string | null;
  case_size?: number | null;
  unit_of_measurement?: string | null;
}): string | null {
  const notes = typeof row.extraction_notes === "string" ? row.extraction_notes : "";
  const tier = notes.match(/\btier\s*:\s*([^;\n]+)/i)?.[1]?.trim();
  if (tier) return trim(tier);
  const pack = notes.match(/\bpackage\s*:\s*([^;\n]+)/i)?.[1]?.trim();
  if (pack) return trim(pack);
  const size = row.case_size != null ? Number(row.case_size) : null;
  // A size of 1 is a per-unit price, not a pack. Labelling it "1 kg" would read
  // as a rung the supplier never quoted.
  if (size != null && Number.isFinite(size) && size > 1 && row.unit_of_measurement) {
    return `${size} ${row.unit_of_measurement}`;
  }
  return null;
}
