import type { CallAttempt } from "@/lib/call-brief";
import { CALL_OUTCOMES } from "@/lib/call-brief";

// The follow-up email sent the moment a call case goes back to the email loop.
// Unlike the generic no-reply nudge (no-reply-followup.ts), this one exists
// because a call happened: it names what was discussed so the supplier isn't
// asked to repeat themselves, and folds in Granola notes when there are any.

export interface CallFollowupInput {
  contactName: string | null;
  materialName: string | null;
  callLog: CallAttempt[];
  deescalationNote: string | null;
  granolaNotes: string | null;
  signoff: string;
}

export function buildCallFollowupBody(opts: CallFollowupInput): string {
  const greeting = opts.contactName ? `Hi ${opts.contactName.split(/\s+/)[0]},` : "Hi there,";
  const mat = opts.materialName ? ` for ${opts.materialName}` : "";

  const reached = opts.callLog.filter((a) => a.outcome === "reached");
  const talkedLine = reached.length
    ? `Thanks for taking the time to talk it through on the phone.`
    : `We tried reaching you by phone to follow up.`;

  const recap: string[] = [];
  if (opts.granolaNotes) recap.push(opts.granolaNotes.trim());
  if (opts.deescalationNote) recap.push(opts.deescalationNote.trim());
  if (!recap.length) {
    for (const a of opts.callLog) {
      if (a.note) recap.push(a.note.trim());
    }
  }

  const lines = [
    greeting,
    "",
    `${talkedLine} Following up in writing${mat} so we have a record and you have something to reply to when you're ready.`,
  ];
  if (recap.length) {
    lines.push("", "From our conversation:", ...recap.map((r) => `- ${r}`));
  }
  lines.push(
    "",
    `A quote with price, pack size, lead time, and MOQ would be perfect, and I'm happy to answer any questions.`,
    "",
    "Thanks,",
    opts.signoff
  );
  return lines.join("\n");
}
