// PERS-06. The accidental thousand-row cut is caught by the truncation guard,
// which waves through anything carrying an explicit `.limit()` on the grounds
// that the caller asked for it. That is the remaining hole: a deliberate window
// is invisible in exactly the same way an accidental one is, because nothing
// downstream is told how much was left outside it.
//
// A cap is allowed. A cap nobody is told about is not. PostgREST will return
// the true matching count on the SAME request as the capped page, so there is
// no second query and no excuse:
//
//   const cases = await cappedRead(
//     admin.from("cases").select("*", { count: "exact" }).eq(...).order("created_at").limit(CAP),
//     CAP,
//     "open cases",
//   );
//   await ctx.log(cases.note);          // "50 of 312 open cases this run - 262 more waiting"
//   for (const row of cases.rows) ...

export type CappedRead<T> = {
  rows: T[];
  /** Rows matching the filters, ignoring the cap. */
  total: number;
  remainder: number;
  capped: boolean;
  /** Ready to drop into a log line or a run summary. Never silent. */
  note: string;
};

type CountedResult<T> = { data: T[] | null; error: unknown; count: number | null };

/**
 * Run a capped read and carry the remainder out with it. The query must be
 * built with `{ count: "exact" }`; a missing count throws rather than reporting
 * a remainder of zero, because "nothing was left behind" is the one answer this
 * helper must never invent.
 */
export async function cappedRead<T>(
  query: PromiseLike<CountedResult<T>>,
  cap: number,
  what: string
): Promise<CappedRead<T>> {
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? [];
  if (count === null || count === undefined) {
    throw new Error(
      `cappedRead("${what}") got no count back. Build the query with ` +
        `.select(..., { count: "exact" }) so the remainder comes back on the same request.`
    );
  }
  return { rows, total: count, ...remainder(rows.length, count, what) };
}

/**
 * The reporting half on its own, for a worklist that was capped in JS after the
 * read (a per-run budget, a time budget) rather than in the query.
 */
export function remainderNote(taken: number, total: number, what: string): string {
  return remainder(taken, total, what).note;
}

function remainder(
  taken: number,
  total: number,
  what: string
): { remainder: number; capped: boolean; note: string } {
  const left = Math.max(total - taken, 0);
  return {
    remainder: left,
    capped: left > 0,
    note: left > 0
      ? `${taken} of ${total} ${what} this run - ${left} more waiting`
      : `${total} ${what}, all of them`,
  };
}
