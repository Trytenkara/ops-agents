import type { createAdminClient } from "@/lib/supabase/admin";
import { recheckMarketplaceQuote, type AggregatorSeller } from "./price-recheck";
import { shopifyFeedPull } from "./shopify-feed";
import { convertToUsd, roundUsd } from "@/lib/fx";
import { ensureMarketplaceCaseDims } from "@/lib/marketplace-case-dims-fill";
import { neverMarketplaceHostOf } from "@/lib/marketplace-hosts";
import { screenClonedListings } from "@/lib/clone-ring";
import { aggregatorNameOf, isAggregatorIndexUrl, isAggregatorPlatformName, shouldEnumerateAggregatorSellers } from "@/lib/aggregator-hosts";
import { getOrgAssignmentContext, orgAutoKey, resolveOperatorId, type AssignmentContext } from "@/lib/operator-assignment";
import { leadMarketKind } from "@/lib/lead-market";
import { splitPriceDelta } from "@/lib/price-delta";

type Admin = ReturnType<typeof createAdminClient>;

// #4 — marketplace pricing. New marketplace leads carry a listing URL but no
// pulled price. Attempt to auto-pull the listed price (reusing the same
// web_search recheck Agent 05 runs on expiring quotes); on success stamp the
// price onto the lead so it's populated in the pipeline, on failure (login
// wall, broken link, nothing found) flag the lead and open a case tagging the
// lead's operator to pull it by hand. Read-only on Tenkara — writes only to OA
// leads_in_flight.payload + cases.

// Per-run throughput is split so a re-check backlog can never starve first pulls
// of freshly-discovered leads (and vice-versa). Both share the same run deadline.
const FIRST_PULL_CAP = 20; // brand-new marketplace leads with no price yet (Sonnet+web_fetch, ~25s each).
// Already-pulled leads due for re-validation. Sized against the run deadline, not
// against the pool: 14 consecutive hourly runs each processed exactly the old
// 20+50 cap in 331-705s (mean ~500s) of the 700s budget, so the cap was binding
// while ~30% of the wall clock went unused. In FULL mode every pulled lead wants a
// daily re-check, and active-org demand (1,144) had only 1,200/day of capacity —
// 95% utilisation, which a single slow day pushes into permanent arrears.
//
// Overshooting the average on purpose: the batch loop checks the deadline BEFORE
// each batch's model calls, so a slow run truncates without wasting a pull and its
// leftovers roll to the next run (the pre-existing behaviour). A fast run now
// converts its spare budget into throughput instead of idling.
const RECHECK_CAP = 85;
const CONCURRENCY = 4;
const FLAG_AFTER_ATTEMPTS = 3; // needs_review is read this many times before a case is opened, so one flaky web_search result isn't a premature escalation. It does NOT stop the retries.

// A lead is never given up on. Only a structural verdict ends a pull (price
// found, or a host that has no checkout at all); every other outcome keeps the
// lead in the queue forever, with the gap between reads widening so persistence
// costs a bounded amount. Attempt 40 of a genuinely priceless page is one read a
// month, not a nightly re-failure, and the day the page starts publishing a
// price we are still there to see it.
// A stored URL that cannot hold a price: no product page lives at /contact,
// /about or a bare domain root, so reading one can only ever fail.
const NON_PRODUCT_PATH = /^\/?(contact([-_]?us)?|about([-_]?us)?|home|index)?\/?$/i;
function isNonProductUrl(u: string): boolean {
  try {
    return NON_PRODUCT_PATH.test(new URL(u).pathname);
  } catch {
    return false;
  }
}

function sameSite(a: string, b: string): boolean {
  try {
    const reg = (h: string) => h.replace(/^www\./, "").toLowerCase().split(".").slice(-2).join(".");
    return reg(new URL(a).hostname) === reg(new URL(b).hostname);
  } catch {
    return false;
  }
}

const RETRY_BACKOFF_DAYS = [1, 1, 3, 7, 14, 30];
function retryAfter(attempts: number): string {
  const days = RETRY_BACKOFF_DAYS[Math.min(attempts, RETRY_BACKOFF_DAYS.length - 1)];
  return new Date(Date.now() + days * 86400000).toISOString();
}

// Re-validation mode.
//  FULL (default): re-verify EVERY marketplace lead DAILY so pricing/info is always
//    current — next_check_at is always ~1 day out regardless of stability.
//  ADAPTIVE (env PRICE_PULL_MODE=adaptive): widen the interval per the volatility
//    ladder below (checks stable leads less often, snaps back to daily on a move).
// Adaptive stays live behind the flag; flip the env to switch. Intended to kick in
// once daily check volume gets large (> PRICE_PULL_DAILY_SOFT_LIMIT) — see index.ts.
const FULL_REFRESH = process.env.PRICE_PULL_MODE !== "adaptive";
const DAILY_SOFT_LIMIT = Number(process.env.PRICE_PULL_DAILY_SOFT_LIMIT || 500); // above this, notify + consider adaptive

// Volatility ladder used ONLY in adaptive mode. Marketplace prices drift, so a
// pulled lead isn't frozen — it's re-checked on a cadence that widens while the
// price holds steady and snaps back to daily the moment it moves (AIMD backoff).
const CHANGE_THRESHOLD_PCT = 1.0;                 // <1% move treated as unchanged (matches Agent 05's quote-recheck threshold).

// Currency safety net. The reader sometimes reports "USD" (or leaves it blank,
// which we treat as USD) for a listing that is actually in INR/EUR/etc.
const CURRENCY_TOKENS: Array<[RegExp, string]> = [
  [/₹|\binr\b|rupees?|(?:^|[^a-z])rs\.?\s*\d|\d\s*rs\.?(?:$|[^a-z])/i, "INR"],
  [/€|\beur\b|euros?/i, "EUR"],
  [/£|\bgbp\b/i, "GBP"],
  [/\bcny\b|\brmb\b|人民币|元/i, "CNY"],
  [/\baud\b/i, "AUD"],
  [/\bcad\b/i, "CAD"],
];
const DOMESTIC_CURRENCY_HOSTS: RegExp[] = [
  /\.in$/, /\.pk$/, /\.kz$/, /\.cn$/, /\.id$/, /\.vn$/, /\.br$/, /\.lk$/, /\.bd$/,
  /indiamart/, /exportersindia/, /tradeindia/, /flagma/,
];
function sniffCurrencyToken(text: string): string | null {
  for (const [re, code] of CURRENCY_TOKENS) if (re.test(text)) return code;
  return null;
}

const IMPLAUSIBLE_MOVE_FACTOR = 10;
const INTERVAL_LADDER_DAYS = [1, 2, 4, 7, 14, 30]; // stable_streak → days until next check (capped at 30).
const HISTORY_DEPTH = 10;                          // capped per-lead price-check history kept in payload.
// Re-checks are lower-stakes than a first extraction (comparing to a known
// baseline), so run them on a cheaper model. Override via env to A/B vs Sonnet.
const RECHECK_MODEL = process.env.MARKETPLACE_RECHECK_MODEL || "claude-haiku-4-5";

interface LeadRow {
  id: string;
  org_id: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  material_id: string | null;
  material_name: string | null;
  source: string | null;
  payload: any;
}

