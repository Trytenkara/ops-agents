// Defensive style sanitizer for outbound draft email subjects/bodies.
// Goals:
//   1. Strip em dashes (—) and en dashes (–) the workflow guide forbids.
//   2. Replace the term "RFQ" with "sourcing inquiry" (client-facing language rule).
//   3. Remove a small set of canned AI phrases that slip past the system prompt.
//   4. Collapse 3+ blank lines to a maximum of one blank line between paragraphs.
//   5. Drop internal note lines (call outcomes, operator notes) that a drafter
//      interpolated into a supplier-facing body. See internal-notes.ts.
// Conservative, never rewrites meaning, only formatting.

import { stripInternalNotes } from "@/lib/internal-notes";

const DASH_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\s*—\s*/g, ", "],          // em dash with surrounding spaces → comma
  [/\s*–\s*/g, ", "],          // en dash with surrounding spaces → comma
];

// "RFQ" is internal jargon; outbound copy says "sourcing inquiry". Handle the
// article ("an RFQ" → "a sourcing inquiry") and plural before the bare term.
const RFQ_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\ban RFQs?\b/g, "a sourcing inquiry"],
  [/\bRFQs\b/g, "sourcing inquiries"],
  [/\bRFQ\b/g, "sourcing inquiry"],
];

const AI_PHRASE_STRIPS: RegExp[] = [
  /\bI hope this (?:email|message) finds you well[.,]?\s*/gi,
  /\bPer our records[,]?\s*/gi,
  /\bI am reaching out to\b/gi,
  /\bIn conclusion[,]?\s*/gi,
];

function clean(text: string, dropInternalNotes: boolean): string {
  let out = text;
  if (dropInternalNotes) out = stripInternalNotes(out).body;
  for (const [re, rep] of DASH_REPLACEMENTS) out = out.replace(re, rep);
  for (const [re, rep] of RFQ_REPLACEMENTS) out = out.replace(re, rep);
  for (const re of AI_PHRASE_STRIPS) out = out.replace(re, "");
  // Collapse 3+ consecutive newlines to exactly two (one blank line).
  out = out.replace(/\n{3,}/g, "\n\n");
  // Trim trailing whitespace on each line.
  out = out.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n");
  return out.trim();
}

export function sanitizeDraft<T extends { subject: string; body: string }>(d: T): T {
  return { ...d, subject: clean(d.subject, false), body: clean(d.body, true) };
}

// Email clients render a plain `\n`-separated body as one collapsed paragraph.
// Convert to minimal HTML: each blank-line-separated block becomes a <p>,
// single newlines inside a block become <br>. HTML-escape everything first.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function bodyToHtml(plainBody: string): string {
  const paragraphs = plainBody
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
