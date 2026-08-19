import { CALL_OUTCOMES, type CallOutcome } from "@/lib/call-brief";

// The whole of "take back the last logged outcome", as one pure function so it
// can be proved without a live session: what the case metadata and status become
// once the most recent attempt comes off.
export function undoLastAttemptPatch(
  metadata: Record<string, any>,
  status: string | null
): { patch: Record<string, any>; undone: any; reopened: boolean } | null {
  const callLog: any[] = Array.isArray(metadata.call_log) ? metadata.call_log : [];
  if (!callLog.length) return null;
  const last = callLog[callLog.length - 1];
  const remaining = callLog.slice(0, -1);

  // Put back whatever that outcome changed. A misclicked "wrong number" wiped
  // the phone, and an undo that leaves the supplier unreachable is not an undo.
  const brief = metadata.call_brief ? { ...(metadata.call_brief as Record<string, any>) } : null;
  if (brief && last.outcome === "wrong_number" && last.prev_phone) {
    brief.contact = { ...(brief.contact ?? {}), phone: last.prev_phone, phoneSource: last.prev_phone_source ?? null };
    brief.phoneStatus = last.prev_phone_status ?? "ok";
  }

  const patch: Record<string, any> = {
    metadata: { ...metadata, call_log: remaining, ...(brief ? { call_brief: brief } : {}) },
  };
  // A terminal outcome is what closed the task, so undoing it reopens it;
  // otherwise the supplier stays closed with no outcome against them.
  const reopened = status === "resolved" && !!CALL_OUTCOMES[last.outcome as CallOutcome]?.terminal;
  if (reopened) {
    patch.status = remaining.length ? "in_progress" : "open";
    patch.resolved_at = null;
    patch.resolution_note = null;
  }
  return { patch, undone: last, reopened };
}
