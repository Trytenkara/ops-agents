"use client";

import { useState } from "react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useListFilter, byString, byNumberDesc, byDateDesc } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { cn } from "@/lib/utils";

// The Quote board section of the Platform Extraction tab. Read/pull surface:
// every field the pipeline extracted from supplier replies + attachments,
// including the structured lead time / MOQ / payment terms added in migration
// 0042. Each row has a Copy button that yields a tab-separated line Evan pastes
// straight into Tenkara. Nothing here writes back — it's a source to pull from.

const CONF_ORDER: Record<string, number> = { needs_review: 0, low: 1, medium: 2, high: 3 };

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function leadTime(r: any): string {
  if (r.lead_time_days != null) return `${r.lead_time_days} d`;
  if (r.lead_time_text) return r.lead_time_text;
  return "—";
}

function moq(r: any): string {
  if (r.moq_quantity == null) return "—";
  return `${fmt(r.moq_quantity)}${r.moq_unit ? " " + r.moq_unit : ""}`;
}

// One tab-separated line for pasting into a Tenkara quote/supplier row. Order
// mirrors the visible columns so what you copy is what you see.
function pullLine(r: any): string {
  return [
    r.supplier_name ?? "",
    r.material_name ?? "",
    r.grade ?? "",
    r.unit_price ?? "",
    r.currency ?? "",
    r.case_size ?? "",
    r.unit_of_measurement ?? "",
    r.lead_time_days ?? "",
    r.moq_quantity ?? "",
    r.moq_unit ?? "",
    r.payment_terms ?? "",
  ].join("\t");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className={cn(
        "rounded-md border border-border px-2 py-1 text-xs transition-colors",
        copied ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      )}
      title="Copy this row as a tab-separated line to paste into Tenkara"
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

export function ExtractionQuoteBoard({ rows, slug, showDocs = false }: { rows: any[]; slug: string; showDocs?: boolean }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r: any) => `${r.supplier_name ?? ""} ${r.material_name ?? ""} ${r.grade ?? ""} ${r.payment_terms ?? ""}`,
    searchPlaceholder: "supplier, material, grade, terms…",
    sorts: [
      { value: "newest", label: "Newest", compare: byDateDesc((r: any) => r.created_at) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: any) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: any) => r.material_name) },
      { value: "unit_price", label: "Per-unit price", compare: byNumberDesc((r: any) => -(r.unit_price ?? Infinity)) },
      {
        value: "confidence",
        label: "Confidence (low first)",
        compare: (a: any, b: any) => (CONF_ORDER[a.confidence] ?? 9) - (CONF_ORDER[b.confidence] ?? 9),
      },
    ],
  });

  const csvRows = filtered.map((r: any) => [
    r.supplier_name ?? "",
    r.material_name ?? "",
    r.grade ?? "",
    r.unit_price ?? "",
    r.currency ?? "",
    r.case_size ?? "",
    r.unit_of_measurement ?? "",
    r.lead_time_days ?? "",
    r.lead_time_text ?? "",
    r.moq_quantity ?? "",
    r.moq_unit ?? "",
    r.payment_terms ?? "",
    r.confidence ?? "",
    r.status ?? "",
    ...(showDocs ? [Array.isArray(r._missing_docs) && r._missing_docs.length ? `Missing: ${r._missing_docs.join(", ")}` : "OK"] : []),
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "platform-extraction")}
          headers={[
            "Supplier",
            "Material",
            "Grade",
            "Per-unit",
            "Currency",
            "Case size",
            "Unit",
            "Lead time (days)",
            "Lead time (raw)",
            "MOQ",
            "MOQ unit",
            "Payment terms",
            "Confidence",
            "Status",
            ...(showDocs ? ["Qualification docs"] : []),
          ]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Grade</TableHead>
            <TableHead className="text-right">Per-unit</TableHead>
            <TableHead className="text-right">Pack</TableHead>
            <TableHead>Lead time</TableHead>
            <TableHead>MOQ</TableHead>
            <TableHead>Payment terms</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Conf.</TableHead>
            <TableHead>Status</TableHead>
            {showDocs && <TableHead>Docs</TableHead>}
            <TableHead className="text-right">Pull</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((r: any) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium align-top">
                {r.supplier_name ?? <span className="text-destructive">— missing —</span>}
              </TableCell>
              <TableCell className="align-top">
                {r.material_name ?? <span className="text-destructive">— missing —</span>}
              </TableCell>
              <TableCell className="align-top text-sm">
                {r.grade ? (
                  <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs">{r.grade}</span>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
              <TableCell className="text-right align-top">
                {r.unit_price != null ? (
                  <span>
                    {fmt(r.unit_price)}
                    {r.currency && r.currency !== "USD" && <span className="ml-1 text-xs text-muted-foreground">{r.currency}</span>}
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="text-right align-top text-sm">
                {r.case_size != null ? `${fmt(r.case_size)} ${r.unit_of_measurement ?? ""}`.trim() : "—"}
              </TableCell>
              <TableCell className="align-top text-sm" title={r.lead_time_text ?? undefined}>
                {leadTime(r)}
              </TableCell>
              <TableCell className="align-top text-sm">{moq(r)}</TableCell>
              <TableCell className="align-top text-sm">
                {r.payment_terms ?? <span className="text-muted-foreground text-xs">—</span>}
              </TableCell>
              <TableCell className="align-top text-xs text-muted-foreground">
                {r.source === "attachment" ? r.source_attachment_name ?? "attachment" : "email body"}
              </TableCell>
              <TableCell className="align-top text-xs">{(r.confidence ?? "").replace("_", " ") || "—"}</TableCell>
              <TableCell className="align-top text-xs">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5",
                    r.status === "approved" ? "bg-emerald-500/10 text-emerald-600" : "bg-secondary text-muted-foreground"
                  )}
                >
                  {(r.status ?? "").replace("_", " ") || "—"}
                </span>
              </TableCell>
              {showDocs && (
                <TableCell className="align-top text-xs">
                  {Array.isArray(r._missing_docs) && r._missing_docs.length > 0 ? (
                    <span className="text-destructive">Missing: {r._missing_docs.join(", ")}</span>
                  ) : (
                    <span className="text-emerald-600">✓</span>
                  )}
                </TableCell>
              )}
              <TableCell className="text-right align-top">
                <CopyButton text={pullLine(r)} />
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={showDocs ? 13 : 12} className="text-center py-8 text-muted-foreground">
                No extracted quotes yet. Supplier replies and price sheets land here as the agents process them.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
