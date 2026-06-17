"use client";

import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import {
  MarketplaceFindingRow,
  MarketplaceFindingHeaders,
  marketplaceFindingColSpan,
} from "@/components/marketplace-finding-row";
import { useListFilter, byString, byNumberDesc, byDateDesc } from "@/components/use-list-filter";

export function MarketplaceFindingsList({ rows, canAct }: { rows: any[]; canAct: boolean }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.supplier_name ?? ""} ${r.material_name ?? ""}`,
    searchPlaceholder: "supplier or material…",
    sorts: [
      { value: "change", label: "Biggest change", compare: byNumberDesc((r: any) => Math.abs(Number(r.pct_change ?? 0))) },
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
          <MarketplaceFindingHeaders showOrg={false} />
        </TableHeader>
        <TableBody>
          {filtered.map((r: any) => (
            <MarketplaceFindingRow key={r.id} r={r} canAct={canAct} showOrg={false} />
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={marketplaceFindingColSpan(false)} className="text-center py-8 text-muted-foreground">
                No price changes match.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
