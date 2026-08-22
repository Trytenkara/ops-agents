/**
 * A bounded-concurrency walk over a worklist that always knows when to stop.
 *
 * PERS-09. A run whose length is set by the size of a worklist rather than by
 * the code is as long as the worklist, and being killed by the platform is not
 * a stopping condition: the run is recorded as `function timed out before
 * completion` with no counts, so the work it did do is invisible and the next
 * run has no idea where to pick up. The thread owner sync overran on 2026-08-20
 * exactly this way.
 *
 * `stop` is REQUIRED rather than optional, which is the whole point of this
 * module. There were two private copies of this helper; one took a stop
 * predicate and one did not, and the one that did not was the paced Tenkara
 * mirror in the org reset. Making the parameter mandatory means the next
 * per-item push loop cannot be written without answering the question. A caller
 * that genuinely cannot run out of time passes `NEVER_STOPS` and says why.
 *
 * Returns the items that were never started, so a sweep that ran out of time
 * reports the remainder instead of the caller inferring it.
 */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  stop: () => boolean
): Promise<T[]> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        if (stop()) return;
        await fn(items[next++]);
      }
    })
  );
  return items.slice(next);
}

/** For a worklist bounded by something other than the clock. Say why at the call site. */
export const NEVER_STOPS = () => false;
