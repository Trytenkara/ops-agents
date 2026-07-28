import type { createAdminClient } from "@/lib/supabase/admin";
import { recheckMarketplaceQuote } from "./price-recheck";
import { convertToUsd } from "@/lib/fx";
import { getOrgOperatorPool, getSupplierAssignments, resolveSupplierOperatorId } from "@/lib/operator-assignment";

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
const FIRST_PULL_CAP = 20; // brand-new marketplace leads with no price yet (Sonnet+web_search, ~25s each).
const RECHECK_CAP = 10;    // already-pulled leads that are due for a re-validation (Haiku — see RECHECK_MODEL).
const CONCURRENCY = 4;
const MAX_PULL_ATTEMPTS = 3; // needs_review is retried across hourly runs up to this many times before a case is opened, so one flaky web_search result isn't a permanent escalation.

// Adaptive re-validation. Marketplace prices drift, so a pulled lead isn't frozen
// forever — it's re-checked on a cadence that widens while the price holds steady
// and snaps back to daily the moment it moves (AIMD backoff).
const CHANGE_THRESHOLD_PCT = 1.0;                 // <1% move treated as unchanged (matches Agent 05's quote-recheck threshold).
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

export interface LeadPullResult {
  processed: number;
  pulled: number;
  flagged: number;
  pending: number;
  stoppedEarly: boolean;
}

