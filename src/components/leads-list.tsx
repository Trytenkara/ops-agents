"use client";

import { useState } from "react";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { LeadRichRow, LeadRichHeaders, leadRichColSpan, leadMarketKind } from "@/components/lead-rich-row";
import { useListFilter, byString, byDateDesc, usePersistedState } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { BulkRemoveBar } from "@/components/bulk-remove-bar";
import { removeLeads } from "@/app/actions/leads";
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

const STAGE_OPTIONS = [
  { value: "all", label: "All stages" },
  { value: "raw", label: "Raw" },
  { value: "enriched", label: "Enriched" },
  { value: "ready_for_outreach", label: "Ready to send" },
  { value: "held", label: "Held (needs name)" },
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
  const [type, setType] = usePersistedState("leads-type", "all");
  const [country, setCountry] = usePersistedState("leads-country", "all");
  const [recency, setRecency] = usePersistedState("leads-recency", "all");
  const [stage, setStage] = usePersistedState("leads-stage", "all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleOne = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

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
    .filter((r: any) =>
      stage === "all" ? true : stage === "held" ? !!r.needs_material_name : r.stage === stage
    )
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
    persistKey: "leads",
  });

  const selectable = canAct;
  const filteredIds = filtered.map((r: any) => r.id);
  const selectedCount = filteredIds.filter((id: string) => selected.has(id)).length;
  const allSelected = filteredIds.length > 0 && selectedCount === filteredIds.length;
  const toggleAll = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of filteredIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
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
            <span className="text-xs text-muted-foreground">Stage</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Stage" value={stage} onValueChange={setStage} options={STAGE_OPTIONS} />
          </label>
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
      {selectable && (
        <BulkRemoveBar
          count={selectedCount}
          noun="lead"
          onRemove={() => removeLeads(filteredIds.filter((id: string) => selected.has(id)))}
          onClear={() => setSelected(new Set())}
        />
      )}
      <Table>
        <TableHeader>
          <LeadRichHeaders showOrg={false} selectable={selectable} allSelected={allSelected} onToggleAll={toggleAll} />
        </TableHeader>
        <TableBody>
          {filtered.map((r: any) => (
            <LeadRichRow
              key={r.id}
              r={r}
              canAct={canAct}
              showOrg={false}
              orgId={orgId}
              operatorOptions={operatorOptions}
              selectable={selectable}
              selected={selected.has(r.id)}
              onToggleSelect={(checked) => toggleOne(r.id, checked)}
            />
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={leadRichColSpan(false, selectable)} className="text-center py-8 text-muted-foreground">
                No leads match.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
