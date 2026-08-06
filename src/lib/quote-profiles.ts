import { SupabaseClient } from "@supabase/supabase-js";
import { resolveCaseDims, type CaseDims } from "@/lib/marketplace-case-dims";
import { selectAllPaged } from "@/lib/supabase-paging";

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
  // Raw pack label off the listing ("25 KG (55 LB)"). Identifies which rung of a
  // supplier's price ladder this quote is, and survives a pack string case_size
  // can't parse.
  pack_size: string | null;
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
  source_url: string | null;
  density: number | null;
  density_unit: string | null;
  density_source: string | null;
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
  price, case_size, unit_of_measurement, pack_size, currency,
  case_type, case_width, case_height, case_length, case_dimensions_unit, case_weight,
  quote_expiry, lead_time_days,
  min_inventory, min_inventory_unit, max_inventory, max_inventory_unit,
  is_hazardous, is_refrigerated, protect_from_freezing,
  material_sku, purchasing_notes,
  source_url, density, density_unit, density_source,
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

// Paged for the same reason as getSupplierProfiles: a 1000-row truncation would
// make the seeders' dedup guard blind and duplicate every profile past the cap.
export async function getQuoteProfiles(
  admin: SupabaseClient,
  orgId: string
): Promise<QuoteProfile[]> {
  const PAGE = 1000;
  const all: QuoteProfile[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("quote_profiles")
      .select(PROFILE_COLUMNS)
      .eq("org_id", orgId)
      .order("supplier_name")
      // created_at, not id: the id is a random uuid, so ordering by it scattered
      // a newly added quote anywhere in its supplier's list. Oldest first puts a
      // manual add at the bottom where the operator just created it.
      .order("created_at")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as QuoteProfile[]));
    if (!data || data.length < PAGE) return all;
  }
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
  const staged = await selectAllPaged<any>((from, to) =>
    admin
      .from("staged_quotes")
      .select("supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, currency, case_type, case_dimensions, lead_time_days, moq_quantity, moq_unit, payment_terms, grade, source_attachment_url")
      .eq("org_id", orgId)
      .not("status", "eq", "dismissed")
      .order("id")
      .range(from, to)
  );
  if (!staged.length) return 0;

  const existing = await getQuoteProfiles(admin, orgId);
  // A reply-driven quote belongs on the packless profile, never on one of a
  // marketplace ladder's tier rows — those are public listing prices this
  // supplier never negotiated.
  // Keyed on the supplier NAME, so a nameless quote would key on the material
  // alone and collide with every other nameless quote for it — the second
  // supplier's quote would be swallowed as an update to the first. Nameless
  // quotes are excluded from the index and always insert.
  const existingByKey = new Map<string, QuoteProfile>();
  for (const p of existing) {
    if (!p.supplier_name?.trim()) continue;
    const key = `${p.supplier_name.toLowerCase()}|${p.material_name?.toLowerCase()}`;
    const prev = existingByKey.get(key);
    if (!prev || (prev.pack_size && !p.pack_size)) existingByKey.set(key, p);
  }

  let created = 0;
  // Counts every write, not just inserts: see the same fix in supplier-profiles.
  let touched = 0;
  for (const s of staged as any[]) {
    const supplierKey = (s.supplier_name ?? "").trim().toLowerCase();
    const key = `${supplierKey}|${(s.material_name ?? "").toLowerCase()}`;
    const current = supplierKey ? existingByKey.get(key) : undefined;
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
        if ((generatedNotes || null) === (current.generated_notes ?? null)) continue;
        await admin.from("quote_profiles").update({ generated_notes: generatedNotes || null }).eq("id", current.id);
        touched++;
        if (touched >= limit) break;
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
        source_url: typeof s.source_attachment_url === "string" ? s.source_attachment_url : null,
        generated_notes: generatedNotes || null,
      });
      existingByKey.set(key, {} as QuoteProfile);
      created++;
      touched++;
      if (touched >= limit) break;
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
// A vulgar fraction is accepted ("1/2 KG" → 0.5 kg): sub-kilo rungs on a ladder
// are written that way, and failing them left the tier with no unit at all, which
// blocks every $/kg comparison downstream.
const PACK_RE =
  /^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*(kg|mg|lbs?|pounds?|oz|ounces?|fl\s?oz|ml|kl|gal|gallons?|liters?|litres?|mt|tons?|tonnes?)\b/i;
