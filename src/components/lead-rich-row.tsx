import { TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { LeadRowActions } from "@/components/lead-row-actions";

// Shared rich-lead rendering used by both the cross-org Review queue
// (/work/review/leads) and the per-client Leads tab. Keeping a single
// component means the scraped/discovery fields (source URLs, citations,
// site-type, pricing, signal, completeness, catalog drift) can't drift
// between the two surfaces.

// Lead origin badge. Maps the stored source to the ops-facing label/colour:
// platform DB vs Scout (AI discovery) vs Sourcing Index (catalog archive) vs
// ops bulk upload.
const SOURCE_BADGE: Record<string, { label: string; cls: string; title: string }> = {
  existing_db: {
    label: "Platform DB",
    cls: "bg-secondary text-secondary-foreground",
    title: "From the Tenkara platform database (existing supplier history).",
  },
  marketplace: {
    label: "Sourcing Index",
    cls: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
    title: "Matched from the Sourcing Index catalog archive.",
  },
  ai_discovery: {
    label: "Scout",
    cls: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
    title: "Discovered by Agent 03 (Scout) via web search — verify before promoting.",
  },
  human_bulk_upload: {
    label: "Ops upload",
    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    title: "Added by ops via the suppliers CSV upload.",
  },
};

export function LeadSourceBadge({ source }: { source: string | null | undefined }) {
  const s = source ? SOURCE_BADGE[source] : undefined;
  if (!s) return <span className="text-muted-foreground">{source ?? "—"}</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}
      title={s.title}
    >
      {s.label}
    </span>
  );
}

export function LeadRichHeaders({ showOrg = true }: { showOrg?: boolean }) {
  return (
    <TableRow>
      <TableHead>Supplier</TableHead>
      <TableHead>Material</TableHead>
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
export function leadRichColSpan(showOrg = true): number {
  return showOrg ? 9 : 8;
}

// Marketplace vs direct (non-marketplace), derived from the scanner's site_type.
// M = marketplace (no signup), MS = marketplace (after registration), N = direct
// quote/RFQ only. Returns null when the lead isn't classified.
export function leadMarketKind(siteType: string | null | undefined): "marketplace" | "direct" | null {
  if (siteType === "M" || siteType === "MS") return "marketplace";
  if (siteType === "N") return "direct";
  return null;
}

export function LeadRichRow({
  r,
  canAct,
  showOrg = true,
}: {
  r: any;
  canAct: boolean;
  showOrg?: boolean;
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
        {r.operator_name && (
          <div className="text-[11px] text-muted-foreground" title="Operator who owns this supplier for this client">
            Operator: <span className="text-foreground">{r.operator_name}</span>
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
            <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {r.grade ?? r.payload?.grade}
            </span>
          </div>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs align-top">
        {signal ? (
          <>
            <code>{signal}</code>
            {signalCount != null && <span className="ml-1">×{signalCount}</span>}
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="align-top">
        {marketKind ? (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              marketKind === "marketplace"
                ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                : "bg-secondary text-secondary-foreground"
            }`}
            title={
              siteType === "M"
                ? "Marketplace — online checkout, no signup"
                : siteType === "MS"
                ? "Marketplace — checkout after registration"
                : "Direct supplier — quote / RFQ only"
            }
          >
            {marketKind === "marketplace" ? "Marketplace" : "Direct"}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="align-top"><LeadSourceBadge source={r.source} /></TableCell>
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
