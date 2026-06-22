import Link from "next/link";
import { TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { MarketplaceFindingActions } from "@/components/marketplace-finding-actions";

// Shared rendering for a marketplace price-check finding, used by the cross-org
// Review queue (/work/review/marketplace) and the per-client Price Changes tab.
// One component keeps the scraped fields (source URL, notes, classification,
// pack size) identical across both surfaces.

// Parse a pack-size string ("25 kg", "5,000 kg", "1 lb") into a quantity + unit
// so a bulk total can be normalized to a per-unit price for tier comparison.
export function perUnitPrice(
  price: number | null,
  packSize: string | null
): { value: number; unit: string } | null {
  if (price == null || !packSize) return null;
  const m = String(packSize).match(/([\d.,]+)\s*(kg|kgs|g|grams?|lb|lbs|oz|mt|ton|tonnes?|l|ml|ea|unit|units|count|ct)?/i);
  if (!m) return null;
  const qty = parseFloat(m[1].replace(/,/g, ""));
  if (!qty || qty <= 0) return null;
  return { value: price / qty, unit: m[2] ? m[2].toLowerCase().replace(/s$/, "") : "unit" };
}

export function formatPrice(v: number | null, currency: string | null) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  const sym = currency === "USD" || !currency ? "$" : "";
  return (
    <span>
      {sym}
      {Number(v).toFixed(2)}
    </span>
  );
}

export function PctBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-muted-foreground">—</span>;
  const v = Number(pct);
  const sign = v > 0 ? "+" : "";
  const abs = Math.abs(v);
  if (abs < 1)
    return (
      <span className="text-muted-foreground">
        {sign}
        {v.toFixed(2)}%
      </span>
    );
  if (abs >= 10) {
    return (
      <span className={v > 0 ? "text-red-600 dark:text-red-400 font-medium" : "text-emerald-600 dark:text-emerald-400 font-medium"}>
        {sign}
        {v.toFixed(1)}%
      </span>
    );
  }
  return (
    <span className={v > 0 ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}>
      {sign}
      {v.toFixed(1)}%
    </span>
  );
}

export function ClassificationBadge({ value }: { value: string | null }) {
  switch (value) {
    case "signal_diverges":
      return <Badge variant="default">diverges</Badge>;
    case "signal_matches_baseline":
      return <Badge variant="secondary">matches</Badge>;
    case "no_signal_found":
      return <Badge variant="secondary">no signal</Badge>;
    case "link_broken":
      return <Badge variant="danger">link broken</Badge>;
    case "login_required":
      return (
        <Badge variant="warn" title="Price is behind a marketplace sign-in/registration wall — ops needs to sign up and pull it manually.">
          needs manual login
        </Badge>
      );
    case "needs_review":
      return <Badge variant="default">review</Badge>;
    default:
      return value ? <Badge variant="secondary">{value}</Badge> : <span className="text-muted-foreground">—</span>;
  }
}

export function MarketplaceFindingHeaders({ showOrg = true }: { showOrg?: boolean }) {
  return (
    <TableRow>
      <TableHead>Supplier</TableHead>
      <TableHead>Material</TableHead>
      <TableHead className="text-right">Old</TableHead>
      <TableHead className="text-right">New</TableHead>
      <TableHead className="text-right">Δ%</TableHead>
      <TableHead>Source</TableHead>
      <TableHead>Class</TableHead>
      {showOrg && <TableHead>Org</TableHead>}
      <TableHead>Checked</TableHead>
      <TableHead className="text-right">Action</TableHead>
    </TableRow>
  );
}

// Column count for empty-state colSpan. Matches MarketplaceFindingHeaders.
export function marketplaceFindingColSpan(showOrg = true): number {
  return showOrg ? 10 : 9;
}

export function MarketplaceFindingRow({
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
        {r.orgs?.slug ? (
          <Link href={`/work/orgs/${r.orgs.slug}/suppliers`} className="text-foreground hover:underline">
            {r.supplier_name}
          </Link>
        ) : (
          <span className="text-foreground">{r.supplier_name}</span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <span>{r.material_name}</span>
        {r.pack_size && <div className="text-xs text-muted-foreground">{r.pack_size}</div>}
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">{formatPrice(r.baseline_price, r.currency)}</TableCell>
      <TableCell className="text-right align-top tabular-nums">{formatPrice(r.current_price, r.currency)}</TableCell>
      <TableCell className="text-right align-top tabular-nums">
        <PctBadge pct={r.pct_change} />
      </TableCell>
      <TableCell className="align-top">
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
        ) : (
          "—"
        )}
        {r.notes && (
          <div className="text-[11px] text-muted-foreground max-w-[28ch] truncate" title={r.notes}>
            {r.notes}
          </div>
        )}
      </TableCell>
      <TableCell className="align-top">
        <ClassificationBadge value={r.classification ?? null} />
      </TableCell>
      {showOrg && (
        <TableCell className="text-muted-foreground align-top">
          {r.orgs?.name ?? <span className="italic text-xs">cross-org</span>}
        </TableCell>
      )}
      <TableCell className="text-muted-foreground align-top">{relativeTime(r.created_at)}</TableCell>
      <TableCell className="text-right align-top">
        <MarketplaceFindingActions findingId={r.id} status={r.status} disabled={!canAct} />
      </TableCell>
    </TableRow>
  );
}