function listingUrl(payload: any): string | null {
  return (
    (payload?.enrichment?.contact?.contact_url as string | undefined) ??
    (payload?.supplier_website as string | undefined) ??
    (payload?.source_url as string | undefined) ??
    null
  );
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// Map an observed change-rate for a marketplace host to a starting cadence (days).
// Seeds a brand-new lead's first interval so a volatile marketplace keeps all its
// listings tight without each SKU having to independently prove it. Little/no
// history → conservative daily.
function priorDaysFor(checks: number, changes: number): number {
  if (checks < 2) return 1;
  const rate = changes / checks;
  if (rate >= 0.3) return 1;
  if (rate >= 0.1) return 2;
  if (changes > 0) return 7;
  return 14; // stable across ≥2 checks, never moved.
}

// Aggregate per-host price-change history across already-pulled leads into a
// starting-interval prior. One lightweight read per run; empty on first rollout
// (no history yet) so everything correctly starts at daily and warms up.
async function computeHostPriors(admin: Admin, activeOrgIds: string[]): Promise<Map<string, number>> {
  const priors = new Map<string, number>();
  const { data, error } = await admin
    .from("leads_in_flight")
    .select("payload")
    .eq("status", "active")
    .in("org_id", activeOrgIds)
    .eq("payload->marketplace_pull->>status", "pulled")
    .limit(1000);
  if (error || !data) return priors;
  const agg = new Map<string, { checks: number; changes: number }>();
  for (const r of data as { payload: any }[]) {
    const mp = r.payload?.marketplace_pull;
    const host = hostOf(mp?.source_url ?? listingUrl(r.payload));
    if (!host) continue;
    const hist = Array.isArray(mp?.history) ? mp.history : [];
    const a = agg.get(host) ?? { checks: 0, changes: 0 };
    a.checks += hist.length;
    a.changes += hist.filter((h: any) => h?.changed).length;
    agg.set(host, a);
  }
  for (const [host, a] of agg) priors.set(host, priorDaysFor(a.checks, a.changes));
  return priors;
}

// An aggregator index page is not a supplier: replace it with one lead per
// company actually listed on it, so every row a buyer sees links to a real
// seller instead of to Alibaba's search results. Returns how many were staged.
export async function expandAggregatorIndexPage(opts: {
  admin: Admin;
  log: (msg: string, meta?: any) => Promise<void> | void;
  runId: string | null;
  lead: LeadRow;
  indexUrl: string;
  sellers: AggregatorSeller[];
  // Retire the lead the sellers were read from. True when the platform itself was
  // recorded as the supplier, so the row was never a company. False when a real
  // company's link merely pointed at a category page: its sellers are new leads,
  // but the company itself is still a lead and the caller re-points it instead.
  retireParent: boolean;
}): Promise<number> {
  const { admin, log, runId, lead: l, indexUrl, sellers: read, retireParent } = opts;
  const aggregator = aggregatorNameOf(indexUrl);
  const { kept: sellers, screened } = screenClonedListings(read);
  if (screened.length) {
    await log(
      `Screened ${screened.length} cloned listing${screened.length === 1 ? "" : "s"} off ${aggregator ?? "an aggregator"} index page (same listing under ${new Set(screened.map((s) => s.supplier_name)).size} invented seller names): ${l.material_name}`,
      { level: "warn", step: "mp_aggregator_split", data: { lead_id: l.id, index_url: indexUrl, screened: screened.map((s) => ({ supplier_name: s.supplier_name, product_url: s.product_url })) } },
    );
  }
    // Don't re-stage sellers already on file for this material (a re-read of the
    // same index page, or a seller the scout found directly).
    const urls = sellers.map((s) => s.product_url);
    const { data: existing } = await admin
      .from("leads_in_flight")
      .select("payload")
      .eq("org_id", l.org_id)
      .eq("material_id", l.material_id)
      .in("payload->>source_url", urls);
    const taken = new Set((existing ?? []).map((r: any) => r.payload?.source_url).filter(Boolean));
    const fresh = sellers.filter((s) => !taken.has(s.product_url));
    if (fresh.length) {
      const { error } = await admin.from("leads_in_flight").insert(
        fresh.map((s) => ({
          org_id: l.org_id,
          supplier_name: s.supplier_name,
          supplier_id: null,
          material_name: l.material_name,
          material_id: l.material_id,
          stage: "raw" as const,
          status: "active" as const,
          source: l.source ?? "ai_discovery",
          payload: {
            inci_name: l.payload?.inci_name ?? null,
            tenkara_org_id: l.payload?.tenkara_org_id ?? null,
            // No supplier_website: a storefront listing is not the seller's own
            // site, and storing one makes enrichment domain-search the platform
            // and return the platform's OWN staff as this seller's contacts
            // (the same trap cleanSupplierWebsite guards at discovery). Every
            // consumer falls back to source_url, which holds the same listing,
            // so the field stays blank until we resolve a real site.
            source_url: s.product_url,
            supplier_country: s.country,
            supplier_role: "Reseller",
            site_type: "A",
            // The index page's numbers are recorded as text only. The child's own
            // price pull reads the seller's listing and publishes from there, so
            // nothing here can become a published price.
            pack_sizes_pricing: s.price != null ? `${s.price}${s.currency ? ` ${s.currency}` : ""}${s.pack_size ? ` / ${s.pack_size}` : ""}` : null,
            moq: s.moq,
            aggregator,
            aggregator_index_url: indexUrl,
            aggregator_parent_lead_id: l.id,
            confidence_hint: "lead",
            confidence_reason: "Low — unverified seller listed on an aggregator, needs human follow-up",
            relevance_tier: "Potential",
            scout_notes: `Listed on ${aggregator ?? "an aggregator"} under ${l.material_name ?? "this material"}.`,
          },
          confidence_score: 0.35,
          agent_run_id: runId,
        })),
      );
      if (error) {
        await log(`Aggregator seller insert failed for ${l.id}: ${error.message}`, { level: "error", step: "mp_aggregator_split", data: { lead_id: l.id } });
        return 0;
      }
    }
    // Retire the umbrella row. Terminal (not "dropped") because no operator
    // rejected it: it was never a supplier, and its sellers now stand in for it.
    if (retireParent) {
      await admin
        .from("leads_in_flight")
        .update({
          status: "terminal",
          stage: "terminal",
          drop_reason: "aggregator_index_page",
          payload: {
            ...(l.payload ?? {}),
            site_type: "A",
            drop_reason: "aggregator_index_page",
            aggregator_split: {
              at: new Date().toISOString(),
              index_url: indexUrl,
              sellers_found: read.length,
              sellers_staged: fresh.length,
              sellers_screened: screened.length || undefined,
            },
          },
        })
        .eq("id", l.id);
    }
    await log(
      `Aggregator index page split into ${fresh.length} seller lead${fresh.length === 1 ? "" : "s"} (${read.length} read${sellers.length - fresh.length ? `, ${sellers.length - fresh.length} already on file` : ""}${screened.length ? `, ${screened.length} cloned listings screened` : ""}): ${l.supplier_name} × ${l.material_name}`,
      { step: "mp_aggregator_split", data: { lead_id: l.id, index_url: indexUrl, staged: fresh.length } },
    );
    return fresh.length;
}

export interface LeadPullResult {
  processed: number;
  pulled: number;
  flagged: number;
  pending: number;
  notMarketplace: number;
  expanded: number;   // aggregator index pages split into one lead per seller
  sellersStaged: number;
  stoppedEarly: boolean;
}

export async function pullPricesForNewMarketplaceLeads(opts: {
  admin: Admin;
  runId: string;
  deadline: number;
  log: (msg: string, meta?: any) => Promise<void> | void;
}): Promise<LeadPullResult> {
  const { admin, runId, deadline, log } = opts;
  const empty: LeadPullResult = { processed: 0, pulled: 0, flagged: 0, pending: 0, notMarketplace: 0, expanded: 0, sellersStaged: 0, stoppedEarly: false };
  if (Date.now() > deadline) return empty;

  // Only pull for orgs that are actively sourcing. Paused ('off') orgs otherwise
  // monopolize this single global FIFO with their stale discovery backlog and
  // starve live clients (they never reach the fetch window). This mirrors the
  // sourcing_status gate the quote-recheck path already applies.
  const { data: activeOrgs, error: orgErr } = await admin
    .from("orgs")
    .select("id, is_internal")
    .in("sourcing_status", ["active", "sourcing_only"]);
  if (orgErr) {
    await log(`Active-org lookup failed (non-fatal): ${orgErr.message}`, { level: "warn", step: "mp_leads" });
    return empty;
  }
  const activeOrgRows = (activeOrgs ?? []).filter((o: any) => o.id);
  const activeOrgIds = activeOrgRows.map((o: any) => o.id);
  if (activeOrgIds.length === 0) return empty;

  // Real (paying) clients always drain their marketplace backlog before internal
  // test orgs (is_internal = true, e.g. Tenkara Internal Sourcing / Arlon Preview).
  // Otherwise a large internal test discovery flood sits ahead of a live client in
  // the FIFO and starves it. Internal orgs still get served — but only with whatever
  // cap is left after real clients are satisfied this run.
  const realOrgIds = activeOrgRows.filter((o: any) => !o.is_internal).map((o: any) => o.id);
  const internalOrgIds = activeOrgRows.filter((o: any) => o.is_internal).map((o: any) => o.id);

  const cols = "id, org_id, supplier_id, supplier_name, material_id, material_name, source, payload";
  const marketplaceFilter = "payload->>site_type.in.(M,MS,A),payload->>supplier_role.eq.Marketplace";
  const eligible = (l: LeadRow) => Boolean(l.material_name && listingUrl(l.payload));
  const nowIso = new Date().toISOString();

  // Cohort A — first pull: active marketplace leads with no pull attempt yet
  // (or still mid-retry). Marketplace is signalled by the scanner's site_type
  // (M/MS) or an explicit Marketplace role. Oldest-first (FIFO) within a tier.
  const queryFirst = async (orgIds: string[], limit: number): Promise<LeadRow[]> => {
    if (orgIds.length === 0 || limit <= 0) return [];
    const { data, error } = await admin
      .from("leads_in_flight")
      .select(cols)
      .eq("status", "active")
      .in("org_id", orgIds)
      .or("payload->marketplace_pull.is.null,payload->marketplace_pull->>status.eq.pending")
      // A retry is only due once its backoff has expired. Legacy rows carry no
      // retry_after and are treated as due.
      .or(`payload->marketplace_pull->>retry_after.is.null,payload->marketplace_pull->>retry_after.lte.${nowIso}`)
      .or(marketplaceFilter)
      // Never-attempted leads sort first (no retry_after), so an ever-growing
      // retry pool can never starve fresh discovery — the same guarantee
      // migration 0088 gives the contact re-queue.
      .order("payload->marketplace_pull->>retry_after", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) {
      await log(`Marketplace lead query failed (non-fatal): ${error.message}`, { level: "warn", step: "mp_leads" });
      return [];
    }
    return ((data ?? []) as LeadRow[]).filter(eligible);
  };

  // Cohort B — re-check: already-pulled leads whose next_check_at is due (or
  // legacy pulled leads with no cadence yet → next_check_at null, treated as due).
  const queryRecheck = async (orgIds: string[], limit: number): Promise<LeadRow[]> => {
    if (orgIds.length === 0 || limit <= 0) return [];
    const { data, error } = await admin
      .from("leads_in_flight")
      .select(cols)
      .eq("status", "active")
      .in("org_id", orgIds)
      .eq("payload->marketplace_pull->>status", "pulled")
      .or(`payload->marketplace_pull->>next_check_at.is.null,payload->marketplace_pull->>next_check_at.lte.${nowIso}`)
      .or(marketplaceFilter)
      .order("payload->marketplace_pull->>next_check_at", { ascending: true, nullsFirst: true }) // most-overdue first
      .limit(limit);
    if (error) {
      await log(`Marketplace re-check query failed (non-fatal): ${error.message}`, { level: "warn", step: "mp_leads" });
      return [];
    }
    return ((data ?? []) as LeadRow[]).filter(eligible);
  };

  // Real clients first; top up any remaining cap from internal test orgs.
  const withPriority = async (
    q: (orgIds: string[], limit: number) => Promise<LeadRow[]>,
    cap: number,
  ): Promise<LeadRow[]> => {
    const real = (await q(realOrgIds, cap * 3)).slice(0, cap);
    if (real.length >= cap || internalOrgIds.length === 0) return real;
    const remaining = cap - real.length;
    const internal = (await q(internalOrgIds, remaining * 3)).slice(0, remaining);
    return [...real, ...internal];
  };

  const firstLeads = await withPriority(queryFirst, FIRST_PULL_CAP);
  const recheckLeads = await withPriority(queryRecheck, RECHECK_CAP);
  const leads = [...firstLeads, ...recheckLeads];
  if (leads.length === 0) return empty;

  // Volume signal: in FULL (daily re-verify) mode, if the due-recheck pool keeps
  // maxing out the per-run cap the daily check volume is getting large — the point
  // at which adaptive (volatility-based) mode should take over. Surfaced as a warn
  // for ops/health now; the Slack notify + auto-switch to PRICE_PULL_MODE=adaptive
  // is the follow-up hook.
  if (FULL_REFRESH && recheckLeads.length >= RECHECK_CAP) {
    await log(
      `Full-mode marketplace re-check pool hit the per-run cap (${RECHECK_CAP}). If daily volume exceeds ~${DAILY_SOFT_LIMIT} checks, switch to PRICE_PULL_MODE=adaptive (volatility cadence).`,
      { level: "warn", step: "mp_volume", data: { recheck_batch: recheckLeads.length, soft_limit: DAILY_SOFT_LIMIT } },
    );
  }

  // Per-host starting-cadence priors, for seeding brand-new leads' first interval.
  const hostPriors = await computeHostPriors(admin, activeOrgIds);

  // Operator pool + assignments per org, for tagging the flag case.
  const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
  const ctxByOrg = new Map<string, AssignmentContext>();
  for (const oid of orgIds) {
    ctxByOrg.set(oid, await getOrgAssignmentContext(admin, oid));
  }
  const operatorFor = (l: LeadRow): string | null => {
    if (!l.org_id) return null;
    const ctx = ctxByOrg.get(l.org_id);
    if (!ctx) return null;
    // Marketplace leads usually have no supplier_id — key on the supplier the way
    // the Leads tab and outreach do, so the case lands on the operator who already
    // owns that supplier instead of on a per-lead pick of its own.
    const key = orgAutoKey(ctx, {
      supplierId: l.supplier_id,
      supplierName: (l as any).supplier_name ?? null,
      email: (l.payload as any)?.supplier_contact_email ?? null,
      leadId: l.id,
    });
    return resolveOperatorId(ctx, key, leadMarketKind((l.payload as any)?.site_type), (l as any).supplier_name ?? null);
  };

  let processed = 0;
  let pulled = 0;
  let flagged = 0;
  let pending = 0;
  let notMarketplace = 0;
  let expanded = 0;
  let sellersStaged = 0;
  let stoppedEarly = false;

  const expandIndexPage = (l: LeadRow, indexUrl: string, sellers: AggregatorSeller[], retireParent: boolean) =>
    expandAggregatorIndexPage({ admin, log, runId, lead: l, indexUrl, sellers, retireParent });

  const processOne = async (l: LeadRow): Promise<"pulled" | "flagged" | "pending" | "not_marketplace" | "expanded" | null> => {
    const url = listingUrl(l.payload)!;
    const priorPull = l.payload?.marketplace_pull ?? null;
    // A re-check is a lead we've already priced (status 'pulled'); a first pull
    // is anything else. Re-checks compare to a known baseline on a cheaper model.
    const isRecheck = priorPull?.status === "pulled";
    const priorPrice = isRecheck ? (typeof priorPull?.price === "number" ? priorPull.price : null) : null;
    // The listed-currency price on file. Change detection thresholds on THIS, not
    // on the USD figure: a rupee listing that never moved still drifts in dollars
    // every time the rate does, and counting that as a seller reprice both lied in
    // `history[].changed` and inflated the per-host volatility prior that decides
    // how often we re-read the page. Null for USD listings, where the two are equal.
    const priorNativePrice = isRecheck && typeof priorPull?.native_price === "number" ? priorPull.native_price : null;
    const priorNativeCurrency = isRecheck ? (priorPull?.native_currency ?? null) : null;
    // Two shapes of "the platform is the lead", handled differently:
    //  - platformAsSupplier: no real company on the row at all. Ask the reader to
    //    enumerate the sellers on the page so we can replace it with one lead each.
    //  - staleIndexUrl: a real company whose stored link points at a category
    //    page. The normal read already searches out its own product page; we just
    //    persist that repaired URL so the row stops linking to the category.
    const platformAsSupplier = isAggregatorPlatformName(l.supplier_name, l.material_name);
    const staleIndexUrl = !platformAsSupplier && isAggregatorIndexUrl(url);
    // Ask for the seller roster on anything that could be an index page, not only
    // when the supplier NAME gave it away. Keying on the name meant a category page
    // the scout had attributed to one real company was never fanned out: measured
    // 2026-08-05, 154 aggregator leads named the platform and were expanded, while
    // 262 more sat on genuine multi-seller index URLs under a company's name and
    // were never even asked. The page decides; the name and URL only trigger asking.
    const enumerateSellers = platformAsSupplier || shouldEnumerateAggregatorSellers(url);
    let result;
    const noCheckout = neverMarketplaceHostOf(url);
    if (noCheckout) {
      // No checkout by host, so skip the read entirely and fall through to the
      // terminal branch below. A directory is never the supplier; a direct
      // quote-desk catalogue IS the supplier and still goes to outreach.
      result = {
        classification: "not_marketplace" as const,
        market_kind: "marketplace" as const, aggregator: null,
        current_price: null, currency: null, pack_size: null, unit_price: null,
        tiers: [] as any[], moq: null, lead_time: null, shipping: null,
        stock_status: null, stock_note: null,
        source_url: url, source_citations: [] as any[],
        notes:
          noCheckout.kind === "directory"
            ? `${noCheckout.host} is a lead-source directory (no checkout) — used to find suppliers, never a marketplace price.`
            : `${noCheckout.host} is a direct supplier's own catalogue with no checkout (orders route through a quote desk) — no marketplace price to publish; quote it through outreach.`,
        index_page: false, sellers: [] as any[],
      };
    } else {
    // Tier A½: if this is a Shopify store, its own product feed states every
    // variant price and the shop's base currency, so read that instead of
    // paying a model to interpret the rendered page. Cheaper, faster, and more
    // accurate on ladders — the DOM often shows one geo-localized number where
    // the feed lists the whole ladder. Falls through on any miss.
    //
    // Skipped when we need the seller roster: that is a question about the page,
    // which a single-product feed cannot answer.
    let shopify: Awaited<ReturnType<typeof shopifyFeedPull>> = null;
    if (!enumerateSellers) {
      shopify = await shopifyFeedPull({
        url,
        material: l.material_name ?? "",
        supplier: l.supplier_name,
      }).catch(() => null);
    }
    if (shopify) {
      result = shopify;
    } else {
    try {
      result = await recheckMarketplaceQuote({
        supplier_name: l.supplier_name ?? "",
        material_name: l.material_name ?? "",
        product_url: url,
        baseline_price: priorPrice,
        case_size: null,
        unit: null,
        // Enumerating sellers is a harder read than a price check, so an
        // umbrella lead always goes to the full model even on a re-check.
        model: isRecheck && !enumerateSellers ? RECHECK_MODEL : undefined,
        enumerate_sellers: enumerateSellers,
        index_page_expected: platformAsSupplier,
      });
    } catch (e: any) {
      result = { classification: "needs_review" as const, market_kind: (aggregatorNameOf(url) ? "aggregator" : "marketplace") as "marketplace" | "aggregator", aggregator: aggregatorNameOf(url), current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], moq: null, lead_time: null, shipping: null, source_url: url, source_citations: [], notes: `pull failed: ${e?.message ?? e}`, index_page: false, sellers: [], infra_failure: true };
    }
    }
    }

    // Index page confirmed: split it into its sellers.
    if (result.index_page && result.sellers.length > 0) {
      if (platformAsSupplier) {
        sellersStaged += await expandIndexPage(l, url, result.sellers, true);
        return "expanded";
      }
      // A real company whose stored link turned out to be a category page. The
      // sellers on it are new leads, but this row is a company an operator may
      // already be working, so it survives the split and gets re-pointed at its
      // own listing when the page names it.
      const key = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const self = key(l.supplier_name)
        ? result.sellers.find((s) => {
            const a = key(s.supplier_name);
            const b = key(l.supplier_name);
            return a && (a === b || a.startsWith(b) || b.startsWith(a));
          })
        : undefined;
      sellersStaged += await expandIndexPage(l, url, result.sellers.filter((s) => s !== self), false);
      if (self) {
        const nextPayload = {
          ...(l.payload ?? {}),
          supplier_website: self.product_url,
          source_url: self.product_url,
          aggregator_index_url: url,
          // Back to 'pending' so the next pass prices the company's own listing.
          // Attempts carry over, so a URL that keeps resolving to a category page
          // still runs out of retries instead of looping forever.
          marketplace_pull: {
            ...(l.payload?.marketplace_pull ?? {}),
            status: "pending" as const,
            reason: "index_page_self_listing_repaired",
            source_url: self.product_url,
            at: new Date().toISOString(),
          },
        };
        const { error: selfErr } = await admin.from("leads_in_flight").update({ payload: nextPayload }).eq("id", l.id);
        if (selfErr) {
          await log(`Self-listing repair failed for ${l.id}: ${selfErr.message}`, { level: "error", step: "mp_aggregator_split", data: { lead_id: l.id } });
          return null;
        }
        await log(`Re-pointed ${l.supplier_name} from an index page to its own listing on ${aggregatorNameOf(url) ?? "the platform"}: ${l.material_name}`, {
          step: "mp_aggregator_split",
          data: { lead_id: l.id, index_url: url, self_listing: self.product_url },
        });
        return "expanded";
      }
      // The page lists sellers but not this company, so there is nothing here to
      // price. Fall through to the normal needs_review path: its backoff decides
      // when to retry and opens an operator case if the link never resolves.
      result.classification = "needs_review";
      result.notes = `Stored link is a ${aggregatorNameOf(url) ?? "platform"} index page listing ${result.sellers.length} other seller${result.sellers.length === 1 ? "" : "s"}, not ${l.supplier_name ?? "this company"}; its sellers were staged as their own leads. ${result.notes ?? ""}`.trim();
    }
    // Nothing readable on it. The platform is not a company, so the row can
    // never become a lead no matter what the page turned out to be. (Lead-source
    // directories keep their own terminal branch below, which says so precisely.)
    if (platformAsSupplier && !noCheckout) {
      await admin
        .from("leads_in_flight")
        .update({
          status: "terminal",
          stage: "terminal",
          drop_reason: "aggregator_index_page",
          payload: {
            ...(l.payload ?? {}),
            site_type: "A",
            drop_reason: "aggregator_index_page",
            aggregator_split: { at: new Date().toISOString(), index_url: url, sellers_found: 0, sellers_staged: 0, notes: result.notes ?? null },
          },
        })
        .eq("id", l.id);
      await log(`Aggregator platform recorded as the supplier and no sellers were readable — retiring the row: ${l.supplier_name} × ${l.material_name}`, {
        step: "mp_aggregator_split",
        data: { lead_id: l.id, index_url: url, notes: result.notes ?? null },
      });
      return "expanded";
    }

    // The row links to whatever is in the payload, so a lead left pointing at a
    // category page keeps showing "Alibaba search results" as its supplier link
    // even after the reader found the company's own listing. Promote the page it
    // actually read to be the lead's URL.
    // The stored link is often not a product page at all: discovery saved the
    // supplier's /contact page or bare homepage, the reader then searched and
    // found the real listing, and until now that correction was thrown away and
    // the same dead URL was read again on every retry. Promote it, so attempts
    // compound instead of repeating. Only within the same site: a link to some
    // other company's page is a different lead, not a repair.
    const repairable = staleIndexUrl || isNonProductUrl(url);
    const repairedUrl =
      repairable &&
      result.source_url &&
      result.source_url !== url &&
      !isAggregatorIndexUrl(result.source_url) &&
      (staleIndexUrl || sameSite(url, result.source_url))
        ? result.source_url
        : null;
    const withRepairedUrl = (payload: any): any => {
      if (!repairedUrl) return payload;
      const next = { ...payload, supplier_website: repairedUrl, source_url: repairedUrl, aggregator_index_url: url };
      if (payload?.enrichment?.contact?.contact_url === url) {
        next.enrichment = { ...payload.enrichment, contact: { ...payload.enrichment.contact, contact_url: repairedUrl } };
      }
      return next;
    };

    // Currency safety net (runs BEFORE conversion below). Correct a wrong/blank
    // currency label so the conversion step actually fires, and quarantine prices
    // from domestic-currency hosts whose currency we can't confirm — rather than
    // letting a raw foreign number publish as USD.
    // Skipped when the currency was read from a source that states it outright
    // (a Shopify /meta.json). Both branches below are heuristics over page text
    // and the TLD, so on a .in-hosted store whose feed authoritatively says USD
    // they would quarantine a correct price as "unconfirmed".
    if (result.classification === "current_price_found" && !result.currency_authoritative) {
      const priceText = [result.pack_size, result.notes, ...result.tiers.map((t) => t.pack_size)]
        .filter(Boolean)
        .join(" | ");
      const token = sniffCurrencyToken(priceText);
      const host = hostOf(result.source_url ?? url) ?? "";
      const domesticHost = DOMESTIC_CURRENCY_HOSTS.some((re) => re.test(host));
      const labeledUsdOrBlank = result.currency == null || result.currency === "USD";
      if (token && token !== "USD" && result.currency !== token) {
        // Explicit foreign token in the price text overrides a wrong/blank label;
        // the conversion block below then converts it to USD.
        result.notes = `Currency corrected to ${token} (detected in price text; was ${result.currency ?? "unspecified"}). ${result.notes ?? ""}`.trim();
        result.currency = token;
      } else if (labeledUsdOrBlank && domesticHost) {
        // Domestic-currency host with no positive USD confirmation — refuse to
        // publish an unconverted number as USD; flag for manual confirmation.
        result.classification = "needs_review";
        result.current_price = null;
        result.unit_price = null;
        result.tiers = [];
        result.notes = `Price on a domestic-currency host (${host}) with unconfirmed currency — not publishing as USD. ${result.notes ?? ""}`.trim();
      }
    }

    // Normalize EVERY listed non-USD price to USD before we publish or store it:
    // the single current_price/unit_price AND every tier in the ladder. Converting
    // only current_price left the tier ladder in the listed currency (e.g. INR from
    // IndiaMART) while marketplace_pull.price became USD, so the Control Room rendered
    // a raw ₹ value as "$" — a ~85x overstatement. If no rate is available for the
    // listed currency we must NOT emit an unconverted foreign number labeled USD, so
    // downgrade to needs_review and drop the numbers rather than publish a wrong price.
    if (result.currency && result.currency !== "USD") {
      const listed = result.currency;
      const probe = await convertToUsd(1, listed).catch(() => null);
      if (!probe) {
        result.classification = "needs_review";
        result.current_price = null;
        result.unit_price = null;
        result.tiers = [];
        result.notes = `Listed in ${listed}; USD conversion unavailable — not publishing an unconverted price. ${result.notes ?? ""}`.trim();
      } else {
        // Keep the listed amount and the rate we used. Converting in place used to
        // destroy both, which made a later USD move impossible to attribute: a lead
        // going $100 → $105 could be the seller repricing or just the rupee moving,
        // and nothing on the row distinguished them. With native + rate stored, the
        // split is arithmetic, and the 6h FX pass can restate USD without a re-scrape.
        const rate = probe.rate;
        const toUsd = (n: number | null): number | null =>
          n == null || !Number.isFinite(n) ? n : roundUsd(n * rate);
        result.native_price = result.current_price;
        result.native_unit_price = result.unit_price;
        result.native_currency = listed;
        result.fx_rate = rate;
        result.fx_rate_at = new Date().toISOString();
        result.current_price = toUsd(result.current_price);
        result.unit_price = toUsd(result.unit_price);
        result.tiers = result.tiers.map((t) => ({
          ...t,
          native_price: t.price,
          native_unit_price: t.unit_price,
          native_currency: listed,
          fx_rate: rate,
          price: toUsd(t.price),
          unit_price: toUsd(t.unit_price),
        }));
        result.currency = "USD";
      }
    } else if (typeof result.current_price === "number" && (!result.currency || result.currency === "USD")) {
      // Blank counts as USD *here specifically*, and only because the two guards
      // above have already run: an explicit foreign token would have relabelled
      // this, and a blank on a domestic-currency host would have been quarantined
      // with its prices dropped. So a blank reaching this point is a dollar site,
      // and the write below publishes it as USD regardless. Stamping it is exactly
      // as strong a claim as the price itself.
      //
      // Matching only "USD" was the first attempt and it silently did nothing:
      // the extractor usually returns no currency at all on US pages, so the
      // common case fell through both branches and stayed unstamped.
      //
      // The price check is not defensive padding: a result with no price (an
      // unreadable listing, a non-marketplace verdict) has nothing to denominate,
      // and stamping one would assert a currency for a number that does not exist.
      // Stamp USD listings too, even though there is nothing to convert. Without
      // this, native_currency is null for both "the page listed dollars" and "we
      // read this page before native capture shipped" — and those must not render
      // the same. A null read as USD would let the delta split attribute a legacy
      // INR lead's entire USD move to the seller, which is a fabricated
      // attribution on precisely the rows the split exists to disambiguate.
      // Null now means unknown, and the UI says so instead of guessing.
      result.native_price = result.current_price;
      result.native_unit_price = result.unit_price;
      result.native_currency = "USD";
      result.fx_rate = 1;
      result.fx_rate_at = new Date().toISOString();
      result.tiers = result.tiers.map((t) => ({
        ...t,
        native_price: t.price,
        native_unit_price: t.unit_price,
        native_currency: "USD",
        fx_rate: 1,
      }));
    }

    if (
      result.classification === "current_price_found" &&
      (typeof result.current_price !== "number" || !Number.isFinite(result.current_price) || result.current_price <= 0)
    ) {
      result.notes = `Invalid nonpositive marketplace price; not publishing. ${result.notes ?? ""}`.trim();
      result.classification = "needs_review";
      result.current_price = null;
      result.unit_price = null;
      result.tiers = [];
    }

    // Catastrophic-move guard. Before trusting a re-check's number, sanity-check it
    // against the price on file: an order-of-magnitude swing in either direction is
    // almost certainly a misread, not a real move.
    if (
      isRecheck &&
      result.classification === "current_price_found" &&
      typeof result.current_price === "number" &&
      result.current_price > 0 &&
      priorPrice != null &&
      priorPrice > 0
    ) {
      const ratio = result.current_price / priorPrice;
      if (ratio <= 1 / IMPLAUSIBLE_MOVE_FACTOR || ratio >= IMPLAUSIBLE_MOVE_FACTOR) {
        result.notes = `Implausible price move: $${priorPrice} on file → $${result.current_price} read (${ratio < 1 ? `-${Math.round((1 - ratio) * 100)}%` : `${ratio.toFixed(1)}x`}). Likely a misread/placeholder or wrong-page read; keeping prior price for manual confirmation. ${result.notes ?? ""}`.trim();
        result.classification = "needs_review";
        result.current_price = null;
        result.unit_price = null;
        result.tiers = [];
      }
    }

    // Checkout is the truest marketplace test (per ops). If the reader positively
    // determined the listing has a price but NO online checkout — a plain price
    // listing, a distributor list-price page, or a B2B quote/inquiry listing — it
    // is not a marketplace. Terminate: never publish a price, drop it from both
    // re-pull pools (terminal status), and downgrade site_type M/MS→N so it leaves
    // the live marketplace price index (leadMarketKind reads site_type). No retry,
    // no manual-pull case: there is no marketplace price for a human to pull either.
    if (result.classification === "not_marketplace") {
      const terminalIso = new Date().toISOString();
      const priorSiteType = l.payload?.site_type ?? null;
      const nextPayload: any = { ...(l.payload ?? {}) };
      if (priorSiteType === "M" || priorSiteType === "MS") nextPayload.site_type = "N";
      nextPayload.marketplace_pull = {
        status: "not_marketplace" as const,
        reason: "not_marketplace",
        source_url: result.source_url ?? url,
        last_notes: result.notes ?? null,
        at: terminalIso,
      };
      nextPayload.marketplace_checkout = {
        has_checkout: false,
        checked_at: terminalIso,
        source_url: result.source_url ?? url,
        site_type_corrected_from: (priorSiteType === "M" || priorSiteType === "MS") ? priorSiteType : null,
        notes: result.notes ?? null,
      };
      const { error: upErr } = await admin
        .from("leads_in_flight")
        .update({ payload: nextPayload })
        .eq("id", l.id);
      if (upErr) {
        await log(`Lead payload update failed for ${l.id}: ${upErr.message}`, { level: "error", step: "mp_leads", data: { lead_id: l.id } });
        return null;
      }
      await log(`Not a marketplace (no checkout) — not publishing, removed from price index: ${l.supplier_name} × ${l.material_name}`, {
        step: "mp_not_marketplace",
        data: { lead_id: l.id, site_type_corrected_from: nextPayload.marketplace_checkout.site_type_corrected_from, source_url: nextPayload.marketplace_pull.source_url },
      });
      return "not_marketplace";
    }

    // Aggregators (Alibaba, IndiaMART, ...) are a third market kind alongside
    // marketplace and direct: multi-seller platforms where ordering runs through
    // a Send Inquiry form, so the listed number is an indicative ask rather than
    // a checkout price. We keep and refresh it exactly like a marketplace price,
    // but stamp WHICH aggregator it came from and mark the trust level so the
    // Control Room can filter it into its own tab instead of blending it in.
    const aggregatorName =
      result.market_kind === "aggregator"
        ? result.aggregator ?? aggregatorNameOf(result.source_url ?? url)
        : null;
    const aggregatorMark = aggregatorName
      ? { market_kind: "aggregator" as const, aggregator: aggregatorName, price_trust: "low" as const }
      : {};

    const gotPrice = result.classification === "current_price_found" && result.current_price != null;
    const reason = result.classification; // current_price_found | login_required | link_broken | needs_review
    // login_required / link_broken are actionable and escalate on the first hit.
    // needs_review is the transient/ambiguous catch-all (web_search hiccup, JSON
    // parse failure, multi-SKU / RFQ-only / pack-size mismatch) — retry it across
    // a few hourly runs before opening a case, so one flaky result isn't a
    // permanent escalation "without information".
    const actionable = reason === "login_required" || reason === "link_broken";
    const priorAttempts = Number(l.payload?.marketplace_pull?.attempts ?? 0);
    // A failure that taught us nothing about the page (API 5xx, no JSON back, a
    // read that ran out of tokens) is not an attempt and must not widen the
    // backoff: retry it at full speed tomorrow.
    const infraFailure = !gotPrice && result.infra_failure === true;
    const attempts = gotPrice || infraFailure ? priorAttempts : priorAttempts + 1;
    // Escalation opens the operator case; it no longer ends the lead's life.
    // Actionable reasons (login wall, dead link) surface on the first hit,
    // needs_review only once it has survived a few reads.
    const escalate = !gotPrice && !infraFailure && (actionable || attempts >= FLAG_AFTER_ATTEMPTS);

    // Adaptive cadence (only meaningful on a successful pull). On a re-check, a
    // ≥1% move resets to daily and widens the ladder while it holds; a first pull
    // seeds its starting interval from the per-host volatility prior.
    const nowIso = new Date().toISOString();

    // Availability, and WHEN the listing went away. `out_of_stock_since` is
    // sticky across re-reads: without it every pass would restamp today and the
    // row could only ever say "out of stock as of now", which is the one thing an
    // operator already knows. It clears the moment the page says buyable again.
    // A read where the page said nothing about stock is silence, not a return to
    // in-stock, so it carries the last verdict forward rather than erasing it.
    const priorStock = priorPull?.stock_status ?? null;
    const stock = result.stock_status
      ? {
          stock_status: result.stock_status,
          stock_note: result.stock_note ?? null,
          stock_checked_at: nowIso,
          out_of_stock_since:
            result.stock_status === "in_stock"
              ? null
              : priorStock === result.stock_status
              ? (priorPull?.out_of_stock_since ?? nowIso)
              : nowIso,
        }
      : {
          stock_status: priorStock,
          stock_note: priorPull?.stock_note ?? null,
          stock_checked_at: priorPull?.stock_checked_at ?? null,
          out_of_stock_since: priorPull?.out_of_stock_since ?? null,
        };
    const soldOut = stock.stock_status === "out_of_stock" || stock.stock_status === "discontinued";

    let cadence: {
      check_interval_days: number;
      next_check_at: string;
      stable_streak: number;
      last_change_at: string | null;
      previous_price: number | null;
      previous_native_price: number | null;
      previous_fx_rate: number | null;
      history: any[];
    } | null = null;
    if (gotPrice) {
      // Compare like for like. When both scrapes carry a native price in the SAME
      // currency, that pair is the seller's actual asking price and FX cancels out
      // of the comparison entirely. Otherwise fall back to USD (a USD listing, or a
      // legacy row predating native capture, where USD is all we have).
      const nativeComparable =
        priorNativePrice != null &&
        priorNativePrice > 0 &&
        result.native_price != null &&
        result.native_currency != null &&
        priorNativeCurrency === result.native_currency;
      const [baseline, current] = nativeComparable
        ? [priorNativePrice!, result.native_price!]
        : [priorPrice, result.current_price];
      const changed =
        baseline != null &&
        baseline > 0 &&
        current != null &&
        Math.abs(current - baseline) / baseline >= CHANGE_THRESHOLD_PCT / 100;
      let intervalDays: number;
      let streak: number;
      if (!isRecheck) {
        // First pull → seed from host prior (defaults to daily).
        streak = 0;
        intervalDays = hostPriors.get(hostOf(result.source_url ?? url) ?? "") ?? 1;
      } else if (changed) {
        streak = 0;
        intervalDays = 1;
      } else {
        streak = Number(priorPull?.stable_streak ?? 0) + 1;
        intervalDays = INTERVAL_LADDER_DAYS[Math.min(streak, INTERVAL_LADDER_DAYS.length - 1)];
      }
      // FULL mode (default): re-verify daily regardless of stability. We still track
      // `streak`/`history`/`changed` above so a later switch to adaptive has the
      // volatility signal ready — we just override the interval to 1 day here.
      if (FULL_REFRESH) intervalDays = 1;
      const priorHistory = Array.isArray(priorPull?.history) ? priorPull.history : [];
      const history = [
        ...priorHistory,
        {
          at: nowIso,
          price: result.current_price,
          native_price: result.native_price ?? null,
          native_currency: result.native_currency ?? null,
          fx_rate: result.fx_rate ?? null,
          changed,
        },
      ].slice(-HISTORY_DEPTH);
      cadence = {
        check_interval_days: intervalDays,
        next_check_at: new Date(Date.now() + intervalDays * 86400000).toISOString(),
        stable_streak: streak,
        last_change_at: changed ? nowIso : (priorPull?.last_change_at ?? null),
        // The price at the previous scrape, so the Quotes/marketplace tab can show a
        // "last price" column next to the auto-updated current price. The native and
        // rate counterparts are what let the tab split that delta into the part the
        // seller caused and the part the exchange rate caused.
        previous_price: priorPrice ?? (priorPull?.previous_price ?? null),
        previous_native_price: priorNativePrice ?? (priorPull?.previous_native_price ?? null),
        previous_fx_rate: (typeof priorPull?.fx_rate === "number" ? priorPull.fx_rate : null) ?? (priorPull?.previous_fx_rate ?? null),
        history,
        ...(() => {
          const s = splitPriceDelta(
            {
              usd: priorPrice ?? null,
              native: priorNativePrice ?? null,
              rate: (typeof priorPull?.fx_rate === "number" ? priorPull.fx_rate : null) ?? (priorPull?.previous_fx_rate ?? null),
              currency: priorPull?.native_currency ?? null,
            },
            {
              usd: result.current_price,
              native: result.native_price ?? null,
              rate: result.fx_rate ?? null,
              currency: result.native_currency ?? null,
            },
          );
          return {
            price_change_source: s.source === "none" ? (priorPull?.price_change_source ?? "none") : s.source,
            supplier_delta_usd: s.supplierDelta,
            currency_delta_usd: s.currencyDelta,
            // The price to reissue a quote from when the verdict is 'both'.
            supplier_price_usd: s.supplierPriceUsd,
            // Stamped ONLY when the seller moved. This is the column an operator
            // reads to answer "when did this supplier last actually reprice",
            // and it has to survive every FX restatement in between, otherwise
            // an hourly rate pass would make every supplier look like it
            // repriced an hour ago.
            supplier_price_changed_at:
              s.source === "supplier" || s.source === "both"
                ? nowIso
                : (priorPull?.supplier_price_changed_at ?? null),
          };
        })(),
      };
    }

    // A re-check that failed to read a price must NOT destroy the good price we
    // already have on file. Keep the last pull, defer the next check by a day,
    // and record the miss while still escalating repeated failures.
    let preservedRecheckPull: any = null;
    if (!gotPrice && isRecheck) {
      const recheckMisses = Number(priorPull?.recheck_misses ?? 0) + 1;
      const deferPull = {
        ...priorPull,
        next_check_at: new Date(Date.now() + 86400000).toISOString(),
        recheck_misses: recheckMisses,
        attempts,
        last_recheck_reason: reason,
        last_recheck_at: nowIso,
        ...stock,
        ...aggregatorMark,
      };
      preservedRecheckPull = deferPull;
      const { error: upErr } = await admin
        .from("leads_in_flight")
        .update({
          payload: withRepairedUrl({
            ...(l.payload ?? {}),
            ...(aggregatorName ? { site_type: "A" } : {}),
            marketplace_pull: deferPull,
          }),
        })
        .eq("id", l.id);
      if (upErr) {
        await log(`Lead payload update failed for ${l.id}: ${upErr.message}`, { level: "error", step: "mp_leads", data: { lead_id: l.id } });
        return null;
      }
      if (!escalate) {
        await log(`Marketplace re-check inconclusive (${reason}) — keeping last price, retrying tomorrow: ${l.supplier_name} × ${l.material_name}`, {
          step: "mp_recheck_miss",
          data: { lead_id: l.id, reason, recheck_misses: recheckMisses, attempts },
        });
        return "pending";
      }
    }

    const pull = gotPrice
      ? {
          status: "pulled" as const,
          unit_price: result.unit_price,
          price: result.current_price,
          pack_size: result.pack_size,
          currency: "USD",
          // The listing as it was actually printed, plus the rate used to publish
          // the USD figure above. Null on a USD listing. The 0068 invariant only
          // constrains `currency`, so these sit beside it without conflict.
          native_price: result.native_price ?? null,
          native_unit_price: result.native_unit_price ?? null,
          native_currency: result.native_currency ?? null,
          fx_rate: result.fx_rate ?? null,
          fx_rate_at: result.fx_rate_at ?? null,
          // Level-2 listing fields (null unless the page showed them). Consumed by
          // the marketplace quote/supplier profile seeders.
          moq: result.moq,
          lead_time: result.lead_time,
          shipping: result.shipping,
          source_url: result.source_url ?? url,
          pulled_at: nowIso,
          // What actually moved this number last. A price can change without any
          // page being read (the 6-hourly FX pass restates the USD figure off a
          // new rate), so "updated 2h ago" on its own is ambiguous: it may mean a
          // fresh reading of the seller's page or pure arithmetic on a months-old
          // one. Readers that need a genuine observation must check this, not the
          // timestamp.
          price_source: "marketplace_scrape",
          price_source_at: nowIso,
          ...cadence!,
          ...stock,
          ...aggregatorMark,
        }
      : preservedRecheckPull ?? {
          // Always 'pending'. There is no terminal give-up state: `flagged` is a
          // display flag for the operator queue, and the lead keeps its place in
          // the retry rotation whether or not a human ever looks at it.
          status: "pending" as const,
          flagged: escalate,
          reason,
          attempts,
          retry_after: retryAfter(attempts),
          source_url: result.source_url ?? url,
          last_notes: result.notes ?? null,
          at: new Date().toISOString(),
          ...stock,
          ...aggregatorMark,
        };

    // Populate the same price_tiers the Marketplace-pricing tab renders — but
    // never clobber tiers an operator already entered. A re-check (prior status
    // 'pulled') owns the ladder it wrote earlier, so it may refresh it; a lead
    // whose tiers came from an operator is left alone.
    const nextPayload: any = withRepairedUrl({ ...(l.payload ?? {}), marketplace_pull: pull });
    // site_type is what every reader classifies off (leadMarketKind), so move the
    // lead into the aggregator bucket here rather than only tagging the pull.
    // Never for a lead that already captured the seller's own email: the listing
    // still lives on an aggregator host, so this would keep re-flipping it back to
    // "A" on every recheck and silently undo the direct-contact reclassification.
    if (aggregatorName && !l.payload?.aggregator_direct_contact) nextPayload.site_type = "A";
    const existingTiers = Array.isArray(l.payload?.price_tiers) ? l.payload.price_tiers : [];
    const operatorEdited = !!l.payload?.price_tiers_updated_by;
    let writtenTierPacks: string[] = [];
    if (gotPrice && (existingTiers.length === 0 || (isRecheck && !operatorEdited))) {
      // Track last price + change PER TIER (not just the base): match each new
      // pack size to its prior scrape by pack_size so the marketplace tab can show
      // current-vs-last + a changed flag for EVERY tier. previous_price carries the
      // prior scrape's price for that pack (its own prior previous_price if this
      // scrape didn't move); price_changed_at stamps when that tier last moved.
      const packKey = (p: any) => String(p ?? "").trim().toLowerCase();
      const priorByPack = new Map((existingTiers as any[]).map((t) => [packKey(t.pack_size), t]));
      const raw = result.tiers.length
        ? result.tiers.map((t) => ({
            pack_size: t.pack_size ?? "",
            price: t.price ?? null,
            unit_price: t.unit_price ?? null,
            native_price: t.native_price ?? null,
            native_unit_price: t.native_unit_price ?? null,
            native_currency: t.native_currency ?? null,
            fx_rate: t.fx_rate ?? null,
          }))
        : [
            {
              pack_size: result.pack_size ?? "",
              price: result.current_price,
              unit_price: result.unit_price,
              native_price: result.native_price ?? null,
              native_unit_price: result.native_unit_price ?? null,
              native_currency: result.native_currency ?? null,
              fx_rate: result.fx_rate ?? null,
            },
          ];
      const tiers = raw.map((t) => {
        const prior: any = priorByPack.get(packKey(t.pack_size));
        // Persist WHY the price moved, not just that it did. Downstream has to
        // act differently on the two causes: a supplier reprice means the quote
        // on the platform is stale and has to be reissued, while pure FX drift
        // means the seller still stands behind the same number. Computed here at
        // write time (rather than only derived in the UI) so a consumer reading
        // the row can tell them apart without re-deriving the split.
        const priorFxTier = typeof prior?.fx_rate === "number" ? prior.fx_rate : (prior?.previous_fx_rate ?? null);
        const changeSplit = splitPriceDelta(
          {
            usd: typeof prior?.price === "number" ? prior.price : null,
            native: typeof prior?.native_price === "number" ? prior.native_price : null,
            rate: priorFxTier,
            currency: prior?.native_currency ?? null,
          },
          { usd: t.price, native: t.native_price, rate: t.fx_rate, currency: t.native_currency },
        );
        const priorPriceTier = prior && typeof prior.price === "number" ? prior.price : null;
        const priorNativeTier = prior && typeof prior.native_price === "number" ? prior.native_price : null;
        // Same like-for-like rule as the headline: when both scrapes have a native
        // price in the same currency, the seller's move is the native move and FX
        // drops out. Only fall back to USD when there is no native pair to compare.
        const nativePair =
          priorNativeTier != null && priorNativeTier > 0 && t.native_price != null && prior?.native_currency === t.native_currency;
        const base = nativePair ? priorNativeTier : priorPriceTier;
        const cur = nativePair ? t.native_price : t.price;
        const moved = base != null && base > 0 && cur != null && Math.abs(cur - base) / base >= CHANGE_THRESHOLD_PCT / 100;
        return {
          ...t,
          // last price shown for this pack: the prior scrape's price, or the
          // last-different price we already had if this scrape didn't move it.
          previous_price: moved ? priorPriceTier : (prior?.previous_price ?? priorPriceTier ?? null),
          // Native/rate counterparts of previous_price. These three fields are the
          // inputs splitPriceDelta() needs to separate the seller's move from the
          // exchange rate's; deliberately stored raw rather than pre-computed, so
          // every surface derives the split the same way.
          previous_native_price: moved ? priorNativeTier : (prior?.previous_native_price ?? priorNativeTier ?? null),
          previous_fx_rate: (prior && typeof prior.fx_rate === "number" ? prior.fx_rate : null) ?? prior?.previous_fx_rate ?? null,
          // Stamps when the SELLER last moved this tier. FX drift no longer touches it.
          price_changed_at: moved ? nowIso : (prior?.price_changed_at ?? null),
          price_source: "marketplace_scrape",
          price_source_at: nowIso,
          // 'supplier' | 'currency' | 'both' | 'none', plus the two amounts so a
          // consumer never has to recompute the convention. Carried forward when
          // this read moved nothing, so the field always describes the last real
          // change rather than resetting to 'none' on every quiet re-read.
          price_change_source: changeSplit.source === "none" ? (prior?.price_change_source ?? "none") : changeSplit.source,
          supplier_delta_usd: changeSplit.supplierDelta,
          currency_delta_usd: changeSplit.currencyDelta,
          supplier_price_usd: changeSplit.supplierPriceUsd,
          supplier_price_changed_at:
            changeSplit.source === "supplier" || changeSplit.source === "both"
              ? nowIso
              : (prior?.supplier_price_changed_at ?? null),
        };
      });
      nextPayload.price_tiers = tiers;
      nextPayload.price_tiers_updated_at = nowIso;
      writtenTierPacks = tiers.map((t) => t.pack_size).filter(Boolean);
    }

    const { error: upErr } = await admin
      .from("leads_in_flight")
      .update({ payload: nextPayload })
      .eq("id", l.id);
    if (upErr) {
      await log(`Lead payload update failed for ${l.id}: ${upErr.message}`, { level: "error", step: "mp_leads", data: { lead_id: l.id } });
      return null;
    }

    // Keep the marketplace case-dims cache warm for any NEW pack sizes this pull
    // introduced. Cached packs (the common case) cost only an indexed lookup;
    // best-effort, never blocks the pull.
    if (writtenTierPacks.length) {
      await ensureMarketplaceCaseDims(admin, writtenTierPacks);
    }

    if (gotPrice) {
      // An open escalation is a request for a human to pull this price by hand.
      // Once the agent gets it, that request is answered, so close it — otherwise
      // the queue fills with work that is already done and operators stop trusting it.
      const openCases = admin
        .from("cases")
        .update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolution_note: `Auto-pulled by Agent 05: $${result.current_price}${result.pack_size ? ` / ${result.pack_size}` : ""}`,
        })
        .eq("org_id", l.org_id)
        .eq("type", "marketplace_price_pull")
        .in("status", ["open", "in_progress"]);
      // lead_id as well as the id pair: a case raised before its supplier was
      // linked carries a null supplier_id, and `eq.null` would match nothing.
      const { data: answered } = await (l.supplier_id && l.material_id
        ? openCases.or(`metadata->>lead_id.eq.${l.id},and(supplier_id.eq.${l.supplier_id},material_id.eq.${l.material_id})`)
        : openCases.eq("metadata->>lead_id", l.id)
      ).select("id");
      if (answered?.length) {
        await log(`Closed ${answered.length} price-pull escalation(s) now that a price landed: ${l.supplier_name} × ${l.material_name}`, {
          step: "mp_case_resolved",
          data: { lead_id: l.id, case_ids: answered.map((c: any) => c.id) },
        });
      }

      const moved = isRecheck && cadence?.stable_streak === 0 && priorPrice != null;
      const verb = isRecheck ? (moved ? `re-checked (moved from $${priorPrice})` : "re-checked (unchanged)") : "pulled";
      await log(
        `Marketplace price ${verb}: ${l.supplier_name} × ${l.material_name} → $${result.current_price}${result.pack_size ? ` / ${result.pack_size}` : ""}${soldOut ? ` — ${stock.stock_status === "discontinued" ? "DISCONTINUED" : "OUT OF STOCK"} since ${stock.out_of_stock_since}, price is not quotable` : ""} — next check in ${cadence?.check_interval_days}d`,
        {
          step: isRecheck ? "mp_recheck" : "mp_pull",
          data: {
            lead_id: l.id,
            interval_days: cadence?.check_interval_days,
            moved: !!moved,
            stock_status: stock.stock_status,
            out_of_stock_since: stock.out_of_stock_since,
          },
        },
      );
      return "pulled";
    }

    if (!escalate) {
      // No case opened yet. The lead stays pending and comes back around when
      // its backoff expires.
      await log(
        infraFailure
          ? `Marketplace pull did not complete (${result.notes ?? "no detail"}) — not counted as an attempt, retrying tomorrow: ${l.supplier_name} × ${l.material_name}`
          : `Marketplace price inconclusive (${reason}) — attempt ${attempts}, retrying after ${pull.retry_after}: ${l.supplier_name} × ${l.material_name}`,
        { step: "mp_retry", data: { lead_id: l.id, reason, attempts, infra_failure: infraFailure, retry_after: pull.retry_after } },
      );
      return "pending";
    }

    // Escalate: actionable reason (login/broken link) or a needs_review that
    // survived MAX_PULL_ATTEMPTS. Flag + tag the operator, unless a case is open.
    const { data: dupe } = await admin
      .from("cases")
      .select("id")
      .eq("org_id", l.org_id)
      .eq("type", "marketplace_price_pull")
      .eq("supplier_id", l.supplier_id)
      .eq("material_id", l.material_id)
      .eq("status", "open")
      .maybeSingle();
    if (!dupe) {
      const reasonLabel =
        reason === "login_required" ? "the listing needs a login/account"
        : reason === "link_broken" ? "the listing link is broken"
        : `no price could be auto-pulled after ${attempts} attempts`;
      const noteSuffix = reason === "needs_review" && result.notes ? ` (${result.notes})` : "";
      // Say it up front: a manual pull on a sold-out listing is wasted work, and
      // the operator can only tell by opening the page unless we hand it over.
      const stockPrefix = soldOut
        ? `The listing has been ${stock.stock_status === "discontinued" ? "discontinued" : "out of stock"} since ${stock.out_of_stock_since?.slice(0, 10)}${stock.stock_note ? ` ("${stock.stock_note}")` : ""} — check it is still worth pricing before pulling. `
        : "";
      await admin.from("cases").insert({
        org_id: l.org_id,
        type: "marketplace_price_pull",
        status: "open",
        supplier_id: l.supplier_id,
        material_id: l.material_id,
        recommended_action: `${stockPrefix}Marketplace price for ${l.material_name} from ${l.supplier_name ?? "this supplier"} couldn't be auto-pulled — ${reasonLabel}${noteSuffix}. Pull the listed/wholesale price manually: ${pull.source_url}`,
        assigned_operator: operatorFor(l),
        metadata: {
          source_agent: "agent-05-marketplace-validation",
          source_run_id: runId,
          lead_id: l.id,
          supplier_name: l.supplier_name,
          material_name: l.material_name,
          reason,
          attempts,
          last_notes: result.notes ?? null,
          source_url: pull.source_url,
          stock_status: stock.stock_status,
          out_of_stock_since: stock.out_of_stock_since,
        },
      });
    }
    await log(`Marketplace price flagged for an operator (${reason}, ${attempts} attempts) — still retrying, next read after ${pull.retry_after}: ${l.supplier_name} × ${l.material_name}`, {
      step: "mp_flag",
      data: { lead_id: l.id, reason, attempts, retry_after: pull.retry_after },
    });
    return "flagged";
  };

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      stoppedEarly = true;
      break;
    }
    const batch = leads.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(batch.map((l) => processOne(l)));
    for (const o of outcomes) {
      if (o == null) continue;
      processed++;
      if (o === "pulled") pulled++;
      else if (o === "pending") pending++;
      else if (o === "not_marketplace") notMarketplace++;
      else if (o === "expanded") expanded++;
      else flagged++;
    }
  }

  return { processed, pulled, flagged, pending, notMarketplace, expanded, sellersStaged, stoppedEarly };
}
