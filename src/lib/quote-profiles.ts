import { SupabaseClient } from "@supabase/supabase-js";

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
  notes, approval_status, created_at, updated_at
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
  Omit<QuoteProfile, "id" | "org_id" | "created_at" | "updated_at">
>;

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
  fields: QuoteProfileUpdate
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
  orgId: string
): Promise<number> {
  const { data: staged } = await admin
    .from("staged_quotes")
    .select("supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, currency, case_type, case_dimensions, lead_time_days, moq_quantity, moq_unit, payment_terms, grade")
    .eq("org_id", orgId)
    .not("status", "eq", "dismissed");
  if (!staged?.length) return 0;

  const existing = await getQuoteProfiles(admin, orgId);
  const existingKeys = new Set(
    existing.map((p) => `${p.supplier_name?.toLowerCase()}|${p.material_name?.toLowerCase()}`)
  );

  let created = 0;
  for (const s of staged as any[]) {
    const key = `${(s.supplier_name ?? "").toLowerCase()}|${(s.material_name ?? "").toLowerCase()}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    const dims = s.case_dimensions ?? {};
    try {
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
      });
      created++;
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
