"use client";

import { useState, Fragment } from "react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  formatPrice,
  perUnitPrice,
  PctBadge,
  ClassificationBadge,
} from "@/components/marketplace-finding-row";
import { MarketplaceFindingActions } from "@/components/marketplace-finding-actions";
import { useListFilter, byString, byNumberDesc, byDateDesc } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { fmtCaseDims, resolveCaseDims, type CaseDims } from "@/lib/marketplace-case-dims";
import { relativeTime } from "@/lib/utils";

const COLS = 10;

// Prefer the agent's structured unit_price (Agent 05); fall back to deriving it
// from the pack-size string.
function unitPriceOf(r: any): { value: number; unit: string } | null {
  if (r.unit_price != null && Number.isFinite(Number(r.unit_price))) {
    const fromPack = perUnitPrice(1, r.pack_size ?? null);
    return { value: Number(r.unit_price), unit: fromPack?.unit ?? "unit" };
  }
  return perUnitPrice(r.current_price ?? r.baseline_price ?? null, r.pack_size ?? null);
}

function perUnitLabel(r: any): string {
  const pu = unitPriceOf(r);
  return pu ? `$${pu.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}/${pu.unit}` : "";
}

// Cheapest per-unit first; rows without a parseable pack size sort last.
function tierSort(a: any, b: any): number {
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
}: {
  rows: any[];
  canAct: boolean;
  slug?: string;
  orgClients?: { id: string; name: string }[];
  tagsByMaterialName?: Record<string, string>;
  dimsByPack?: Record<string, CaseDims>;
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
    r.material_name ?? "",
    r.pack_size ?? "",
    fmtCaseDims(resolveCaseDims(dimsByPack, r.pack_size)) ?? "",
    perUnitLabel(r),
    r.baseline_price ?? "",
    r.current_price ?? "",
    r.pct_change != null ? `${r.pct_change}%` : "",
    r.created_at ?? "",
  ]);

  return (
    <div className="space-y-3">
      {orgClients.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="all">All clients</option>
            {orgClients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {clientFilter !== "all" && (
            <span className="text-xs text-muted-foreground">{clientRows.length} of {rows.length} rows</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "price-changes")}
          headers={["Supplier", "Material", "Pack / tier", "Case dims", "Per-unit", "On file", "Current", "Change", "Updated"]}
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
            <TableHead className="text-right" title="Percent change from On file to Current">Δ</TableHead>
            <TableHead>Supplier / source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead title="When this marketplace price was last checked / refreshed">Updated</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from(groups.values()).map((tiers) => {
            const head = tiers[0];
            const sorted = [...tiers].sort(tierSort);
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
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="align-top">
                        {r.pack_size ? (
                          <span>{r.pack_size}</span>
                        ) : (
                          <span className="text-muted-foreground text-xs">size unknown · bulk total</span>
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
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">{formatPrice(r.baseline_price, r.currency)}</TableCell>
                      <TableCell className="text-right align-top tabular-nums">{formatPrice(r.current_price, r.currency)}</TableCell>
                      <TableCell className="text-right align-top tabular-nums"><PctBadge pct={r.pct_change} /></TableCell>
                      <TableCell className="align-top">
                        <div className="font-medium">{r.supplier_name ?? "—"}</div>
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
