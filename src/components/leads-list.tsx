"use client";

import { useState } from "react";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { LeadRichRow, LeadRichHeaders, leadRichColSpan, leadMarketKind } from "@/components/lead-rich-row";
import { useListFilter, byString, byDateDesc } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { Select } from "@/components/ui/select";
import { filenameFor } from "@/lib/csv";

const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "marketplace", label: "Marketplace" },
  { value: "direct", label: "Direct" },
];

const RECENCY_OPTIONS = [
  { value: "1", label: "Last 24h" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const countryOf = (r: any): string => (r.payload?.supplier_country ?? "").toString().trim();

export function LeadsList({
  rows,
  canAct,
  slug,
  orgId,
  operatorOptions,
}: {
  rows: any[];
  canAct: boolean;
  slug: string;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
}) {
  const [type, setType] = useState("all");
  const [country, setCountry] = useState("all");
  const [recency, setRecency] = useState("all");

  const countryOptions = [
    { value: "all", label: "All countries" },
    ...Array.from(new Set(rows.map(countryOf).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b))
      .map((c) => ({ value: c, label: c })),
  ];

  const recencyCutoff = recency === "all" ? null : Date.now() - Number(recency) * 24 * 3600 * 1000;
  const typeRows = (
    type === "all"
      ? rows
      : rows.filter((r: any) => (r.market_kind ?? leadMarketKind(r.payload?.site_type)) === type)
  )
    .filter((r: any) => (country === "all" ? true : countryOf(r) === country))
    .filter((r: any) => {
      if (recencyCutoff == null) return true;
      const t = r.created_at ? new Date(r.created_at).getTime() : 0;
      return t >= recencyCutoff;
    });

  const { filtered, controls } = useListFilter(typeRows, {
    searchText: (r) => `${r.supplier_name ?? ""} ${r.material_name ?? ""} ${r.grade ?? ""} ${countryOf(r)}`,
    searchPlaceholder: "supplier, material, grade, country…",
    sorts: [
      { value: "newest", label: "Newest", compare: byDateDesc((r: any) => r.created_at) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: any) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: any) => r.material_name) },
    ],
    defaultSort: "newest",
  });

  const csvRows = filtered.map((r: any) => [
    r.supplier_name ?? "",
    r.material_name ?? "",
    r.grade ?? "",
    countryOf(r),
    r.market_kind ?? leadMarketKind(r.payload?.site_type) ?? "",
    r.source ?? "",
    r.status ?? "",
    r.created_at ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {controls}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Type</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Type" value={type} onValueChange={setType} options={TYPE_OPTIONS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Country of origin</span>
            <Select size="sm" className="min-w-[10rem]" ariaLabel="Country of origin" value={country} onValueChange={setCountry} options={countryOptions} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Discovered</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Discovered" value={recency} onValueChange={setRecency} options={RECENCY_OPTIONS} />
          </label>
        </div>
        <ListCsvButton
          filename={filenameFor(slug, "leads")}
          headers={["Supplier", "Material", "Grade", "Country", "Type", "Source", "Status", "Created"]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <LeadRichHeaders showOrg={false} />
        </TableHeader>
        <TableBody>
          {filtered.map((r: any) => (
            <LeadRichRow key={r.id} r={r} canAct={canAct} showOrg={false} orgId={orgId} operatorOptions={operatorOptions} />
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
