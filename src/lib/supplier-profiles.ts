import { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";
import { leadMarketKind, type MarketKind } from "@/lib/lead-market";

export interface SupplierProfile {
  id: string;
  org_id: string;
  supplier_id: string | null;
  supplier_name: string;
  supplier_type: MarketKind | null;
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
  generated_notes: string | null;
  field_sources: Record<string, string>;
  approval_status: "draft" | "pending_review" | "final_review";
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
  notes, generated_notes, field_sources, approval_status, created_at, updated_at
`;

// Paged: PostgREST caps a request at 1000 rows, and a truncated read here makes
// the seeder's dedup guard blind to everything past the cap, so it recreates
// those suppliers on every run.
export async function getSupplierProfiles(
  admin: SupabaseClient,
  orgId: string
): Promise<SupplierProfile[]> {
  const PAGE = 1000;
  const all: SupplierProfile[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("supplier_profiles")
      .select(PROFILE_COLUMNS)
      .eq("org_id", orgId)
      .order("supplier_name")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as SupplierProfile[]));
    if (!data || data.length < PAGE) return all;
  }
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

// Resolve supplier_id by looking up supplier_name in supplier_profiles for the org.
// Returns the supplier_id from the profile if found, else null. Used by export/approval
// workflows to backfill supplier_id on staged quotes when it was extracted as name-only.
export async function resolveSupplierIdByName(
  admin: SupabaseClient,
  orgId: string,
  supplierName: string | null
): Promise<string | null> {
  if (!supplierName) return null;
  const nameKey = supplierName.trim().toLowerCase();
  if (!nameKey) return null;

  const { data, error } = await admin
    .from("supplier_profiles")
    .select("supplier_id")
    .eq("org_id", orgId)
    .ilike("supplier_name", nameKey)
    .maybeSingle();

  if (error) return null;
  return data?.supplier_id ?? null;
}

// Read-only counterpart to upsertSupplierProfile's lookup: resolve the profile on
// whichever key identifies this supplier, without creating one. Callers that only
// want to know what we already hold must not seed a row as a side effect.
export async function findSupplierProfile(
  admin: SupabaseClient,
  orgId: string,
  supplierId: string | null,
  supplierName: string | null
): Promise<SupplierProfile | null> {
  const name = (supplierName ?? "").trim();
  if (!supplierId && !name) return null;
  const { data } = supplierId
    ? await admin.from("supplier_profiles").select(PROFILE_COLUMNS).eq("org_id", orgId).eq("supplier_id", supplierId).maybeSingle()
    : await admin.from("supplier_profiles").select(PROFILE_COLUMNS).eq("org_id", orgId).is("supplier_id", null).ilike("supplier_name", name).maybeSingle();
  return (data as SupplierProfile | null) ?? null;
}

export async function upsertSupplierProfile(
  admin: SupabaseClient,
  orgId: string,
  supplierId: string | null,
  supplierName: string,
  seed: SupplierProfileSeed = {}
): Promise<SupplierProfile> {
  // One profile per supplier is a unique index now, so resolve an existing row
  // on whichever key identifies this supplier rather than letting the insert
  // fail: name-only suppliers are the majority and have no supplier_id.
  const found = supplierId
    ? await admin.from("supplier_profiles").select(PROFILE_COLUMNS).eq("org_id", orgId).eq("supplier_id", supplierId).maybeSingle()
    : await admin.from("supplier_profiles").select(PROFILE_COLUMNS).eq("org_id", orgId).is("supplier_id", null).ilike("supplier_name", supplierName.trim()).maybeSingle();
  if (found.data) return found.data as SupplierProfile;

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
      shipping_terms: seed.shipping_terms ?? null,
      shipping_email: seed.shipping_email ?? null,
      generated_notes: seed.generated_notes ?? null,
      billing_email: seed.billing_email ?? null,
    })
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return data as SupplierProfile;
}

export type SupplierProfileUpdate = Partial<
  Omit<SupplierProfile, "id" | "org_id" | "generated_notes" | "created_at" | "updated_at">
>;

type SupplierProfileSeed = SupplierProfileUpdate & { generated_notes?: string | null };

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
  const leads = await selectAllPaged<{ supplier_id: string | null; supplier_name: string | null; payload: any; source: string | null }>(
    (from, to) =>
      admin
        .from("leads_in_flight")
        .select("supplier_id, supplier_name, payload, source")
        .eq("org_id", orgId)
        .eq("status", "active")
        .order("id")
        .range(from, to)
  );
  if (!leads.length) return 0;

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
  const bySupplier = new Map<string, { supplierId: string | null; name: string; payload: any; source: string | null }>();
  for (const lead of leads) {
    const name = (lead.supplier_name ?? "").trim();
    const nameKey = name.toLowerCase();
    const key = lead.supplier_id ?? nameKey;
    if (!key) continue; // neither id nor name — can't identify a supplier
    // First lead wins, except that a marketplace seller split out into its own
    // direct lead has two rows under one name. The direct one is the supplier we
    // actually deal with, so it drives the profile no matter which row we saw
    // first; otherwise the card kept showing Aggregator against a direct thread.
    const held = bySupplier.get(key);
    if (held && !((lead.payload as any)?.aggregator_direct_contact === true && !(held.payload as any)?.aggregator_direct_contact)) continue;
    bySupplier.set(key, { supplierId: lead.supplier_id ?? null, name, payload: lead.payload ?? {}, source: lead.source ?? null });
  }

  // A lead split out of a marketplace listing carries no supplier_id while the
  // listing keeps one, so one company lands under two keys and, on the first run
  // for that supplier, each key inserts its own profile (the partial unique
  // indexes in 0075 cover id-rows and name-rows separately, so both are legal).
  // Fold the name-only group into the id-bearing one; the direct payload still
  // wins inside it.
  const idKeyByName = new Map<string, string>();
  for (const [key, info] of bySupplier) {
    if (info.supplierId && info.name) idKeyByName.set(info.name.toLowerCase(), key);
  }
  for (const [key, info] of [...bySupplier]) {
    if (info.supplierId || !info.name) continue;
    const idKey = idKeyByName.get(info.name.toLowerCase());
    if (!idKey || idKey === key) continue;
    const held = bySupplier.get(idKey)!;
    if ((info.payload as any)?.aggregator_direct_contact === true && !(held.payload as any)?.aggregator_direct_contact) {
      bySupplier.set(idKey, { ...held, payload: info.payload, source: info.source });
    }
    bySupplier.delete(key);
  }

  const existingById = new Map(existing.filter((p) => p.supplier_id).map((p) => [p.supplier_id!, p]));
  const existingByName = new Map(existing.map((p) => [(p.supplier_name ?? "").trim().toLowerCase(), p]));
  let created = 0;
  // The cap has to count every supplier we WRITE, not just the ones we insert.
  // Counting inserts only made this loop O(all suppliers in the org): once an
  // org was fully profiled it issued one serial UPDATE per supplier, forever,
  // which is what pushed the whole agent past its 800s ceiling.
  let touched = 0;
  for (const info of bySupplier.values()) {
    const nameKey = info.name.toLowerCase();
    // A supplier scouted before it was linked to Tenkara already has a name-only
    // profile, and looking an id-bearing lead up by id alone missed it and inserted
    // a second row (the partial unique indexes let an id-row and a name-row coexist).
    // Adopt the name-only row instead. A name row that already carries a DIFFERENT
    // supplier_id is a different company sharing a name, so it is not a match.
    const byName = nameKey ? existingByName.get(nameKey) : undefined;
    const current = info.supplierId
      ? existingById.get(info.supplierId) ?? (byName && !byName.supplier_id ? byName : undefined)
      : byName;
    const adoptId = Boolean(info.supplierId && current && !current.supplier_id);
    const p = info.payload;
    const marketKind: MarketKind = leadMarketKind(p.site_type) ?? "direct";
    try {
      const mpShipping = p.marketplace_pull?.shipping;
      const shippingTerms = typeof mpShipping === "string" && mpShipping.trim() ? mpShipping.trim() : null;
      const generatedNotes = [
        `Discovered via ${info.source ?? p.discovery_source ?? "supplier lead"}.`,
        p.supplier_website ? `Website: ${p.supplier_website}.` : null,
        p.supplier_country ? `Country: ${p.supplier_country}.` : null,
        p.enrichment?.contact?.source ? `Contact source: ${p.enrichment.contact.source}.` : null,
        shippingTerms ? `Shipping terms: ${shippingTerms}.` : null,
      ].filter(Boolean).join(" ");
      // Contact enrichment writes under payload.enrichment.contact; the top-level
      // keys only exist on leads that arrived with contacts attached.
      const contact = p.enrichment?.contact ?? {};
      const pocEmail = p.supplier_contact_email ?? p.contact_email ?? contact.email ?? null;
      const pocPhone = p.sales_phone ?? contact.phone ?? null;
      const pocName = p.poc_name ?? contact.poc_name ?? null;
      const shippingAddress = p.hq_address ?? null;
      if (current) {
        // Freeze: once a supplier leaves draft, a human owns it. Agents stop
        // writing so an operator's review is never overwritten by a later pass.
        if (current.approval_status !== "draft") continue;
        // supplier_type is otherwise frozen at first seed, so a seller that gave us
        // its own email and left the marketplace track kept showing as Aggregator on
        // the validation card while the leads tab called it Direct. Correct it, but
        // only while the operator has not ticked marketplace_type_correct — once they
        // have verified the kind, theirs wins like every other field here.
        const staleMarketKind =
          p.aggregator_direct_contact === true &&
          marketKind !== current.supplier_type &&
          !current.marketplace_type_correct;
        const patch = {
          // Fill-only: an operator's entry always wins over enrichment.
          ...(adoptId ? { supplier_id: info.supplierId } : {}),
          ...(staleMarketKind ? { supplier_type: marketKind } : {}),
          ...((generatedNotes || null) !== (current.generated_notes ?? null) ? { generated_notes: generatedNotes || null } : {}),
          ...(shippingTerms && !current.shipping_terms ? { shipping_terms: shippingTerms } : {}),
          ...(pocEmail && !current.poc_email ? { poc_email: pocEmail } : {}),
          ...(pocPhone && !current.poc_phone ? { poc_phone: pocPhone } : {}),
          ...(pocName && !current.poc_name ? { poc_name: pocName } : {}),
          ...(shippingAddress && !current.shipping_address ? { shipping_address: shippingAddress } : {}),
        };
        // Steady state is "nothing changed", so re-writing identical notes on
        // every supplier every run is pure cost. Skip it and the cap is rarely
        // reached at all.
        if (!Object.keys(patch).length) continue;
        const { error: updateError } = await admin.from("supplier_profiles").update(patch).eq("id", current.id);
        if (updateError) throw updateError;
        touched++;
        if (touched >= limit) break;
      } else {
        await upsertSupplierProfile(admin, orgId, info.supplierId, info.name, {
          supplier_type: marketKind,
          poc_email: pocEmail,
          poc_phone: pocPhone,
          poc_name: pocName,
          shipping_address: shippingAddress,
          shipping_terms: shippingTerms,
          generated_notes: generatedNotes || null,
        });
        if (nameKey) existingNames.add(nameKey);
        created++;
        touched++;
        if (touched >= limit) break;
      }
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

// The completeness fields a supplier can actually tell us, in plain words. Only
// supplier_type is missing from the list, because it is ours to derive from where
// we found them, not theirs to state. Used to turn "this profile is at 40%" into
// an ask a first-contact email can carry.
const PROFILE_ASK_CLAUSE: Partial<Record<keyof SupplierProfile, string>> = {
  poc_email: "the best sales email to quote from",
  poc_phone: "a direct phone number",
  poc_name: "who we would be dealing with by name",
  shipping_address: "the address the goods ship or are picked up from",
  shipping_terms: "which shipping terms you can offer (EXW, FOB, DDP)",
  shipping_email: "a logistics or shipping contact",
  billing_email: "a billing or accounts-receivable email",
  billing_poc_name: "a billing contact name",
  payment_upfront_pct: "any deposit you require (0% is a fine answer)",
};

// Blank askable fields, worst-first by how much they hold the profile back. Empty
// when the profile is already complete enough that asking would be noise.
export function missingProfileAsks(p: SupplierProfile | null | undefined, belowPct = 80): string[] {
  if (!p) return Object.values(PROFILE_ASK_CLAUSE) as string[];
  if (profileCompleteness(p).pct >= belowPct) return [];
  const out: string[] = [];
  for (const [field, clause] of Object.entries(PROFILE_ASK_CLAUSE) as [keyof SupplierProfile, string][]) {
    const v = p[field];
    if (v == null || v === "" || v === false) out.push(clause);
  }
  return out;
}

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
