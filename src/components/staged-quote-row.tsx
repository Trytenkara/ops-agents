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

export function StagedQuoteHeaders({ showOrg = true }: { showOrg?: boolean }) {
  return (
    <TableRow>
      <TableHead>Supplier</TableHead>
      <TableHead>Material</TableHead>
      <TableHead className="text-right">Price</TableHead>
      <TableHead className="text-right">Case</TableHead>
      <TableHead>Unit</TableHead>
      <TableHead className="text-right">Per-unit</TableHead>
      <TableHead>Source</TableHead>
      <TableHead>Conf.</TableHead>
      {showOrg && <TableHead>Org</TableHead>}
      <TableHead className="text-right">Action</TableHead>
    </TableRow>
  );
}

// Column count for empty-state colSpan. Matches StagedQuoteHeaders.
export function stagedQuoteColSpan(showOrg = true): number {
  return showOrg ? 10 : 9;
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
      <TableCell className="text-right align-top">{fmt(r.price)}</TableCell>
      <TableCell className="text-right align-top">{fmt(r.case_size)}</TableCell>
      <TableCell className="align-top">{r.unit_of_measurement ?? "—"}</TableCell>
      <TableCell className="text-right align-top">{fmt(r.unit_price)}</TableCell>
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
        />
      </TableCell>
    </TableRow>
  );
}
