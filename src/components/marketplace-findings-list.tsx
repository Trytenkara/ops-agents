"use client";

import { useState, Fragment } from "react";
import { Select } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  formatPrice,
  perUnitPrice,
  ClassificationBadge,
} from "@/components/marketplace-finding-row";
import { MarketplaceFindingActions } from "@/components/marketplace-finding-actions";
import { useListFilter, byString, byNumberDesc, byDateDesc } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { PriceSourceLabel, PriceChangeReason, SupplierOnlyPrice, SupplierChangedCell, ListedCurrencyCell, ListedPriceCell, fmtListedPrice, fmtSource, fmtChangeReason, fmtSupplierOnlyPrice, fmtSupplierChanged } from "@/components/price-delta-cell";
import { fmtCaseDims, resolveCaseDims, type CaseDims } from "@/lib/marketplace-case-dims";
import { relativeTime } from "@/lib/utils";
import { aggregatorNameOf } from "@/lib/aggregator-hosts";
import { qaPrice, type QaResult } from "@/lib/price-qa";
import { resolveDensity, type DensityIndex } from "@/lib/material-density";

const COLS = 12;

// Prefer the agent's structured unit_price (Agent 05); fall back to deriving it
// from the pack-size string.
function unitPriceOf(r: any): { value: number; unit: string } | null {
  if (r.unit_price != null && Number.isFinite(Number(r.unit_price))) {
    const fromPack = perUnitPrice(1, r.pack_size ?? null);
    return { value: Number(r.unit_price), unit: fromPack?.unit ?? "unit" };
  }
  return perUnitPrice(r.current_price ?? r.baseline_price ?? null, r.pack_size ?? null);
}

function qaOf(r: any, densities: DensityIndex = {}): QaResult {
  const d = resolveDensity(densities, r.material_name);
  return qaPrice({
    material_name: r.material_name,
    density: d?.density ?? null,
    density_unit: d?.unit ?? null,
    density_rank: d?.rank ?? null,
    density_kind: d?.kind ?? null,
    price: r.current_price ?? r.baseline_price ?? null,
    unit_price: r.unit_price ?? null,
    pack_size: r.pack_size ?? null,
    source_url: r.source_url ?? null,
    market_kind: r.aggregator ? "aggregator" : null,
    citation_required: true,
  });
}

function perUnitLabel(r: any): string {
  const pu = unitPriceOf(r);
  return pu ? `$${pu.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}/${pu.unit}` : "";
}

// Cheapest first. $/kg is the only figure comparable ACROSS pack sizes, so it
// sorts ahead of raw per-unit (which would rank $/oz against $/kg as if they
// were the same number); rows with neither sort last.
function tierSort(a: any, b: any, densities: DensityIndex): number {
  const ka = qaOf(a, densities).price_per_kg_usd;
  const kb = qaOf(b, densities).price_per_kg_usd;
  if (ka != null && kb != null && ka !== kb) return ka - kb;
  if (ka != null && kb == null) return -1;
  if (ka == null && kb != null) return 1;
  const pa = unitPriceOf(a)?.value ?? Infinity;
  const pb = unitPriceOf(b)?.value ?? Infinity;
  if (pa !== pb) return pa - pb;
  return (a.baseline_price ?? Infinity) - (b.baseline_price ?? Infinity);
}

