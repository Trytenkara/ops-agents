import type { CallAttempt } from "@/lib/call-brief";

// The follow-up email sent the moment a call case goes back to the email loop.
// Unlike the generic no-reply nudge (no-reply-followup.ts), this one exists
// because a call happened. It carries no internal note text; the staging tailor
// trims the ask against the thread so the supplier is not asked to repeat
// themselves.

export interface CallFollowupInput {
  contactName: string | null;
  materialName: string | null;
  callLog: CallAttempt[];
  signoff: string;
}

export function buildCallFollowupBody(opts: CallFollowupInput): string {
  const greeting = opts.contactName ? `Hi ${opts.contactName.split(/\s+/)[0]},` : "Hi there,";
  const mat = opts.materialName ? ` for ${opts.materialName}` : "";

  const reached = opts.callLog.filter((a) => a.outcome === "reached");
  const talkedLine = reached.length
    ? `Thanks for taking the time to talk it through on the phone.`
    : `We tried reaching you by phone to follow up.`;

  // Nothing internal is interpolated here at all. The call log, the operator's
  // de-escalation note and the Granola meeting paste are all internal free text
  // written for us, not for the supplier: one of them shipped "Unable to reach
  // after two call attempts" to a live supplier, and the other two are raw
  // enough that no line filter can make them safe. They stay in the case record
  // for the operator. What the supplier actually needs from this email, the ask,
  // is below, and the staging tailor trims it against the thread so it does not
  // re-ask for anything they already answered.
  const lines = [
    greeting,
    "",
    `${talkedLine} Following up in writing${mat} so we have a record and you have something to reply to when you're ready.`,
  ];
  lines.push(
    "",
    `A quote with price, pack size, lead time, and MOQ would be perfect, and I'm happy to answer any questions.`,
    "",
    "Thanks,",
    opts.signoff
  );
  return lines.join("\n");
}
