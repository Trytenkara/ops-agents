import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { agenticPull, type PullResult, captureShippingCost, type ShippingCaptureResult } from "@/lib/browserbase-pull";
import { normalizeToUsd as fxNormalize } from "@/lib/fx";
import { estimatePerTierShipping } from "@/lib/shipping-estimation";
import { loadMaterialDensities } from "@/lib/material-density";
import { getOrgShipToAddress, formatAddressForCheckout } from "@/lib/tenkara-ship-to";
import { sanitizeTiers, type PriceTier } from "@/lib/price-tiers";
import { publishablePrice, publishableTiers, withheldMark } from "@/lib/price-publish";
import { sortByOrgPriority } from "@/lib/org-priority";

// Agent 19 - Browserbase Price Escalation.
//
// Agent 05 reads a listing as text and repairs bad URLs by search. That cannot
// press a size selector or run a site's own search box, so two shapes of lead
// come back unpriced no matter how many times it retries: a JS-rendered page
// whose price only appears after choosing a variant, and a lead pointing at a
// supplier's root domain rather than a product. This agent drives a real browser
// at exactly that residue.
//
// It is a SUPPLEMENTAL tier, not a replacement. A browser session plus several
// model calls per lead is far more expensive than Agent 05's read, so this runs
// once daily over a bounded slice while Agent 05 keeps running hourly over
// everything.
//
// Replaces the container-side `browserbase-price-pull` Tier B cron, which could
// only run on a laptop. Two behaviour changes came with the move:
//   - It selects on marketplace_pull.status = 'pending', which is what Agent 05
//     actually writes. The container queried 'needs_manual_pull', a status only
//     the container's own writer ever produced, so it was picking up ~19 leads
//     out of a residue of ~1,650.
//   - Concurrency is sized for a serverless invocation rather than a long-lived
//     process: a wall-clock deadline inside the function budget, with unfinished
//     leads simply left for tomorrow (they keep their place in the rotation).

// Sized against /api/cron's maxDuration of 800s. A lead takes ~2.4 min at worst,
// so the deadline is what actually bounds a run; the lead cap is a cost ceiling.
const RUN_DEADLINE_MS = 700_000;
const MAX_LEADS_PER_RUN = 120;
// Read windows, wider than the per-run budget. Their remainder is reported, not
// hidden: see selectWorklist (PERS-06).
const PENDING_WINDOW = 1500;
const WITHHELD_WINDOW = 500;
// Browserbase plan allows 100 concurrent sessions. Stay under it: this agent is
// not the only thing that may hold sessions.
const CONCURRENCY = 40;
// Even on distinct residential IPs, firing many leads at ONE host at once trips
// that host's own rate limiter.
const HOST_CAP = 3;
// Abandon a lead that runs long so its slot frees up. The Browserbase session
// self-terminates via its own server-side timeout.
const LEAD_TIMEOUT_MS = 200_000;

// Hosts that show no list price even to a logged-in buyer: they are quote-request
// walls by design. They were consuming a full browser session each, every run,
// for almost no prices. Skip them unless this lead has actually yielded a price
// before, in which case keep refreshing it so nothing already working is lost.
const RFQ_WALL_HOSTS = [
  "knowde.com",
  "tridge.com",
  "alibaba.com",
  "tradeindia.com",
  "indiamart.com",
  "made-in-china.com",
  "globalsources.com",
  "globaltradeplaza.com",
  "globy.com",
  "pharmaoffer.com",
  "echemi.com",
  "ulprospector.com",
  "specialchem.com",
  "dkshdiscover.com",
  "thomasnet.com",
  "azelis.com",
  "ingredientsbazar.com",
  "faire.com",
  "univarsolutions.com",
  "usetorg.com",
];

