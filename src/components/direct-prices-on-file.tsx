"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { useListFilter, byString, byDateDesc } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";

export type DirectPriceRow = {
  id: string;
  supplierName: string | null;
  materialName: string | null;
  price: number | null;
  unitPrice: number | null;
  unitOfMeasurement: string | null;
  currency: string | null;
  grade: string | null;
  status: string | null;
  createdAt: string | null;
  caseDims: string | null;
};

function fmtPrice(r: DirectPriceRow): string {
  if (r.unitPrice != null) return `${r.currency ?? "USD"} ${r.unitPrice.toFixed(2)}/${r.unitOfMeasurement ?? "unit"}`;
  if (r.price != null) return `${r.currency ?? "USD"} ${r.price}`;
  return "";
}

// Current direct-supplier prices we already hold (from staged_quotes) that
// aren't tied to an open re-quote draft. These are the "price on file" for
// non-marketplace suppliers — shown so the Live Price Index reflects current
// prices, not only re-quotes in flight.
export function DirectPricesOnFile({ rows, slug }: { rows: DirectPriceRow[]; slug: string }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.supplierName ?? ""} ${r.materialName ?? ""}`,
    searchPlaceholder: "supplier or material…",
    sorts: [
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: DirectPriceRow) => r.supplierName) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: DirectPriceRow) => r.materialName) },
      { value: "newest", label: "Newest", compare: byDateDesc((r: DirectPriceRow) => r.createdAt) },
    ],
    defaultSort: "supplier",
  });

  const csvRows = filtered.map((r) => [
    r.supplierName ?? "",
    r.materialName ?? "",
    fmtPrice(r),
    r.caseDims ?? "",
    r.grade ?? "",
    r.status ?? "",
    r.createdAt ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "direct-prices-on-file")}
          headers={["Supplier", "Material", "Price", "Case dims", "Grade", "Status", "Captured"]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead className="text-right">Price on file</TableHead>
            <TableHead>Case dims</TableHead>
            <TableHead>Grade</TableHead>
            <TableHead>Captured</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">{r.supplierName ?? "—"}</TableCell>
              <TableCell>{r.materialName ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                <div className="flex flex-col items-end gap-0.5">
                  <span className="font-medium text-foreground">{fmtPrice(r) || "—"}</span>
                  {r.status && r.status !== "approved" && (
                    <Badge variant="secondary" title="Captured from a supplier reply — review under Materials.">
                      {r.status === "pending_review" ? "pending review" : r.status}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-xs">
                {r.caseDims ? (
                  <span className="inline-flex flex-col gap-0.5">
                    <span>{r.caseDims}</span>
                    <span
                      className="inline-flex w-fit items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      title="AI-estimated dimensions — verify before freight quoting"
                    >
                      AI estimate
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{r.grade ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(r.createdAt)}</TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No direct prices on file yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