export function MarketplaceFindingsList({
  rows,
  canAct,
  slug = "all",
  orgClients = [],
  tagsByMaterialName = {},
  dimsByPack = {},
  densities = {},
}: {
  rows: any[];
  canAct: boolean;
  slug?: string;
  orgClients?: { id: string; name: string }[];
  tagsByMaterialName?: Record<string, string>;
  dimsByPack?: Record<string, CaseDims>;
  densities?: DensityIndex;
}) {
  const [clientFilter, setClientFilter] = useState("all");
  const clientRows = clientFilter === "all"
    ? rows
    : rows.filter((r: any) => r.material_name && tagsByMaterialName[(r.material_name as string).toLowerCase()] === clientFilter);

  const { filtered, controls } = useListFilter(clientRows, {
    searchText: (r) => `${r.supplier_name ?? ""} ${r.material_name ?? ""}`,
    searchPlaceholder: "supplier or material…",
    sorts: [
      { value: "change", label: "Biggest change", compare: byNumberDesc((r: any) => Math.abs(Number(r.pct_change ?? 0))) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: any) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: any) => r.material_name) },
      { value: "newest", label: "Newest", compare: byDateDesc((r: any) => r.created_at) },
    ],
  });

  // Group by material so all suppliers' tiers for one material sit together
  // (cheapest per-unit first); the supplier is called out per row in the Source
  // column, not in the group header.
  const groups = new Map<string, any[]>();
  for (const r of filtered) {
    const key = `${r.material_name ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const csvRows = filtered.map((r: any) => [
    r.supplier_name ?? "",
    r.aggregator ?? aggregatorNameOf(r.source_url) ?? "",
    r.material_name ?? "",
    r.pack_size ?? "",
    fmtCaseDims(resolveCaseDims(dimsByPack, r.pack_size)) ?? "",
    perUnitLabel(r),
    qaOf(r, densities).price_per_kg_usd ?? "",
    qaOf(r, densities).pack_class,
    qaOf(r, densities).verdict,
    r.baseline_price ?? "",
    r.current_price ?? "",
    fmtSupplierChanged(r.supplier_price_changed_at),
    fmtListedPrice(r.listed_price),
    r.listed_currency ?? "",
    r.created_at ?? "",
    fmtSource(r.price_source),
    fmtChangeReason(r.price_change_source),
    fmtSupplierOnlyPrice(r.price_change_source, r.supplier_price_usd),
  ]);

  return (
    <div className="space-y-3">
      {orgClients.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            size="sm"
            className="w-48"
            ariaLabel="Filter by client"
            value={clientFilter}
            onValueChange={setClientFilter}
            options={[{ value: "all", label: "All clients" }, ...orgClients.map((c) => ({ value: c.id, label: c.name }))]}
          />
          {clientFilter !== "all" && (
            <span className="text-xs text-muted-foreground">{clientRows.length} of {rows.length} rows</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "price-changes")}
          headers={["Supplier", "Aggregator", "Material", "Pack / tier", "Case dims", "Per-unit", "$/kg", "Pack class", "QA", "On file", "Current", "Supplier price changed", "Listed price", "Listed currency", "Updated", "Last updated by", "Why it changed", "Supplier-only price (USD)"]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pack / tier</TableHead>
            <TableHead>Case dims</TableHead>
            <TableHead className="text-right">Per-unit</TableHead>
            <TableHead className="text-right" title="Previous marketplace scrape for this pack size">On file</TableHead>
            <TableHead className="text-right" title="Latest marketplace scrape for this pack size">Current</TableHead>
            <TableHead title="When the seller themselves last moved this price. Exchange-rate restatements do not touch it, so a stale date here means the listing has genuinely held.">
              Supplier price changed
            </TableHead>
            <TableHead className="text-right" title="The price exactly as the listing shows it, before conversion. On a non-USD row this is the number that only moves when the seller reprices.">
              Listed price
            </TableHead>
            <TableHead title="The currency this listing was originally read in. A non-USD row is reconverted once a day when the rate source publishes, so its USD figure can move on its own.">
              Listed currency
            </TableHead>
            <TableHead>Supplier / source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead title="When this price last changed, and what changed it. 'rate only' means the exchange rate was restated without re-reading the listing.">Updated</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from(groups.values()).map((tiers) => {
            const head = tiers[0];
            const sorted = [...tiers].sort((x, y) => tierSort(x, y, densities));
            const supplierCount = new Set(tiers.map((t) => t.supplier_name).filter(Boolean)).size;
            return (
              <Fragment key={head.material_name ?? "—"}>
                <TableRow className="bg-secondary/40">
                  <TableCell colSpan={COLS} className="py-2">
                    <span className="font-medium">{head.material_name ?? "—"}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {tiers.length} tier{tiers.length === 1 ? "" : "s"}
                      {supplierCount > 1 ? ` · ${supplierCount} suppliers` : ""}
                    </span>
                  </TableCell>
                </TableRow>
                {sorted.map((r) => {
                  const pu = unitPriceOf(r);
                  const qa = qaOf(r, densities);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="align-top">
                        {r.pack_size ? (
                          <span>{r.pack_size}</span>
                        ) : (
                          <span className="text-muted-foreground text-xs">size unknown · bulk total</span>
                        )}
                        {qa.verdict !== "pass" && (
                          <div
                            className={
                              qa.verdict === "needs_review"
                                ? "mt-0.5 w-fit rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-300"
                                : "mt-0.5 w-fit rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                            }
                            title={qa.flags.map((f) => f.message).join("\n")}
                          >
                            {qa.verdict === "needs_review" ? "Needs review" : "Check"}
                          </div>
                        )}
                        {qa.pack_class === "retail" && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground" title="Retail-size pack, not a wholesale comparable.">
                            retail pack
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        {fmtCaseDims(resolveCaseDims(dimsByPack, r.pack_size)) ? (
                          <span className="inline-flex flex-col gap-0.5">
                            <span>{fmtCaseDims(resolveCaseDims(dimsByPack, r.pack_size))}</span>
                            <span
                              className="inline-flex w-fit items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                              title="AI-estimated from pack size — verify before freight quoting"
                            >
                              AI estimate
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">
                        {pu ? (
                          <span className="font-medium">
                            ${pu.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}/{pu.unit}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {qa.price_per_kg_usd != null && (() => {
                          // A $/kg converted from a volume pack rests on a density we
                          // sourced, not on a weight the supplier printed. That flag is
                          // info-level, so the QA chip stays hidden; say it here or the
                          // operator cannot tell the two apart.
                          const via = qa.flags.find((f) => f.code === "converted_via_density");
                          return (
                            <div
                              className="text-[11px] text-muted-foreground"
                              title={via ? via.message : "Normalized to $/kg, the only basis comparable across pack sizes."}
                            >
                              ${qa.price_per_kg_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}/kg
                              {via && <span className="ml-1 underline decoration-dotted">via density</span>}
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">{formatPrice(r.baseline_price, r.currency)}</TableCell>
                      <TableCell className="text-right align-top tabular-nums">{formatPrice(r.current_price, r.currency)}</TableCell>
                      <TableCell className="align-top text-xs">
                        <SupplierChangedCell at={r.supplier_price_changed_at} />
                        <PriceChangeReason source={r.price_change_source} />
                        <SupplierOnlyPrice source={r.price_change_source} value={r.supplier_price_usd} />
                      </TableCell>
                      <TableCell className="align-top text-right text-xs">
                        <ListedPriceCell price={r.listed_price ?? null} currency={r.listed_currency ?? null} />
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        <ListedCurrencyCell currency={r.listed_currency ?? null} />
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="font-medium">{r.supplier_name ?? "—"}</div>
                        {(r.aggregator ?? aggregatorNameOf(r.source_url)) && (
                          <div
                            className="text-[11px] text-amber-700 dark:text-amber-400"
                            title="Aggregator this price was pulled from. Multi-seller inquiry platform, so the number is an indicative ask, not a checkout price."
                          >
                            via {r.aggregator ?? aggregatorNameOf(r.source_url)}
                          </div>
                        )}
                        {r.source_url ? (
                          <a
                            href={r.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline truncate inline-block max-w-[24ch]"
                            title={r.source_url}
                          >
                            {r.source_url.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
                          </a>
                        ) : null}
                        {r.notes && (
                          <div className="text-[11px] text-muted-foreground max-w-[28ch] truncate" title={r.notes}>
                            {r.notes}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top"><ClassificationBadge value={r.classification ?? null} /></TableCell>
                      <TableCell className="text-muted-foreground align-top text-xs" title={r.created_at ? new Date(r.created_at).toLocaleString() : undefined}>
                        {r.created_at ? relativeTime(r.created_at) : "—"}
                        <PriceSourceLabel source={r.price_source} />
                      </TableCell>
                      <TableCell className="text-right align-top">
                        {r.kind === "on_file" ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : (
                          <MarketplaceFindingActions findingId={r.id} status={r.status} disabled={!canAct} />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </Fragment>
            );
          })}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={COLS} className="text-center py-8 text-muted-foreground">
                No prices match.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
