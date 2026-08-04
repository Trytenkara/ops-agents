import type { SupabaseClient } from "@supabase/supabase-js";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { getSupplierProfiles, type SupplierProfile } from "@/lib/supplier-profiles";

// Keeps the Supplier Validation card filled from the sources we already own, on
// every cycle rather than only at profile-creation time. Deliberately dumb: no
// LLM, no web, no caps — Tenkara's supplier record, the lead's own enrichment,
// and any supplier reply that reached staged_quotes.
//
// Fill-only. A column is written only when it is currently empty, so an
// operator edit (or a richer earlier source) is never clobbered. Every write
// records where it came from in field_sources, which is also what lets the card
// explain a blank instead of just showing one.

export type FieldSource = "tenkara" | "lead" | "staged_quote" | "not_published" | string;

const TERMS_FIELDS = [
  "shipping_terms", "shipping_email", "billing_email", "billing_poc_name",
  "payment_upfront_pct", "payment_net_days", "payment_completion", "payment_credit_line",
  "ddp_min_limit", "ddp_max_limit",
] as const;

export const CONTACT_FIELDS = ["poc_email", "poc_phone", "poc_name", "shipping_address"] as const;

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

const str = (v: any): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};

const num = (v: any): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

interface TenkaraSupplier {
  id: string;
  name: string;
  poc_name: string | null;
  poc_email: string | null;
  poc_phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  shipping_terms: string | null;
  shipping_email: string | null;
  billing_email: string | null;
  payment_terms: any;
  ddp_minimum_limit: string | number | null;
  ddp_maximum_limit: string | number | null;
  accessorial_charges: any;
}

