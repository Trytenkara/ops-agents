// Does the evidence we hold about a supplier satisfy the client's DEALBREAKER
// specs? Pure function, no network, no DB: callers pass the spec (resolved from
// Tenkara) and whatever free text they already captured.
//
// ADVISORY ONLY. A verdict of "unmet" means the required spec was not found in
// the text we have, NOT that the supplier fails it. Free-text absence is weak
// evidence: a homepage that never says "Palm-Based" is silent, not disqualifying.
// So nothing here may gate outreach or drop a lead; it annotates and sorts.
//
// Multiple dealbreaker grades on one material are CONJUNCTIVE facets, not
// alternatives (live data has Matcha = Organic + Powder + Ceremonial, all
// isDealbreaker:true). Every facet must be evidenced for a "meets".

export type DealbreakerVerdict = "meets" | "unmet" | "unknown";

export interface DealbreakerSpec {
  // Dealbreaker grade names from Tenkara materials.grade[].grade_name.
  requiredGrades: string[];
  // Dealbreaker certification names from user_supplier_settings.
  requiredCerts: string[];
}

export interface DealbreakerFit {
  verdict: DealbreakerVerdict;
  // Facets we found evidence for, and facets we did not. Both are spec strings.
  satisfied: string[];
  unmet: string[];
  // Facets whose text carried no distinguishing token, so they were not judged
  // either way (e.g. a grade named "#5"). Excluded from the verdict.
  unjudgeable: string[];
  note: string | null;
}

// Tokens that carry no distinguishing power inside a grade/cert name. "Palm-Based"
// must match on "palm" alone, and "Ceremonial Grade" on "ceremonial", otherwise a
// supplier page saying "palm oil" would score as unmet on the word "based".
const GENERIC_FACET_TOKENS = new Set([
  "based",
  "base",
  "grade",
  "graded",
  "type",
  "quality",
  "certified",
  "certification",
  "certificate",
  "standard",
  "spec",
  "specification",
  "min",
  "max",
  "and",
  "the",
  "for",
]);

// A dealbreaker grade is sometimes not a facet list at all but a whole prose
// materials spec that happens to contain commas (a live example runs "White,
// Opaque, Matte Finish, One Side: Corona-treated..., Roll Width: 50-60 inches").
// Comma-splitting that yields a dozen pseudo-facets no listing text can ever
// satisfy, so every supplier lands on "unmet" forever. Detect the shape and
// decline to judge it instead of emitting a guaranteed-negative verdict.
const MAX_FACETS = 5;
const MAX_FACET_CHARS = 40;

export function isProseSpec(facets: string[]): boolean {
  return facets.length > MAX_FACETS || facets.some((f) => f.trim().length > MAX_FACET_CHARS);
}

function facetTokens(facet: string): string[] {
  return Array.from(
    new Set(
      facet
        .toLowerCase()
        .split(/[^a-z0-9.]+/)
        // Keep numeric-bearing tokens (99.7, iso9001) — a percentage or standard
        // number is often the whole distinguishing content of a grade name.
        .filter((t) => t.length >= 2 && !GENERIC_FACET_TOKENS.has(t))
    )
  );
}

// A facet is satisfied when EVERY distinguishing token appears in the haystack.
// Substring matching handles plurals and compounds ("palm" in "palm-kernel").
function facetSatisfied(facet: string, haystack: string): boolean | null {
  const tokens = facetTokens(facet);
  if (tokens.length === 0) return null; // nothing to test → not judgeable
  return tokens.every((t) => haystack.includes(t));
}

export function hasDealbreakers(spec: DealbreakerSpec | null | undefined): boolean {
  if (!spec) return false;
  return spec.requiredGrades.some((g) => g.trim()) || spec.requiredCerts.some((c) => c.trim());
}

// Returns null when the client configured no dealbreakers at all, so the payload
// of the ~majority of orgs that set none stays untouched.
export function assessDealbreakerFit(args: {
  spec: DealbreakerSpec | null | undefined;
  // Supplier product/grade free text (collectProductText output).
  evidenceText: string | null | undefined;
  // Certifications parsed off the supplier's own site during enrichment.
  parsedCerts?: string[] | null;
  // Certifications the discovery scout captured as free text.
  scoutCerts?: string | null;
}): DealbreakerFit | null {
  const spec = args.spec;
  if (!hasDealbreakers(spec)) return null;

  const allGrades = spec!.requiredGrades.filter((g) => g.trim());
  const certs = spec!.requiredCerts.filter((c) => c.trim());
  // A prose spec is reported as unjudgeable rather than silently checked.
  const gradesAreProse = isProseSpec(allGrades);
  const grades = gradesAreProse ? [] : allGrades;

  const gradeHaystack = (args.evidenceText ?? "").toLowerCase();
  // Certs can be evidenced by the site-parsed list, the scout's free text, or the
  // product blob — union all three before judging.
  const certHaystack = [args.evidenceText ?? "", args.scoutCerts ?? "", (args.parsedCerts ?? []).join(" ")]
    .join(" ")
    .toLowerCase();

  const haveGradeEvidence = gradeHaystack.trim().length > 0;
  const haveCertEvidence = certHaystack.trim().length > 0;

  const satisfied: string[] = [];
  const unmet: string[] = [];
  const unjudgeable: string[] = gradesAreProse ? [...allGrades] : [];

  const judge = (facet: string, haystack: string, haveEvidence: boolean) => {
    if (!haveEvidence) {
      unjudgeable.push(facet);
      return;
    }
    const result = facetSatisfied(facet, haystack);
    if (result === null) unjudgeable.push(facet);
    else if (result) satisfied.push(facet);
    else unmet.push(facet);
  };

  for (const g of grades) judge(g, gradeHaystack, haveGradeEvidence);
  for (const c of certs) judge(c, certHaystack, haveCertEvidence);

  // Nothing was judgeable — no evidence text, or every facet was unnameable. This
  // is the dominant state pre-enrichment, since most raw leads carry no grade text.
  if (satisfied.length === 0 && unmet.length === 0) {
    return {
      verdict: "unknown",
      satisfied,
      unmet,
      unjudgeable,
      note: "No product or certification evidence captured yet, so the client's dealbreakers could not be checked.",
    };
  }

  if (unmet.length === 0) {
    return {
      verdict: "meets",
      satisfied,
      unmet,
      unjudgeable,
      note: null,
    };
  }

  return {
    verdict: "unmet",
    satisfied,
    unmet,
    unjudgeable,
    note: `No evidence this supplier offers ${unmet.join(", ")} (client dealbreaker). Confirm before or during outreach.`,
  };
}