function hostOf(u: string | null): string | null {
  try {
    return new URL(u!).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isRfqWall(host: string | null): boolean {
  const h = host ?? "";
  return RFQ_WALL_HOSTS.some((w) => h === w || h.endsWith("." + w));
}

function listingUrl(payload: any): string | null {
  return (
    payload?.marketplace_pull?.source_url ??
    payload?.enrichment?.contact?.contact_url ??
    payload?.supplier_website ??
    payload?.source_url ??
    null
  );
}

interface Lead {
  id: string;
  org_id: string;
  supplier_name: string | null;
  material_name: string | null;
  payload: any;
  url: string;
}

// Round-robin leads across hosts so the flat worker pool spreads load naturally
// and the per-host gate rarely has to block.
function interleaveByHost(leads: Lead[]): Lead[] {
  const groups = new Map<string, Lead[]>();
  for (const l of leads) {
    const h = hostOf(l.url) ?? "?";
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h)!.push(l);
  }
  const lists = [...groups.values()];
  const out: Lead[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const g of lists) {
      const x = g.shift();
      if (x) {
        out.push(x);
        added = true;
      }
    }
  }
  return out;
}

// Per-host semaphore. A freed slot is handed straight to a waiter rather than
// decremented, which avoids a check-then-increment race.
class HostGate {
  private cap: number;
  private n = new Map<string, number>();
  private q = new Map<string, (() => void)[]>();
  constructor(cap: number) {
    this.cap = Math.max(1, cap);
  }
  async acquire(host: string) {
    const cur = this.n.get(host) ?? 0;
    if (cur < this.cap) {
      this.n.set(host, cur + 1);
      return;
    }
    await new Promise<void>((res) => {
      const w = this.q.get(host) ?? [];
      w.push(res);
      this.q.set(host, w);
    });
  }
  release(host: string) {
    const w = this.q.get(host);
    if (w && w.length) {
      w.shift()!();
      return;
    }
    this.n.set(host, Math.max(0, (this.n.get(host) ?? 1) - 1));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: any;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error(`lead timed out after ${Math.round(ms / 1000)}s`), { timedOut: true })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// A 0 or negative price is never real: it is an unhydrated variant or a
// placeholder. Publishing it would show a supplier as free.
function dropZeroPrices(r: PullResult): PullResult {
  const bad = (p: any) => p == null || !Number.isFinite(Number(p)) || Number(p) <= 0;
  const tiers = (r.tiers ?? []).filter((t) => !bad(t.price));
  // Only act when a price was actually thrown away. The old test was
  // `bad(r.current_price)`, which is true of every result that never had a
  // price, so a login wall and a dead link both came out of here relabelled
  // `needs_review` — 307 leads, every failure kind flattened into one, and
  // `login_required` (the one that escalates to a human) unreachable from this
  // agent entirely.
  const droppedTiers = (r.tiers ?? []).length - tiers.length;
  const droppedCurrent = r.current_price != null && bad(r.current_price);
  if (!droppedTiers && !droppedCurrent) return r;
  const current = bad(r.current_price) ? tiers[0]?.price ?? null : r.current_price;
  return {
    ...r,
    tiers,
    current_price: current,
    // A found price that turns out to be a placeholder is no longer a found
    // price. Any other verdict stands: dropping a bad number says nothing about
    // why the page could not be read.
    classification:
      current == null && r.classification === "current_price_found" ? "needs_review" : r.classification,
    notes: `${r.notes} (dropped non-positive price(s); nothing real left to publish)`,
  };
}

// The published price column is USD by constraint, so a foreign listing is
// converted before it can be written. No reachable rate means no number at all,
// never an unconverted foreign figure presented as dollars.
async function normalizeToUsd(
  r: PullResult,
): Promise<PullResult & { native_price?: number | null; native_currency?: string | null; fx_rate?: number | null }> {
  const cur = r.currency;
  if (!cur || cur === "USD" || r.current_price == null) return r;
  // One rate for the whole listing, via the shared policy. Converting each tier
  // separately used to fall back to the RAW FOREIGN NUMBER when a tier's lookup
  // failed, which is the exact thing the comment above forbids.
  const fx = await fxNormalize(cur);
  if (fx.status !== "converted") {
    return {
      ...r,
      classification: "needs_review",
      current_price: null,
      tiers: [],
      notes: `${r.notes} Listed in ${cur}; no USD rate reachable, left unpublished rather than unconverted.`,
    };
  }
  // A tier whose converted price comes back null is dropped, never kept at its
  // foreign value.
  const tiers = r.tiers
    .map((t) => ({ ...t, price: fx.convert(t.price), unit_price: fx.convert(t.unit_price) }))
    .filter((t): t is typeof t & { price: number } => t.price != null);
  return {
    ...r,
    current_price: fx.convert(r.current_price),
    tiers,
    currency: "USD",
    native_price: r.current_price,
    native_currency: cur,
    fx_rate: fx.rate,
    notes: `${r.notes} Listed in ${cur} ${r.current_price}; converted to USD $${fx.convert(r.current_price)} at 1 ${cur} = $${fx.rate}.`,
  };
}

/**
 * Write a pull back onto the lead. Mirrors Agent 05's vocabulary so the price
 * index tab renders both identically, and keeps its central rule: a run that
 * cannot read a price NEVER wipes a price we already have. It records the miss
 * beside the good number instead.
 */
async function writePull(
  admin: any,
  lead: Lead,
  raw: PullResult,
  shippingResult?: ShippingCaptureResult | null,
): Promise<boolean> {
  const result = await normalizeToUsd(dropZeroPrices(raw));
  const now = new Date().toISOString();
  const gotPrice = result.classification === "current_price_found" && result.current_price != null;
  const prev = lead.payload?.marketplace_pull ?? {};
  const hadPrice = prev.status === "pulled" && prev.price != null;
  const nextPayload: any = { ...(lead.payload ?? {}) };

  let pull: any;
  if (gotPrice) {
    const priceChanged = hadPrice && prev.price !== result.current_price;
    pull = {
      status: "pulled",
      price: result.current_price,
      unit_price: result.unit_price ?? null,
      pack_size: result.pack_size ?? null,
      currency: "USD",
      native_price: (result as any).native_price ?? null,
      native_currency: (result as any).native_currency ?? null,
      fx_rate: (result as any).fx_rate ?? null,
      source_url: result.source_url,
      source: "browserbase_stagehand",
      pulled_at: now,
      // A price can move without any page being read (the FX pass restates USD
      // off a new rate), so readers that need a genuine observation check this
      // rather than the timestamp.
      price_source: "marketplace_scrape",
      price_source_at: now,
      ...(priceChanged ? { previous_price: prev.price, price_changed_at: now } : {}),
      // Shipping cost fields (populated by captureShippingCost after price capture)
      shipping_cost: shippingResult?.shippingCost ?? null,
      shipping_cost_currency: shippingResult?.currency ?? null,
      shipping_address_used: shippingResult?.shippingAddress ?? null,
      shipping_cost_attempted_at: shippingResult?.attemptedAt ?? null,
      shipping_cost_failed_reason: shippingResult?.failedReason ?? null,
    };
    const tiers: PriceTier[] = result.tiers.length
      ? result.tiers.map((t) => ({ pack_size: t.pack_size ?? "", price: t.price, unit_price: t.unit_price ?? null }))
      : [{ pack_size: result.pack_size ?? "", price: result.current_price, unit_price: result.unit_price ?? null }];

    // Add per-tier shipping cost estimates if we captured an MOQ shipping cost
    if (shippingResult?.shippingCost != null && tiers.length > 0) {
      // PRICING-05: the per-tier estimate is only as honest as the weight behind
      // it, and a volumetric pack has no weight without the material's density.
      const densities = await loadMaterialDensities(admin, lead.org_id);
      const estimates = await estimatePerTierShipping(shippingResult.shippingCost, tiers, lead.material_name ?? "", densities);
      for (const [tierIdx, estimatedCost] of Object.entries(estimates)) {
        const idx = parseInt(tierIdx, 10);
        if (tiers[idx]) tiers[idx].shipping_cost_estimate = estimatedCost;
      }
    }

    const gated = publishableTiers(sanitizeTiers(tiers) as any[], { where: "escalation pull" });
    const gatedPull = publishablePrice(pull as any, { where: "escalation pull" });
    const withheld = withheldMark([...gatedPull.issues, ...gated.issues], {
      at: now,
      droppedPacks: gated.dropped.map((t: any) => t.pack_size),
    });
    if (withheld) {
      pull = gatedPull.row as any;
      // A note is prose an operator has to be looking at the right row to read.
      // The mark beside it is what the worklist below and the client's flagged
      // panel select on, so a withheld price comes back round instead of sitting
      // as a blank cell that reads as "nobody has pulled this yet" (PERS-07).
      Object.assign(pull, withheld);
      pull.last_notes = `${pull.last_notes ? pull.last_notes + " " : ""}Withheld: ${withheld.withheld_reason}`;
    }
    nextPayload.price_tiers = gated.tiers;
    nextPayload.price_tiers_updated_at = now;
  } else if (hadPrice) {
    // Keep the last known good price live and flag that today's refresh failed,
    // with the reason why.
    pull = {
      ...prev,
      escalation_failed_at: now,
      escalation_fail_reason: result.classification,
      escalation_fail_notes: result.notes ?? null,
    };
  } else {
    // Still 'pending': there is no terminal give-up state, the lead keeps its
    // place in the retry rotation whether or not a human ever looks at it.
    pull = {
      ...prev,
      status: "pending",
      reason: result.classification,
      source: "browserbase_stagehand",
      source_url: result.source_url,
      last_notes: result.notes ?? null,
      escalated_at: now,
      at: now,
      // This read produced no price at all, so an earlier read's withholding is
      // no longer what is wrong with the lead. Left set, the flagged panel would
      // keep reporting a price we took away when the truth is we never got one.
      withheld: false,
      withheld_reason: null,
    };
  }

  nextPayload.marketplace_pull = pull;
  const { error } = await admin.from("leads_in_flight").update({ payload: nextPayload }).eq("id", lead.id);
  if (error) throw new Error(error.message);
  return gotPrice;
}

async function selectWorklist(admin: any, log: RunLog): Promise<{ leads: Lead[]; skippedWalls: number; outsideWindow: number }> {
  const { data: orgs } = await admin.from("orgs").select("id, slug, is_internal, sourcing_status");
  const live = new Map<string, any>();
  for (const o of orgs ?? []) {
    if (o.sourcing_status === "active" || o.sourcing_status === "sourcing_only") live.set(o.id, o);
  }
  if (!live.size) return { leads: [], skippedWalls: 0, outsideWindow: 0 };

  const [pending, withheld] = await Promise.all([
    admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_name, material_name, payload", { count: "exact" })
      .eq("status", "active")
      .in("org_id", [...live.keys()])
      .eq("payload->marketplace_pull->>status", "pending")
      .in("payload->marketplace_pull->>reason", ["login_required", "needs_review"])
      // Stalest first, so a bounded run advances through the pool rather than
      // re-reading the same head every day.
      .order("payload->marketplace_pull->>at", { ascending: true, nullsFirst: true })
      .limit(PENDING_WINDOW),
    // A price the publish gate took away files as `pulled` with no `reason`, so
    // it satisfies neither predicate above and nothing ever came back for it —
    // the one pool guaranteed to contain a page we read successfully and still
    // could not publish (PERS-07). Separate query rather than an `or(...)`: the
    // two cohorts are selected on different keys and a nested-json or() is the
    // kind of filter that silently matches nothing.
    admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_name, material_name, payload", { count: "exact" })
      .eq("status", "active")
      .in("org_id", [...live.keys()])
      .eq("payload->marketplace_pull->>withheld", "true")
      .order("payload->marketplace_pull->>withheld_at", { ascending: true, nullsFirst: true })
      .limit(WITHHELD_WINDOW),
  ]);
  const error = pending.error ?? withheld.error;
  if (error) throw new Error(`worklist query failed: ${error.message}`);
  const byId = new Map<string, any>();
  for (const r of [...(pending.data ?? []), ...(withheld.data ?? [])]) byId.set(r.id, r);
  const rows = [...byId.values()];

  let skippedWalls = 0;
  let eligible: Lead[] = [];
  for (const r of rows ?? []) {
    const url = listingUrl(r.payload);
    if (!url) continue;
    const host = hostOf(url);
    const mp = r.payload?.marketplace_pull ?? {};
    if (isRfqWall(host) && mp.price == null) {
      skippedWalls++;
      continue;
    }
    eligible.push({ ...r, url } as Lead);
  }

  // Real clients always get scarce throughput before internal test orgs.
  eligible = sortByOrgPriority(eligible, (l) => live.get(l.org_id));
  // PERS-06: the run summary already names what the TIME budget left behind.
  // These two read windows left their own remainder unsaid, so a pool deeper
  // than 1,500 pending leads looked like a pool of exactly 1,500.
  const pool = (pending.count ?? rows.length) + (withheld.count ?? 0);
  const outsideWindow = Math.max(pool - rows.length, 0);
  await log(
    `Worklist: ${eligible.length} eligible of ${pool} in the pool, ${skippedWalls} skipped as quote-request walls` +
      (outsideWindow ? ` — ${outsideWindow} outside the read window` : ""),
    { step: "worklist", data: { pool, outsideWindow } },
  );
  return { leads: eligible.slice(0, MAX_LEADS_PER_RUN), skippedWalls, outsideWindow };
}

type RunLog = (m: string, o?: any) => Promise<void>;

registerAgent({
  slug: "agent-19-browserbase-escalation",
  displayName: "Agent 19 - Browserbase Price Escalation",
  description:
    "Drives a real (remote Browserbase) browser at the marketplace leads Agent 05 could not price: JS-rendered pages whose price only appears after selecting a size, and leads pointing at a supplier root domain rather than a product page. Dismisses popups, runs the site's own search, opens the matching product, and sweeps every pack size for a true price ladder. Supplemental to Agent 05, never a replacement.",
  async run(ctx) {
    const admin = createAdminClient();
    const deadline = Date.now() + RUN_DEADLINE_MS;

    if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
      ctx.setStatus("failure");
      ctx.setSummary("BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set");
      await ctx.log("Browserbase credentials missing", { level: "error", step: "config" });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      ctx.setStatus("failure");
      ctx.setSummary("ANTHROPIC_API_KEY missing");
      return;
    }

    const { leads, skippedWalls, outsideWindow } = await selectWorklist(admin, (m, o) => ctx.log(m, o));
    if (!leads.length) {
      ctx.setStatus("success");
      ctx.setSummary(`No escalation-eligible leads (${skippedWalls} quote-request walls skipped).`);
      return;
    }

    const ordered = interleaveByHost(leads);
    const gate = new HostGate(HOST_CAP);
    let idx = 0;
    let pulled = 0;
    let missed = 0;
    let shippingAttempted = 0; // leads where we tried to extract shipping
    let shippingCaptured = 0; // leads where shipping cost was successfully extracted
    let shippingFailed = 0; // leads where shipping extraction was attempted but failed
    // PRICING-04. Four counts, not a rate. A rate of zero out of zero is what
    // this feature reported for weeks while it was inert, and it read the same
    // as a quiet day. Priced leads whose client has no destination are counted
    // separately so "nobody has a ship-to configured" can never be mistaken for
    // "extraction is failing", and neither can hide behind a null percentage.
    let shippingNoAddress = 0;
    let stoppedForTime = false;

    const worker = async () => {
      while (true) {
        if (Date.now() > deadline) {
          stoppedForTime = true;
          return;
        }
        const i = idx++;
        if (i >= ordered.length) return;
        const lead = ordered[i];
        const host = hostOf(lead.url) ?? "?";
        await gate.acquire(host);
        try {
          let result: PullResult | null = null;
          let lastErr: any = null;

          // Fetch org's ship-to address for shipping cost capture (optional, non-blocking)
          let shipToAddress: { country: string; state: string; city: string; zip: string } | null = null;
          try {
            shipToAddress = await getOrgShipToAddress(admin, lead.org_id);
          } catch (e) {
            // Silently ignore — shipping is optional, not critical
          }

          // agenticPull returns a classified result rather than throwing for
          // normal outcomes, so the only case worth retrying here is our own
          // wall-clock abandonment: re-run it once in a fresh session.
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              result = await withTimeout(
                agenticPull({
                  url: lead.url,
                  supplier: lead.supplier_name ?? "",
                  material: lead.material_name ?? "",
                  shipToAddress,
                }),
                LEAD_TIMEOUT_MS,
              );
              break;
            } catch (e: any) {
              lastErr = e;
              if (!e?.timedOut || attempt === 2 || Date.now() > deadline) break;
            }
          }
          if (!result) {
            const note = lastErr?.timedOut
              ? `timed out after ${Math.round(LEAD_TIMEOUT_MS / 1000)}s`
              : `stagehand error: ${String(lastErr?.message ?? lastErr).slice(0, 180)}`;
            result = {
              classification: "needs_review",
              current_price: null,
              currency: null,
              pack_size: null,
              unit_price: null,
              tiers: [],
              notes: note,
              source_url: lead.url,
            };
          }

          // Track shipping extraction attempt & result
          // Shipping is only attempted if price was captured and org has an address
          const priced = result.classification === "current_price_found" && result.current_price != null;
          if (priced && !shipToAddress) shippingNoAddress++;
          if (shipToAddress && priced) {
            shippingAttempted++;
            if (result.shippingCost != null) {
              shippingCaptured++;
            } else {
              // Extraction was attempted but no numeric cost found
              shippingFailed++;
            }
          }

          // Wrap shipping result for writePull
          const shippingResult: ShippingCaptureResult | null = result.shippingCost != null
            ? {
                shippingCost: result.shippingCost,
                currency: result.shippingCurrency ?? null,
                shippingAddress: shipToAddress ? `${shipToAddress.city}, ${shipToAddress.state}, ${shipToAddress.zip}, ${shipToAddress.country}` : null,
                failedReason: null,
                attemptedAt: new Date().toISOString(),
              }
            : null;

          const gotPrice = await writePull(admin, lead, result, shippingResult);
          if (gotPrice) {
            pulled++;
            await ctx.log(
              `Priced ${lead.supplier_name} × ${lead.material_name}: USD ${result.current_price} (${result.tiers.length || 1} tier(s))`,
              { step: "escalation_pull", data: { lead_id: lead.id, host, tiers: result.tiers.length } },
            );
          } else {
            missed++;
            await ctx.log(`${result.classification}: ${lead.supplier_name} × ${lead.material_name} — ${(result.notes ?? "").slice(0, 120)}`, {
              step: "escalation_miss",
              data: { lead_id: lead.id, host, reason: result.classification },
            });
          }
        } catch (e: any) {
          missed++;
          await ctx.log(`Lead ${lead.id} failed: ${String(e?.message ?? e).slice(0, 200)}`, {
            level: "warn",
            step: "escalation_error",
            data: { lead_id: lead.id },
          });
        } finally {
          gate.release(host);
        }
      }
    };

