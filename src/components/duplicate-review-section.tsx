"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/utils";
import { resolveDuplicateLead, type DuplicateVerdict } from "@/app/actions/duplicate-review";

export interface DuplicateReviewRow {
  leadId: string;
  supplierName: string;
  materialName: string | null;
  domain: string;
  existingNames: string[];
  website: string | null;
  parkedAt: string | null;
  reason: string | null;
  canonicalName: string | null;
}

export function DuplicateReviewSection({ rows, canAct }: { rows: DuplicateReviewRow[]; canAct: boolean }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = (leadId: string, verdict: DuplicateVerdict) => {
    setBusy(leadId);
    setError(null);
    startTransition(async () => {
      const res = await resolveDuplicateLead(leadId, verdict);
      if (!res.ok) setError(res.error);
      setBusy(null);
    });
  };

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No possible duplicates waiting. New ones appear here within 20 minutes.</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        These leads are held back because the company looks like a supplier this client already has, or like another
        lead waiting next to it. Nothing is sent and no supplier record is created while a lead sits here. Three ways
        out: <strong>Same, keep both</strong> renames this lead to the existing supplier so it attaches to that record
        instead of making a second one (use this when the lead has a material the supplier does not),{" "}
        <strong>Same, drop it</strong> throws the lead away, and <strong>Different</strong> puts it straight back into
        the pipeline.
      </p>
      {error && <p className="text-sm text-destructive">Could not save that: {error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>New lead</TableHead>
            <TableHead>Already a supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Held</TableHead>
            <TableHead className="text-right">Same company?</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.leadId}>
              <TableCell className="font-medium align-top">
                <div>{r.supplierName}</div>
                {r.website ? (
                  <Link
                    href={r.website.startsWith("http") ? r.website : `https://${r.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary underline hover:no-underline"
                  >
                    {r.domain} ↗
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">{r.domain}</span>
                )}
              </TableCell>
              <TableCell className="align-top text-sm">
                {r.existingNames.map((n) => (
                  <div key={n}>{n}</div>
                ))}
                {r.reason && <div className="text-xs text-muted-foreground">{r.reason}</div>}
              </TableCell>
              <TableCell className="align-top text-sm text-muted-foreground">{r.materialName ?? "—"}</TableCell>
              <TableCell className="align-top text-xs text-muted-foreground">
                {r.parkedAt ? relativeTime(r.parkedAt) : "—"}
              </TableCell>
              <TableCell className="text-right align-top">
                {canAct ? (
                  <div className="inline-flex gap-2">
                    {r.canonicalName && (
                      <Button
                        size="sm"
                        variant="outline"
                        title={`Rename this lead to "${r.canonicalName}" and release it`}
                        disabled={pending && busy === r.leadId}
                        onClick={() => decide(r.leadId, "merge")}
                      >
                        Same, keep both
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending && busy === r.leadId}
                      onClick={() => decide(r.leadId, "same")}
                    >
                      Same, drop it
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending && busy === r.leadId}
                      onClick={() => decide(r.leadId, "different")}
                    >
                      Different
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">View only</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
