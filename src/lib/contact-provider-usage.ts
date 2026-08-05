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
  // Circuit breaker: a `quota` outcome means the provider's credit pool is dry
  // (429 rate-cap or 402 insufficient-credits). Every further call this run just
  // 402s for free but wastes wall-clock and a claim slot, so trip the provider
  // and let the waterfall fall straight through to the next one. `auth` is left
  // out on purpose: ZoomInfo 401s on its search leg while its enrich leg still
  // bills successfully, so an auth failure is not reliably terminal.
  if (call.outcome === "quota") tripped.add(call.provider);
  buffer.push(call);
  if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
}

export function drainContactApiCalls(): ContactApiCall[] {
  return buffer.splice(0, buffer.length);
}

// Per-run circuit breaker for exhausted providers. Warm serverless lambdas keep
// module state across invocations, so this is reset explicitly at the start of
// each Agent 06 run (see the enrichment runner) rather than living for the life
// of the process — otherwise a provider tripped one run stays dark forever, even
// after credits refill.
const tripped = new Set<ContactProvider>();

export function isContactProviderTripped(provider: ContactProvider): boolean {
  return tripped.has(provider);
}

export function resetContactProviderBreaker(): void {
  tripped.clear();
}
