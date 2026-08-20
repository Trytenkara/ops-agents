// The inbound router's target test. Rows are ordered most-recent-first, as the
// callers order them. Shapes marked "live" are real draft_reference sets read
// out of the table on 2026-08-20.
import { soleReplyTarget } from "../src/lib/org-isolation";

const A = "org-a", B = "org-b";
const r = (org: string | null, sup: string | null, mat: string | null, kind = "cold_outbound") => ({
  org_id: org,
  supplier_id: sup,
  material_id: mat,
  kind,
});

type Case = [string, ReturnType<typeof r>[], string | null];

const cases: Case[] = [
  // --- live shapes that must now MATCH. Every one of these was refused.
  [
    "Reroot: unlinked cold outreach, then a linked follow-up, plus a triage draft",
    [
      r(A, null, null, "unmatched_inbound_clarification"),
      r(A, "sup-1", "mat-1", "inbound_reply"),
      r(A, "sup-1", "mat-1", "no_reply_followup"),
      r(A, null, "mat-1", "cold_outbound"),
    ],
    "sup-1",
  ],
  ["Depu: unlinked cold outreach and one linked follow-up", [r(A, "sup-1", "mat-1", "no_reply_followup"), r(A, null, "mat-1")], "sup-1"],
  ["every row unlinked but one", [r(A, null, "mat-1"), r(A, null, "mat-1"), r(A, "sup-1", "mat-1")], "sup-1"],
  ["a triage draft cannot make a clean thread ambiguous", [r(A, null, null, "unmatched_inbound_clarification"), r(A, "sup-1", "mat-1")], "sup-1"],
  ["already unambiguous", [r(A, "sup-1", "mat-1")], "sup-1"],

  // --- must still REFUSE
  ["two clients on one thread", [r(A, "sup-1", "mat-1"), r(B, "sup-1", "mat-1")], null],
  ["two clients, one of them unlinked", [r(A, null, "mat-1"), r(B, "sup-1", "mat-1")], null],
  ["two genuinely different suppliers", [r(A, "sup-1", "mat-1"), r(A, "sup-2", "mat-1")], null],
  ["one supplier, two materials", [r(A, "sup-1", "mat-1"), r(A, "sup-1", "mat-2")], null],
  ["nothing named at all", [r(A, null, null), r(A, null, null)], null],
  ["material known, supplier never linked", [r(A, null, "mat-1"), r(A, null, "mat-1")], null],
  ["supplier known, material never linked", [r(A, "sup-1", null)], null],
  ["no candidates", [], null],
];

let bad = 0;
for (const [name, rows, want] of cases) {
  const got = soleReplyTarget(rows);
  const ok = (got?.supplierId ?? null) === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${(got ? "match" : "triage").padEnd(6)} ${name}${ok ? "" : `   EXPECTED ${want ?? "triage"}`}`);
}

// The row it files against must describe the outreach, not the triage artefact
// that a previous refusal left behind.
const chosen = soleReplyTarget([
  r(A, null, null, "unmatched_inbound_clarification"),
  r(A, "sup-1", "mat-1", "no_reply_followup"),
]);
const pickedOutreach = chosen?.ref.kind === "no_reply_followup";
if (!pickedOutreach) bad++;
console.log(`${pickedOutreach ? "ok  " : "FAIL"}  files against the outreach row, not the triage draft (got ${chosen?.ref.kind})`);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
if (bad) process.exit(1);
