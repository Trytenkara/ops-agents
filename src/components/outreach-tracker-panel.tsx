import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { OutreachTracker } from "@/lib/outreach-tracker";

// Per-material outreach funnel on the Leads page. Answers the ops question a
// single "material" row can't: how many suppliers were drafted, to whom, how
// many were skipped (and why), and how many drafts QA flagged for review.
export function OutreachTrackerPanel({ tracker }: { tracker: OutreachTracker }) {
  if (tracker.materials.length === 0) return null;
  const t = tracker.totals;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-xl tracking-tight">Outreach tracker</h2>
        <div className="text-xs text-muted-foreground">
          {t.emails} email{t.emails === 1 ? "" : "s"} · {t.suppliers} supplier{t.suppliers === 1 ? "" : "s"}
          {t.qaFlagged > 0 && <> · <span className="text-amber-700 dark:text-amber-400">{t.qaFlagged} QA</span></>}
          {t.manual > 0 && <> · {t.manual} manual</>}
          {t.skipped > 0 && <> · {t.skipped} skipped</>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        What actually happened per material once it entered outreach — drafts staged, who they went to, drafts QA held for
        review, suppliers with no email (handed to an operator), and skipped leads.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Material</TableHead>
            <TableHead className="text-right">Drafts</TableHead>
            <TableHead className="text-right">QA held</TableHead>
            <TableHead className="text-right">Manual (no email)</TableHead>
            <TableHead className="text-right">Skipped</TableHead>
            <TableHead>To whom / notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tracker.materials.map((m) => {
            const skipNote = Object.entries(m.skipReasons)
              .map(([r, n]) => `${n} ${r}`)
              .join(", ");
            return (
              <TableRow key={m.materialId ?? m.materialName} className="align-top">
                <TableCell className="font-medium">{m.materialName}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {m.drafted > 0 ? (
                    <span title={`${m.staged} awaiting review · ${m.progressed} reviewed/sent`}>
                      {m.drafted}
                      {m.staged > 0 && <span className="text-muted-foreground text-xs"> ({m.staged} to review)</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m.qaFlagged > 0 ? (
                    <Badge variant="warn" title="Drafts QA flagged — review before sending.">{m.qaFlagged}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m.manual > 0 ? (
                    <span title="Suppliers with no public email — RFQ handed to an operator to send via the supplier's form.">{m.manual}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {m.skipped > 0 ? m.skipped : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {m.suppliers.length > 0 && (
                    <div className="text-foreground">{m.suppliers.slice(0, 6).join(", ")}{m.suppliers.length > 6 ? ` +${m.suppliers.length - 6}` : ""}</div>
                  )}
                  {skipNote && <div>skipped: {skipNote}</div>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