let supplierCache: { rows: TenkaraSupplier[]; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

async function loadTenkaraSuppliers(): Promise<TenkaraSupplier[]> {
  if (supplierCache && Date.now() - supplierCache.at < CACHE_MS) return supplierCache.rows;
  const rows = await tenkaraQuery<TenkaraSupplier>(
    `SELECT id, name, poc_name, poc_email, poc_phone, address, city, state, zip,
            shipping_terms, shipping_email, billing_email, payment_terms,
            ddp_minimum_limit, ddp_maximum_limit, accessorial_charges
     FROM public.suppliers`
  );
  supplierCache = { rows, at: Date.now() };
  return rows;
}

function fullAddress(s: TenkaraSupplier): string | null {
  const locality = [s.city, s.state].filter(Boolean).join(", ");
  const line = [s.address, locality, s.zip].filter(Boolean).join(", ");
  return line || null;
}

// Tenkara keys payment terms by the client's Tenkara org id. Use the client's
// own terms; if there is exactly one entry and it isn't org-scoped to someone
// else, that is this supplier's only agreement and applies.
function paymentTermsFor(raw: any, tenkaraOrgId: string | null): any | null {
  if (!raw || typeof raw !== "object") return null;
  if (tenkaraOrgId && raw[tenkaraOrgId]) return raw[tenkaraOrgId];
  const entries = Object.values(raw).filter((v) => v && typeof v === "object");
  return entries.length === 1 ? entries[0] : null;
}

function accessorial(raw: any, tenkaraOrgId: string | null): Record<string, any> {
  if (!raw || typeof raw !== "object") return {};
  const byOrg = tenkaraOrgId ? raw.by_org?.[tenkaraOrgId] : null;
  return { ...(raw.defaults ?? {}), ...(byOrg ?? {}) };
}

// Free-text supplier terms off a reply ("Net 30, 25% deposit") — only the two
// shapes that are unambiguous. Anything else stays null rather than guessed.
export function parsePaymentTermsText(text: string | null | undefined): { net_days?: number; upfront?: number } {
  const out: { net_days?: number; upfront?: number } = {};
  if (!text) return out;
  const net = text.match(/net\s*[- ]?\s*(\d{1,3})\b/i);
  if (net) out.net_days = parseInt(net[1], 10);
  const up = text.match(/(\d{1,3})\s*%\s*(?:up ?front|deposit|advance|in advance|prepay)/i);
  if (up) out.upfront = parseInt(up[1], 10);
  return out;
}

function leadContact(payload: any): Record<string, string | null> {
  const p = payload ?? {};
  const c = p.enrichment?.contact ?? {};
  return {
    poc_email: str(p.supplier_contact_email) ?? str(p.contact_email) ?? str(c.email),
    poc_phone: str(p.sales_phone) ?? str(c.phone),
    poc_name: str(p.poc_name) ?? str(c.name),
    shipping_address: str(p.hq_address) ?? str(p.supplier_address),
  };
}

const isEmpty = (v: any): boolean => v === null || v === undefined || v === "";

export interface FillStats {
  profilesUpdated: number;
  fieldsFilled: number;
  bySource: Record<string, number>;
}

export async function fillProfilesFromKnownSources(
  admin: SupabaseClient,
  orgId: string,
  tenkaraOrgId: string | null
): Promise<FillStats> {
  const stats: FillStats = { profilesUpdated: 0, fieldsFilled: 0, bySource: {} };
  const profiles = await getSupplierProfiles(admin, orgId);
  if (!profiles.length) return stats;

  const [{ data: leads }, { data: staged }] = await Promise.all([
    admin
      .from("leads_in_flight")
      .select("supplier_id, supplier_name, payload")
      .eq("org_id", orgId)
      .eq("status", "active"),
    admin
      .from("staged_quotes")
      .select("supplier_id, supplier_name, payment_terms")
      .eq("org_id", orgId)
      .not("payment_terms", "is", null),
  ]);

  // Best contact each lead knows about, merged across that supplier's leads:
  // one lead may carry the email and another the phone.
  const leadByKey = new Map<string, Record<string, string | null>>();
  for (const lead of (leads ?? []) as any[]) {
    const keys = [lead.supplier_id, norm(lead.supplier_name)].filter(Boolean) as string[];
    const contact = leadContact(lead.payload);
    for (const k of keys) {
      const cur = leadByKey.get(k) ?? {};
      for (const [f, v] of Object.entries(contact)) if (isEmpty(cur[f]) && v) cur[f] = v;
      leadByKey.set(k, cur);
    }
  }

  const stagedByKey = new Map<string, string>();
  for (const q of (staged ?? []) as any[]) {
    const terms = str(q.payment_terms);
    if (!terms) continue;
    for (const k of [q.supplier_id, norm(q.supplier_name)].filter(Boolean) as string[]) {
      if (!stagedByKey.has(k)) stagedByKey.set(k, terms);
    }
  }

  let tenkaraById = new Map<string, TenkaraSupplier>();
  let tenkaraByName = new Map<string, TenkaraSupplier>();
  try {
    const rows = await loadTenkaraSuppliers();
    tenkaraById = new Map(rows.map((r) => [r.id, r]));
    tenkaraByName = new Map();
    for (const r of rows) {
      const k = norm(r.name);
      if (k && !tenkaraByName.has(k)) tenkaraByName.set(k, r);
    }
  } catch {
    // Tenkara unreachable: still fill from leads and replies.
  }

  for (const p of profiles) {
    const nameKey = norm(p.supplier_name);
    const updates: Record<string, any> = {};
    const sources: Record<string, FieldSource> = {};

    const put = (field: keyof SupplierProfile, value: any, source: FieldSource) => {
      if (isEmpty(value)) return;
      if (!isEmpty((p as any)[field]) || !isEmpty(updates[field])) return;
      updates[field as string] = value;
      sources[field as string] = source;
    };

    const t = (p.supplier_id ? tenkaraById.get(p.supplier_id) : undefined) ?? tenkaraByName.get(nameKey);
    if (t) {
      put("poc_email", str(t.poc_email), "tenkara");
      put("poc_phone", str(t.poc_phone), "tenkara");
      put("poc_name", str(t.poc_name), "tenkara");
      put("shipping_address", fullAddress(t), "tenkara");
      put("shipping_terms", str(t.shipping_terms), "tenkara");
      put("shipping_email", str(t.shipping_email), "tenkara");
      put("billing_email", str(t.billing_email), "tenkara");
      put("ddp_min_limit", num(t.ddp_minimum_limit), "tenkara");
      put("ddp_max_limit", num(t.ddp_maximum_limit), "tenkara");
      if (!p.ddp_can_book && (num(t.ddp_minimum_limit) != null || num(t.ddp_maximum_limit) != null)) {
        updates.ddp_can_book = true;
        sources.ddp_can_book = "tenkara";
      }
      const pt = paymentTermsFor(t.payment_terms, tenkaraOrgId);
      if (pt) {
        put("payment_upfront_pct", num(pt.upfront), "tenkara");
        put("payment_net_days", num(pt.net_days), "tenkara");
        put("payment_completion", num(pt.completion) != null ? String(pt.completion) : null, "tenkara");
        put("payment_credit_line", num(pt.credit_line) != null ? String(pt.credit_line) : null, "tenkara");
      }
      const fees = accessorial(t.accessorial_charges, tenkaraOrgId);
      const feeMap: Record<string, string[]> = {
        hazmat_handling_fee: ["hazmat", "hazmat_handling", "hazmat_fee"],
        temp_storage_fee: ["temp_storage", "temperature_storage", "storage"],
        liftgate_fee: ["liftgate", "lift_gate"],
        special_packaging_fee: ["special_packaging", "packaging"],
      };
      for (const [col, keys] of Object.entries(feeMap)) {
        if (Number((p as any)[col]) !== 0) continue;
        const hit = keys.map((k) => num(fees[k])).find((v) => v != null && v !== 0);
        if (hit != null) {
          updates[col] = hit;
          sources[col] = "tenkara";
        }
      }
    }

    const lead = (p.supplier_id ? leadByKey.get(p.supplier_id) : undefined) ?? leadByKey.get(nameKey);
    if (lead) {
      for (const f of CONTACT_FIELDS) put(f, lead[f], "lead");
    }

    const terms = (p.supplier_id ? stagedByKey.get(p.supplier_id) : undefined) ?? stagedByKey.get(nameKey);
    if (terms) {
      const parsed = parsePaymentTermsText(terms);
      put("payment_net_days", parsed.net_days ?? null, "staged_quote");
      put("payment_upfront_pct", parsed.upfront ?? null, "staged_quote");
    }

    if (!Object.keys(updates).length) continue;
    const { error } = await admin
      .from("supplier_profiles")
      .update({ ...updates, field_sources: { ...((p as any).field_sources ?? {}), ...sources } })
      .eq("id", p.id);
    if (error) continue;
    stats.profilesUpdated += 1;
    for (const s of Object.values(sources)) {
      stats.fieldsFilled += 1;
      stats.bySource[s] = (stats.bySource[s] ?? 0) + 1;
    }
  }

  return stats;
}

// Fields a supplier only ever tells us in a reply, so a blank one means
// "asked, not answered yet" rather than "we failed to look it up".
export function isTermsField(field: string): boolean {
  return (TERMS_FIELDS as readonly string[]).includes(field);
}
