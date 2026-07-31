import { SupabaseClient } from "@supabase/supabase-js";
import { resolveCaseDims, type CaseDims } from "@/lib/marketplace-case-dims";

export interface QuoteProfile {
  id: string;
  org_id: string;
  supplier_id: string | null;
  supplier_name: string;
  material_id: string | null;
  material_name: string;
  price: number | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  currency: string;
  case_type: string | null;
  case_width: number | null;
  case_height: number | null;
  case_length: number | null;
  case_dimensions_unit: string;
  case_weight: number | null;
  quote_expiry: string | null;
  lead_time_days: number | null;
  min_inventory: number | null;
  min_inventory_unit: string | null;
  max_inventory: number | null;
  max_inventory_unit: string | null;
  is_hazardous: boolean;
  is_refrigerated: boolean;
  protect_from_freezing: boolean;
  material_sku: string | null;
  purchasing_notes: string | null;
  name_match: boolean;
  inci_match: boolean;
  grades_match: boolean;
  grades_match_detail: string | null;
  additional_grades: string | null;
  preorder_coa_required: boolean;
  preorder_coa_dealbreaker: boolean;
  preorder_coa_requested: boolean;
  preorder_coa_met: boolean;
  preorder_sds_required: boolean;
  preorder_sds_dealbreaker: boolean;
  preorder_sds_requested: boolean;
  preorder_sds_met: boolean;
  preorder_tds_required: boolean;
  preorder_tds_dealbreaker: boolean;
  preorder_tds_requested: boolean;
  preorder_tds_met: boolean;
  preorder_sample_required: boolean;
  preorder_sample_dealbreaker: boolean;
  preorder_sample_requested: boolean;
  preorder_sample_met: boolean;
  postorder_coa_required: boolean;
  postorder_coa_dealbreaker: boolean;
  postorder_sds_required: boolean;
  postorder_sds_dealbreaker: boolean;
  postorder_tds_required: boolean;
  postorder_tds_dealbreaker: boolean;
  notes: string | null;
  generated_notes: string | null;
  approval_status: "draft" | "pending_review" | "ready_for_submission" | "submitted";
  created_at: string;
  updated_at: string;
}

const PROFILE_COLUMNS = `
  id, org_id, supplier_id, supplier_name, material_id, material_name,
  price, case_size, unit_of_measurement, currency,
  case_type, case_width, case_height, case_length, case_dimensions_unit, case_weight,
  quote_expiry, lead_time_days,
  min_inventory, min_inventory_unit, max_inventory, max_inventory_unit,
  is_hazardous, is_refrigerated, protect_from_freezing,
  material_sku, purchasing_notes,
  name_match, inci_match, grades_match, grades_match_detail, additional_grades,
  preorder_coa_required, preorder_coa_dealbreaker, preorder_coa_requested, preorder_coa_met,
  preorder_sds_required, preorder_sds_dealbreaker, preorder_sds_requested, preorder_sds_met,
  preorder_tds_required, preorder_tds_dealbreaker, preorder_tds_requested, preorder_tds_met,
  preorder_sample_required, preorder_sample_dealbreaker, preorder_sample_requested, preorder_sample_met,
  postorder_coa_required, postorder_coa_dealbreaker,
  postorder_sds_required, postorder_sds_dealbreaker,
  postorder_tds_required, postorder_tds_dealbreaker,
  notes, generated_notes, approval_status, created_at, updated_at
`;

export async function getQuoteProfiles(
  admin: SupabaseClient,
  orgId: string
): Promise<QuoteProfile[]> {
  const { data, error } = await admin
    .from("quote_profiles")
    .select(PROFILE_COLUMNS)
    .eq("org_id", orgId)
    .order("supplier_name");
  if (error) throw error;
  return (data ?? []) as QuoteProfile[];
}

export type QuoteProfileUpdate = Partial<
  Omit<QuoteProfile, "id" | "org_id" | "generated_notes" | "created_at" | "updated_at">
>;

type QuoteProfileSeed = QuoteProfileUpdate & { generated_notes?: string | null };

export async function updateQuoteProfile(
  admin: SupabaseClient,
  profileId: string,
  updates: QuoteProfileUpdate
): Promise<QuoteProfile> {
  const { data, error } = await admin
    .from("quote_profiles")
    .update(updates)
    .eq("id", profileId)
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return data as QuoteProfile;
}

export async function insertQuoteProfile(
  admin: SupabaseClient,
  orgId: string,
  fields: QuoteProfileSeed
): Promise<QuoteProfile> {
  const { data, error } = await admin
    .from("quote_profiles")
    .insert({
      org_id: orgId,
      supplier_name: fields.supplier_name ?? "",
      material_name: fields.material_name ?? "",
      ...fields,
    })
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return data as QuoteProfile;
}

