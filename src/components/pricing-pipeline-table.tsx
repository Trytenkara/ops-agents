import Link from "next/link";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { PIPELINE_STAGES, type PipelineData } from "@/lib/pricing-pipeline";

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PricingPipelineTable({ data, emptyReason }: { data: PipelineData; emptyReason?: string }) {
  const { threads, counts } = data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {PIPELINE_STAGES.map((s) => (
          <div key={s.key} className="rounded-md border px-3 py-2 text-sm">
            <div className="font-medium tabular-nums">{counts[s.key] ?? 0}</div>
            <div className="text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      {threads.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
          {emptyReason ?? "No tracked threads yet. They appear here once outreach is staged."}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead>Materials</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last update</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {threads.map((t) => (
              <TableRow key={t.threadId}>
                <TableCell className="font-medium">{t.supplier}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {t.materials.slice(0, 4).join(", ")}
                  {t.materials.length > 4 ? ` +${t.materials.length - 4}` : ""}
                </TableCell>
                <TableCell>
                  <span className="rounded-full border px-2 py-0.5 text-xs">
                    {PIPELINE_STAGES.find((s) => s.key === t.status)?.label ?? t.status}
                  </span>
                  {t.lastNote ? <div className="mt-1 text-xs text-muted-foreground">{t.lastNote}</div> : null}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{relTime(t.updatedAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-3 text-sm">
                    <Link href={`/work/drafts/${t.draftRefId}`} className="underline">
                      Open
                    </Link>
                    {t.draftLink ? (
                      <a href={t.draftLink} target="_blank" rel="noreferrer" className="underline">
                        Missive
                      </a>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
