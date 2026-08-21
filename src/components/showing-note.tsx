// PERS-06 on a page. A list capped at 50 looks exactly like a list of 50, and
// the operator works the slice believing it is the whole queue. Where a page
// windows a read, it says so here, with the true count and what is missing.

export function ShowingNote({
  shown,
  total,
  noun,
  hint,
}: {
  shown: number;
  total: number | null | undefined;
  noun: string;
  hint?: string;
}) {
  const count = total ?? shown;
  const left = Math.max(count - shown, 0);
  if (left <= 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Showing {shown} of {count} {noun} — {left} more not listed here.
      {hint ? ` ${hint}` : ""}
    </p>
  );
}
