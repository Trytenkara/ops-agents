"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { useListFilter, byString, byDateDesc } from "@/components/use-list-filter";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { PriceSourceLabel, PriceChangeReason, SupplierOnlyPrice, SupplierChangedCell, ListedCurrencyCell, ListedPriceCell, fmtListedPrice, fmtSource, fmtChangeReason, fmtSupplierOnlyPrice, fmtSupplierChanged } from "@/components/price-delta-cell";

export type DirectPriceRow = {
  id: string;
  supplierName: string | null;
  materialName: string | null;
  // Which rung of the supplier's ladder this price is ("tier: >=1000kg"). One
  // supplier can hold several rows for one material; without this they read as
  // duplicates.
  tier: string | null;
  price: number | null;
  unitPrice: number | null;
  unitOfMeasurement: string | null;
  currency: string | null;
  previousPrice: number | null;
  previousUnitPrice: number | null;
  // Why a supplier quote's two deltas do not sum to the Δ% beside them: the Δ%
  // is this quote against the supplier's previous quote, and so is supplierDelta
  // (but valued at a single rate, so a rate move between the two quotes can't be
  // mistaken for a reprice). currencyDelta answers a different question against a
  // different baseline: how much the quote we are holding has drifted in USD
  // since the day it landed. See stagedQuoteDelta in lib/price-delta.ts.
  currencyDelta: number | null;
  supplierDelta: number | null;
  currencyAttributable: boolean;
  supplierAttributable: boolean;
  listedPrice: number | null;
  listedCurrency: string | null;
  grade: string | null;
  status: string | null;
  priceSource: string | null;
  priceChangeSource: string | null;
  supplierOnlyPrice: number | null;
  supplierPriceChangedAt: string | null;
  createdAt: string | null;
  caseDims: string | null;
};

function fmtPrice(r: DirectPriceRow, previous = false): string {
  const unitPrice = previous ? r.previousUnitPrice : r.unitPrice;
  const price = previous ? r.previousPrice : r.price;
  if (unitPrice != null) return `${r.currency ?? "USD"} ${unitPrice.toFixed(2)}/${r.unitOfMeasurement ?? "unit"}`;
  if (price != null) return `${r.currency ?? "USD"} ${price}`;
  return "";
}

function directPctChange(r: DirectPriceRow): number | null {
  const current = r.unitPrice ?? r.price;
  const previous = r.previousUnitPrice ?? r.previousPrice;
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

// Current direct-supplier prices we already hold (from staged_quotes) that
// aren't tied to an open re-quote draft. These are the "price on file" for
// non-marketplace suppliers — shown so the Live Price Index reflects current
// prices, not only re-quotes in flight.
export function DirectPricesOnFile({ rows, slug }: { rows: DirectPriceRow[]; slug: string }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.supplierName ?? ""} ${r.materialName ?? ""}`,
    searchPlaceholder: "supplier or material…",
    sorts: [
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: DirectPriceRow) => r.supplierName) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: DirectPriceRow) => r.materialName) },
      { value: "newest", label: "Newest", compare: byDateDesc((r: DirectPriceRow) => r.createdAt) },
    ],
    defaultSort: "supplier",
  });

  const csvRows = filtered.map((r) => [
    r.supplierName ?? "",
    r.materialName ?? "",
    r.tier ?? "",
    fmtPrice(r, true),
    fmtPrice(r),
    fmtSupplierChanged(r.supplierPriceChangedAt),
    fmtListedPrice(r.listedPrice),
    r.listedCurrency ?? "",
    r.caseDims ?? "",
    r.grade ?? "",
    r.status ?? "",
    r.createdAt ?? "",
    fmtSource(r.priceSource),
    fmtChangeReason(r.priceChangeSource),
    fmtSupplierOnlyPrice(r.priceChangeSource, r.supplierOnlyPrice),
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "direct-prices-on-file")}
          headers={[
            "Supplier",
            "Material",
            "Tier / pack",
            "On file",
            "Current",
            "Supplier price changed",
            "Listed price",
            "Listed currency",
            "Case dims",
            "Grade",
            "Status",
            "Updated",
            "Last updated by",
            "Why it changed",
            "Supplier-only price (USD)",
          ]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead title="Which quantity break or pack this price is for. Each rung is priced and tracked separately.">Tier / pack</TableHead>
            <TableHead className="text-right" title="Previous captured direct price for this supplier × material × tier">On file</TableHead>
            <TableHead className="text-right" title="Latest captured direct price for this supplier × material">Current</TableHead>
            <TableHead title="When the supplier themselves last moved this price. Exchange-rate restatements do not touch it, so a stale date here means the seller has genuinely held their price.">
              Supplier price changed
            </TableHead>
            <TableHead className="text-right" title="The price exactly as the supplier quoted it, before conversion. On a non-USD row this is the number that only moves when the supplier reprices.">
              Listed price
            </TableHead>
            <TableHead title="The currency this price was originally quoted in. A non-USD row is reconverted hourly, so its USD figure moves on its own.">
              Listed currency
            </TableHead>
            <TableHead>Case dims</TableHead>
            <TableHead>Grade</TableHead>
            <TableHead title="When this price last changed, and what changed it. 'rate only' means the exchange rate was restated without re-confirming the price with the supplier.">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">{r.supplierName ?? "—"}</TableCell>
              <TableCell>{r.materialName ?? "—"}</TableCell>
              <TableCell className="text-xs">
                {r.tier ? (
                  <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">{r.tier}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{fmtPrice(r, true) || "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                <div className="flex flex-col items-end gap-0.5">
                  <span className="font-medium text-foreground">{fmtPrice(r) || "—"}</span>
                  {r.status && r.status !== "approved" && (
                    <Badge variant="secondary" title="Captured from a supplier reply — review under Materials.">
                      {r.status === "pending_review" ? "pending review" : r.status}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-xs">
                <SupplierChangedCell at={r.supplierPriceChangedAt} />
                <PriceChangeReason source={r.priceChangeSource} />
                <SupplierOnlyPrice source={r.priceChangeSource} value={r.supplierOnlyPrice} />
              </TableCell>
              <TableCell className="text-right text-xs">
                <ListedPriceCell price={r.listedPrice} currency={r.listedCurrency} />
              </TableCell>
              <TableCell className="text-xs">
                <ListedCurrencyCell currency={r.listedCurrency} />
              </TableCell>
              <TableCell className="text-xs">
                {r.caseDims ? (
                  <span className="inline-flex flex-col gap-0.5">
                    <span>{r.caseDims}</span>
                    <span
                      className="inline-flex w-fit items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      title="AI-estimated dimensions — verify before freight quoting"
                    >
                      AI estimate
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{r.grade ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">
                {relativeTime(r.createdAt)}
                <PriceSourceLabel source={r.priceSource} />
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                No direct prices on file yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
