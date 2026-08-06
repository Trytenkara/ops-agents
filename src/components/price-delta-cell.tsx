"use client";

// The two delta columns, rendered the same way everywhere they appear
// (Marketplace, Aggregator, Direct). Shared because the distinction only works
// if it reads identically on every tab: an operator scanning across tabs should
// never have to re-learn what a blank cell means.
//
// Three states, and keeping them apart is the whole point:
//   a number  — measured
//   "n/a"     — not measurable for this row (no listed-currency baseline on
//               file, e.g. a lead priced before native capture shipped)
//   "—"       — measured and flat
// Blanking "not measured" the same way as "no change" would quietly assert the
// currency contributed nothing, which is exactly the wrong claim on a row where
// we simply do not know.

const UP = "text-amber-700 dark:text-amber-400";
const DOWN = "text-emerald-700 dark:text-emerald-400";

export function DeltaCell({
  value,
  attributable,
  kind,
  currency,
}: {
  value: number | null;
  attributable: boolean;
  kind: "currency" | "supplier";
  currency?: string | null;
}) {
  if (!attributable || value == null) {
    return (
      <span
        className="text-muted-foreground/60"
        title={
          kind === "currency"
            ? "No listed-currency baseline on file for this row, so exchange-rate movement can't be separated out."
            : "No comparable earlier price on file, so the supplier's own movement can't be isolated."
        }
      >
        n/a
      </span>
    );
  }
  if (Math.abs(value) < 0.01) {
    return (
      <span
        className="text-muted-foreground"
        title={kind === "currency" ? "No exchange-rate movement." : "Supplier has not changed their price."}
      >
        —
      </span>
    );
  }
  return (
    <span
      className={value > 0 ? UP : DOWN}
      title={
        kind === "currency"
          ? `Exchange-rate movement${currency ? ` on the listed ${currency} price` : ""}, not a change by the supplier.`
          : "The supplier changed their price. Exchange-rate movement is excluded."
      }
    >
      {value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}
    </span>
  );
}

// What actually wrote the price last. Shown beside the timestamp because the
// timestamp alone is misleading: the 6-hourly FX pass restates the USD figure
// without reading anything, so a price can be minutes old and still reflect a
// listing nobody has looked at in weeks. "rate only" is the label that earns
// this column; the rest exist so it isn't the only one and therefore alarming.
const SOURCE_LABELS: Record<string, { label: string; title: string; muted?: boolean }> = {
  marketplace_scrape: { label: "page read", title: "Read from the seller's live listing." },
  fx_refresh: {
    label: "rate only",
    title:
      "Restated at a new exchange rate. No page was read and no supplier was contacted, so the amount the seller is asking has not been re-confirmed.",
    muted: true,
  },
  supplier_quote: { label: "supplier reply", title: "Captured from a price the supplier sent us." },
  operator: { label: "operator", title: "Entered by hand." },
};

