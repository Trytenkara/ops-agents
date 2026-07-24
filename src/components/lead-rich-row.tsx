import { TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { LeadRowActions } from "@/components/lead-row-actions";
import { SupplierOperatorAssign } from "@/components/supplier-operator-assign";
import { LeadOperatorAssign } from "@/components/lead-operator-assign";
import { deriveMatchTier } from "@/lib/lead-match-tier";

// Shared rich-lead rendering used by both the cross-org Review queue
// (/work/review/leads) and the per-client Leads tab. Keeping a single
// component means the scraped/discovery fields (source URLs, citations,
// site-type, pricing, signal, completeness, catalog drift) can't drift
// between the two surfaces.

// Lead origin badge. Maps the stored source to the ops-facing label/colour:
// platform DB vs Scout (AI discovery) vs Sourcing Index (catalog archive) vs
// ops bulk upload.
type BadgeVariant = "default" | "secondary" | "outline" | "success" | "warn" | "danger" | "info" | "accent";

const SOURCE_BADGE: Record<string, { label: string; variant: BadgeVariant; title: string }> = {
  existing_db: {
    label: "Platform DB",
    variant: "secondary",
    title: "From the Tenkara platform database (existing supplier history).",
  },
  marketplace: {
    label: "Sourcing Index",
    variant: "accent",
    title: "Matched from the Sourcing Index catalog archive.",
  },
  ai_discovery: {
    label: "Scout",
    variant: "warn",
    title: "Discovered by Agent 03 (Scout) via web search — verify before promoting.",
  },
  sourceready: {
    label: "SourceReady",
    variant: "info",
    title: "Discovered via the SourceReady supplier database (tag/keyword match) — verify the raw-material fit.",
  },
  importyeti: {
    label: "ImportYeti",
    variant: "info",
    title: "Matched via ImportYeti US-customs shipment data.",
  },
  human_bulk_upload: {
    label: "Ops upload",
    variant: "success",
    title: "Added by ops via the suppliers CSV upload.",
  },
};

// Material-match tier: does the evidence show this supplier actually makes THIS
// material (Confirmed), or was it a looser tag/keyword surface that still needs
// verification (Potential)? See lib/lead-match-tier.
export function LeadMatchBadge({ r }: { r: any }) {
  const { tier, reason } = deriveMatchTier(r);
  return tier === "confirmed" ? (
    <Badge variant="success" title={reason}>Confirmed</Badge>
  ) : (
    <Badge variant="outline" title={reason}>Potential</Badge>
  );
}

export function LeadSourceBadge({ source }: { source: string | null | undefined }) {
  const s = source ? SOURCE_BADGE[source] : undefined;
  if (!s) return <span className="text-muted-foreground">{source ?? "—"}</span>;
  return <Badge variant={s.variant} title={s.title}>{s.label}</Badge>;
}

export function LeadRichHeaders({
  showOrg = true,
  selectable = false,
  allSelected = false,
  onToggleAll,
}: {
  showOrg?: boolean;
  selectable?: boolean;
  allSelected?: boolean;
  onToggleAll?: (checked: boolean) => void;
}) {
  return (
    <TableRow>
      {selectable && (
        <TableHead className="w-8">
          <input
            type="checkbox"
            aria-label="Select all leads"
            className="h-4 w-4 accent-destructive align-middle"
            checked={allSelected}
            onChange={(e) => onToggleAll?.(e.target.checked)}
          />
        </TableHead>
      )}
      <TableHead>Supplier</TableHead>
      <TableHead>Material</TableHead>
      <TableHead>Returned price</TableHead>
      <TableHead>Signal</TableHead>
      <TableHead>Type</TableHead>
      <TableHead>Source</TableHead>
      {showOrg && <TableHead>Org</TableHead>}
      <TableHead>Staged</TableHead>
      <TableHead>Run</TableHead>
      <TableHead className="text-right">Action</TableHead>
    </TableRow>
  );
}

// Column count for empty-state colSpan. Matches LeadRichHeaders.
export function leadRichColSpan(showOrg = true, selectable = false): number {
  return (showOrg ? 10 : 9) + (selectable ? 1 : 0);
}

// Marketplace vs direct (non-marketplace), derived from the scanner's site_type.
// M = marketplace (no signup), MS = marketplace (after registration), N = direct
// quote/RFQ only. Returns null when the lead isn't classified.
// Turn the raw signal enum into a readable label (e.g. quoted_same_material →
// "Quoted same material").
const SIGNAL_LABELS: Record<string, string> = {
  quoted_same_material: "Quoted same material",
  catalog_match: "Catalog match",
  same_material: "Same material",
  prior_relationship: "Prior relationship",
};
export function humanizeSignal(signal: string): string {
  return SIGNAL_LABELS[signal] ?? signal.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function leadMarketKind(siteType: string | null | undefined): "marketplace" | "direct" | null {
  if (siteType === "M" || siteType === "MS") return "marketplace";
  if (siteType === "N") return "direct";
  return null;
}

export function LeadRichRow({
  r,
  canAct,
  showOrg = true,
  orgId,
  operatorOptions,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  r: any;
  canAct: boolean;
  showOrg?: boolean;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (checked: boolean) => void;
}) {
  const signal = r.payload?.signal as string | undefined;
  const signalCount = r.payload?.signal_count as number | undefined;
  const sourceUrl = (r.payload?.source_url ?? r.payload?.supplier_website) as string | undefined;
  const siteType = r.payload?.site_type as "M" | "MS" | "N" | undefined;
  const marketKind = (r.market_kind as "marketplace" | "direct" | null | undefined) ?? leadMarketKind(siteType);
  const completeness = r.payload?.completeness_score != null ? Number(r.payload.completeness_score) : null;
  const citations = Array.isArray(r.payload?.source_citations) ? r.payload.source_citations : [];

  return (
    <TableRow>
      {selectable && (
        <TableCell className="align-top">
          <input
            type="checkbox"
            aria-label="Select lead"
            className="mt-1 h-4 w-4 accent-destructive"
            checked={selected}
            onChange={(e) => onToggleSelect?.(e.target.checked)}
          />
        </TableCell>
      )}
      <TableCell className="font-medium align-top">
        <div className="flex items-center gap-2 flex-wrap">
          <span>{r.supplier_name ?? "—"}</span>
          {completeness != null && (
            <span
              className="text-[10px] font-normal text-muted-foreground"
              title="Share of RFQ fields the scanner captured (pricing, contact, MOQ, grades, certs, HQ)"
            >
              {Math.round(completeness * 100)}% ready
            </span>
          )}
        </div>
        {(r.payload?.supplier_country || r.payload?.supplier_role) && (
          <div className="text-xs text-muted-foreground">
            {[r.payload?.supplier_role, r.payload?.supplier_country].filter(Boolean).join(" · ")}
          </div>
        )}
        {canAct && orgId && operatorOptions ? (
          <div
            className="mt-1"
            title={
              r.supplier_id
                ? "Operator who owns this supplier for this client. Assigning here sets the supplier's operator, so the lead and supplier stay matched."
                : "Operator who owns this discovery lead. Assigning here routes its outreach to the chosen operator; Auto spreads leads across the team."
            }
          >
            <div className="text-[11px] text-muted-foreground mb-0.5">Operator</div>
            {r.supplier_id ? (
              <SupplierOperatorAssign
                orgId={orgId}
                supplierId={r.supplier_id}
                assignedId={r.operator_assigned_id ?? null}
                autoName={r.operator_auto_name ?? null}
                options={operatorOptions}
              />
            ) : (
              <LeadOperatorAssign
                orgId={orgId}
                leadId={r.id}
                assignedId={r.operator_assigned_id ?? null}
                autoName={r.operator_auto_name ?? null}
                options={operatorOptions}
              />
            )}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground" title="Operator who owns this lead for this client (assigned to ops_operator/ops_lead team members)">
            Operator: <span className={r.operator_name ? "text-foreground" : "italic"}>{r.operator_name ?? "Unassigned"}</span>
          </div>
        )}
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-primary hover:underline truncate max-w-[28ch]"
            title={sourceUrl}
          >
            {sourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
          </a>
        )}
        {citations.length > 1 && (
          <details className="text-xs text-muted-foreground mt-0.5">
            <summary className="cursor-pointer hover:text-foreground">{citations.length} sources</summary>
            <ul className="mt-1 space-y-0.5 max-w-[40ch]">
              {citations.slice(0, 6).map((u: string, i: number) => (
                <li key={i} className="truncate">
                  <a href={u} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {u.replace(/^https?:\/\//, "").slice(0, 50)}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-center gap-2">
          <span>{r.material_name ?? "—"}</span>
          {r.payload?.catalog_drift === "no_longer_listed" && (
            <span
              className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              title="Agent 05 detected the supplier dropped this material from their catalog."
            >
              drift
            </span>
          )}
        </div>
        {r.payload?.inci_name && (
          <div className="text-xs text-muted-foreground truncate max-w-[28ch]">{r.payload.inci_name}</div>
        )}
        {(r.grade ?? r.payload?.grade) && (
          <div className="mt-0.5">
            <Badge variant="secondary">{r.grade ?? r.payload?.grade}</Badge>
          </div>
        )}
      </TableCell>
      <TableCell className="align-top">
        {(() => {
          const sr = r.payload?.supplier_reply;
          if (!sr || sr.captured_price == null) {
            return <span className="text-muted-foreground text-xs">—</span>;
          }
          const cur = sr.captured_currency ?? "USD";
          const headline =
            sr.captured_unit_price != null
              ? `${cur} ${Number(sr.captured_unit_price).toLocaleString(undefined, { maximumFractionDigits: 4 })}/${sr.captured_unit_of_measurement ?? "unit"}`
              : `${cur} ${sr.captured_price}`;
          return (
            <div className="flex flex-col gap-0.5">
              <span className="font-medium tabular-nums" title="Price the supplier stated in their reply — review under Materials.">{headline}</span>
              {sr.captured_grade && <span className="text-xs text-muted-foreground">{sr.captured_grade}</span>}
            </div>
          );
        })()}
      </TableCell>
      <TableCell className="align-top">
        {signal ? (
          <Badge variant="secondary" title={`Why this supplier surfaced as a lead${signalCount != null ? ` — seen ${signalCount}×` : ""}`}>
            {humanizeSignal(signal)}
            {signalCount != null && signalCount > 1 && <span className="ml-1 text-muted-foreground">×{signalCount}</span>}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="align-top">
        {marketKind ? (
          <Badge
            variant={marketKind === "marketplace" ? "accent" : "secondary"}
            title={
              siteType === "M"
                ? "Marketplace — online checkout, no signup"
                : siteType === "MS"
                ? "Marketplace — checkout after registration"
                : "Direct supplier — quote / RFQ only"
            }
          >
            {marketKind === "marketplace" ? "Marketplace" : "Direct"}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          <LeadSourceBadge source={r.source} />
          <LeadMatchBadge r={r} />
        </div>
      </TableCell>
      {showOrg && (
        <TableCell className="text-muted-foreground">
          {r.orgs?.name ?? <span className="italic text-xs">cross-org</span>}
        </TableCell>
      )}
      <TableCell className="text-muted-foreground">{relativeTime(r.created_at)}</TableCell>
      <TableCell>
        {r.agent_run_id ? (
          <a
            href={`/agents/runs/${r.agent_run_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-muted"
            title="Open the agent run that created this lead (new tab)"
          >
            run ↗
          </a>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-right">
        {r.status === "active" ? (
          <LeadRowActions
            leadId={r.id}
            stage={r.stage}
            status={r.status}
            hasBlockedReason={!!r.payload?.enrichment_blocked_reason}
            disabled={!canAct}
          />
        ) : (
          <span className="text-xs text-muted-foreground" title={r.drop_reason ?? undefined}>
            {r.status}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
