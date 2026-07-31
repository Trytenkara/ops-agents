import { SupabaseClient } from "@supabase/supabase-js";

export interface SupplierProfile {
  id: string;
  org_id: string;
  supplier_id: string | null;
  supplier_name: string;
  supplier_type: "marketplace" | "direct" | null;
  poc_email: string | null;
  poc_phone: string | null;
  poc_name: string | null;
  shipping_address: string | null;
  shipping_terms: string | null;
  shipping_email: string | null;
  ddp_can_book: boolean;
  ddp_min_limit: number | null;
  ddp_max_limit: number | null;
  billing_email: string | null;
  billing_poc_name: string | null;
  payment_upfront_pct: number | null;
  payment_net_days: number | null;
  payment_completion: string | null;
  payment_credit_line: string | null;
  hazmat_handling_fee: number;
  temp_storage_fee: number;
  liftgate_fee: number;
  special_packaging_fee: number;
  contact_info_complete: boolean;
  marketplace_type_correct: boolean;
  address_accurate: boolean;
  shipping_terms_correct: boolean;
  billing_verified: boolean;
  payment_info_verified: boolean;
  payment_terms_confirmed: boolean;
  notes: string | null;
  approval_status: "draft" | "pending_review" | "ready_for_submission" | "submitted";
  created_at: string;
  updated_at: string;
}

const PROFILE_COLUMNS = `
  id, org_id, supplier_id, supplier_name, supplier_type,
  poc_email, poc_phone, poc_name,
  shipping_address, shipping_terms, shipping_email,
  ddp_can_book, ddp_min_limit, ddp_max_limit,
  billing_email, billing_poc_name,
  payment_upfront_pct, payment_net_days, payment_completion, payment_credit_line,
  hazmat_handling_fee, temp_storage_fee, liftgate_fee, special_packaging_fee,
  contact_info_complete, marketplace_type_correct, address_accurate,
  shipping_terms_correct, billing_verified, payment_info_verified, payment_terms_confirmed,
  notes, approval_status, created_at, updated_at
`;

export async function getSupplierProfiles(
  admin: SupabaseClient,
  orgId: string
): Promise<SupplierProfile[]> {
  const { data, error } = await admin
    .from("supplier_profiles")
    .select(PROFILE_COLUMNS)
    .eq("org_id", orgId)
    .order("supplier_name");
  if (error) throw error;
  return (data ?? []) as SupplierProfile[];
}

