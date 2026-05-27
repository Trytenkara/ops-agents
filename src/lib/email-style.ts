// Defensive style sanitizer for outbound draft email subjects/bodies.
// Goals:
//   1. Strip em dashes (—) and en dashes (–) the workflow guide forbids.
//   2. Remove a small set of canned AI phrases that slip past the system prompt.
//   3. Collapse 3+ blank lines to a maximum of one blank line between paragraphs.
// Conservative — never rewrites meaning, only formatting.

const DASH_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\s*—\s*/g, ", "],          // em dash with surrounding spaces → comma
  [/\s*–\s*/g, ", "],          // en dash with surrounding spaces → comma
];

const AI_PHRASE_STRIPS: RegExp[] = [
  /\bI hope this (?:email|message) finds you well[.,]?\s*/gi,
  /\bPer our records[,]?\s*/gi,
  /\bI am reaching out to\b/gi,
  /\bIn conclusion[,]?\s*/gi,
];

function clean(text: string): string {
  let out = text;
  for (const [re, rep] of DASH_REPLACEMENTS) out = out.replace(re, rep);
  for (const re of AI_PHRASE_STRIPS) out = out.replace(re, "");
  // Collapse 3+ consecutive newlines to exactly two (one blank line).
  out = out.replace(/\n{3,}/g, "\n\n");
  // Trim trailing whitespace on each line.
  out = out.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n");
  return out.trim();
}

export function sanitizeDraft<T extends { subject: string; body: string }>(d: T): T {
  return { ...d, subject: clean(d.subject), body: clean(d.body) };
}