// Seed quote profiles from staged_quotes
export async function seedQuoteProfilesFromStaged(
  admin: SupabaseClient,
  orgId: string,
  limit = Infinity
): Promise<number> {
  if (limit <= 0) return 0;
  const { data: staged } = await admin
    .from("staged_quotes")
    .select("supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, currency, case_type, case_dimensions, lead_time_days, moq_quantity, moq_unit, payment_terms, grade")
    .eq("org_id", orgId)
    .not("status", "eq", "dismissed");
  if (!staged?.length) return 0;

  const existing = await getQuoteProfiles(admin, orgId);
  const existingByKey = new Map(
    existing.map((p) => [`${p.supplier_name?.toLowerCase()}|${p.material_name?.toLowerCase()}`, p])
  );

  let created = 0;
  for (const s of staged as any[]) {
    const key = `${(s.supplier_name ?? "").toLowerCase()}|${(s.material_name ?? "").toLowerCase()}`;
    const current = existingByKey.get(key);
    const dims = s.case_dimensions ?? {};
    try {
      const generatedNotes = [
        s.price != null ? `Quoted ${s.currency ?? "USD"} ${Number(s.price)}${s.case_size ? ` for case size ${s.case_size} ${s.unit_of_measurement ?? "units"}` : ""}.` : null,
        s.lead_time_days != null ? `Lead time: ${s.lead_time_days} days.` : null,
        s.moq_quantity != null ? `MOQ: ${s.moq_quantity}${s.moq_unit ? ` ${s.moq_unit}` : ""}.` : null,
        s.payment_terms ? `Payment terms: ${s.payment_terms}.` : null,
        s.grade ? `Grade: ${s.grade}.` : null,
      ].filter(Boolean).join(" ");
      if (current) {
        await admin.from("quote_profiles").update({ generated_notes: generatedNotes || null }).eq("id", current.id);
        continue;
      }
      await insertQuoteProfile(admin, orgId, {
        supplier_id: s.supplier_id ?? null,
        supplier_name: s.supplier_name ?? "",
        material_id: s.material_id ?? null,
        material_name: s.material_name ?? "",
        price: s.price != null ? Number(s.price) : null,
        case_size: s.case_size != null ? Number(s.case_size) : null,
        unit_of_measurement: s.unit_of_measurement ?? null,
        currency: s.currency ?? "USD",
        case_type: s.case_type ?? null,
        case_width: dims.width != null ? Number(dims.width) : null,
        case_height: dims.height != null ? Number(dims.height) : null,
        case_length: dims.length != null ? Number(dims.length) : null,
        case_weight: dims.packaging_case_weight != null ? Number(dims.packaging_case_weight) : null,
        lead_time_days: s.lead_time_days ?? null,
        min_inventory: s.moq_quantity != null ? Number(s.moq_quantity) : null,
        min_inventory_unit: s.moq_unit ?? null,
        additional_grades: s.grade ?? null,
        generated_notes: generatedNotes || null,
      });
      existingByKey.set(key, {} as QuoteProfile);
      created++;
      if (created >= limit) break;
    } catch {
      // skip duplicates
    }
  }
  return created;
}

// --- Marketplace listing parsers -------------------------------------------
// These read free-text scraped off a product page (never operator input), so
// they are deliberately conservative: if the value isn't unambiguous we return
// null rather than guess. A wrong case_size feeds the freight calc, so a blank
// is safer than a bad parse.

// Leading "<number> <unit>" of a pack string, e.g. "1.25 Lb" → {size:1.25, unit:"lb"}.
// Single-letter units (g/l/G) are excluded — "5G" is ambiguous (gram vs gallon).
const PACK_RE =
  /(\d+(?:\.\d+)?)\s*(kg|mg|lbs?|pounds?|oz|ounces?|fl\s?oz|ml|kl|gal|gallons?|liters?|litres?|mt|tons?|tonnes?)\b/i;
export function parsePackSize(pack: string | null | undefined): { size: number | null; unit: string | null } {
  if (!pack) return { size: null, unit: null };
  const m = pack.match(PACK_RE);
  if (!m) return { size: null, unit: null };
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { size: null, unit: null };
  return { size: n, unit: m[2].toLowerCase().replace(/\s+/g, " ") };
}

// "Ships in 3-5 business days" → 5 (upper bound of a range); weeks → ×7.
export function parseLeadTimeDays(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)\s*(?:[-–to]+\s*(\d+))?\s*(business\s+)?(day|days|week|weeks|wk|wks)\b/i);
  if (!m) return null;
  const hi = m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10);
  if (!Number.isFinite(hi)) return null;
  return /week|wk/i.test(m[4]) ? hi * 7 : hi;
}

