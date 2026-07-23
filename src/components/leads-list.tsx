"use client";

import { useState } from "react";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { LeadRichRow, LeadRichHeaders, leadRichColSpan, leadMarketKind, humanizeSignal } from "@/components/lead-rich-row";
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

const countryOf = (r: any): string => (r.payload?.supplier_country ?? "").toString().trim();

export function LeadsList({
  rows,
  canAct,
  slug,
  orgId,
  operatorOptions,
  forceStage,
}: {
  rows: any[];
  canAct: boolean;
  slug: string;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
  // When set (e.g. the "Not enriched" tab), lock the stage filter to this value
  // and hide the Stage dropdown — the tab already scopes the list.
  forceStage?: string;
}) {
  const [type, setType] = usePersistedState("leads-type", "all");
  const [recency, setRecency] = usePersistedState("leads-recency", "all");
  // Stage is driven by the pipeline tabs above (forceStage), not a dropdown here.
  const effectiveStage = forceStage ?? "all";
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleOne = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const recencyCutoff = recency === "all" ? null : Date.now() - Number(recency) * 24 * 3600 * 1000;
  const typeRows = (
    type === "all"
      ? rows
      : rows.filter((r: any) => (r.market_kind ?? leadMarketKind(r.payload?.site_type)) === type)
  )
    .filter((r: any) =>
      effectiveStage === "all" ? true : effectiveStage === "held" ? !!r.needs_material_name : r.stage === effectiveStage
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

  // Returned price mirrors the on-screen cell (from a supplier's reply, if any).
  const returnedPrice = (r: any): string => {
    const sr = r.payload?.supplier_reply;
    if (!sr || sr.captured_price == null) return "";
    const cur = sr.captured_currency ?? "USD";
    return sr.captured_unit_price != null
      ? `${cur} ${sr.captured_unit_price}/${sr.captured_unit_of_measurement ?? "unit"}`
      : `${cur} ${sr.captured_price}`;
  };

  // One export, mirroring exactly the rows on screen (search + filters + active
  // stage tab). Columns match the manual supplier-sourcing index (material ->
  // supplier identity -> RFQ fields -> provenance), plus a few on-screen extras
  // (returned price, operator). All leads are loaded client-side, so this is
  // complete — no separate server download needed.
  const csvHeaders = [
    "Material", "INCI name", "Trade name", "Supplier", "Role", "Type", "Country",
    "Website", "Pack sizes / pricing", "Email", "Phone", "HQ address",
    "Supplier background", "Grades offered", "Certifications", "MOQ",
    "Returned price", "Operator", "Signal", "Source", "Stage", "Status",
    "Confidence", "Completeness", "Source citations", "Notes", "Created",
  ];
  const csvRows = filtered.map((r: any) => {
    const p = r.payload ?? {};
    const citations: string[] = Array.isArray(p.source_citations) ? p.source_citations : [];
    return [
      r.material_name ?? "",
      p.inci_name ?? "",
      p.trade_name ?? "",
      r.supplier_name ?? "",
      p.supplier_role ?? "",
      r.market_kind ?? leadMarketKind(p.site_type) ?? "",
      countryOf(r),
      p.supplier_website ?? p.source_url ?? "",
      p.pack_sizes_pricing ?? "",
      p.supplier_contact_email ?? "",
      p.supplier_phone ?? "",
      p.hq_address ?? "",
      p.supplier_background ?? "",
      p.grades_offered ?? r.grade ?? p.grade ?? "",
      p.certifications ?? "",
      p.moq ?? "",
      returnedPrice(r),
      r.operator_name ?? r.operator_auto_name ?? "",
      p.signal ? humanizeSignal(p.signal) : "",
      r.source ?? "",
      r.stage ?? "",
      r.status ?? "",
      r.confidence_score ?? "",
      p.completeness_score ?? "",
      citations.join("; "),
      p.scout_notes ?? p.scout_rationale ?? "",
      r.created_at ?? "",
    ];
  });

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
            <span className="text-xs text-muted-foreground">Discovered</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Discovered" value={recency} onValueChange={setRecency} options={RECENCY_OPTIONS} />
          </label>
        </div>
        <ListCsvButton
          filename={filenameFor(slug, "leads")}
          headers={csvHeaders}
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