export async function getSupplierProfile(
  admin: SupabaseClient,
  profileId: string
): Promise<SupplierProfile | null> {
  const { data, error } = await admin
    .from("supplier_profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw error;
  return data as SupplierProfile | null;
}

export async function upsertSupplierProfile(
  admin: SupabaseClient,
  orgId: string,
  supplierId: string | null,
  supplierName: string,
  seed: Partial<SupplierProfile> = {}
): Promise<SupplierProfile> {
  if (supplierId) {
    const { data: existing } = await admin
      .from("supplier_profiles")
      .select(PROFILE_COLUMNS)
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .maybeSingle();
    if (existing) return existing as SupplierProfile;
  }

  const { data, error } = await admin
    .from("supplier_profiles")
    .insert({
      org_id: orgId,
      supplier_id: supplierId,
      supplier_name: supplierName,
      supplier_type: seed.supplier_type ?? null,
      poc_email: seed.poc_email ?? null,
      poc_phone: seed.poc_phone ?? null,
      poc_name: seed.poc_name ?? null,
      shipping_address: seed.shipping_address ?? null,
      shipping_email: seed.shipping_email ?? null,
      billing_email: seed.billing_email ?? null,
    })
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return data as SupplierProfile;
}

export type SupplierProfileUpdate = Partial<
  Omit<SupplierProfile, "id" | "org_id" | "created_at" | "updated_at">
>;

export async function updateSupplierProfile(
  admin: SupabaseClient,
  profileId: string,
  updates: SupplierProfileUpdate
): Promise<SupplierProfile> {
  const { data, error } = await admin
    .from("supplier_profiles")
    .update(updates)
    .eq("id", profileId)
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return data as SupplierProfile;
}

// Seed profiles for all suppliers in an org from their lead enrichment data.
// Only creates profiles that don't already exist (by supplier_id).
export async function seedProfilesFromLeads(
  admin: SupabaseClient,
  orgId: string,
  limit = Infinity
): Promise<number> {
  if (limit <= 0) return 0;
  const { data: leads } = await admin
    .from("leads_in_flight")
    .select("supplier_id, supplier_name, payload, source")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (!leads?.length) return 0;

  // Most leads carry only a supplier_name (no supplier_id), and the Supplier
  // Validation view groups by `supplier_id ?? supplier_name`, so we seed on the
  // same key — otherwise the vast name-only majority never gets a profile.
  // Dedup is critical for name-only suppliers: upsertSupplierProfile only
  // dedupes by supplier_id, so a name-only insert would be repeated on every
  // run. We skip any supplier whose id OR name already has a profile.
  const existing = await getSupplierProfiles(admin, orgId);
  const existingIds = new Set(existing.map((p) => p.supplier_id).filter(Boolean));
  const existingNames = new Set(
    existing.map((p) => (p.supplier_name ?? "").trim().toLowerCase()).filter(Boolean)
  );

  // Group leads by supplier_id (preferred) or lowercased name, first lead wins.
  const bySupplier = new Map<string, { supplierId: string | null; name: string; payload: any }>();
  for (const lead of leads) {
    const name = (lead.supplier_name ?? "").trim();
    const nameKey = name.toLowerCase();
    const key = lead.supplier_id ?? nameKey;
    if (!key) continue; // neither id nor name — can't identify a supplier
    if (lead.supplier_id ? existingIds.has(lead.supplier_id) : existingNames.has(nameKey)) continue;
    if (bySupplier.has(key)) continue;
    bySupplier.set(key, { supplierId: lead.supplier_id ?? null, name, payload: lead.payload ?? {} });
  }

  let created = 0;
  for (const info of bySupplier.values()) {
    const nameKey = info.name.toLowerCase();
    // Guard the id-less path once more against names claimed earlier this batch.
    if (!info.supplierId && existingNames.has(nameKey)) continue;
    const p = info.payload;
    const isMarketplace =
      p.site_type === "M" || p.site_type === "MS" ? "marketplace" : "direct";
    try {
      await upsertSupplierProfile(admin, orgId, info.supplierId, info.name, {
        supplier_type: isMarketplace as "marketplace" | "direct",
        poc_email: p.supplier_contact_email ?? p.contact_email ?? null,
        poc_phone: p.sales_phone ?? null,
        poc_name: p.poc_name ?? null,
        shipping_address: p.hq_address ?? null,
      });
      if (nameKey) existingNames.add(nameKey);
      created++;
      if (created >= limit) break;
    } catch {
      // skip duplicates
    }
  }
  return created;
}

// Completeness score: how many of the approval-required fields are filled.
const COMPLETENESS_FIELDS: (keyof SupplierProfile)[] = [
  "supplier_type",
  "poc_email",
  "poc_phone",
  "poc_name",
  "shipping_address",
  "shipping_terms",
  "shipping_email",
  "billing_email",
  "billing_poc_name",
  "payment_upfront_pct",
];

const CHECKLIST_FIELDS: (keyof SupplierProfile)[] = [
  "contact_info_complete",
  "marketplace_type_correct",
  "address_accurate",
  "shipping_terms_correct",
  "billing_verified",
  "payment_info_verified",
  "payment_terms_confirmed",
];

export function profileCompleteness(p: SupplierProfile): {
  filled: number;
  total: number;
  pct: number;
  checked: number;
  checkTotal: number;
} {
  const total = COMPLETENESS_FIELDS.length;
  let filled = 0;
  for (const f of COMPLETENESS_FIELDS) {
    const v = p[f];
    if (v != null && v !== "" && v !== false) filled++;
  }
  const checkTotal = CHECKLIST_FIELDS.length;
  let checked = 0;
  for (const f of CHECKLIST_FIELDS) {
    if (p[f] === true) checked++;
  }
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  return { filled, total, pct, checked, checkTotal };
}
