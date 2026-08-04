// Call-level journal for the paid contact providers (Hunter, LeadMagic,
// ZoomInfo, GetProspect).
//
// Every provider lib soft-fails to null by design, so a quota-exhausted
// provider is indistinguishable from a genuine miss at the call site: the
// waterfall just falls through to the next (more expensive) provider. Hunter
// burned its whole monthly allowance on 2026-07-31 and every lookup silently
// went to ZoomInfo for four days before anyone noticed. This journal is what
// makes that visible.
//
// The libs push a record per call; run-enrich drains the buffer after each lead
// and writes the records to agent_run_events, which Settings > "API usage &
// cost" aggregates. Draining is best-effort: a record that never reaches the DB
// costs us a log line, never a lead.

export type ContactProvider = "hunter" | "leadmagic" | "zoominfo" | "getprospect";

// hit/miss are normal operation (a miss is free on every provider we use).
// quota/auth/error are the states that must never be mistaken for a miss.
export type ContactCallOutcome = "hit" | "miss" | "quota" | "auth" | "error";

export interface ContactApiCall {
  provider: ContactProvider;
  outcome: ContactCallOutcome;
  // Best estimate of billable units this call consumed, in the provider's own
  // unit (Hunter: emails revealed; ZoomInfo: contacts enriched; LeadMagic:
  // credits; GetProspect: emails found). Zero on a miss or failure.
  units: number;
  domain: string | null;
  detail?: string | null;
}

// Bounded so a caller that never drains (a skill, a one-off script) can't grow
// this without limit. Oldest records are dropped first.
const MAX_BUFFERED = 500;
const buffer: ContactApiCall[] = [];

export function recordContactApiCall(call: ContactApiCall): void {
  buffer.push(call);
  if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
}

export function drainContactApiCalls(): ContactApiCall[] {
  return buffer.splice(0, buffer.length);
}
