import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FlaggedGroup } from "@/lib/flagged-work";

// The home UI-06 asks for: everything the fleet flagged for a person on this
// client, in one place, each row carrying the reason it was flagged.
//
// Nothing here names a set. The groups arrive from FLAGGED_SETS and are
// rendered whatever they are, so a new kind of flag cannot be added to the
// registry and then quietly left off the screen.

function when(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function FlaggedWorkPanel({ groups }: { groups: FlaggedGroup[] }) {
  const live = groups.filter((g) => g.total !== 0);
  return (
    <Card className="tb-surface shadow-none">
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Flagged for a person</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing is flagged. Prices the fleet could not publish, quotes captured without a figure and untested contact
            addresses all appear here with the reason they were held back.
          </p>
        ) : (
          live.map((g) => (
            <details key={g.key} className="rounded-md border border-border">
              <summary className="flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2">
                <span className="text-sm font-medium text-foreground">
                  {g.label}
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">{g.rule}</span>
                </span>
                <span className="text-sm font-serif text-amber-600 dark:text-amber-400">
                  {g.total < 0 ? "unknown" : g.total}
                </span>
              </summary>
              <div className="space-y-2 border-t border-border px-3 py-3">
                <p className="text-xs text-muted-foreground">{g.description}</p>
                <ul className="space-y-1.5">
                  {g.items.map((i) => (
                    <li key={i.id} className="text-xs">
                      <span className="font-medium text-foreground">{i.title}</span>
                      {when(i.at) && <span className="ml-2 text-muted-foreground">{when(i.at)}</span>}
                      <span className="block text-muted-foreground">{i.reason}</span>
                    </li>
                  ))}
                </ul>
                {g.total > g.items.length && (
                  <p className="text-xs text-muted-foreground">
                    Showing {g.items.length} of {g.total}.
                  </p>
                )}
                <Link href={g.href} className="inline-block text-xs text-primary hover:underline">
                  Go to where these are fixed →
                </Link>
              </div>
            </details>
          ))
        )}
      </CardContent>
    </Card>
  );
}