// "Min. order: 25 kg" → {qty:25, unit:"kg"}; falls back to a bare quantity.
export function parseMoq(text: string | null | undefined): { qty: number | null; unit: string | null } {
  if (!text) return { qty: null, unit: null };
  const packed = parsePackSize(text);
  if (packed.size != null) return { qty: packed.size, unit: packed.unit };
  const m = text.match(/(\d+(?:\.\d+)?)\s*(units?|pieces?|pcs?|each|ea)?\b/i);
  if (!m) return { qty: null, unit: null };
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { qty: null, unit: null };
  return { qty: n, unit: m[2] ? m[2].toLowerCase() : null };
}

// Seed quote profiles for MARKETPLACE leads directly from the price we already
// web-fetched (leads_in_flight.payload.marketplace_pull), so marketplace
// suppliers fill in without waiting for an email reply. Direct suppliers keep
// the reply-driven staged_quotes path. Create-only: never overwrites a profile
// that already exists for that supplier+material (a staged/negotiated quote or
// an operator edit wins). dimsMap resolves the outer-case estimate from the
// pack size (marketplace_case_dims cache); Level-2 fields (lead time, MOQ) come
// from the listing when the extractor captured them, else stay null.
export async function seedQuoteProfilesFromMarketplace(
  admin: SupabaseClient,
  orgId: string,
  dimsMap: Record<string, CaseDims>,
  limit = Infinity
): Promise<number> {
  if (limit <= 0) return 0;
  const { data: leads } = await admin
    .from("leads_in_flight")
    .select("supplier_id, supplier_name, material_id, material_name, payload")
    .eq("org_id", orgId)
    .eq("status", "active")
    .eq("payload->marketplace_pull->>status", "pulled")
    .or("payload->>site_type.in.(M,MS),payload->>supplier_role.eq.Marketplace");
  if (!leads?.length) return 0;

  const existing = await getQuoteProfiles(admin, orgId);
  const existingKeys = new Set(
    existing.map((p) => `${p.supplier_name?.toLowerCase()}|${p.material_name?.toLowerCase()}`)
  );

  let created = 0;
  for (const l of leads as any[]) {
    const key = `${(l.supplier_name ?? "").toLowerCase()}|${(l.material_name ?? "").toLowerCase()}`;
    if (existingKeys.has(key)) continue;
    const mp = l.payload?.marketplace_pull ?? {};
    const price = mp.price != null ? Number(mp.price) : null;
    if (price == null || !Number.isFinite(price)) continue; // no usable price — skip
    existingKeys.add(key);
    const pack = typeof mp.pack_size === "string" ? mp.pack_size : null;
    const { size, unit } = parsePackSize(pack);
    const dims = resolveCaseDims(dimsMap, pack);
    const leadTime = parseLeadTimeDays(mp.lead_time);
    const moq = parseMoq(mp.moq);
    const src = typeof mp.source_url === "string" ? mp.source_url : null;
    try {
      await insertQuoteProfile(admin, orgId, {
        supplier_id: l.supplier_id ?? null,
        supplier_name: l.supplier_name ?? "",
        material_id: l.material_id ?? null,
        material_name: l.material_name ?? "",
        price,
        case_size: size,
        unit_of_measurement: unit,
        currency: typeof mp.currency === "string" && mp.currency ? mp.currency : "USD",
        case_type: dims?.case_type ?? null,
        case_width: dims?.width ?? null,
        case_height: dims?.height ?? null,
        case_length: dims?.length ?? null,
        case_weight: dims?.weight_kg ?? null,
        lead_time_days: leadTime,
        min_inventory: moq.qty,
        min_inventory_unit: moq.unit,
        purchasing_notes: `Auto-filled from marketplace listing${pack ? ` (${pack})` : ""}${src ? ` — ${src}` : ""}`,
      });
      created++;
      if (created >= limit) break;
    } catch {
      // skip duplicates
    }
  }
  return created;
}

const QUOTING_FIELDS: (keyof QuoteProfile)[] = [
  "price", "case_size", "unit_of_measurement", "case_type",
  "case_width", "case_height", "case_length", "case_weight",
  "quote_expiry", "lead_time_days",
];

const QUALIFYING_FIELDS: (keyof QuoteProfile)[] = [
  "name_match", "inci_match", "grades_match",
];

const PREORDER_FIELDS: (keyof QuoteProfile)[] = [
  "preorder_coa_met", "preorder_sds_met", "preorder_tds_met",
];

export function quoteCompleteness(p: QuoteProfile): {
  filled: number;
  total: number;
  pct: number;
} {
  const all = [...QUOTING_FIELDS, ...QUALIFYING_FIELDS, ...PREORDER_FIELDS];
  const total = all.length;
  let filled = 0;
  for (const f of all) {
    const v = p[f];
    if (v != null && v !== "" && v !== false && v !== 0) filled++;
  }
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  return { filled, total, pct };
}
