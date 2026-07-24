// Contact-fabrication guard. Agents that draft supplier emails must NEVER invent
// a shipping address, phone number, or email address. A prompt instruction alone
// is not steadfast (an LLM can ignore it), so this module deterministically
// detects contact info in an outgoing body and flags anything that isn't on an
// approved, human-curated allowlist. The lint rule (outreach-qa/lint.ts) and the
// staging chokepoint (draft-staging.ts) use it to HARD-BLOCK such drafts.
//
// Allowlist = per brand/org approved values below, PLUS values the caller passes
// in at runtime (e.g. the recipient's own email). Empty config for a brand means
// the agent may not state ANY contact info for it — it must defer to a human,
// which is exactly what the correct drafts already do.

export interface BrandContacts {
  addresses?: string[];
  phones?: string[];
  emails?: string[];
}

// Ops-curated. Key by ghost-brand name and/or org UUID. Add a brand's REAL
// shipping address / phone / sender email here only once it's verified — until
// then the agent is forced to defer instead of inventing one.
export const BRAND_CONTACTS: Record<string, BrandContacts> = {
  // "Sierra Materials Co": { addresses: ["..."], phones: ["..."], emails: ["..."] },
};

// Normalize for comparison: lowercase, collapse whitespace, strip everything
// except alphanumerics so "+1 (424) 644-7100" == "14246447100" and
// "2847 Industrial Parkway" == "2847industrialparkway".
export function normalizeContact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function approvedContactsFor(keys: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (!key) continue;
    const c = BRAND_CONTACTS[key];
    if (!c) continue;
    out.push(...(c.addresses ?? []), ...(c.phones ?? []), ...(c.emails ?? []));
  }
  return out;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Street address: a number, 1-4 capitalized/word tokens, then a street suffix.
// Deliberately excludes "Suite"/"Unit" as the trigger suffix to avoid matching
// phrases like "Unit 300"; a real street line still matches on its main suffix.
const STREET_RE =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Parkway|Pkwy|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Highway|Hwy|Circle|Cir|Terrace|Ter|Square|Sq|Loop|Trail|Trl|Industrial)\b\.?/gi;

// Phone: an optional +, then digit groups with typical separators, 10-15 digits
// total. The 10-digit floor excludes quantities/MOQs/prices/dates/lead times.
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().\-]{8,}\d/g;

function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

export interface ContactViolation {
  kind: "address" | "phone" | "email";
  value: string;
}

// Return every contact value in `text` that is NOT on `allowed`. Empty result
// means the body is clean.
export function findFabricatedContacts(text: string, allowed: string[]): ContactViolation[] {
  if (!text) return [];
  const allow = allowed.map(normalizeContact).filter(Boolean);
  const seen = new Set<string>();
  const out: ContactViolation[] = [];

  // Allowed if the detected value matches an approved value exactly, or (since
  // detection may extract only part of an address, or a phone with/without
  // country code) one normalized form contains the other. The length guard
  // stops trivially-short overlaps from waving a fabricated value through.
  const isAllowed = (norm: string) =>
    allow.some((a) => a === norm || (Math.min(a.length, norm.length) >= 6 && (a.includes(norm) || norm.includes(a))));

  const push = (kind: ContactViolation["kind"], raw: string) => {
    const value = raw.trim();
    const norm = normalizeContact(value);
    if (!norm || isAllowed(norm) || seen.has(kind + norm)) return;
    seen.add(kind + norm);
    out.push({ kind, value });
  };

  for (const m of text.matchAll(EMAIL_RE)) push("email", m[0]);
  for (const m of text.matchAll(STREET_RE)) push("address", m[0]);
  for (const m of text.matchAll(PHONE_CANDIDATE_RE)) {
    const n = digitCount(m[0]);
    if (n >= 10 && n <= 15) push("phone", m[0]);
  }
  return out;
}
