"use client";

import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { LeadRichRow, LeadRichHeaders, leadRichColSpan } from "@/components/lead-rich-row";
import { useListFilter, byString, byNumberDesc, byDateDesc } from "@/components/use-list-filter";

export function LeadsList({ rows, canAct }: { rows: any[]; canAct: boolean }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.supplier_name ?? ""} ${r.material_name ?? ""} ${r.grade ?? ""}`,
    searchPlaceholder: "supplier, material, grade…",
    sorts: [
      { value: "confidence", label: "Confidence", compare: byNumberDesc((r: any) => r.confidence_score) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: any) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: any) => r.material_name) },
      { value: "newest", label: "Newest", compare: byDateDesc((r: any) => r.created_at) },
    ],
  });

  return (
    <div className="space-y-3">
      {controls}
      <Table>
        <TableHeader>
          <LeadRichHeaders showOrg={false} />
        </TableHeader>
        <TableBody>
          {filtered.map((r: any) => (
            <LeadRichRow key={r.id} r={r} canAct={canAct} showOrg={false} />
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={leadRichColSpan(false)} className="text-center py-8 text-muted-foreground">
                No leads match.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
