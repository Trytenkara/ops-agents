import { TableRow, TableHead, TableCell } from "@/components/ui/table";
import { StagedQuoteRowActions } from "@/components/staged-quote-row-actions";

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
  return showOrg ? 12 : 11;
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
        {r.material_name ?? <span className="text-destructive">— missing —</span>}
      </TableCell>
      <TableCell className="align-top text-sm">
        {r.grade ? (
          <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs">{r.grade}</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="text-right align-top">{fmt(r.price)}</TableCell>
      <TableCell className="text-right align-top">{fmt(r.case_size)}</TableCell>
      <TableCell className="align-top">{r.unit_of_measurement ?? "—"}</TableCell>
      <TableCell className="text-right align-top">{fmt(r.unit_price)}</TableCell>
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