export function parsePackSize(pack: string | null | undefined): { size: number | null; unit: string | null } {
  if (!pack) return { size: null, unit: null };
  const m = pack.match(PACK_RE);
  if (!m) return { size: null, unit: null };
  const numerator = parseFloat(m[1]);
  const denominator = m[2] != null ? parseFloat(m[2]) : 1;
  if (!Number.isFinite(numerator) || numerator <= 0) return { size: null, unit: null };
  if (!Number.isFinite(denominator) || denominator <= 0) return { size: null, unit: null };
  const n = numerator / denominator;
  if (!Number.isFinite(n) || n <= 0) return { size: null, unit: null };
  return { size: n, unit: m[3].toLowerCase().replace(/\s+/g, " ") };
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

// "Minimum order: 25 kg" → {qty:25, unit:"kg"}. Never interpret a bare
// number or range because it may be a shipping threshold, pack count, or price.
export function parseMoq(text: string | null | undefined): { qty: number | null; unit: string | null } {
  if (!text) return { qty: null, unit: null };
  const m = text.match(/\b(?:minimum\s+order|min\.?\s+order|moq)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(kg|mg|lbs?|pounds?|oz|ounces?|fl\s?oz|ml|kl|gal|gallons?|liters?|litres?|mt|tons?|tonnes?|units?|pieces?|pcs?|each|ea)\b/i);
  if (!m) return { qty: null, unit: null };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { qty: null, unit: null };
  return { qty: n, unit: m[2].toLowerCase().replace(/\s+/g, " ") };
}

// Sync quote profiles for MARKETPLACE leads from the prices we already
// web-fetched (leads_in_flight.payload), so marketplace suppliers fill in without
// waiting for an email reply. Direct suppliers keep the reply-driven staged_quotes
// path.
//
// One profile per PACK TIER, not per supplier: a listing's ladder is a set of
// distinct quotes (25 KG at $276 is not the same offer as 1/2 KG at $10), and
// collapsing it to the headline threw away everything an operator actually
// negotiates against.
//
// Idempotent re-sync, not create-only: a marketplace price is a public fact that
// moves, so every pass re-reads it. Only the fields the listing owns are written,
// and an existing non-null is never blanked by a listing that stopped reporting
// the value — so operator corrections and the whole qualifying/document/approval
// side of the profile survive untouched.
const LISTING_NOTE_PREFIX = "Auto-filled from marketplace listing";

interface MarketplaceTier {
  pack: string | null;
  price: number;
}

// The ladder if we have one, else the single headline price as a one-rung ladder.
// A rung with no usable price is dropped rather than written as a null quote.
function marketplaceTiers(payload: any): MarketplaceTier[] {
  const mp = payload?.marketplace_pull ?? {};
  const raw = Array.isArray(payload?.price_tiers) && payload.price_tiers.length
    ? payload.price_tiers
    : [{ pack_size: mp.pack_size ?? null, price: mp.price }];
  const out: MarketplaceTier[] = [];
  const seen = new Set<string>();
  for (const t of raw as any[]) {
    const price = t?.price != null ? Number(t.price) : null;
    if (price == null || !Number.isFinite(price) || price <= 0) continue;
    const pack = typeof t?.pack_size === "string" && t.pack_size.trim() ? t.pack_size.trim() : null;
    const key = (pack ?? "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pack, price });
  }
  return out;
}

const packKeyOf = (pack: string | null | undefined) => (pack ?? "").trim().toLowerCase();

export async function syncQuoteProfilesFromMarketplace(
  admin: SupabaseClient,
  orgId: string,
  dimsMap: Record<string, CaseDims>,
  limit = Infinity
): Promise<{ created: number; updated: number }> {
  if (limit <= 0) return { created: 0, updated: 0 };
  const leads = await selectAllPaged<any>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("supplier_id, supplier_name, material_id, material_name, payload")
      .eq("org_id", orgId)
      .eq("status", "active")
      .eq("payload->marketplace_pull->>status", "pulled")
      .or("payload->>site_type.in.(M,MS,A),payload->>supplier_role.eq.Marketplace")
      .order("id")
      .range(from, to)
  );
  if (!leads.length) return { created: 0, updated: 0 };

  const existing = await getQuoteProfiles(admin, orgId);
  const identityKey = (value: { supplier_id?: string | null; supplier_name?: string | null; material_id?: string | null; material_name?: string | null }) =>
    value.supplier_id && value.material_id
      ? `id:${value.supplier_id}:${value.material_id}`
      : `name:${(value.supplier_name ?? "").trim().toLowerCase()}|${(value.material_name ?? "").trim().toLowerCase()}`;
  const byIdentity = new Map<string, QuoteProfile[]>();
  for (const p of existing) {
    const key = identityKey(p);
    const bucket = byIdentity.get(key);
    if (bucket) bucket.push(p);
    else byIdentity.set(key, [p]);
  }

  let created = 0;
  let updated = 0;
  let writes = 0;
  for (const l of leads as any[]) {
    const mp = l.payload?.marketplace_pull ?? {};
    // Never publish a number we couldn't confirm as USD — a foreign figure read as
    // dollars is worse than no quote at all.
    if (String(mp.currency ?? "").trim().toUpperCase() !== "USD") continue;
    const tiers = marketplaceTiers(l.payload);
    if (!tiers.length) continue;

    const rows = byIdentity.get(identityKey(l)) ?? [];
    const leadTime = parseLeadTimeDays(mp.lead_time);
    const moq = parseMoq(mp.moq);
    const src = typeof mp.source_url === "string" ? mp.source_url : null;
    const claimed = new Set<string>();

    for (const tier of tiers) {
      if (writes >= limit) return { created, updated };
      const key = packKeyOf(tier.pack);
      let target = key ? rows.find((p) => packKeyOf(p.pack_size) === key) : undefined;
      // Pre-0087 rows carry no pack label. Adopt one instead of inserting beside
      // it, so the tier it was really quoting keeps its operator work; prefer the
      // rung whose price matches.
      if (!target) {
        target =
          rows.find((p) => !p.pack_size && !claimed.has(p.id) && p.price != null && Number(p.price) === tier.price) ??
          rows.find((p) => !p.pack_size && !claimed.has(p.id));
      }

      const { size, unit } = parsePackSize(tier.pack);
      const dims = resolveCaseDims(dimsMap, tier.pack);
      const listed = {
        pack_size: tier.pack,
        case_size: size,
        unit_of_measurement: unit,
        case_type: dims?.case_type ?? null,
        case_width: dims?.width ?? null,
        case_height: dims?.height ?? null,
        case_length: dims?.length ?? null,
        case_weight: dims?.weight_kg ?? null,
        lead_time_days: leadTime,
        min_inventory: moq.qty,
        min_inventory_unit: moq.unit,
        source_url: src,
      };

      if (!target) {
        try {
          const inserted = await insertQuoteProfile(admin, orgId, {
            supplier_id: l.supplier_id ?? null,
            supplier_name: l.supplier_name ?? "",
            material_id: l.material_id ?? null,
            material_name: l.material_name ?? "",
            price: tier.price,
            currency: "USD",
            ...listed,
            purchasing_notes: `${LISTING_NOTE_PREFIX}${tier.pack ? ` (${tier.pack})` : ""}`,
          });
          rows.push(inserted);
          byIdentity.set(identityKey(l), rows);
          claimed.add(inserted.id);
          created++;
          writes++;
        } catch {
          // Unique-index collision: another pass already wrote this tier.
        }
        continue;
      }

      claimed.add(target.id);
      const patch: QuoteProfileUpdate = {};
      // The listing owns the price outright — refreshing it is the point of the
      // re-sync.
      if (target.price == null || Number(target.price) !== tier.price) patch.price = tier.price;
      if (String(target.currency ?? "").toUpperCase() !== "USD") patch.currency = "USD";
      for (const [field, next] of Object.entries(listed) as [keyof typeof listed, any][]) {
        const current = (target as any)[field];
        // Fill a blank or move one non-null to another, but never blank a value the
        // listing has simply gone quiet about.
        if (next == null) continue;
        const same = typeof next === "number" ? current != null && Number(current) === next : current === next;
        if (same) continue;
        (patch as any)[field] = next;
      }
      if (!Object.keys(patch).length) continue;
      try {
        const fresh = await updateQuoteProfile(admin, target.id, patch);
        Object.assign(target, fresh);
        updated++;
        writes++;
      } catch {
        // Row moved or collided under us; the next pass retries.
      }
    }
  }
  return { created, updated };
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
