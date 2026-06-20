"use client";

import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { StagedQuoteRow, StagedQuoteHeaders, stagedQuoteColSpan, STAGED_CONF_ORDER } from "@/components/staged-quote-row";
import { useListFilter, byString, byNumberDesc, byDateDesc } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";

export function StagedQuotesList({ rows, canAct, slug = "all" }: { rows: any[]; canAct: boolean; slug?: string }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.supplier_name ?? ""} ${r.material_name ?? ""} ${r.grade ?? ""}`,
    searchPlaceholder: "supplier, material, grade…",
    sorts: [
      {
        value: "confidence",
        label: "Confidence (low first)",
        compare: (a: any, b: any) => (STAGED_CONF_ORDER[a.confidence] ?? 9) - (STAGED_CONF_ORDER[b.confidence] ?? 9),
      },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: any) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: any) => r.material_name) },
      { value: "unit_price", label: "Per-unit price", compare: byNumberDesc((r: any) => -(r.unit_price ?? Infinity)) },
      { value: "newest", label: "Newest", compare: byDateDesc((r: any) => r.created_at) },
    ],
  });

  const csvRows = filtered.map((r: any) => [
    r.supplier_name ?? "",
    r.material_name ?? "",
    r.grade ?? "",
    r.price ?? "",
    r.case_size ?? "",
    r.unit_of_measurement ?? "",
    r.unit_price ?? "",
    r.confidence ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "staged-quotes")}
          headers={["Supplier", "Material", "Grade", "Price", "Case size", "Unit", "Per-unit", "Confidence"]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <StagedQuoteHeaders showOrg={false} />
        </TableHeader>
        <TableBody>
          {filtered.map((r: any) => (
            <StagedQuoteRow key={r.id} r={r} canAct={canAct} showOrg={false} />
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={stagedQuoteColSpan(false)} className="text-center py-8 text-muted-foreground">
                No staged quotes match.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
