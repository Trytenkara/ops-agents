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

export function fmtDelta(value: number | null, attributable: boolean): string {
  if (!attributable || value == null) return "n/a";
  if (Math.abs(value) < 0.01) return "0.00";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}`;
}
