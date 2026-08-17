import { TableRow, TableHead, TableCell } from "@/components/ui/table";
import { StagedQuoteRowActions } from "@/components/staged-quote-row-actions";
import { stagedPackLabel } from "@/lib/staged-pack-label";

// Shared rendering for a staged supplier quote (extracted by the Email Scanner),
// used by the cross-org Review queue (/work/review/staged-quotes) and the
// per-client Quotes tab. One component keeps the extracted fields + Edit/Approve
// actions identical across both.

export const STAGED_CONF_ORDER: Record<string, number> = {
  needs_review: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// Money with an explicit currency indicator. Prices are normalized to USD at
// ingest, but a foreign quote we couldn't convert is kept in its listed currency
// and flagged needs_review — it must NOT render as a bare number that reads as
// dollars. "$" for USD/blank, the ISO code otherwise.
function fmtMoney(n: number | null, currency: string | null): string {
  if (n == null) return "—";
  const cur = (currency ?? "").trim().toUpperCase();
  return !cur || cur === "USD" ? `$${fmt(n)}` : `${cur} ${fmt(n)}`;
}

function fmtDims(d: any): string | null {
  if (!d || d.width == null || d.height == null || d.length == null) return null;
  return `${d.width} x ${d.height} x ${d.length} ${d.unit ?? "in"}`;
}

export function StagedQuoteHeaders({ showOrg = true }: { showOrg?: boolean }) {
  return (
    <TableRow>
      <TableHead>Supplier</TableHead>
      <TableHead>Material</TableHead>
      <TableHead>Grade</TableHead>
      <TableHead className="text-right">Price</TableHead>
      <TableHead className="text-right">Case</TableHead>
      <TableHead>Unit</TableHead>
      <TableHead className="text-right">Per-unit</TableHead>
      <TableHead>Incoterm</TableHead>
      <TableHead>Case dims</TableHead>
      <TableHead>Source</TableHead>
      <TableHead>Conf.</TableHead>
      {showOrg && <TableHead>Org</TableHead>}
      <TableHead className="text-right">Action</TableHead>
    </TableRow>
  );
}

// Column count for empty-state colSpan. Matches StagedQuoteHeaders.
export function stagedQuoteColSpan(showOrg = true): number {
  return showOrg ? 13 : 12;
}

export function StagedQuoteRow({
  r,
  canAct,
  showOrg = true,
}: {
  r: any;
  canAct: boolean;
  showOrg?: boolean;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium align-top">
        {r.supplier_name ?? <span className="text-destructive">— missing —</span>}
      </TableCell>
      <TableCell className="align-top">
        <span className="flex flex-col gap-0.5">
          <span>{r.material_name ?? <span className="text-destructive">— missing —</span>}</span>
          {/* A tiered reply lands as one row per rung, so without the rung three
              quotes for one material read as three duplicates. */}
          {stagedPackLabel(r) && (
            <span className="w-fit rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {stagedPackLabel(r)}
            </span>
          )}
        </span>
      </TableCell>
      <TableCell className="align-top text-sm">
        {r.grade ? (
          <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs">{r.grade}</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="text-right align-top">{fmtMoney(r.price, r.currency)}</TableCell>
      <TableCell className="text-right align-top">{fmt(r.case_size)}</TableCell>
      <TableCell className="align-top">{r.unit_of_measurement ?? "—"}</TableCell>
      {/* A blank per-unit price is a deliberate outcome, not missing data: the
          supplier never said what quantity their price covers, so the reason is
          shown on hover rather than a guessed number in the cell. */}
      <TableCell className="text-right align-top">
        {r.unit_price == null && r.unit_price_gap_reason ? (
          <span
            className="cursor-help text-muted-foreground underline decoration-dotted underline-offset-4"
            title={r.unit_price_gap_reason}
          >
            —
          </span>
        ) : (
          fmtMoney(r.unit_price, r.currency)
        )}
      </TableCell>
      {/* A price without its delivery term is not comparable to another
          supplier's, so a blank here is a real gap, not a cosmetic one. */}
      <TableCell className="align-top text-xs">
        {r.incoterm ? (
          <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[11px]">
            {r.incoterm}
            {r.incoterm_location ? <span className="ml-1 text-muted-foreground">{r.incoterm_location}</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="align-top text-xs">
        {fmtDims(r.case_dimensions) ? (
          <span className="inline-flex flex-col gap-0.5">
            <span>
              {r.case_type ? <span className="text-muted-foreground">{r.case_type} </span> : null}
              {fmtDims(r.case_dimensions)}
            </span>
            {r.dim_source === "ai_estimated" && (
              <span
                className="inline-flex w-fit items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                title="AI-estimated dimensions, verify before Tenkara upload"
              >
                AI estimate
              </span>
            )}
            {r.dim_source === "operator_approved" && (
              <span
                className="inline-flex w-fit items-center rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                title="Operator-approved dimensions from the case calculator"
              >
                Operator approved
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground">
        {r.source === "attachment" ? r.source_attachment_name ?? "attachment" : "email body"}
      </TableCell>
      <TableCell className="align-top text-xs">{(r.confidence ?? "").replace("_", " ") || "—"}</TableCell>
      {showOrg && <TableCell className="align-top text-xs">{r.orgs?.name ?? "—"}</TableCell>}
      <TableCell className="text-right align-top">
        <StagedQuoteRowActions
          stagedId={r.id}
          status={r.status}
          disabled={!canAct}
          initial={{
            supplier_name: r.supplier_name,
            material_name: r.material_name,
            price: r.price,
            case_size: r.case_size,
            unit_of_measurement: r.unit_of_measurement,
            currency: r.currency,
          }}
          caseInit={{
            case_type: r.case_type ?? null,
            case_size: r.case_size ?? null,
            unit_of_measurement: r.unit_of_measurement ?? null,
            case_dimensions: r.case_dimensions ?? null,
          }}
        />
      </TableCell>
    </TableRow>
  );
}
