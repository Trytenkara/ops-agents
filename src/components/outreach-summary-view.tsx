"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { DraftStatusBadge } from "@/components/draft-status-badge";
import { relativeTime, cn } from "@/lib/utils";
import type { OutreachTracker } from "@/lib/outreach-tracker";
import type { ThreadRow } from "@/components/threads-list";

interface Props {
  tracker: OutreachTracker;
  threads: ThreadRow[];
  slug: string;
}

export function OutreachSummaryView({ tracker, threads, slug }: Props) {
  const [expandedMaterial, setExpandedMaterial] = useState<string | null>(null);

  const threadsByMaterial = useMemo(() => {
    const map = new Map<string, ThreadRow[]>();
    for (const t of threads) {
      if (!t.materialId && !t.materialName) continue;
      const key = t.materialId ?? `name:${(t.materialName ?? "").toLowerCase()}`;
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return map;
  }, [threads]);

  const t = tracker.totals;

  const csvHeaders = ["Material", "Drafts", "Awaiting review", "QA held", "Manual (no email)", "Skipped", "Skip reasons", "Suppliers"];
  const csvRows = tracker.materials.map((m) => [
    m.materialName,
    m.drafted,
    m.staged,
    m.qaFlagged,
    m.manual,
    m.skipped,
    Object.entries(m.skipReasons).map(([r, n]) => `${n} ${r}`).join("; "),
    m.suppliers.join("; "),
  ]);

  if (tracker.materials.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No outreach activity yet. Once outreach runs for this client, drafts, skipped leads, and manual cases show up here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {t.emails} email{t.emails === 1 ? "" : "s"} · {t.suppliers} supplier{t.suppliers === 1 ? "" : "s"}
          {t.qaFlagged > 0 && <> · <span className="text-amber-700 dark:text-amber-400">{t.qaFlagged} QA</span></>}
          {t.manual > 0 && <> · {t.manual} manual</>}
          {t.skipped > 0 && <> · {t.skipped} skipped</>}
        </div>
        <ListCsvButton filename={filenameFor(slug, "outreach-summary")} headers={csvHeaders} rows={csvRows} />
      </div>
      <p className="text-xs text-muted-foreground">
        Per-material outreach summary. Expand a material to see each supplier thread. Click a supplier to open the draft.
      </p>
      {tracker.marketplace.total > 0 && (
        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
          <span className="font-medium">Marketplace suppliers ({tracker.marketplace.total}):</span>{" "}
          {tracker.marketplace.emailed} emailed · {tracker.marketplace.manual} handed to operator
          {tracker.marketplace.needsPull > 0 && <> · <span className="text-amber-700 dark:text-amber-400">{tracker.marketplace.needsPull} need manual price pull</span></>}
          {tracker.marketplace.pending > 0 && <> · {tracker.marketplace.pending} pending</>}
        </div>
      )}

      <div className="space-y-1.5">
        {tracker.materials.map((m) => {
          const key = m.materialId ?? `name:${m.materialName.toLowerCase()}`;
          const isExpanded = expandedMaterial === key;
          const materialThreads = threadsByMaterial.get(key) ?? [];
          const skipNote = Object.entries(m.skipReasons).map(([r, n]) => `${n} ${r}`).join(", ");

          return (
            <div key={key} className="rounded-lg border bg-card overflow-hidden">
              <div
                className="flex items-center justify-between px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors"
                onClick={() => setExpandedMaterial(isExpanded ? null : key)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-muted-foreground">{isExpanded ? "v" : ">"}</span>
                  <span className="font-medium text-sm">{m.materialName}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  {m.drafted > 0 && (
                    <span className="tabular-nums">
                      {m.drafted} draft{m.drafted !== 1 ? "s" : ""}
                      {m.staged > 0 && <span className="text-muted-foreground"> ({m.staged} to review)</span>}
                    </span>
                  )}
                  {m.qaFlagged > 0 && <Badge variant="warn">{m.qaFlagged} QA</Badge>}
                  {m.manual > 0 && <span className="text-muted-foreground">{m.manual} manual</span>}
                  {m.skipped > 0 && <span className="text-muted-foreground">{m.skipped} skipped</span>}
                  <span className="text-muted-foreground">
                    {m.suppliers.length} supplier{m.suppliers.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t px-4 py-3 space-y-2 bg-muted/20">
                  {materialThreads.length > 0 ? (
                    <div className="space-y-1">
                      {materialThreads.map((thread) => (
                        <Link
                          key={thread.id}
                          href={`/work/drafts/${thread.id}`}
                          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent/60 transition-colors group"
                        >
                          <Badge variant={thread.kind === "inbound" ? "success" : "default"} className="shrink-0">
                            {thread.kind === "inbound" ? "Reply" : "RFQ"}
                          </Badge>
                          <span className="font-medium truncate flex-1" title={thread.supplierName ?? undefined}>
                            {thread.supplierName ?? "Unknown supplier"}
                          </span>
                          {thread.quoteRef && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              Quote {thread.quoteRef}
                            </span>
                          )}
                          <DraftStatusBadge status={thread.status} reviewerName={thread.reviewerName} />
                          <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                            {relativeTime(thread.createdAt)}
                          </span>
                          <span className="text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0">Open</span>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground py-1">
                      {m.suppliers.length > 0
                        ? `Suppliers: ${m.suppliers.join(", ")}`
                        : "No threads found for this material."}
                    </p>
                  )}
                  {skipNote && (
                    <p className="text-xs text-muted-foreground">Skipped: {skipNote}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
