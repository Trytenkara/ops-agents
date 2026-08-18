// Internal notes may never reach a supplier.
//
// A call-follow-up drafter pasted the raw call log into the outbound body, so a
// supplier received "From our conversation: - Unable to reach after two call
// attempts." Fixing that one drafter is not enough: every internal free-text
// field (operator de-escalation notes, Granola meeting pastes, agent reason
// strings) is one interpolation away from the same leak.
//
// The invariant is positive: an outbound body carries only sentences addressed
// TO the supplier. Internal recap material is either rewritten for them or left
// out. This module is the runtime backstop, applied inside sanitizeDraft, which
// is itself applied inside stageDraft. Nothing outbound skips it.

// Headers a drafter uses to introduce a dump of internal recap lines.
const RECAP_HEADERS: RegExp[] = [
  /^\s*from our (?:conversation|call|notes)\s*:?\s*$/i,
  /^\s*(?:call|internal|operator|granola)\s+notes?\s*:?\s*$/i,
  /^\s*notes? from the call\s*:?\s*$/i,
  /^\s*recap\s*:?\s*$/i,
];

// Phrasing that only ever describes OUR side of a call attempt or our own
// pipeline state. A supplier is never told any of this.
const INTERNAL_LINE_PATTERNS: RegExp[] = [
  /unable to reach/i,
  /(?:no answer|wrong number)/i,
  /left (?:a |them a )?voicemail/i,
  /\bcall attempts?\b/i,
  /\battempted? to call\b/i,
  /\bcannot supply this\b/i,
  /supplier (?:already )?responded to our email/i,
  /\bfollow[- ]?up (?:#|number )?\d+\b/i,
  /\bcall stage \d+\b/i,
  /\bdo not contact\b/i,
  /\binternal(?: use)? only\b/i,
];

function isInternalLine(line: string): boolean {
  const l = line.trim().replace(/^[-*•]\s*/, "");
  if (!l) return false;
  if (RECAP_HEADERS.some((re) => re.test(l))) return true;
  return INTERNAL_LINE_PATTERNS.some((re) => re.test(l));
}

export interface InternalNoteRedaction {
  body: string;
  removed: string[];
}

// Drop any line that reads as internal note material. Line-scoped on purpose:
// removing a whole paragraph would gut a legitimate draft, and every observed
// leak arrived as its own line (a recap header plus bulleted note lines).
export function stripInternalNotes(body: string): InternalNoteRedaction {
  const removed: string[] = [];
  const kept = body.split("\n").filter((line) => {
    if (isInternalLine(line)) {
      removed.push(line.trim());
      return false;
    }
    return true;
  });
  return { body: kept.join("\n"), removed };
}

export function containsInternalNote(text: string): boolean {
  return text.split("\n").some(isInternalLine);
}
