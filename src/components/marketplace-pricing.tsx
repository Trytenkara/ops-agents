"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useListFilter, byString } from "@/components/use-list-filter";
import { dealbreakerFitRank } from "@/lib/dealbreaker-fit";
import { leadMarketKind, type MarketKind } from "@/lib/lead-market";
import { aggregatorNameFromPayload } from "@/lib/aggregator-hosts";
import { saveLeadPriceTiers } from "@/app/actions/leads";
import { type PriceTier, tierBreakdown, composePackSize } from "@/lib/price-tiers";
import { fmtCaseDims, resolveCaseDims, type CaseDims } from "@/lib/marketplace-case-dims";
import { relativeTime } from "@/lib/utils";

// Published-price view, rendered once per market kind:
//   marketplace — pricing published on a storefront you can actually check out on
//     (site_type M = no signup, MS = after registration).
//   aggregator  — multi-seller inquiry platforms (Alibaba, IndiaMART, ...,
//     site_type A). The number is an indicative ask, not a transactable price, so
//     these get their own tab and every row names the aggregator it came from.
// Ops can structure either ladder into tiers (pack size → price → $/unit) inline.

type Row = {
  id: string;
  supplier_name: string | null;
  material_name: string | null;
  source: string | null;
  market_kind?: MarketKind | null;
  payload: any;
};

function siteTypeMeta(st: string | null | undefined): { label: string; title: string } | null {
  if (st === "M") return { label: "Open checkout", title: "Marketplace — public price, checkout without signup" };
  if (st === "MS") return { label: "Checkout after signup", title: "Marketplace — price visible after registration" };
  if (st === "A") return { label: "Inquiry only", title: "Aggregator — ordering goes through a Send Inquiry form, there is no checkout" };
  return null;
}


