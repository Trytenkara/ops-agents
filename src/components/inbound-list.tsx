"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { useListFilter, byString, byDateDesc, byNumberDesc } from "@/components/use-list-filter";

export type InboundRow = {
  id: string;
  subject: string | null;
  status: string;
  createdAt: string | null;
  qaErrors: number;
  qaTotal: number;
  missiveLink: string | null;
};

export function InboundList({ rows, slug }: { rows: InboundRow[]; slug: string }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.subject ?? ""} ${r.status}`,
    searchPlaceholder: "subject, status…",
    sorts: [
      { value: "newest", label: "Newest", compare: byDateDesc((r: InboundRow) => r.createdAt) },
      { value: "qa", label: "Most QA flags", compare: byNumberDesc((r: InboundRow) => r.qaTotal) },
      { value: "subject", label: "Subject (A–Z)", compare: byString((r: InboundRow) => r.subject) },
      { value: "status", label: "Status", compare: byString((r: InboundRow) => r.status) },
    ],
    defaultSort: "newest",
  });

  const csvRows = filtered.map((r) => [
    r.subject ?? "",
    r.qaErrors > 0 ? `${r.qaErrors} to fix` : r.qaTotal > 0 ? `${r.qaTotal} flags` : "clean",
    r.status,
    r.createdAt ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "inbound")}
          headers={["Reply draft", "QA", "Status", "Drafted"]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reply draft</TableHead>
            <TableHead>QA</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Drafted</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="font-medium">{d.subject ?? "(no subject)"}</TableCell>
              <TableCell>
                {d.qaErrors > 0 ? <Badge variant="danger">{d.qaErrors} to fix</Badge> : d.qaTotal > 0 ? <Badge variant="warn">{d.qaTotal}</Badge> : <span className="text-xs text-muted-foreground">clean</span>}
              </TableCell>
              <TableCell><Badge variant="secondary">{d.status}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.createdAt)}</TableCell>
              <TableCell>
                {d.missiveLink ? <a href={d.missiveLink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-sm">Open in Missive ↗</a> : "—"}
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No inbound reply drafts match.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