    const n = Math.min(CONCURRENCY, ordered.length);
    await ctx.log(`Escalating ${ordered.length} lead(s) across up to ${n} concurrent Browserbase sessions (host cap ${HOST_CAP})`, {
      step: "fanout",
    });
    await Promise.all(Array.from({ length: n }, () => worker()));

    const attempted = pulled + missed;
    ctx.setItemsProcessed(attempted);
    ctx.setMetadata({
      attempted,
      pulled,
      missed,
      skippedWalls,
      eligible: ordered.length,
      stoppedForTime,
      shippingAttempted,
      shippingCaptured,
      shippingFailed,
      shippingNoAddress,
      shippingRate: shippingAttempted > 0 ? Math.round((shippingCaptured / shippingAttempted) * 100) : null,
    });
    ctx.setStatus(pulled === 0 && attempted > 0 ? "partial" : "success");
    ctx.setSummary(
      `Browserbase escalation: priced ${pulled}/${attempted} lead(s)` +
        (shippingAttempted > 0
          ? ` · shipping captured for ${shippingCaptured}/${shippingAttempted} (${Math.round((shippingCaptured / shippingAttempted) * 100)}%)`
          : shippingNoAddress > 0
            ? ` · shipping not attempted on ${shippingNoAddress} priced lead(s): no ship-to configured`
            : "") +
        (skippedWalls ? ` · ${skippedWalls} quote-request walls skipped` : "") +
        (stoppedForTime ? ` · stopped at time budget (${ordered.length - attempted} left for tomorrow)` : "") +
        (outsideWindow ? ` · ${outsideWindow} outside the read window` : ""),
    );
  },
});
