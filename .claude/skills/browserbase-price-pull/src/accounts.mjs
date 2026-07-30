// OA (ops-agents Supabase) access for the marketplace-account lifecycle.
//
// Uses the PostgREST REST API with the service-role key (bypasses RLS) — the
// same OA project the fleet writes to. No new dependency; plain fetch. DDL is
// applied separately via the pooler (REST can't DDL); this file is DML only.
//
// Responsibilities:
//   - read an org's client purchasing email (orgs.purchasing_email)
//   - get / create / update marketplace_accounts rows
//   - list an org's login-gated leads (marketplace_pull needs_manual_pull /
//     login_required) that we should pull once logged in
//   - write a pulled price back onto leads_in_flight.payload.marketplace_pull
//     in the SAME shape Agent 05 (lead-price-pull.ts) writes
//   - open a case (the human "click the confirm link" task)

const OA_REF = "aiyzpjnvenfmurhyamge";
const BASE = `https://${OA_REF}.supabase.co/rest/v1`;

function key() {
  const k = process.env.OA_SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("OA_SUPABASE_SERVICE_ROLE_KEY not set");
  return k;
}

async function oa(path, { method = "GET", body, prefer } = {}) {
  const headers = {
    apikey: key(),
    Authorization: `Bearer ${key()}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OA ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// ---- orgs -----------------------------------------------------------------

// Resolve an org by uuid or slug. Returns {id, name, slug, purchasing_email}.
export async function getOrg(orgRef) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(orgRef);
  const filter = isUuid ? `id=eq.${orgRef}` : `slug=eq.${encodeURIComponent(orgRef)}`;
  const rows = await oa(`orgs?${filter}&select=id,name,slug,purchasing_email&limit=1`);
  return rows?.[0] ?? null;
}

// Orgs currently in a sourcing state (the fleet's org gate) — BOTH `active` and
// `sourcing_only`. The real paying clients are `sourcing_only` (California,
// McGinley); only internal test orgs sit in `active`. Selecting `active` alone
// silently skipped every real client. Ordered is_internal ASC so real clients
// are processed before internal test orgs when a per-run cap applies.
export async function listActiveOrgs() {
  return (
    (await oa(
      `orgs?sourcing_status=in.(active,sourcing_only)&select=id,name,slug,is_internal&order=is_internal.asc,name.asc`
    )) ?? []
  );
}

// ---- marketplace_accounts -------------------------------------------------

export async function getAccount(orgId, host) {
  const rows = await oa(
    `marketplace_accounts?org_id=eq.${orgId}&host=eq.${encodeURIComponent(host)}&select=*&limit=1`
  );
  return rows?.[0] ?? null;
}

export async function listAccounts({ status } = {}) {
  const f = status ? `&status=eq.${status}` : "";
  return (await oa(`marketplace_accounts?select=*${f}&order=created_at.asc`)) ?? [];
}

export async function createAccount(row) {
  const out = await oa("marketplace_accounts", {
    method: "POST",
    body: row,
    prefer: "return=representation",
  });
  return out?.[0] ?? null;
}

export async function updateAccount(id, patch) {
  const out = await oa(`marketplace_accounts?id=eq.${id}`, {
    method: "PATCH",
    body: { ...patch, updated_at: new Date().toISOString() },
    prefer: "return=representation",
  });
  return out?.[0] ?? null;
}

// ---- leads ----------------------------------------------------------------

function listingUrl(payload) {
  return (
    payload?.marketplace_pull?.source_url ??
    payload?.enrichment?.contact?.contact_url ??
    payload?.supplier_website ??
    payload?.source_url ??
    null
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Leads Agent 05 gave up on (marketplace_pull.needs_manual_pull) that a real
// rendered Browserbase page can often recover. Two recoverable reasons:
//   login_required — web_search saw "sign in" nav and assumed a paywall (usually
//                    a false positive; the price is public).
//   needs_review   — web_search found no numeric price in snippets, often because
//                    the price is JS-rendered (absent from static search results).
// link_broken is intentionally excluded (a dead URL won't render either).
export async function listLoginRequiredLeads(orgId, { host, reasons = ["login_required"], all = false } = {}) {
  const sel = `&select=id,org_id,supplier_name,material_name,payload`;
  let query;
  if (all) {
    // Refresh mode: EVERY marketplace lead (priced or not), so the daily pull
    // re-checks live prices and reflects any change. `marketplace_pull` is set by
    // Agent 05 for exactly the marketplace listings, so its presence is the marker.
    query =
      `leads_in_flight?org_id=eq.${orgId}&status=eq.active` +
      `&payload->marketplace_pull=not.is.null` +
      sel +
      `&order=payload->marketplace_pull->>pulled_at.asc.nullsfirst,created_at.asc`;
  } else {
    const reasonFilter =
      reasons.length === 1
        ? `&payload->marketplace_pull->>reason=eq.${reasons[0]}`
        : `&payload->marketplace_pull->>reason=in.(${reasons.join(",")})`;
    query =
      `leads_in_flight?org_id=eq.${orgId}&status=eq.active` +
      `&payload->marketplace_pull->>status=eq.needs_manual_pull` +
      reasonFilter +
      sel +
      // Stalest-first: never-attempted (null `at`) leads, then the ones we pulled
      // longest ago, so time-boxed batches advance through the pool.
      `&order=payload->marketplace_pull->>at.asc.nullsfirst,created_at.asc`;
  }
  const rows = (await oa(query)) ?? [];
  return rows
    .map((l) => ({ ...l, url: listingUrl(l.payload) }))
    .filter((l) => l.url && (!host || hostOf(l.url) === host));
}

// Write a pulled price back in the same shape lead-price-pull.ts uses, so the
// Marketplace-pricing tab and downstream tiering read it identically.
export async function writePull(lead, result) {
  const url = lead.url;
  const source = result.source ?? "browserbase_login"; // e.g. "browserbase_agent" for the native-agent tier
  const now = new Date().toISOString();
  const gotPrice = result.classification === "current_price_found" && result.current_price != null;
  const prev = lead.payload?.marketplace_pull ?? {};
  const hadPrice = prev.status === "pulled" && prev.price != null;

  const nextPayload = { ...(lead.payload ?? {}) };
  let pull;

  if (gotPrice) {
    // Daily refresh may read a DIFFERENT price than last time — reflect it live
    // (price + tier ladder) on every successful pull, and note when it changed.
    const priceChanged = hadPrice && prev.price !== result.current_price;
    pull = {
      status: "pulled",
      unit_price: result.unit_price ?? null,
      price: result.current_price,
      pack_size: result.pack_size ?? null,
      currency: result.currency ?? "USD",
      source_url: result.source_url ?? url,
      source,
      pulled_at: now,
      ...(priceChanged ? { previous_price: prev.price, price_changed_at: now } : {}),
    };
    const tiers = (result.tiers ?? []).length
      ? result.tiers.map((t) => ({ pack_size: t.pack_size ?? "", price: t.price ?? null, unit_price: t.unit_price ?? null }))
      : [{ pack_size: result.pack_size ?? "", price: result.current_price, unit_price: result.unit_price ?? null }];
    nextPayload.price_tiers = tiers;
    nextPayload.price_tiers_updated_at = now;
  } else if (hadPrice) {
    // Refresh could NOT read a price this run, but we already have a good one.
    // NEVER wipe good pricing on a transient miss — keep the last-known price live
    // and FLAG that today's refresh failed, with the reason WHY, for ops visibility.
    pull = {
      ...prev,
      source,
      refresh_failed_at: now,
      refresh_fail_reason: result.classification, // login_required | link_broken | needs_review
      refresh_fail_notes: result.notes ?? null,
    };
  } else {
    // No price now and none before — flag for manual pull WITH the reason why.
    pull = {
      status: "needs_manual_pull",
      reason: result.classification, // login_required | link_broken | needs_review
      source,
      source_url: url,
      last_notes: result.notes ?? null,
      // Preserve the escalation marker so we don't re-run the expensive agent
      // tier on a lead it already failed to resolve.
      ...(result.agent_attempted_at ? { agent_attempted_at: result.agent_attempted_at } : {}),
      at: now,
    };
  }

  nextPayload.marketplace_pull = pull;
  await oa(`leads_in_flight?id=eq.${lead.id}`, {
    method: "PATCH",
    body: { payload: nextPayload },
  });
  return gotPrice;
}

// ---- cases ----------------------------------------------------------------

// Durable Tier-2 marker: stamp a lead with the agent run it was handed to, BEFORE
// polling. If the process dies mid-run, a --harvest pass reads agent_run_id back
// off the lead and writes the result — so we never lose (or re-pay for) the work.
export async function stampAgentRun(lead, runId, stamp) {
  const mp = { ...(lead.payload?.marketplace_pull ?? {}) };
  mp.agent_run_id = runId;
  mp.agent_attempted_at = stamp;
  const nextPayload = { ...(lead.payload ?? {}), marketplace_pull: mp };
  await oa(`leads_in_flight?id=eq.${lead.id}`, { method: "PATCH", body: { payload: nextPayload } });
}

// Leads that were handed to an agent run but not yet resolved (still
// needs_manual_pull with an agent_run_id) — the harvest queue.
export async function listPendingAgentRunLeads(orgId) {
  const rows =
    (await oa(
      `leads_in_flight?org_id=eq.${orgId}&select=id,supplier_name,material_name,payload` +
        `&payload->marketplace_pull->>status=eq.needs_manual_pull` +
        `&payload->marketplace_pull->>agent_run_id=not.is.null`,
    )) ?? [];
  return rows.map((l) => ({ ...l, url: listingUrl(l.payload), runId: l.payload?.marketplace_pull?.agent_run_id }));
}

// Open a case (the human "click the confirm link" task). Returns the case id.
export async function openCase({ orgId, type, recommended_action, metadata, assigned_operator }) {
  const out = await oa("cases", {
    method: "POST",
    body: {
      org_id: orgId,
      type,
      status: "open",
      recommended_action,
      assigned_operator: assigned_operator ?? null,
      metadata: metadata ?? {},
    },
    prefer: "return=representation",
  });
  return out?.[0]?.id ?? null;
}

export { hostOf };