export function MarketplacePricing({
  rows,
  canAct,
  slug,
  dimsByPack = {},
  kind = "marketplace",
}: {
  rows: Row[];
  canAct: boolean;
  slug: string;
  dimsByPack?: Record<string, CaseDims>;
  kind?: Extract<MarketKind, "marketplace" | "aggregator">;
}) {
  const isAggregatorTab = kind === "aggregator";
  const marketRows = rows.filter((r) => (r.market_kind ?? leadMarketKind(r.payload?.site_type)) === kind);

  const { filtered, controls } = useListFilter(marketRows, {
    searchText: (r) => `${r.supplier_name ?? ""} ${r.material_name ?? ""}`,
    searchPlaceholder: "supplier or material…",
    sorts: [
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: Row) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: Row) => r.material_name) },
      {
        value: "dealbreaker",
        label: "Meets dealbreakers first",
        compare: (a: Row, b: Row) =>
          dealbreakerFitRank(a.payload) - dealbreakerFitRank(b.payload) ||
          byString((r: Row) => r.supplier_name)(a, b),
      },
    ],
    defaultSort: "supplier",
  });

  if (marketRows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        {isAggregatorTab
          ? "No aggregator leads yet. These appear when a listing is found on a multi-seller inquiry platform such as Alibaba, IndiaMART, or Made-in-China."
          : "No marketplace leads yet. These appear when Scout finds suppliers with published website pricing (open checkout or checkout-after-signup)."}
      </p>
    );
  }

  const exportUrl = `/api/leads-in-flight/marketplace-pricing-csv?org=${encodeURIComponent(slug)}&kind=${kind}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap items-end gap-3">{controls}</div>
        <a
          href={exportUrl}
          download
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm hover:bg-secondary/60 transition-colors"
        >
          Export CSV
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        {isAggregatorTab ? (
          <>
            {filtered.length} aggregator listing{filtered.length === 1 ? "" : "s"}, each labelled with the platform it came
            from. These are multi-seller inquiry platforms with no checkout, so treat the numbers as indicative asks to
            confirm with the seller, not as prices you can buy at. Structure each ladder into tiers the same way.
          </>
        ) : (
          <>
            {filtered.length} marketplace supplier{filtered.length === 1 ? "" : "s"} with direct website pricing. Structure
            each published price ladder into tiers — size, unit, and case type (drum, bag…), total price, and the
            derived $/unit. The split columns export straight into the platform&apos;s quote fields.
          </>
        )}
      </p>
      <div className="space-y-3">
        {filtered.map((r) => (
          <MarketplaceLeadCard key={r.id} row={r} canAct={canAct} dimsByPack={dimsByPack} />
        ))}
        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">No {isAggregatorTab ? "aggregator" : "marketplace"} leads match.</p>
        )}
      </div>
    </div>
  );
}

function emptyTier(): PriceTier {
  return {
    pack_size: "",
    price: null,
    unit_price: null,
    case_size: null,
    unit_of_measurement: null,
    case_type: null,
  };
}

// $/unit: prefer an explicit unit_price (pulled or operator-typed); otherwise
// derive it from total price / case size so a priced tier always shows a per-unit
// figure. Null when there's no price or size to divide.
function derivedUnitPrice(t: PriceTier): number | null {
  if (t.unit_price != null) return t.unit_price;
  if (t.price != null && t.case_size != null && t.case_size !== 0) {
    return Math.round((t.price / t.case_size) * 10000) / 10000;
  }
  return null;
}

function MarketplaceLeadCard({ row, canAct, dimsByPack }: { row: Row; canAct: boolean; dimsByPack: Record<string, CaseDims> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const initial: PriceTier[] = Array.isArray(row.payload?.price_tiers) && row.payload.price_tiers.length
    ? row.payload.price_tiers.map((t: any) => {
        const tier: PriceTier = {
          pack_size: t.pack_size ?? "",
          price: t.price ?? null,
          unit_price: t.unit_price ?? null,
          case_size: t.case_size ?? null,
          unit_of_measurement: t.unit_of_measurement ?? null,
          case_type: t.case_type ?? null,
        };
        // Prefill the split cells by parsing pack_size when the agent only wrote
        // the free-text (operator edits then persist explicit values).
        const b = tierBreakdown(tier);
        return { ...tier, ...b };
      })
    : [emptyTier()];
  const [tiers, setTiers] = useState<PriceTier[]>(initial);

  const st = siteTypeMeta(row.payload?.site_type);
  const isAggregator = (row.market_kind ?? leadMarketKind(row.payload?.site_type)) === "aggregator";
  const aggregator = isAggregator ? aggregatorNameFromPayload(row.payload) : null;
  const pull = row.payload?.marketplace_pull as
    | { status: "pulled" | "needs_manual_pull" | "pending"; reason?: string; pulled_at?: string }
    | undefined;
  const pullReasonLabel: Record<string, string> = {
    login_required: "needs login/account",
    link_broken: "link broken",
    needs_review: "no price found",
  };
  const sourceUrl = (row.payload?.source_url ?? row.payload?.supplier_website) as string | undefined;
  // A platform inquiry is submitted into the aggregator's own web form, so nothing
  // about it shows on the listing. Without this an operator cannot tell a seller we
  // already contacted from one we have never touched. draft_reference_id is stamped
  // on the lead at submit time, so the thread needs no extra query to link.
  const inquiry = row.payload?.inquiry_submitted as
    | { at?: string; platform?: string; draft_reference_id?: string }
    | undefined;
  const inquiryReplied = !!row.payload?.supplier_reply;
  const inquiryStuck = !!row.payload?.direct_contact_escalated;
  // Once a seller is split out into its own direct lead, the reply state moves
  // with the conversation, so this row would sit on "inquiry sent" forever and
  // read like nobody answered. Say what actually happened instead.
  const yieldedDirect = row.payload?.direct_lead_id
    ? ((row.payload?.yielded_direct_contact ?? {}) as { email?: string })
    : null;
  const rawPricing = row.payload?.pack_sizes_pricing as string | undefined;
  const moq = row.payload?.moq as string | undefined;
  const updatedAt = row.payload?.price_tiers_updated_at as string | undefined;
  // Read-only reference to the last-scraped ladder (Agent 05 stamps previous_price
  // + price_changed_at per tier). Indexed to match `initial`'s order on load; used
  // only to display "last price" / when it changed, never edited or saved here.
  const priorTiers: any[] = Array.isArray(row.payload?.price_tiers) ? row.payload.price_tiers : [];

  function setTier(i: number, patch: Partial<PriceTier>) {
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function addTier() {
    setTiers((prev) => [...prev, emptyTier()]);
  }
  function removeTier(i: number) {
    setTiers((prev) => (prev.length <= 1 ? [emptyTier()] : prev.filter((_, idx) => idx !== i)));
  }
  function save() {
    setMsg(null);
    // Keep the free-text pack_size in sync with the split cells so downstream
    // readers (display, $/unit math, older views) stay populated.
    const toSave: PriceTier[] = tiers.map((t) => ({
      ...t,
      pack_size:
        composePackSize({
          case_size: t.case_size,
          unit_of_measurement: t.unit_of_measurement,
          case_type: t.case_type,
        }) ?? t.pack_size,
    }));
    start(async () => {
      const r = await saveLeadPriceTiers(row.id, toSave);
      if (r.ok) setMsg({ kind: "ok", text: "Saved" });
      else setMsg({ kind: "err", text: r.error ?? "failed" });
      router.refresh();
    });
  }

  const num = (v: number | null | undefined) => (v == null ? "" : String(v));
  const toNum = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const toText = (s: string): string | null => s.trim() || null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{row.supplier_name ?? "—"}</span>
            {aggregator && (
              <Badge variant="warn" title="Aggregator this listing was pulled from. Multi-seller inquiry platform, so the number is an indicative ask, not a checkout price.">
                via {aggregator}
              </Badge>
            )}
            {st && <Badge variant={isAggregator ? "warn" : "accent"} title={st.title}>{st.label}</Badge>}
            {pull?.status === "pulled" && (
              <Badge variant="success" title={pull.pulled_at ? `Auto-pulled ${pull.pulled_at}` : "Price auto-pulled from the listing"}>
                price auto-pulled
              </Badge>
            )}
            {pull?.status === "needs_manual_pull" && (
              <Badge variant="danger" title="Auto-scrape couldn't get a price — an operator must enter it manually.">
                unable to scrape{pull.reason ? ` · ${pullReasonLabel[pull.reason] ?? pull.reason}` : ""}
              </Badge>
            )}
            {(!pull || pull.status === "pending") && (
              <Badge variant="outline" title="Not yet resolved — the marketplace price agent will retry pulling the listed price over the next runs. You can also enter the price ladder manually now.">
                price pull pending
              </Badge>
            )}
            {yieldedDirect ? (
              <Badge
                variant="success"
                title={`This seller answered from its own address, so it now has a separate direct supplier lead (${yieldedDirect.email ?? "own address"}) that owns the email thread and the quotes. This row stays the listing the price index publishes from.`}
              >
                direct supplier created
              </Badge>
            ) : (
              inquiry && (
                <Badge
                  variant={inquiryStuck ? "danger" : inquiryReplied ? "success" : "accent"}
                  title={
                    inquiryStuck
                      ? "Seller replied through the platform relay, so we still have no direct address. Escalated to ops."
                      : inquiryReplied
                        ? "Seller replied to our platform inquiry."
                        : `Inquiry submitted${inquiry.at ? ` ${relativeTime(inquiry.at)}` : ""}, awaiting a reply.`
                  }
                >
                  {inquiryStuck ? "inquiry needs contact" : inquiryReplied ? "inquiry replied" : "inquiry sent"}
                </Badge>
              )
            )}
            <span className="text-xs text-muted-foreground">· {row.material_name ?? "—"}</span>
          </div>
          {inquiry?.draft_reference_id && (
            <Link
              href={`/work/drafts/${inquiry.draft_reference_id}`}
              className="block text-xs text-primary hover:underline"
            >
              View inquiry thread →
            </Link>
          )}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs text-primary hover:underline truncate max-w-[44ch]"
              title={sourceUrl}
            >
              {sourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
            </a>
          )}
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          {(pull?.pulled_at || updatedAt) && (
            <div title={pull?.pulled_at ? new Date(pull.pulled_at).toLocaleString() : (updatedAt ? new Date(updatedAt).toLocaleString() : undefined)}>
              <span className="font-medium text-foreground">Updated</span> {relativeTime(pull?.pulled_at ?? updatedAt ?? null)}
            </div>
          )}
          {(rawPricing || moq) && (
            <div className="max-w-[36ch]">
              {rawPricing && <div title="What Scout captured off the listing"><span className="font-medium text-foreground">Listed:</span> {rawPricing}</div>}
              {moq && <div><span className="font-medium text-foreground">MOQ:</span> {moq}</div>}
            </div>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[10%]" title="Units per case (case_size)">Size</TableHead>
            <TableHead className="w-[10%]" title="Unit of measurement (kg, lb, g, L…)">Unit</TableHead>
            <TableHead className="w-[14%]" title="Container / packaging (case_type): drum, pail, bag…">Case type</TableHead>
            <TableHead className="w-[20%]">Case dims (est.)</TableHead>
            <TableHead className="w-[15%]">Price (total)</TableHead>
            <TableHead className="w-[15%]" title="Last scraped price for this pack — auto-updates when the marketplace price changes">Last price</TableHead>
            <TableHead className="w-[13%]">$ / unit</TableHead>
            <TableHead className="w-[12%] text-right">{canAct ? "" : ""}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.map((t, i) => (
            <TableRow key={i}>
              <TableCell>
                <Input
                  inputMode="decimal"
                  value={num(t.case_size)}
                  disabled={!canAct || pending}
                  placeholder="25"
                  onChange={(e) => setTier(i, { case_size: toNum(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <Input
                  value={t.unit_of_measurement ?? ""}
                  disabled={!canAct || pending}
                  placeholder="kg"
                  onChange={(e) => setTier(i, { unit_of_measurement: toText(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <Input
                  value={t.case_type ?? ""}
                  disabled={!canAct || pending}
                  placeholder="drum"
                  onChange={(e) => setTier(i, { case_type: toText(e.target.value) })}
                />
              </TableCell>
              <TableCell className="text-xs">
                {fmtCaseDims(resolveCaseDims(dimsByPack, t.pack_size)) ? (
                  <span
                    className="text-muted-foreground"
                    title="AI-estimated outer case from pack size — verify before freight quoting"
                  >
                    {fmtCaseDims(resolveCaseDims(dimsByPack, t.pack_size))}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <Input
                  inputMode="decimal"
                  value={num(t.price)}
                  disabled={!canAct || pending}
                  placeholder="450.00"
                  onChange={(e) => setTier(i, { price: toNum(e.target.value) })}
                />
              </TableCell>
              <TableCell className="text-xs tabular-nums align-middle">
                {(() => {
                  const prev = priorTiers[i]?.previous_price;
                  const changedAt = priorTiers[i]?.price_changed_at as string | undefined;
                  if (prev == null) return <span className="text-muted-foreground">—</span>;
                  const moved = t.price != null && Number(prev) !== Number(t.price);
                  return (
                    <span className={moved ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>
                      ${Number(prev).toFixed(2)}
                      {changedAt && (
                        <span className="ml-1 text-[10px] opacity-70" title={new Date(changedAt).toLocaleString()}>
                          {moved ? "changed " : "checked "}{relativeTime(changedAt)}
                        </span>
                      )}
                    </span>
                  );
                })()}
              </TableCell>
              <TableCell>
                {t.unit_price == null && derivedUnitPrice(t) != null ? (
                  <span
                    className="text-sm text-muted-foreground"
                    title="Derived from price ÷ size — updates automatically when you edit price or size."
                  >
                    {derivedUnitPrice(t)}
                    <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">est</span>
                  </span>
                ) : (
                  <Input
                    inputMode="decimal"
                    value={num(t.unit_price)}
                    disabled={!canAct || pending}
                    placeholder="18.00"
                    onChange={(e) => setTier(i, { unit_price: toNum(e.target.value) })}
                  />
                )}
              </TableCell>
              <TableCell className="text-right">
                {canAct && (
                  <button
                    type="button"
                    className="text-red-600 hover:underline text-xs disabled:opacity-50"
                    disabled={pending}
                    onClick={() => removeTier(i)}
                    aria-label="Remove tier"
                  >
                    remove
                  </button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {canAct && (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" disabled={pending} onClick={addTier}>
            + Add tier
          </Button>
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save tiers"}
          </Button>
          {updatedAt && !msg && (
            <span className="text-[11px] text-muted-foreground">Last edited {new Date(updatedAt).toLocaleDateString()}</span>
          )}
          {msg && (
            <span className={msg.kind === "ok" ? "text-xs text-emerald-600" : "text-xs text-red-600"}>{msg.text}</span>
          )}
        </div>
      )}
    </div>
  );
}
