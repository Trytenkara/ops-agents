import { tenkaraQuery } from "./tenkara-readonly";

export type SupplierApproval = "approved" | "pending_review" | "denied" | "draft";

export interface ClientSupplier {
  id: string;
  name: string | null;
  approval: SupplierApproval;
  is_marketplace: boolean;
  poc_name: string | null;
  poc_email: string | null;
  approval_notes: string | null;
  last_approved_at: string | null;
  // Extra fields, for the Tenkara-template-format export.
  website: string | null;
  poc_phone: string | null;
  poc_phone_extension: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  shipping_terms: string | null;
  shipping_email: string | null;
  billing_email: string | null;
  minimum_order: number | null;
  minimum_order_unit: string | null;
  supplier_type: string | null;
  purchasing_notes: string | null;
  ddp_minimum_limit: number | null;
  ddp_maximum_limit: number | null;
}

export interface ClientSuppliers {
  approved: ClientSupplier[];
  pending_review: ClientSupplier[];
  denied: ClientSupplier[];
  draft: ClientSupplier[];
  total: number;
}

const EMPTY: ClientSuppliers = { approved: [], pending_review: [], denied: [], draft: [], total: 0 };

// Suppliers a client has in Tenkara, grouped by approval state. A supplier is
// tied to an org when the org's tenkara id is in its organization_ids array.
export async function getClientSuppliers(orgTenkaraId: string | null): Promise<ClientSuppliers> {
  if (!orgTenkaraId) return EMPTY;
  let rows: ClientSupplier[] = [];
  try {
    rows = await tenkaraQuery<ClientSupplier>(
      `select id::text as id,
              name,
              approval::text as approval,
              coalesce(is_marketplace, false) as is_marketplace,
              poc_name,
              poc_email,
              approval_notes,
              last_approved_at,
              website,
              poc_phone,
              poc_phone_extension,
              address,
              city,
              state,
              zip,
              country,
              shipping_terms,
              shipping_email,
              billing_email,
              minimum_order,
              minimum_order_unit,
              array_to_string(supplier_type, ';') as supplier_type,
              purchasing_notes,
              ddp_minimum_limit,
              ddp_maximum_limit
         from public.suppliers
        where $1::uuid = any(organization_ids)
        order by name asc`,
      [orgTenkaraId]
    );
  } catch (e) {
    console.error("[client-suppliers] query failed:", e);
    return EMPTY;
  }
  const out: ClientSuppliers = { approved: [], pending_review: [], denied: [], draft: [], total: rows.length };
  for (const r of rows) {
    const key = (["approved", "pending_review", "denied", "draft"] as const).includes(r.approval as SupplierApproval)
      ? (r.approval as SupplierApproval)
      : "draft";
    out[key].push(r);
  }
  return out;
}