export function PriceSourceLabel({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  const meta = SOURCE_LABELS[source];
  if (!meta) return null;
  return (
    <span className={`block text-[10px] ${meta.muted ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground/70"}`} title={meta.title}>
      {meta.label}
    </span>
  );
}

export function fmtSource(source: string | null | undefined): string {
  return source ? SOURCE_LABELS[source]?.label ?? source : "";
}

// WHY the price last moved, which is a different question from what wrote it and
// drives a different decision: a supplier reprice makes the quote we are holding
// stale and it has to be reissued, while pure rate drift means the seller still
// stands behind the same number.
const CHANGE_LABELS: Record<string, { label: string; title: string; cls: string }> = {
  supplier: {
    label: "supplier",
    title: "The supplier changed their price. Any quote issued off the old number is stale and should be reissued.",
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  currency: {
    label: "currency",
    title: "Only the exchange rate moved. The supplier is still asking the same amount in their own currency.",
    cls: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  },
  both: {
    label: "supplier + currency",
    title: "The supplier repriced AND the exchange rate moved. Both columns are material.",
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
};

export function PriceChangeReason({ source }: { source: string | null | undefined }) {
  // 'none' and null both render nothing, but they are not the same claim: 'none'
  // means we compared and the price held, null means never evaluated. Neither is
  // worth a badge, because a badge on an unchanged row is noise.
  if (!source || source === "none") return null;
  const meta = CHANGE_LABELS[source];
  if (!meta) return null;
  return (
    <span className={`inline-flex w-fit items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`} title={meta.title}>
      {meta.label}
    </span>
  );
}

// Only rendered on a 'both' row, and deliberately so. Everywhere else the
// headline price already is the supplier-only price, and repeating it would
// read as a second, disagreeing number.
export function SupplierOnlyPrice({
  source,
  value,
}: {
  source: string | null | undefined;
  value: number | null | undefined;
}) {
  if (source !== "both" || value == null || !Number.isFinite(Number(value))) return null;
  return (
    <span
      className="block text-[10px] text-muted-foreground"
      title="The current price with exchange-rate movement taken back out: what the seller's own reprice is worth on its own. Reissue platform quotes from this, not from the headline, so rate drift doesn't get baked into a contract number."
    >
      supplier only ${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
    </span>
  );
}

export function fmtSupplierOnlyPrice(source: string | null | undefined, value: number | null | undefined): string {
  return source === "both" && value != null && Number.isFinite(Number(value)) ? String(value) : "";
}

export function fmtChangeReason(source: string | null | undefined): string {
  return source && source !== "none" ? CHANGE_LABELS[source]?.label ?? source : "";
}

export function fmtDelta(value: number | null, attributable: boolean): string {
  if (!attributable || value == null) return "n/a";
  if (Math.abs(value) < 0.01) return "0.00";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}`;
}

// When the SUPPLIER last moved this price, as an absolute date/time rather than
// "2h ago". Relative time is actively misleading here now that the FX pass runs
// hourly: every foreign row would read as freshly updated while the seller may
// not have touched it in months.
export function SupplierChangedCell({ at }: { at: string | null | undefined }) {
  if (!at) {
    return (
      <span className="text-muted-foreground/60" title="No supplier price change recorded yet. Either this is the first price we hold, or the seller has not moved it since we started tracking.">
        —
      </span>
    );
  }
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="whitespace-nowrap tabular-nums" title={`${d.toLocaleString()} — the seller's own price moved at this time. Exchange-rate restatements do not touch it.`}>
      {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
      <span className="text-muted-foreground">{d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
    </span>
  );
}

export function fmtSupplierChanged(at: string | null | undefined): string {
  return at ?? "";
}

// The price exactly as the seller lists it, before conversion. This is the only
// number on the row that is not a derived figure: the USD column moves hourly
// with the rate even when the listing has not changed, so on a foreign row this
// is what an operator is actually negotiating against.
export function ListedPriceCell({
  price,
  currency,
}: {
  price: number | null | undefined;
  currency?: string | null;
}) {
  if (price == null || !Number.isFinite(Number(price))) {
    return (
      <span className="text-muted-foreground/60" title="Listed price not captured for this row. It predates native-price capture.">
        —
      </span>
    );
  }
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title={
        currency && currency !== "USD"
          ? `The seller's own listed price in ${currency}. It only moves when the seller reprices, unlike the USD column.`
          : "The seller's own listed price, as read from the listing."
      }
    >
      {Number(price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
    </span>
  );
}

export function fmtListedPrice(price: number | null | undefined): string {
  return price != null && Number.isFinite(Number(price)) ? String(price) : "";
}

// The currency the listing was actually read in. Null is NOT rendered as USD:
// a row we read before native capture shipped genuinely has an unknown listing
// currency, and calling it USD would assert the price cannot move on FX.
export function ListedCurrencyCell({ currency }: { currency: string | null | undefined }) {
  if (!currency) {
    return (
      <span className="text-muted-foreground/60" title="Listing currency not captured for this row. It predates native-currency capture.">
        —
      </span>
    );
  }
  const foreign = currency !== "USD";
  return (
    <span
      className={foreign ? "font-medium text-sky-700 dark:text-sky-400" : "text-muted-foreground"}
      title={
        foreign
          ? `Listed in ${currency}. The USD figure shown is converted at the current rate and moves hourly with it.`
          : "Listed in USD. The price only moves when the seller changes it."
      }
    >
      {currency}
    </span>
  );
}
