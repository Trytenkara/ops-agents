"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type WorkType = "drafts" | "quotes" | "changes" | "cases" | "leads";

export interface ClientRow {
  slug: string;
  name: string;
  drafts: number;
  quotes: number;
  changes: number;
  cases: number;
  leads: number;
  total: number;
  oldestDays: number;
}

const CARDS: { key: WorkType; label: string; tone: string; ring: string }[] = [
  { key: "drafts", label: "Drafts to review", tone: "text-blue-700", ring: "ring-blue-400" },
  { key: "quotes", label: "Quotes to approve", tone: "text-emerald-700", ring: "ring-emerald-400" },
  { key: "changes", label: "Price changes", tone: "text-amber-700", ring: "ring-amber-400" },
  { key: "cases", label: "Open cases", tone: "text-red-700", ring: "ring-red-400" },
  { key: "leads", label: "Leads ready", tone: "text-teal-700", ring: "ring-teal-400" },
];

const COLS: { key: WorkType; label: string }[] = [
  { key: "drafts", label: "Drafts" },
  { key: "quotes", label: "Quotes" },
  { key: "changes", label: "Price changes" },
  { key: "cases", label: "Cases" },
  { key: "leads", label: "Leads" },
];

// Deep-link a filtered row straight to the tab where that work lives.
const TYPE_TAB: Record<WorkType, string> = {
  drafts: "/threads",
  quotes: "/quotes",
  changes: "/price-changes",
  cases: "/cases",
  leads: "/leads",
};

export function HomeBoard({ counts, rows }: { counts: Record<WorkType, number>; rows: ClientRow[] }) {
  const [active, setActive] = useState<WorkType | null>(null);

  const visible = (active ? rows.filter((r) => r[active] > 0) : rows).slice().sort((a, b) =>
    active ? b[active] - a[active] : b.total - a.total
  );

  return (
    <div className="space-y-6">
      {/* Quick-View cards — click to filter the table below by type. */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {CARDS.map((c) => {
          const value = counts[c.key];
          const isActive = active === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setActive(isActive ? null : c.key)}
              className={cn(
                "text-left rounded-lg border border-border bg-background py-4 px-4 transition-all hover:border-foreground/30",
                isActive && `ring-2 ${c.ring} border-transparent`
              )}
            >
              <div className={cn("text-3xl font-serif", value > 0 ? c.tone : "text-muted-foreground")}>{value}</div>
              <div className="text-xs text-muted-foreground mt-1">{c.label}</div>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        <div className="flex flex-row items-center justify-between">
          <h3 className="text-sm uppercase tracking-wider text-muted-foreground font-medium">
            Clients needing attention
            {active && <span className="ml-2 normal-case tracking-normal text-foreground">· {CARDS.find((c) => c.key === active)?.label}</span>}
          </h3>
          {active && (
            <button type="button" onClick={() => setActive(null)} className="text-xs text-primary hover:underline">
              Clear filter
            </button>
          )}
        </div>
        <div>
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting across your clients right now. 🎣</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  {COLS.map((col) => (
                    <TableHead key={col.key} className={cn("text-right", active === col.key && "text-foreground")}>{col.label}</TableHead>
                  ))}
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Oldest</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.slug}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    {COLS.map((col) => (
                      <TableCell
                        key={col.key}
                        className={cn(
                          "text-right",
                          r[col.key] > 0 ? "text-foreground" : "text-muted-foreground/40",
                          active === col.key && "font-semibold"
                        )}
                      >
                        {r[col.key] || "—"}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-semibold">{r.total}</TableCell>
                    <TableCell className={cn("text-right text-sm", r.oldestDays >= 7 ? "text-red-700 font-medium" : "text-muted-foreground")}>
                      {r.oldestDays === 0 ? "today" : `${r.oldestDays}d`}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/work/orgs/${r.slug}${active ? TYPE_TAB[active] : ""}`}
                        className="text-primary hover:underline text-sm"
                      >
                        Open →
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
