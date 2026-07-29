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
export async function listLoginRequiredLeads(orgId, { host, reasons = ["login_required"] } = {}) {
  const reasonFilter =
    reasons.length === 1
      ? `&payload->marketplace_pull->>reason=eq.${reasons[0]}`
      : `&payload->marketplace_pull->>reason=in.(${reasons.join(",")})`;
  const rows =
    (await oa(
      `leads_in_flight?org_id=eq.${orgId}&status=eq.active` +
        `&payload->marketplace_pull->>status=eq.needs_manual_pull` +
        reasonFilter +
        `&select=id,org_id,supplier_name,material_name,payload&order=created_at.asc`
    )) ?? [];
  return rows
    .map((l) => ({ ...l, url: listingUrl(l.payload) }))
    .filter((l) => l.url && (!host || hostOf(l.url) === host));
}

// Write a pulled price back in the same shape lead-price-pull.ts uses, so the
// Marketplace-pricing tab and downstream tiering read it identically.
export async function writePull(lead, result) {
  const url = lead.url;
  const gotPrice = result.classification === "current_price_found" && result.current_price != null;
  const pull = gotPrice
    ? {
        status: "pulled",
        unit_price: result.unit_price ?? null,
        price: result.current_price,
        pack_size: result.pack_size ?? null,
        currency: result.currency ?? "USD",
        source_url: result.source_url ?? url,
        source: "browserbase_login",
        pulled_at: new Date().toISOString(),
      }
    : {
        status: "needs_manual_pull",
        reason: result.classification, // login_required | link_broken | needs_review
        source: "browserbase_login",
        source_url: url,
        last_notes: result.notes ?? null,
        at: new Date().toISOString(),
      };

  const nextPayload = { ...(lead.payload ?? {}), marketplace_pull: pull };
  const existingTiers = Array.isArray(lead.payload?.price_tiers) ? lead.payload.price_tiers : [];
  if (gotPrice && existingTiers.length === 0) {
    const tiers = (result.tiers ?? []).length
      ? result.tiers.map((t) => ({ pack_size: t.pack_size ?? "", price: t.price ?? null, unit_price: t.unit_price ?? null }))
      : [{ pack_size: result.pack_size ?? "", price: result.current_price, unit_price: result.unit_price ?? null }];
    nextPayload.price_tiers = tiers;
    nextPayload.price_tiers_updated_at = new Date().toISOString();
  }

  await oa(`leads_in_flight?id=eq.${lead.id}`, {
    method: "PATCH",
    body: { payload: nextPayload },
  });
  return gotPrice;
}

// ---- cases ----------------------------------------------------------------

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
