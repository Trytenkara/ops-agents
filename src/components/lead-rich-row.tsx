"use client";
import { useState, useTransition } from "react";
import { TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { LeadRowActions } from "@/components/lead-row-actions";
import { SupplierOperatorAssign } from "@/components/supplier-operator-assign";
import { LeadOperatorAssign } from "@/components/lead-operator-assign";
import { deriveMatchTier } from "@/lib/lead-match-tier";
import { leadMarketKind, leadRichColSpan } from "@/lib/lead-market";
import { updateLeadEmail } from "@/app/actions/leads";

export { leadMarketKind, leadRichColSpan };

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
export function LeadMatchBadge({ r, large = false }: { r: any; large?: boolean }) {
  const { tier, reason } = deriveMatchTier(r);
  const big = large ? "text-xs px-2.5 py-1 font-semibold" : "";
  const hint = large ? " ⓘ" : "";
  return tier === "confirmed" ? (
    <Badge variant="success" title={reason} className={big}>{large ? "✓ " : ""}Confirmed{hint}</Badge>
  ) : (
    <Badge variant="warn" title={reason} className={big}>Potential{hint}</Badge>
  );
}

// Why a lead left the pipeline (dropped/terminal) or was suppressed before
// outreach. Keyed off the reason CODE (the part before any ":" in drop_reason,
// or payload.outreach_suppressed.reason).
const REMOVAL_REASON_LABEL: Record<string, string> = {
  non_material_supplier: "Freight/logistics — not a material supplier",
  dedup_canonical_name: "Duplicate (same company)",
  duplicate: "Duplicate lead",
  duplicate_open_case: "Duplicate of an open case",
  escalated_to_case: "Escalated to a case",
  manual_outreach_case: "No contact recovered",
  no_contact_recovered: "No contact recovered",
  not_a_supplier: "Not actually a supplier",
  wrong_material: "Wrong material",
  already_relationship: "Already a supplier relationship",
  prior_relationship: "Already a supplier relationship",
  low_quality_signal: "Low-quality signal",
  out_of_scope_geo: "Out of geographic scope",
  dnc_company: "Do-not-contact (client list)",
  excluded_country: "Excluded country (client setting)",
};

// Marketplace price-pull give-up reasons: the auto-scrape couldn't land a price,
// so an operator has to enter it by hand. Surfaced as a red "Unable to scrape" flag.
const SCRAPE_REASON_LABEL: Record<string, string> = {
  link_broken: "link broken",
  login_required: "price behind login",
  needs_review: "no price found on page",
};

// Resolve a removal/suppression reason for a lead, if any: outreach suppression
// (lead still active) takes precedence, else the drop_reason on a dropped/terminal
// lead. Returns a friendly label + whether it was a pre-outreach suppression.
export type RemovalKind = "suppressed" | "dropped" | "enrichment" | "scrape";

// A lead is "dropped" only when an operator physically dropped it (dropLead sets
// payload.dropped_by). Automatic terminal/dropped states (escalation, no-contact,
// dedup, freight filter) are treated as "enrichment" — the fleet couldn't finish
// on its own and a human needs to step in.
export function isOperatorDropped(r: any): boolean {
  return Boolean(r?.payload?.dropped_by);
}

export function leadRemoval(r: any): { label: string; kind: RemovalKind } | null {
  const sup = r?.payload?.outreach_suppressed?.reason as string | undefined;
  if (sup) return { label: REMOVAL_REASON_LABEL[sup] ?? sup, kind: "suppressed" };
  if (r?.status && r.status !== "active") {
    const raw = ((r.drop_reason as string | undefined) || (r?.payload?.drop_reason as string | undefined)) ?? "";
    const code = raw.split(":")[0].trim();
    return {
      label: REMOVAL_REASON_LABEL[code] || raw || r.status,
      kind: isOperatorDropped(r) ? "dropped" : "enrichment",
    };
  }
  // Active marketplace lead whose price auto-scrape gave up — needs an operator
  // to type the price in. Reported as a red flag so it isn't lost among filled rows.
  const mp = r?.payload?.marketplace_pull;
  if (mp?.status === "needs_manual_pull") {
    return { label: SCRAPE_REASON_LABEL[mp.reason as string] ?? "needs a manual price", kind: "scrape" };
  }
  return null;
}

// Human-readable explanation of why a lead was held at the raw stage (not
// promoted to enriched) — surfaced in the enrichment panel.
const BLOCKED_REASON_LABEL: Record<string, string> = {
  no_contact_channels: "No website, email, or phone to work from.",
  all_contact_channels_invalid: "Tried the site + contact pages — no reachable email, phone, or form found.",
};

const CONTACT_SOURCE_LABEL: Record<string, string> = {
  scout: "from scout", discovered: "found on site", path: "contact form", tenkara: "Tenkara record",
};

// Inline email editor — pencil icon next to the resolved email, opens an input
// on click. Saves via the updateLeadEmail server action.
function EmailEditInline({ leadId, currentEmail }: { leadId: string; currentEmail: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentEmail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1">
        {currentEmail ?? <span className="text-muted-foreground italic">no email</span>}
        <button
          onClick={() => { setValue(currentEmail ?? ""); setError(null); setEditing(true); }}
          className="text-muted-foreground hover:text-foreground ml-1"
          title="Edit email"
          type="button"
        >✎</button>
      </span>
    );
  }

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await updateLeadEmail(leadId, value);
      if (result.ok) { setEditing(false); }
      else { setError(result.error ?? "failed"); }
    });
  };

  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1">
        <input
          autoFocus
          type="email"
          value={value}
          onChange={(e: { target: { value: string } }) => setValue(e.target.value)}
          onKeyDown={(e: { key: string }) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          className="text-xs border border-border rounded px-1 py-0.5 bg-background min-w-[18ch]"
          disabled={pending}
        />
        <button onClick={save} disabled={pending} className="text-xs text-emerald-700 dark:text-emerald-400 font-medium disabled:opacity-50" type="button">
          {pending ? "…" : "Save"}
        </button>
        <button onClick={() => setEditing(false)} disabled={pending} className="text-xs text-muted-foreground" type="button">Cancel</button>
      </span>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </span>
  );
}

