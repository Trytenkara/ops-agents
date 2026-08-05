"use client";

import { useState, useTransition, useRef } from "react";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { LeadRichRow, LeadRichHeaders, leadRichColSpan, leadMarketKind, humanizeSignal } from "@/components/lead-rich-row";
import { aggregatorNameFromPayload } from "@/lib/aggregator-hosts";
import { deriveMatchTier, matchTierRank } from "@/lib/lead-match-tier";
import { dealbreakerFitRank } from "@/lib/dealbreaker-fit";
import { useListFilter, byString, byDateDesc, byStringBlankLast, usePersistedState } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { docsForQuote, docsOnFileCell, docFieldsCell, docUrlsCell, type SupplierDocIndex } from "@/lib/supplier-doc-index";
import { BulkRemoveBar } from "@/components/bulk-remove-bar";
import { removeLeads, importEmailsFromCsv, type EmailImportResult } from "@/app/actions/leads";
import { Select } from "@/components/ui/select";
import { filenameFor } from "@/lib/csv";
import { leadPackBreakdown } from "@/lib/price-tiers";

const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "marketplace", label: "Marketplace" },
  { value: "aggregator", label: "Aggregator" },
  { value: "direct", label: "Direct" },
];

const RECENCY_OPTIONS = [
  { value: "1", label: "Last 24h" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const MATCH_OPTIONS = [
  { value: "all", label: "All matches" },
  { value: "confirmed", label: "Confirmed only" },
  { value: "potential", label: "Potential only" },
];

// Friendly labels for the Source filter — mirror the SOURCE column badges so the
// dropdown reads the same as the rows. The option list is built from the sources
// actually present in the loaded leads, so an org only sees sources it has.
const SOURCE_LABELS: Record<string, string> = {
  ai_discovery: "Scout",
  sourceready: "SourceReady",
  importyeti: "ImportYeti",
  existing_db: "Platform DB",
  marketplace: "Sourcing Index",
  human_bulk_upload: "Ops upload",
};

const countryOf = (r: any): string => (r.payload?.supplier_country ?? "").toString().trim();

export function LeadsList({
  rows,
  canAct,
  slug,
  orgId,
  operatorOptions,
  forceStage,
  supplierDocs,
}: {
  rows: any[];
  canAct: boolean;
  slug: string;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
  // Qualification documents captured for this org, keyed by supplier + material.
  supplierDocs?: SupplierDocIndex;
  // When set (e.g. the "Not enriched" tab), lock the stage filter to this value
  // and hide the Stage dropdown — the tab already scopes the list.
  forceStage?: string;
}) {
  const [importResult, setImportResult] = useState<EmailImportResult | null>(null);
  const [importing, startImport] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleEmailImportFile(e: { target: HTMLInputElement }) {
    const file = e.target.files?.[0];
    if (!file || !orgId) return;
    const form = new FormData();
    form.append("file", file);
    startImport(async () => {
      const result = await importEmailsFromCsv(orgId, form);
      setImportResult(result);
      if (e.target) e.target.value = "";
    });
  }

  const [type, setType] = usePersistedState("leads-type", "all");
  const [recency, setRecency] = usePersistedState("leads-recency", "all");
  const [match, setMatch] = usePersistedState("leads-match", "all");
  const [source, setSource] = usePersistedState("leads-source", "all");

  const sourceOptions = [
    { value: "all", label: "All sources" },
    ...Array.from(new Set(rows.map((r: any) => r.source).filter(Boolean)))
      .sort()
      .map((s: any) => ({ value: s as string, label: SOURCE_LABELS[s] ?? s })),
  ];
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
    })
    .filter((r: any) => (match === "all" ? true : deriveMatchTier(r).tier === match))
    .filter((r: any) => (source === "all" ? true : r.source === source));

  const { filtered, controls } = useListFilter(typeRows, {
    searchText: (r) =>
      `${r.supplier_name ?? ""} ${r.material_name ?? ""} ${r.grade ?? ""} ${countryOf(r)} ${r.operator_name ?? ""}`,
    searchPlaceholder: "supplier, material, grade, country, operator…",
    sorts: [
      {
        value: "match",
        label: "Confirmed first",
        compare: (a: any, b: any) =>
          matchTierRank(a) - matchTierRank(b) || byDateDesc((r: any) => r.created_at)(a, b),
      },
      {
        value: "dealbreaker",
        label: "Meets dealbreakers first",
        compare: (a: any, b: any) =>
          dealbreakerFitRank(a.payload) - dealbreakerFitRank(b.payload) ||
          matchTierRank(a) - matchTierRank(b) ||
          byDateDesc((r: any) => r.created_at)(a, b),
      },
      { value: "newest", label: "Newest", compare: byDateDesc((r: any) => r.created_at) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: any) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: any) => r.material_name) },
      {
        value: "operator",
        label: "Operator (A–Z)",
        compare: (a: any, b: any) =>
          byStringBlankLast((r: any) => r.operator_name)(a, b) || byDateDesc((r: any) => r.created_at)(a, b),
      },
    ],
    defaultSort: "match",
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
    "Material", "INCI name", "Trade name", "Supplier", "Role", "Type", "Aggregator", "Country",
    "Website", "Pack sizes / pricing", "Size", "Unit", "Case type", "Email", "Phone", "HQ address",
    "Supplier background", "Grades offered", "Certifications", "MOQ",
    "Returned price", "Operator", "Signal", "Source", "Match", "Stage", "Status",
    "Confidence", "Confidence reason", "Completeness", "Completeness reason",
    "Source citations", "Notes", "Docs on file", "Doc fields", "Doc URLs", "Created",
  ];
  const csvRows = filtered.map((r: any) => {
    const p = r.payload ?? {};
    const citations: string[] = Array.isArray(p.source_citations) ? p.source_citations : [];
    const pack = leadPackBreakdown(p);
    const docs = docsForQuote(supplierDocs, {
      supplier_id: r.supplier_id ?? null,
      supplier_name: r.supplier_name ?? "",
      material_id: r.material_id ?? null,
    });
    return [
      r.material_name ?? "",
      p.inci_name ?? "",
      p.trade_name ?? "",
      r.supplier_name ?? "",
      p.supplier_role ?? "",
      r.market_kind ?? leadMarketKind(p.site_type) ?? "",
      (r.market_kind ?? leadMarketKind(p.site_type)) === "aggregator" ? aggregatorNameFromPayload(p) ?? "" : "",
      countryOf(r),
      p.supplier_website ?? p.source_url ?? "",
      p.pack_sizes_pricing ?? "",
      pack.case_size ?? "",
      pack.unit_of_measurement ?? "",
      pack.case_type ?? "",
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
      deriveMatchTier(r).tier,
      r.stage ?? "",
      r.status ?? "",
      r.confidence_score ?? "",
      p.confidence_reason ?? "",
      p.completeness_score ?? "",
      Array.isArray(p.completeness_factors)
        ? p.completeness_factors
            .map((f: any) => {
              const pts = Math.round((Number(f.points) || 0) * 100);
              return `${f.label} (${pts >= 0 ? `+${pts}` : pts}%)`;
            })
            .join("; ")
        : "",
      citations.join("; "),
      p.scout_notes ?? p.scout_rationale ?? "",
      docsOnFileCell(docs), docFieldsCell(docs), docUrlsCell(docs),
      r.created_at ?? "",
    ];
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {controls}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Match</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Match" value={match} onValueChange={setMatch} options={MATCH_OPTIONS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Source</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Source" value={source} onValueChange={setSource} options={sourceOptions} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Type</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Type" value={type} onValueChange={setType} options={TYPE_OPTIONS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Discovered</span>
            <Select size="sm" className="min-w-[9rem]" ariaLabel="Discovered" value={recency} onValueChange={setRecency} options={RECENCY_OPTIONS} />
          </label>
        </div>
        <div className="ml-auto flex shrink-0 items-end gap-2">
          <ListCsvButton
            filename={filenameFor(slug, "leads")}
            headers={csvHeaders}
            rows={csvRows}
          />
          {canAct && orgId && (
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              disabled={importing}
              onClick={() => { setImportResult(null); fileInputRef.current?.click(); }}
              className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1 disabled:opacity-50"
            >
              {importing ? "Importing…" : "Import emails"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              className="hidden"
              onChange={handleEmailImportFile}
            />
            {importResult && (
              <span className={`text-xs ${importResult.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-500"}`}>
                {importResult.ok
                  ? `${importResult.matched} updated${importResult.unmatched ? `, ${importResult.unmatched} not found` : ""}`
                  : importResult.error}
                {importResult.unmatchedSample?.length ? ` (e.g. ${importResult.unmatchedSample.join(", ")})` : ""}
              </span>
            )}
          </div>
          )}
        </div>
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
