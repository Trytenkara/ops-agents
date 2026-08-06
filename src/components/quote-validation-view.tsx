"use client";

import { useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SearchSuggest, type SearchOption } from "@/components/ui/search-suggest";
import { Button } from "@/components/ui/button";
import { QuoteProfileCard } from "@/components/quote-profile-card";
import { createQuoteProfile } from "@/app/actions/quote-profiles";
import { qaQuoteProfile } from "@/lib/price-qa";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { quoteCompleteness, type QuoteProfile } from "@/lib/quote-profiles";
import { aggregatorNameOf } from "@/lib/aggregator-hosts";
import { MARKET_KIND_LABEL, MARKET_KIND_TITLE, MARKET_KIND_VARIANT, type MarketKind } from "@/lib/lead-market";
import {
  docsForQuote,
  docsOnFileCell,
  docFieldsCell,
  docExpiryCell,
  docUrlsCell,
  type SupplierDocIndex,
} from "@/lib/supplier-doc-index";
import type { ClientDocRules } from "@/lib/tenkara-requirements";

interface SupplierQuoteGroup {
  supplierName: string;
  supplierId: string | null;
  operatorName: string | null;
  quotes: QuoteProfile[];
}

// Owning operator per supplier, keyed "id:<supplier_id>" / "name:<lowercased>",
// the same two-key shape as SupplierTypeMap, because a quote may carry only a name.
export type SupplierOperatorMap = Record<string, string>;

// A quote carries no market kind of its own, so read it off the listing it came
// from (an aggregator host is decisive: the price is an indicative ask) and fall
// back to the supplier's validated type.
export type SupplierTypeMap = Record<string, MarketKind>;

// Suppliers already on file for this org, so adding a quote is a pick from a
// list rather than a retype of a name that has to match exactly.
export type SupplierChoice = { id: string | null; name: string };

const NEW_SUPPLIER = "__new__";

function supplierKey(s: SupplierChoice): string {
  return s.id ? `id:${s.id}` : `name:${s.name.toLowerCase()}`;
}

function quoteMarketKind(q: QuoteProfile, types: SupplierTypeMap): MarketKind | null {
  if (aggregatorNameOf(q.source_url)) return "aggregator";
  const byId = q.supplier_id ? types[`id:${q.supplier_id}`] : undefined;
  return byId ?? types[`name:${q.supplier_name.toLowerCase()}`] ?? null;
}

const TYPE_FILTER: { value: string; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "marketplace", label: MARKET_KIND_LABEL.marketplace },
  { value: "aggregator", label: MARKET_KIND_LABEL.aggregator },
  { value: "direct", label: MARKET_KIND_LABEL.direct },
  { value: "unclassified", label: "Unclassified" },
];

const SORT_OPTIONS = [
  { value: "quotes", label: "Most quotes" },
  { value: "name", label: "Supplier (A-Z)" },
  { value: "operator", label: "Operator (A-Z)" },
  { value: "completeness", label: "Avg completeness" },
  { value: "newest", label: "Newest" },
];

const STATUS_FILTER = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_review", label: "Pending Review" },
  { value: "ready_for_submission", label: "Ready" },
  { value: "submitted", label: "Submitted" },
];

