// PostgREST caps a response at 1000 rows and reports no error when it truncates,
// so any read that can exceed that has to page explicitly. A truncated read that
// feeds a dedup guard is the worst case: it silently re-creates everything past
// the cap on every run (see migration 0075).
//
// The paged query MUST carry a stable total order (append `.order("id")`), or
// rows shift between pages and get skipped or repeated.
export async function selectAllPaged<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}
