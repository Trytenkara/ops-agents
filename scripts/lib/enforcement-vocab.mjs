// The fixed vocabulary every rule's Enforcement line must begin with.
//
// This list used to exist twice, hand-copied into check-rules.mjs and
// gen-enforcement.mjs. Two copies of one invariant is the thing META-04
// forbids, and it was sitting inside the tooling that enforces META-04. The
// failure it invites is quiet in the worst way: the checker accepts a line the
// generator cannot classify, so the build passes and the rule lands in the
// ledger as UNCLASSIFIED, or vice versa.
//
// Order matters. `classify` returns the first match, so anything that is a
// prefix of another entry has to come after it. `Audit owed` before `Audit`.

/** @type {Array<{name: string, re: RegExp, meaning: string, owed: boolean}>} */
export const BUCKETS = [
  {
    name: "Guard",
    re: /^Guard\b/,
    meaning: "A shared module or build check makes it impossible.",
    owed: false,
  },
  {
    name: "Audit owed",
    re: /^Audit owed\b/,
    meaning: "No build check can see it; a scheduled job can. Not built.",
    owed: true,
  },
  {
    name: "Audit",
    re: /^Audit —/,
    meaning: "A scheduled job reports the break after the fact.",
    owed: false,
  },
  {
    name: "Check owed",
    re: /^Check owed\b/,
    meaning: "A build check is possible and is not built yet.",
    owed: true,
  },
  {
    name: "Judgement",
    re: /^Judgement\./,
    meaning: "Nothing mechanical can ever verify it. Human, by design.",
    owed: false,
  },
  {
    name: "Cross-reference",
    re: /^See [A-Z]+-\d+\./,
    meaning: "Restates a rule enforced elsewhere.",
    owed: false,
  },
  {
    name: "None",
    re: /^None\./,
    meaning: "Outside this repository. Cannot be checked here.",
    owed: false,
  },
  {
    name: "Retired",
    re: /^Retired\b/,
    meaning: "No longer applies.",
    owed: false,
  },
];

// How the ledger lays the buckets out, which is a reading order and not the
// matching order above. Kept separate so tightening `BUCKETS` can never
// reshuffle the published document.
export const DISPLAY_ORDER = [
  "Guard",
  "Audit",
  "Check owed",
  "Audit owed",
  "Judgement",
  "Cross-reference",
  "None",
  "Retired",
];

export const UNCLASSIFIED = "UNCLASSIFIED";

/** The bucket name for an Enforcement line, or UNCLASSIFIED. */
export function classify(enforcement) {
  return BUCKETS.find((b) => b.re.test(enforcement))?.name ?? UNCLASSIFIED;
}

/** True when the bucket is a debt, and so must also appear in OUTSTANDING.md. */
export function isOwed(bucketName) {
  return BUCKETS.some((b) => b.name === bucketName && b.owed);
}

/**
 * True when the rule owes work, whether or not that is how it opens.
 *
 * The opening word alone is not the answer. A rule may hold one half of its
 * invariant with a real guard and admit the other half is not built:
 * "Guard for the invariants that have a check-rules id. Check owed — extending
 * coverage to the rest." Reading only the first word files that as fully
 * enforced and the debt is never listed anywhere.
 *
 * Any use of the word is a debt, not just the two openings. Three rules
 * admitted their missing half in prose — "the run-summary half is still owed"
 * — and were counted as fully enforced for it, which is the same failure one
 * sentence further in.
 */
export function owesWork(enforcement, bucketName) {
  return isOwed(bucketName) || /\bowed\b/.test(enforcement);
}

/** Human-readable list of the accepted openings, for the failure message. */
export function vocabularyHint() {
  return [
    "'Guard — <module or check-rules id>'",
    "'Audit — <job>'",
    "'Check owed — <check-rules id>'",
    "'Audit owed — <job>'",
    "'Judgement.'",
    "'None.'",
    "'Retired <date>'",
    "'See <RULE-ID>.'",
  ].join(", ");
}