export function QuoteValidationView({
  profiles,
  canAct,
  slug,
  orgId,
  supplierTypes = {},
  supplierOperators = {},
  currentUserName = null,
  supplierDocs,
  clientRules = {},
  suppliers = [],
}: {
  profiles: QuoteProfile[];
  canAct: boolean;
  slug: string;
  orgId: string;
  suppliers?: SupplierChoice[];
  supplierTypes?: SupplierTypeMap;
  supplierOperators?: SupplierOperatorMap;
  currentUserName?: string | null;
  supplierDocs?: SupplierDocIndex;
  clientRules?: ClientDocRules;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("quotes");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);
  const [showAddQuote, setShowAddQuote] = useState(false);
  // Quote cards are collapsed to one summary row each by default, so a supplier
  // with a dozen quotes is a scannable list instead of pages of scrolling. The
  // full card, every field intact, is one click away.
  const [openQuotes, setOpenQuotes] = useState<Set<string>>(new Set());
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const toggleQuote = (id: string) =>
    setOpenQuotes((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // A quote created by hand opens itself and scrolls into view: it lands at the
  // bottom of its supplier (oldest first), which is otherwise off screen.
  function handleCreated(profileId: string, supplierKeyForGroup: string) {
    setExpandedSupplier(supplierKeyForGroup);
    setOpenQuotes((prev) => new Set(prev).add(profileId));
    setJustAdded(profileId);
    setTimeout(() => setJustAdded((id) => (id === profileId ? null : id)), 8000);
  }

  // The ref callback is a new closure each render, so React re-invokes it on
  // every keystroke in the filters. Scroll only the first time we see the node.
  const scrolledTo = useRef<Element | null>(null);
  const scrollIntoViewOnce = (el: HTMLDivElement | null) => {
    if (!el || scrolledTo.current === el) return;
    scrolledTo.current = el;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const kindOf = (q: QuoteProfile): MarketKind | "unclassified" =>
    quoteMarketKind(q, supplierTypes) ?? "unclassified";

  const operatorFor = (q: QuoteProfile): string | null =>
    (q.supplier_id ? supplierOperators[`id:${q.supplier_id}`] : undefined) ??
    supplierOperators[`name:${q.supplier_name.toLowerCase()}`] ??
    null;

  // Group quotes by supplier
  const groupMap = new Map<string, SupplierQuoteGroup>();
  for (const q of profiles) {
    const key = q.supplier_id ?? q.supplier_name.toLowerCase();
    let group = groupMap.get(key);
    if (!group) {
      group = { supplierName: q.supplier_name, supplierId: q.supplier_id, operatorName: operatorFor(q), quotes: [] };
      groupMap.set(key, group);
    }
    group.quotes.push(q);
  }

  // Every supplier an operator could add a quote for: the org's roster plus any
  // supplier that only exists on a quote so far.
  const supplierChoices = new Map<string, SupplierChoice>();
  for (const s of [...suppliers, ...Array.from(groupMap.values()).map((g) => ({ id: g.supplierId, name: g.supplierName }))]) {
    if (!s.name) continue;
    const key = s.name.toLowerCase();
    const current = supplierChoices.get(key);
    // Same supplier reached twice (roster + quote): keep the one carrying an id,
    // so the new quote links instead of only name-matching.
    if (!current || (!current.id && s.id)) supplierChoices.set(key, s);
  }
  const supplierList = Array.from(supplierChoices.values()).sort((a, b) => a.name.localeCompare(b.name));

  const searchOptions: SearchOption[] = [
    ...Array.from(groupMap.values()).map((g) => ({ value: g.supplierName, group: "Suppliers" })),
    ...profiles.map((q) => ({ value: q.material_name ?? "", group: "Materials" })),
  ];

  let groups = Array.from(groupMap.values());

  // Filters
  if (search) {
    const q = search.toLowerCase();
    groups = groups.filter((g) => {
      const hay = `${g.supplierName} ${g.operatorName ?? ""} ${g.quotes.map((qq) => qq.material_name).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (statusFilter !== "all") {
    groups = groups.map((g) => ({
      ...g,
      quotes: g.quotes.filter((q) => q.approval_status === statusFilter),
    })).filter((g) => g.quotes.length > 0);
  }

  // Counts come off the pre-type set, so each option reads as "how many quotes
  // would I get if I picked this" rather than shifting once a type is selected.
  const typeCounts = { marketplace: 0, aggregator: 0, direct: 0, unclassified: 0 };
  for (const g of groups) for (const q of g.quotes) typeCounts[kindOf(q)]++;
  const typeOptions = TYPE_FILTER.map((o) =>
    o.value === "all"
      ? { ...o, label: `${o.label} (${groups.reduce((n, g) => n + g.quotes.length, 0)})` }
      : { ...o, label: `${o.label} (${typeCounts[o.value as keyof typeof typeCounts]})` }
  );
  if (typeFilter !== "all") {
    groups = groups.map((g) => ({
      ...g,
      quotes: g.quotes.filter((q) => kindOf(q) === typeFilter),
    })).filter((g) => g.quotes.length > 0);
  }

  // Owner filter, so an operator can work their own book instead of the client's
  // whole validation queue. Options come off the suppliers actually listed.
  const ownerNames = [...new Set(Array.from(groupMap.values()).map((g) => g.operatorName).filter(Boolean) as string[])].sort();
  const ownerOptions = [
    { value: "all", label: "All operators" },
    ...(currentUserName && ownerNames.includes(currentUserName)
      ? [{ value: currentUserName, label: `My suppliers (${currentUserName})` }]
      : []),
    ...ownerNames.filter((n) => n !== currentUserName).map((n) => ({ value: n, label: n })),
    { value: "unassigned", label: "Unassigned" },
  ];
  if (ownerFilter !== "all") {
    groups = groups.filter((g) => (ownerFilter === "unassigned" ? !g.operatorName : g.operatorName === ownerFilter));
  }

  // Sort
  groups = [...groups].sort((a, b) => {
    switch (sort) {
      case "name":
        return a.supplierName.localeCompare(b.supplierName);
      case "operator": {
        // Unassigned suppliers sort last, so the pile nobody owns is easy to find.
        const aOp = a.operatorName ?? "";
        const bOp = b.operatorName ?? "";
        if (!aOp !== !bOp) return aOp ? -1 : 1;
        return aOp.localeCompare(bOp) || a.supplierName.localeCompare(b.supplierName);
      }
      case "completeness": {
        const aAvg = a.quotes.length ? a.quotes.reduce((s, q) => s + quoteCompleteness(q).pct, 0) / a.quotes.length : 0;
        const bAvg = b.quotes.length ? b.quotes.reduce((s, q) => s + quoteCompleteness(q).pct, 0) / b.quotes.length : 0;
        return bAvg - aAvg;
      }
      case "newest": {
        const aDate = a.quotes.reduce((max, q) => q.updated_at > max ? q.updated_at : max, "");
        const bDate = b.quotes.reduce((max, q) => q.updated_at > max ? q.updated_at : max, "");
        return bDate.localeCompare(aDate);
      }
      default:
        return b.quotes.length - a.quotes.length;
    }
  });

  const totalQuotes = profiles.length;
  const avgCompleteness = totalQuotes > 0
    ? Math.round(profiles.reduce((s, q) => s + quoteCompleteness(q).pct, 0) / totalQuotes)
    : 0;
  const totalSuppliers = groupMap.size;

  // CSV export
  const csvHeaders = [
    "Supplier", "Type", "Operator", "Material", "Price", "Pack / tier", "Case Size", "Units", "Unit Price", "Currency",
    "Case Type", "Case Width", "Case Height", "Case Length", "Case Weight",
    "Density", "Density Unit", "Density Source",
    "Quote Expiry", "Lead Time Days",
    "Hazardous", "Refrigerated", "Protect From Freezing",
    "Name Match", "INCI Match", "Grades Match", "Additional Grades",
    "Pre-Order COA Met", "Pre-Order SDS Met", "Pre-Order TDS Met", "Pre-Order Sample Met",
    "$/kg", "Pack Class", "QA Verdict", "QA Flags",
    "Docs On File", "Doc Fields", "Earliest Doc Expiry", "Doc Downloads",
    "Status", "Completeness %", "Checkout Link", "Purchasing Notes", "Operator Notes", "Generated Notes",
  ];
  const csvRows = profiles.map((q) => {
    const up = q.price != null && q.case_size && q.case_size > 0 ? (q.price / q.case_size).toFixed(4) : "";
    const qa = qaQuoteProfile(q);
    const docs = docsForQuote(supplierDocs, q);
    return [
      q.supplier_name, kindOf(q), operatorFor(q) ?? "", q.material_name,
      q.price ?? "", q.pack_size ?? "", q.case_size ?? "", q.unit_of_measurement ?? "", up, q.currency,
      q.case_type ?? "", q.case_width ?? "", q.case_height ?? "", q.case_length ?? "", q.case_weight ?? "",
      q.density ?? "", q.density != null ? (q.density_unit ?? "") : "", q.density_source ?? "",
      q.quote_expiry ?? "", q.lead_time_days ?? "",
      q.is_hazardous ? "Yes" : "No", q.is_refrigerated ? "Yes" : "No", q.protect_from_freezing ? "Yes" : "No",
      q.name_match ? "Yes" : "No", q.inci_match ? "Yes" : "No", q.grades_match ? "Yes" : "No", q.additional_grades ?? "",
      q.preorder_coa_met ? "Yes" : "No", q.preorder_sds_met ? "Yes" : "No",
      q.preorder_tds_met ? "Yes" : "No", q.preorder_sample_met ? "Yes" : "No",
      qa.price_per_kg_usd ?? "", qa.pack_class, qa.verdict, qa.flags.map((f) => f.code).join("; "),
      docsOnFileCell(docs), docFieldsCell(docs), docExpiryCell(docs), docUrlsCell(docs),
      q.approval_status, quoteCompleteness(q).pct,
      q.source_url ?? "", q.purchasing_notes ?? "", q.notes ?? "", q.generated_notes ?? "",
    ];
  });

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <span className="text-muted-foreground">{totalSuppliers} supplier{totalSuppliers !== 1 ? "s" : ""}</span>
        <span className="text-muted-foreground">{totalQuotes} quote{totalQuotes !== 1 ? "s" : ""}</span>
        <span className="text-muted-foreground">Avg completeness: {avgCompleteness}%</span>
        {canAct && !showAddQuote && (
          <Button size="sm" className="ml-auto" onClick={() => setShowAddQuote(true)}>
            + Add quote
          </Button>
        )}
      </div>

      {/* Add quote form */}
      {showAddQuote && canAct && (
        <AddQuoteForm
          orgId={orgId}
          suppliers={supplierList}
          onClose={() => setShowAddQuote(false)}
          onCreated={(profileId, s) => handleCreated(profileId, s.id ?? s.name)}
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Search</span>
          <SearchSuggest
            className="w-56"
            ariaLabel="Search suppliers and materials"
            placeholder="supplier, material..."
            value={search}
            onValueChange={setSearch}
            options={searchOptions}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Type</span>
          <Select size="sm" className="min-w-[11rem]" ariaLabel="Quote type" value={typeFilter} onValueChange={setTypeFilter} options={typeOptions} />
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Status</span>
          <Select size="sm" className="min-w-[10rem]" ariaLabel="Status" value={statusFilter} onValueChange={setStatusFilter} options={STATUS_FILTER} />
          {ownerNames.length > 0 && (
            <Select size="sm" className="min-w-[11rem]" ariaLabel="Operator" value={ownerFilter} onValueChange={setOwnerFilter} options={ownerOptions} />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Sort</span>
          <Select size="sm" className="min-w-[10rem]" ariaLabel="Sort" value={sort} onValueChange={setSort} options={SORT_OPTIONS} />
        </label>
        <div className="ml-auto">
          <ListCsvButton filename={filenameFor(slug, "quote-validation")} headers={csvHeaders} rows={csvRows} />
        </div>
      </div>

      {/* Supplier groups */}
      <div className="space-y-2">
        {groups.map((g) => {
          const key = g.supplierId ?? g.supplierName;
          const isExpanded = expandedSupplier === key;
          const avgPct = g.quotes.length
            ? Math.round(g.quotes.reduce((s, q) => s + quoteCompleteness(q).pct, 0) / g.quotes.length)
            : 0;
          const materials = g.quotes.map((q) => q.material_name);
          const kinds = Array.from(new Set(g.quotes.map(kindOf))).filter((k): k is MarketKind => k !== "unclassified");
          const aggregators = Array.from(new Set(g.quotes.map((q) => aggregatorNameOf(q.source_url)).filter(Boolean)));
          const statuses = { draft: 0, pending_review: 0, ready_for_submission: 0, submitted: 0 };
          for (const q of g.quotes) {
            if (q.approval_status in statuses) (statuses as any)[q.approval_status]++;
          }

          return (
            <div key={key} className="rounded-lg border bg-card overflow-hidden">
              {/* Supplier summary row */}
              <div
                className="flex items-center justify-between px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors"
                onClick={() => setExpandedSupplier(isExpanded ? null : key)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-muted-foreground">{isExpanded ? "v" : ">"}</span>
                  <span className="font-medium text-sm truncate">{g.supplierName}</span>
                  {kinds.map((k) => (
                    <Badge key={k} variant={MARKET_KIND_VARIANT[k]} title={MARKET_KIND_TITLE[k]}>
                      {k === "aggregator" && aggregators.length === 1
                        ? `${MARKET_KIND_LABEL.aggregator} · ${aggregators[0]}`
                        : MARKET_KIND_LABEL[k]}
                    </Badge>
                  ))}
                  {/* Status summary badges */}
                  {statuses.ready_for_submission > 0 && <Badge variant="success">{statuses.ready_for_submission} ready</Badge>}
                  {statuses.pending_review > 0 && <Badge variant="warn">{statuses.pending_review} pending</Badge>}
                  {statuses.draft > 0 && <Badge variant="secondary">{statuses.draft} draft</Badge>}
                  {statuses.submitted > 0 && <Badge variant="success">{statuses.submitted} submitted</Badge>}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span
                    className="text-xs text-muted-foreground truncate max-w-[14ch]"
                    title={
                      g.operatorName
                        ? `Operator who owns this supplier for this client: ${g.operatorName}`
                        : "No operator owns this supplier yet"
                    }
                  >
                    {g.operatorName ?? <span className="italic">Unassigned</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {g.quotes.length} quote{g.quotes.length !== 1 ? "s" : ""}
                  </span>
                  <div className="flex items-center gap-2 w-20">
                    <div className="h-1.5 flex-1 bg-secondary rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${avgPct >= 80 ? "bg-green-500" : avgPct >= 50 ? "bg-yellow-500" : "bg-red-400"}`}
                        style={{ width: `${avgPct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">{avgPct}%</span>
                  </div>
                  <span className="text-xs text-muted-foreground truncate max-w-[20ch]" title={materials.join(", ")}>
                    {materials[0]}{materials.length > 1 ? ` +${materials.length - 1}` : ""}
                  </span>
                </div>
              </div>

              {/* Expanded: quote cards, each collapsed to a summary row */}
              {isExpanded && (
                <div className="border-t px-4 py-4 space-y-2 bg-muted/20">
                  {g.quotes.length > 1 && (
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setOpenQuotes((prev) => {
                            const next = new Set(prev);
                            const allOpen = g.quotes.every((q) => next.has(q.id));
                            for (const q of g.quotes) {
                              if (allOpen) next.delete(q.id);
                              else next.add(q.id);
                            }
                            return next;
                          })
                        }
                      >
                        {g.quotes.every((q) => openQuotes.has(q.id)) ? "Collapse all" : "Expand all"}
                      </Button>
                    </div>
                  )}
                  {g.quotes.map((q) => (
                    <div
                      key={q.id}
                      ref={q.id === justAdded ? scrollIntoViewOnce : undefined}
                      className={q.id === justAdded ? "rounded-lg ring-2 ring-primary" : undefined}
                    >
                      <QuoteProfileCard
                        profile={q}
                        orgId={orgId}
                        canAct={canAct}
                        docs={docsForQuote(supplierDocs, q)}
                        clientRules={clientRules}
                        collapsed={!openQuotes.has(q.id)}
                        onToggleCollapsed={() => toggleQuote(q.id)}
                      />
                    </div>
                  ))}
                  {canAct && (
                    <AddQuoteForSupplier
                      orgId={orgId}
                      supplierName={g.supplierName}
                      supplierId={g.supplierId}
                      onCreated={(profileId) => handleCreated(profileId, key)}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              No quote profiles yet. Agent 06 builds them automatically from staged quotes and marketplace listings, or add one manually.
            </p>
            {canAct && !showAddQuote && (
              <Button size="sm" onClick={() => setShowAddQuote(true)}>+ Add quote</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AddQuoteForm({
  orgId,
  suppliers,
  onClose,
  onCreated,
}: {
  orgId: string;
  suppliers: SupplierChoice[];
  onClose: () => void;
  onCreated: (profileId: string, supplier: SupplierChoice) => void;
}) {
  const [picked, setPicked] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [materialName, setMaterialName] = useState("");
  const [creating, startCreate] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isNew = picked === NEW_SUPPLIER;
  const selected = suppliers.find((s) => supplierKey(s) === picked) ?? null;
  const supplierName = isNew ? newSupplierName.trim() : selected?.name ?? "";

  function handleCreate() {
    if (!supplierName || !materialName.trim()) {
      setError("Pick a supplier (or enter a new one) and a material name");
      return;
    }
    startCreate(async () => {
      const supplierIdForQuote = isNew ? null : selected?.id ?? null;
      const res = await createQuoteProfile(orgId, {
        supplier_id: supplierIdForQuote,
        supplier_name: supplierName,
        material_name: materialName.trim(),
      });
      if (res.ok) {
        if (res.profileId) onCreated(res.profileId, { id: supplierIdForQuote, name: supplierName });
        onClose();
      } else setError(res.error ?? "Failed to create");
    });
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h4 className="text-sm font-semibold">Add new quote</h4>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 flex-1 min-w-[14rem]">
          <span className="text-xs text-muted-foreground">Supplier</span>
          <Select
            size="sm"
            ariaLabel="Supplier"
            placeholder={suppliers.length ? "Select a supplier…" : "No suppliers on file yet"}
            value={picked}
            onValueChange={setPicked}
            options={[
              ...suppliers.map((s) => ({ value: supplierKey(s), label: s.name })),
              { value: NEW_SUPPLIER, label: "+ Supplier not listed…" },
            ]}
          />
          {isNew && (
            <Input
              autoFocus
              value={newSupplierName}
              onChange={(e) => setNewSupplierName(e.target.value)}
              className="h-8"
              placeholder="New supplier name, e.g. Acme Chemicals"
            />
          )}
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-[14rem]">
          <span className="text-xs text-muted-foreground">Material name</span>
          <Input value={materialName} onChange={(e) => setMaterialName(e.target.value)} className="h-8" placeholder="e.g. Citric Acid" />
        </label>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={handleCreate} disabled={creating}>
          {creating ? "Creating..." : "Create"}
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

function AddQuoteForSupplier({
  orgId,
  supplierName,
  supplierId,
  onCreated,
}: {
  orgId: string;
  supplierName: string;
  supplierId: string | null;
  onCreated: (profileId: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [materialName, setMaterialName] = useState("");
  const [creating, startCreate] = useTransition();

  if (!show) {
    return (
      <Button variant="outline" size="sm" onClick={() => setShow(true)} className="border-primary/40 text-primary hover:bg-primary/10">
        + Add quote for {supplierName}
      </Button>
    );
  }

  function handleCreate() {
    if (!materialName.trim()) return;
    startCreate(async () => {
      const res = await createQuoteProfile(orgId, {
        supplier_id: supplierId,
        supplier_name: supplierName,
        material_name: materialName.trim(),
      });
      if (res.ok) {
        setShow(false);
        setMaterialName("");
        if (res.profileId) onCreated(res.profileId);
      }
    });
  }

  return (
    <div className="flex items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Material name</span>
        <Input value={materialName} onChange={(e) => setMaterialName(e.target.value)} className="h-8 w-48" placeholder="e.g. Citric Acid" />
      </label>
      <Button size="sm" onClick={handleCreate} disabled={creating}>
        {creating ? "..." : "Add"}
      </Button>
      <Button variant="outline" size="sm" onClick={() => setShow(false)}>Cancel</Button>
    </div>
  );
}