export async function pullPricesForNewMarketplaceLeads(opts: {
  admin: Admin;
  runId: string;
  deadline: number;
  log: (msg: string, meta?: any) => Promise<void> | void;
}): Promise<LeadPullResult> {
  const { admin, runId, deadline, log } = opts;
  const empty: LeadPullResult = { processed: 0, pulled: 0, flagged: 0, pending: 0, stoppedEarly: false };
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

  const cols = "id, org_id, supplier_id, supplier_name, material_id, material_name, payload";
  const marketplaceFilter = "payload->>site_type.in.(M,MS),payload->>supplier_role.eq.Marketplace";
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
      .or(marketplaceFilter)
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

  // Per-host starting-cadence priors, for seeding brand-new leads' first interval.
  const hostPriors = await computeHostPriors(admin, activeOrgIds);

  // Operator pool + assignments per org, for tagging the flag case.
  const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
  const poolByOrg = new Map<string, any[]>();
  const assignByOrg = new Map<string, Map<string, string>>();
  for (const oid of orgIds) {
    poolByOrg.set(oid, await getOrgOperatorPool(admin, oid).catch(() => []));
    assignByOrg.set(oid, await getSupplierAssignments(admin, oid).catch(() => new Map()));
  }
  const operatorFor = (l: LeadRow): string | null => {
    if (!l.org_id) return null;
    // Marketplace leads usually have no supplier_id — fall back to the lead id so
    // the sticky-random default spreads across the org's pool instead of every
    // case piling onto pool[0] (mirrors the outreach agent + Leads-tab key).
    return resolveSupplierOperatorId(
      assignByOrg.get(l.org_id) ?? new Map(),
      poolByOrg.get(l.org_id) ?? [],
      l.supplier_id ?? l.id,
    );
  };

  let processed = 0;
  let pulled = 0;
  let flagged = 0;
  let pending = 0;
  let stoppedEarly = false;

  const processOne = async (l: LeadRow): Promise<"pulled" | "flagged" | "pending" | null> => {
    const url = listingUrl(l.payload)!;
    const priorPull = l.payload?.marketplace_pull ?? null;
    // A re-check is a lead we've already priced (status 'pulled'); a first pull
    // is anything else. Re-checks compare to a known baseline on a cheaper model.
    const isRecheck = priorPull?.status === "pulled";
    const priorPrice = isRecheck ? (typeof priorPull?.price === "number" ? priorPull.price : null) : null;
    let result;
    try {
      result = await recheckMarketplaceQuote({
        supplier_name: l.supplier_name ?? "",
        material_name: l.material_name ?? "",
        product_url: url,
        baseline_price: priorPrice,
        case_size: null,
        unit: null,
        model: isRecheck ? RECHECK_MODEL : undefined,
      });
    } catch (e: any) {
      result = { classification: "needs_review" as const, current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], source_url: url, source_citations: [], notes: `pull failed: ${e?.message ?? e}` };
    }

    // Normalize a listed non-USD price to USD so the populated number is comparable.
    if (result.currency && result.currency !== "USD" && result.current_price != null) {
      const conv = await convertToUsd(result.current_price, result.currency).catch(() => null);
      if (conv) {
        result.current_price = conv.usd;
        if (result.unit_price != null) {
          const u = await convertToUsd(result.unit_price, result.currency).catch(() => null);
          if (u) result.unit_price = u.usd;
        }
      }
    }

    const gotPrice = result.classification === "current_price_found" && result.current_price != null;
    const reason = result.classification; // current_price_found | login_required | link_broken | needs_review
    // login_required / link_broken are actionable and escalate on the first hit.
    // needs_review is the transient/ambiguous catch-all (web_search hiccup, JSON
    // parse failure, multi-SKU / RFQ-only / pack-size mismatch) — retry it across
    // a few hourly runs before opening a case, so one flaky result isn't a
    // permanent escalation "without information".
    const actionable = reason === "login_required" || reason === "link_broken";
    const priorAttempts = Number(l.payload?.marketplace_pull?.attempts ?? 0);
    const attempts = gotPrice ? priorAttempts : priorAttempts + 1;
    const escalate = !gotPrice && (actionable || attempts >= MAX_PULL_ATTEMPTS);
    const retry = !gotPrice && !escalate;

    // Adaptive cadence (only meaningful on a successful pull). On a re-check, a
    // ≥1% move resets to daily and widens the ladder while it holds; a first pull
    // seeds its starting interval from the per-host volatility prior.
    const nowIso = new Date().toISOString();
    let cadence: {
      check_interval_days: number;
      next_check_at: string;
      stable_streak: number;
      last_change_at: string | null;
      history: any[];
    } | null = null;
    if (gotPrice) {
      const changed =
        priorPrice != null &&
        result.current_price != null &&
        Math.abs(result.current_price - priorPrice) / priorPrice >= CHANGE_THRESHOLD_PCT / 100;
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
      const priorHistory = Array.isArray(priorPull?.history) ? priorPull.history : [];
      const history = [...priorHistory, { at: nowIso, price: result.current_price, changed }].slice(-HISTORY_DEPTH);
      cadence = {
        check_interval_days: intervalDays,
        next_check_at: new Date(Date.now() + intervalDays * 86400000).toISOString(),
        stable_streak: streak,
        last_change_at: changed ? nowIso : (priorPull?.last_change_at ?? null),
        history,
      };
    }

    // A re-check that failed to read a price must NOT destroy the good price we
    // already have on file. Keep the last pull, defer the next check by a day,
    // and record the miss — a single flaky read (search hiccup, temporary wall)
    // shouldn't nuke a live price or re-flag an already-priced lead.
    if (!gotPrice && isRecheck) {
      const recheckMisses = Number(priorPull?.recheck_misses ?? 0) + 1;
      const deferPull = {
        ...priorPull,
        next_check_at: new Date(Date.now() + 86400000).toISOString(),
        recheck_misses: recheckMisses,
        last_recheck_reason: reason,
        last_recheck_at: nowIso,
      };
      const { error: upErr } = await admin
        .from("leads_in_flight")
        .update({ payload: { ...(l.payload ?? {}), marketplace_pull: deferPull } })
        .eq("id", l.id);
      if (upErr) {
        await log(`Lead payload update failed for ${l.id}: ${upErr.message}`, { level: "error", step: "mp_leads", data: { lead_id: l.id } });
        return null;
      }
      await log(`Marketplace re-check inconclusive (${reason}) — keeping last price, retrying tomorrow: ${l.supplier_name} × ${l.material_name}`, {
        step: "mp_recheck_miss",
        data: { lead_id: l.id, reason, recheck_misses: recheckMisses },
      });
      return "pending";
    }

    const pull = gotPrice
      ? {
          status: "pulled" as const,
          unit_price: result.unit_price,
          price: result.current_price,
          pack_size: result.pack_size,
          currency: "USD",
          source_url: result.source_url ?? url,
          pulled_at: nowIso,
          ...cadence!,
        }
      : {
          status: retry ? ("pending" as const) : ("needs_manual_pull" as const),
          reason, // login_required | link_broken | needs_review
          attempts,
          source_url: result.source_url ?? url,
          last_notes: result.notes ?? null,
          at: new Date().toISOString(),
        };

    // Populate the same price_tiers the Marketplace-pricing tab renders — but
    // never clobber tiers an operator already entered. A re-check (prior status
    // 'pulled') owns the ladder it wrote earlier, so it may refresh it; a lead
    // whose tiers came from an operator is left alone.
    const nextPayload: any = { ...(l.payload ?? {}), marketplace_pull: pull };
    const existingTiers = Array.isArray(l.payload?.price_tiers) ? l.payload.price_tiers : [];
    if (gotPrice && (existingTiers.length === 0 || isRecheck)) {
      const tiers = result.tiers.length
        ? result.tiers.map((t) => ({ pack_size: t.pack_size ?? "", price: t.price ?? null, unit_price: t.unit_price ?? null }))
        : [{ pack_size: result.pack_size ?? "", price: result.current_price, unit_price: result.unit_price }];
      nextPayload.price_tiers = tiers;
      nextPayload.price_tiers_updated_at = new Date().toISOString();
    }

    const { error: upErr } = await admin
      .from("leads_in_flight")
      .update({ payload: nextPayload })
      .eq("id", l.id);
    if (upErr) {
      await log(`Lead payload update failed for ${l.id}: ${upErr.message}`, { level: "error", step: "mp_leads", data: { lead_id: l.id } });
      return null;
    }

    if (gotPrice) {
      const moved = isRecheck && cadence?.stable_streak === 0 && priorPrice != null;
      const verb = isRecheck ? (moved ? `re-checked (moved from $${priorPrice})` : "re-checked (unchanged)") : "pulled";
      await log(
        `Marketplace price ${verb}: ${l.supplier_name} × ${l.material_name} → $${result.current_price}${result.pack_size ? ` / ${result.pack_size}` : ""} — next check in ${cadence?.check_interval_days}d`,
        {
          step: isRecheck ? "mp_recheck" : "mp_pull",
          data: { lead_id: l.id, interval_days: cadence?.check_interval_days, moved: !!moved },
        },
      );
      return "pulled";
    }

    if (retry) {
      // Left in "pending" — no case opened. The query re-picks pending leads on
      // the next hourly run until a price is found or attempts hit the cap.
      await log(`Marketplace price inconclusive (${reason}) — retrying (attempt ${attempts}/${MAX_PULL_ATTEMPTS}): ${l.supplier_name} × ${l.material_name}`, {
        step: "mp_retry",
        data: { lead_id: l.id, reason, attempts },
      });
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
      await admin.from("cases").insert({
        org_id: l.org_id,
        type: "marketplace_price_pull",
        status: "open",
        supplier_id: l.supplier_id,
        material_id: l.material_id,
        recommended_action: `Marketplace price for ${l.material_name} from ${l.supplier_name ?? "this supplier"} couldn't be auto-pulled — ${reasonLabel}${noteSuffix}. Pull the listed/wholesale price manually: ${pull.source_url}`,
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
        },
      });
    }
    await log(`Marketplace price needs manual pull (${reason}, ${attempts} attempts): ${l.supplier_name} × ${l.material_name}`, {
      step: "mp_flag",
      data: { lead_id: l.id, reason, attempts },
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
      else flagged++;
    }
  }

  return { processed, pulled, flagged, pending, stoppedEarly };
}
