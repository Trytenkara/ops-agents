// Defensive style sanitizer for outbound draft email subjects/bodies.
// Goals:
//   1. Strip em dashes (—) and en dashes (–) the workflow guide forbids.
//   2. Replace the term "RFQ" with "sourcing inquiry" (client-facing language rule).
//   3. Remove a small set of canned AI phrases that slip past the system prompt.
//   4. Collapse 3+ blank lines to a maximum of one blank line between paragraphs.
//   5. Drop sentences that invite the supplier to end the conversation or
//      apologise for writing. See CONCESSION_STRIPS.
//   6. Drop internal note lines (call outcomes, operator notes) that a drafter
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

// Sentences that hand the supplier a way out of the conversation, or apologise
// for having sent it. "If the timing isn't right, just say the word and I'll
// stop chasing" was live in the stalled-thread chase and in a few-shot example
// the revalidation drafter learned from. We are a buyer with money asking a
// seller for a price; inviting a no is not politeness, it is a lost supplier.
// Whole sentence goes, not just the phrase, or the remainder reads as debris.
const CONCESSION_STRIPS: RegExp[] = [
  /[^.!?\n]*\b(?:stop chasing|stop (?:following|reaching) (?:up|out)|say the word and)\b[^.!?\n]*[.!?]?[ \t]*/gi,
  /[^.!?\n]*\bno worries if\b[^.!?\n]*[.!?]?[ \t]*/gi,
  /[^.!?\n]*\bfeel free to ignore\b[^.!?\n]*[.!?]?[ \t]*/gi,
  /[^.!?\n]*\bif (?:the )?timing (?:isn'?t|is not) right\b[^.!?\n]*[.!?]?[ \t]*/gi,
  /[^.!?\n]*\bif (?:this|that) (?:isn'?t|is not) (?:something you|of interest|a fit)\b[^.!?\n]*[.!?]?[ \t]*/gi,
  /[^.!?\n]*\b(?:sorry|apologies) (?:to|for) (?:bother|bothering|keep|the )\b[^.!?\n]*[.!?]?[ \t]*/gi,
  /[^.!?\n]*\b(?:I'?ll|we'?ll) (?:stop|leave you (?:alone|be))\b[^.!?\n]*[.!?]?[ \t]*/gi,
  /[^.!?\n]*\blet me know (?:if|and) (?:you'?d like me to|I(?:'| wi)ll) stop\b[^.!?\n]*[.!?]?[ \t]*/gi,
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
  if (dropInternalNotes) {
    for (const re of CONCESSION_STRIPS) out = out.replace(re, " ");
    out = out.replace(/[ \t]{2,}/g, " ");
    // A removed opening sentence leaves the line starting with the space we
    // substituted for it.
    out = out.replace(/^[ \t]+/gm, "");
  }
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