// Per-lead enrichment breakdown: what the enrichment stage resolved, scored,
// cleared, and why it was held — read entirely from the stored payload.enrichment
// (works retroactively; no re-enrichment needed). Renders nothing until a lead
// has been through enrichment.
export function EnrichmentDetails({ r }: { r: any }) {
  const e = r?.payload?.enrichment;
  if (!e) return null;
  const contact = e.contact ?? {};
  const factors = Array.isArray(e.completeness_factors) ? e.completeness_factors : [];
  const probe = e.website_probe ?? null;
  const cleared = e.aggregator_contact_email as string | undefined;
  const blocked = r?.payload?.enrichment_blocked_reason as string | undefined;
  const srcLabel = contact.source ? (CONTACT_SOURCE_LABEL[contact.source] ?? contact.source) : null;

  return (
    <details className="text-xs mt-1">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Enrichment</summary>
      <div className="mt-1 space-y-1 max-w-[38ch] border-l-2 border-border pl-2">
        {/* Added / resolved */}
        {(contact.email || contact.phone || contact.contact_url) && (
          <div>
            <span className="text-emerald-700 dark:text-emerald-400 font-medium">Resolved</span>
            <ul className="ml-2 mt-0.5 space-y-0.5">
              {contact.email && <li>email: <EmailEditInline leadId={r.id} currentEmail={contact.email} />{srcLabel && <span className="text-muted-foreground"> ({srcLabel})</span>}</li>}
              {contact.phone && <li>phone: {contact.phone}</li>}
              {contact.contact_url && <li>contact form{contact.pages_tried ? <span className="text-muted-foreground"> · {contact.pages_tried} pages checked</span> : null}</li>}
            </ul>
          </div>
        )}
        {/* Cleared / removed */}
        {cleared && (
          <div>
            <span className="text-amber-700 dark:text-amber-400 font-medium">Cleared</span>
            <div className="ml-2">{cleared} — marketplace inbox, not the supplier; not used for outreach.</div>
          </div>
        )}
        {/* Website probe */}
        {probe && (
          <div className="text-muted-foreground">
            Website: {probe.ok ? `resolves${probe.status_code ? ` (${probe.status_code})` : ""}` : `didn't resolve${probe.error ? ` (${probe.error})` : ""}`}
          </div>
        )}
        {/* Scoring */}
        {factors.length > 0 && (
          <div>
            <span className="text-muted-foreground">Completeness</span>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {factors.map((f: any, i: number) => {
                const pts = Math.round((Number(f.points) || 0) * 100);
                const negative = pts < 0;
                return (
                  <span
                    key={i}
                    className={
                      "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] " +
                      (negative ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-muted")
                    }
                  >
                    {f.label} {pts >= 0 ? `+${pts}` : pts}%
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {/* Legitimacy */}
        {e.legitimacy_check && (
          <div>
            <span className="text-muted-foreground">
              Legitimacy{" "}
              <span className={
                e.legitimacy_check.score >= 0.6
                  ? "text-emerald-700 dark:text-emerald-400"
                  : e.legitimacy_check.score >= 0.3
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-red-700 dark:text-red-400"
              }>
                {Math.round(e.legitimacy_check.score * 100)}%
              </span>
            </span>
            {e.legitimacy_check.signals?.length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {e.legitimacy_check.signals.map((s: string, i: number) => (
                  <span key={i} className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Marketplace trust (down-rank signals) */}
        {e.marketplace_trust && e.marketplace_trust.signals?.length > 0 && (
          <div>
            <span className="text-amber-700 dark:text-amber-400 font-medium">
              Marketplace{" "}
              <span className="text-muted-foreground font-normal">
                −{Math.round((Number(e.marketplace_trust.penalty) || 0) * 100)}% confidence
              </span>
            </span>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {e.marketplace_trust.signals.map((s: string, i: number) => (
                <span key={i} className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 px-1.5 py-0.5 text-[10px]">
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
        {/* Held */}
        {blocked && (
          <div>
            <span className="text-red-700 dark:text-red-400 font-medium">Held</span>
            <div className="ml-2">{BLOCKED_REASON_LABEL[blocked] ?? blocked}</div>
          </div>
        )}
        {e.enriched_at && (
          <div className="text-muted-foreground">
            enriched {relativeTime(e.enriched_at)}
            {e.enrichment_run_id && (
              <> · <a href={`/agents/runs/${e.enrichment_run_id}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">run ↗</a></>
            )}
          </div>
        )}
      </div>
    </details>
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
      <TableHead>Updated</TableHead>
      <TableHead>Run</TableHead>
      <TableHead className="text-right">Action</TableHead>
    </TableRow>
  );
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
  const completenessFactors = Array.isArray(r.payload?.completeness_factors) ? r.payload.completeness_factors : [];
  // "% ready" only means something once Agent 06 enrichment has actually scored
  // the profile (which records completeness_factors). Before that it's a fixed
  // ingest-time placeholder (e.g. ImportYeti's constant 0.2), which reads as a
  // relevance judgment it isn't — so only surface it once it's real.
  const completenessScored = completenessFactors.length > 0;
  const completenessTitle =
    "Profile completeness (not material fit) — share of outreach fields captured: " +
    completenessFactors
      .map((f: any) => `${f.label} (+${Math.round((Number(f.points) || 0) * 100)}%)`)
      .join(", ");
  const confidenceReason = (r.payload?.confidence_reason as string | undefined) ?? undefined;
  const confidencePct = r.confidence_score != null ? Math.round(Number(r.confidence_score) * 100) : null;
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
          {completenessScored && completeness != null && (
            <span
              className="text-[10px] font-normal text-muted-foreground cursor-help"
              title={completenessTitle}
            >
              {Math.round(completeness * 100)}% ready ⓘ
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <LeadMatchBadge r={r} large />
          {(() => {
            const removal = leadRemoval(r);
            if (!removal) return null;
            return (
              <Badge
                variant={
                  removal.kind === "dropped" || removal.kind === "suppressed" || removal.kind === "scrape"
                    ? "danger"
                    : "warn"
                }
                title={
                  removal.kind === "suppressed"
                    ? "Suppressed before outreach"
                    : removal.kind === "dropped"
                    ? "Dropped by an operator"
                    : removal.kind === "scrape"
                    ? "Auto-scrape couldn't get a price — an operator must enter it manually"
                    : "Supplier escalation: requires human action to continue"
                }
              >
                {removal.kind === "suppressed"
                  ? "Suppressed"
                  : removal.kind === "dropped"
                  ? "Dropped"
                  : removal.kind === "scrape"
                  ? "Unable to scrape"
                  : "Supplier Escalation"}
                : {removal.label}
              </Badge>
            );
          })()}
          {Array.isArray(r.flags) &&
            r.flags.map((f: { code: string; label: string }) => (
              <Badge key={f.code} variant="warn" title="Advisory flag; lead stays in the pipeline">
                {f.label}
              </Badge>
            ))}
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
            {r.tenkara_assignee_name && (
              <div className="text-[11px] text-muted-foreground mt-0.5" title="Who has this conversation assigned in the Tenkara inbox (set when the outreach draft was created)">
                Tenkara: <span className="text-foreground">{r.tenkara_assignee_name}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground" title="Operator who owns this lead for this client (assigned to ops_operator/ops_lead team members)">
            Operator: <span className={r.operator_name ? "text-foreground" : "italic"}>{r.operator_name ?? "Unassigned"}</span>
            {r.tenkara_assignee_name && (
              <span className="ml-2" title="Who has this conversation assigned in the Tenkara inbox">
                · Tenkara: <span className="text-foreground">{r.tenkara_assignee_name}</span>
              </span>
            )}
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
        <EnrichmentDetails r={r} />
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
          <Badge
            variant="secondary"
            title={
              confidenceReason
                ? `Confidence ${confidencePct != null ? `${confidencePct}% — ` : ""}${confidenceReason}`
                : `Why this supplier surfaced as a lead${signalCount != null ? ` — seen ${signalCount}×` : ""}`
            }
          >
            {humanizeSignal(signal)}
            {signalCount != null && signalCount > 1 && <span className="ml-1 text-muted-foreground">×{signalCount}</span>}
          </Badge>
        ) : confidenceReason ? (
          <span
            className="text-xs text-muted-foreground"
            title={`Confidence ${confidencePct != null ? `${confidencePct}% — ` : ""}${confidenceReason}`}
          >
            {confidencePct != null ? `${confidencePct}%` : "—"}
          </span>
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
        </div>
      </TableCell>
      {showOrg && (
        <TableCell className="text-muted-foreground">
          {r.orgs?.name ?? <span className="italic text-xs">cross-org</span>}
        </TableCell>
      )}
      <TableCell className="text-muted-foreground">{relativeTime(r.created_at)}</TableCell>
      <TableCell className="text-muted-foreground">
        {r.updated_at ? relativeTime(r.updated_at) : <span>—</span>}
      </TableCell>
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
