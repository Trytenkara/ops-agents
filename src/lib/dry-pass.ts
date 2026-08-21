// A pass that returned nothing has three possible meanings, not two, and the
// bug PERS-03 describes is always the same one: two of them get collapsed.
//
//   found — the source answered and named something
//   dry   — the source answered and named nothing. Retryable, bounded.
//   infra — the source did not answer. Costs nothing and writes nothing.
//
// Collapsing infra into dry burns a real attempt on an outage. Collapsing dry
// into found writes "searched, nothing here" on a single zero and never looks
// again. Nine sites did one or the other; they now share this.
//
// The shape is lifted from the one source that already had it right — Agent
// 01's SourceReady counter — so this is that code moved, not a new idea.

export type PassOutcome = "found" | "dry" | "infra";

/** Three outcomes, never two. `infra` wins: an outage is not a reading. */
export function passOutcome(found: boolean, infra: boolean): PassOutcome {
  if (infra) return "infra";
  return found ? "found" : "dry";
}

// PERS-04: a retry bound is a spend control and has to be named where it can be
// read, not buried at its call site. Every cross-run dry-pass bound in the
// fleet is here.
export const DRY_PASS_LIMITS = {
  /** Agent 01 SourceReady search, per material. */
  sourceready_search: 3,
  /** Agent 05 aggregator index page: no readable sellers on it. */
  aggregator_index: 3,
  /** Agent 06 supplier web fill: site read, no fields printed. */
  supplier_web_fill: 3,
  /** Agent 09 document page: page read, no documents on it. */
  document_page: 3,
  /** Trade-alias resolution for a material, shared by all three sources. */
  material_aliases: 3,
} as const;

export type DryPassBound = keyof typeof DRY_PASS_LIMITS;

export type DryPassState = { dry: number; done: boolean };

/**
 * Advance a bounded dry-pass counter. `persist: false` means write nothing —
 * an infrastructure failure must leave the record exactly as it found it, or
 * an outage silently spends the retries a real zero is entitled to.
 */
export function advanceDryPass(
  prior: DryPassState | null | undefined,
  outcome: PassOutcome,
  bound: DryPassBound
): DryPassState & { persist: boolean } {
  const priorDry = prior?.dry ?? 0;
  if (outcome === "infra") return { dry: priorDry, done: prior?.done ?? false, persist: false };
  if (outcome === "found") return { dry: priorDry, done: true, persist: true };
  const dry = priorDry + 1;
  return { dry, done: dry >= DRY_PASS_LIMITS[bound], persist: true };
}

/**
 * The cooldown form, for sites that re-attempt on a clock rather than count to
 * a limit. The ladder lengthens but never ends: a miss is never terminal.
 */
export function retryAfter(missCount: number, ladderDays: readonly number[]): string {
  const days = ladderDays[Math.min(Math.max(missCount, 1) - 1, ladderDays.length - 1)];
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/**
 * A 200 is not a success. Upstreams report failures as an ordinary response
 * whose body is an error envelope, or rename the field the rows arrive in; both
 * parse to an empty array and read as "this market is empty". Demand the field
 * and treat its absence as the outage it is.
 */
export function rowsOrThrow(body: any, field: string, source: string): any[] {
  const rows = body?.[field];
  if (Array.isArray(rows)) return rows;
  const detail =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : `no "${field}" array in the response (keys: ${Object.keys(body ?? {}).join(", ") || "none"})`;
  throw new Error(`${source} returned no readable rows: ${detail}`);
}
