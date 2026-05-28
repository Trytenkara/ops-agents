import Link from "next/link";

// Numeric pagination footer for list pages. Renders prev/next + a windowed page
// list (first, last, current ±2). All links carry the existing search params
// with `page` updated. Caller passes the current path + the search-param string
// it wants preserved (excluding `page`).

export function PaginationBar({
  basePath,
  baseQs,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  baseQs: string;            // querystring without `page` (no leading "?")
  page: number;
  pageSize: number;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  function href(p: number) {
    const sp = new URLSearchParams(baseQs);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  const pages = buildPageWindow(page, totalPages);

  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
      <div>
        {total === 0 ? "No results" : `Showing ${from}–${to} of ${total}`}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          {page > 1 ? (
            <Link href={href(page - 1)} className="rounded-md border border-border px-2 py-1 hover:bg-muted">prev</Link>
          ) : (
            <span className="rounded-md border border-dashed border-border px-2 py-1 opacity-50">prev</span>
          )}
          {pages.map((p, i) =>
            p === "…" ? (
              <span key={`gap-${i}`} className="px-1">…</span>
            ) : p === page ? (
              <span key={p} className="rounded-md border border-primary bg-primary text-primary-foreground px-2 py-1 font-medium">
                {p}
              </span>
            ) : (
              <Link key={p} href={href(p)} className="rounded-md border border-border px-2 py-1 hover:bg-muted">
                {p}
              </Link>
            )
          )}
          {page < totalPages ? (
            <Link href={href(page + 1)} className="rounded-md border border-border px-2 py-1 hover:bg-muted">next</Link>
          ) : (
            <span className="rounded-md border border-dashed border-border px-2 py-1 opacity-50">next</span>
          )}
        </div>
      )}
    </div>
  );
}

function buildPageWindow(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const start = Math.max(2, current - 2);
  const end = Math.min(total - 1, current + 2);
  if (start > 2) out.push("…");
  for (let p = start; p <= end; p++) out.push(p);
  if (end < total - 1) out.push("…");
  out.push(total);
  return out;
}
