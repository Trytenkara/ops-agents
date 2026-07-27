// Tenkara bulk-upload column definitions — single source of truth for both the
// staged-quotes exporter and the downloadable blank templates. Names match the
// live Tenkara material_quotes / suppliers schema. See
// artifacts/tenkara-templates/tenkara-bulk-upload-spec.md.

// Columns the quotes exporter actually has data for (clean subset — no ops-only
// fields like unit_price/source/approved_at that were shifting columns).
export const QUOTE_EXPORT_HEADERS = [
  "supplier_id",
  "supplier_name",
  "material_id",
  "material_name",
  "price",
  "case_size",
  "unit_of_measurement",
] as const;

// Fuller recommended template for ops to fill by hand (quotes).
export const QUOTE_TEMPLATE_HEADERS = [
  ...QUOTE_EXPORT_HEADERS,
  "lead_time_days",
  "quote_date",
  "product_expiry",
  "product_url",
  "material_sku",
  "type_of_package",
  "case_type",
  "case_weight",
  "case_width",
  "case_height",
  "case_length",
  "is_international",
  "is_hazardous",
  "is_refrigerated",
  "protect_from_freezing",
  "min_order_amount",
  "min_order_unit",
  "max_order_amount",
  "max_order_unit",
  "min_inventory",
  "max_inventory",
  "purchasing_notes",
  "un_number",
  "hazard_class",
  "hazmat_contact_name",
  "hazmat_contact_phone",
] as const;

// Recommended template for suppliers.
export const SUPPLIER_TEMPLATE_HEADERS = [
  "id",
  "name",
  "website",
  "poc_name",
  "poc_email",
  "poc_phone",
  "poc_phone_extension",
  "address",
  "city",
  "state",
  "zip",
  "country",
  "is_marketplace",
  "shipping_terms",
  "shipping_email",
  "billing_email",
  "minimum_order",
  "minimum_order_unit",
  "supplier_type",
  "purchasing_notes",
  "purchasing_thresholds",
  "ddp_minimum_limit",
  "ddp_maximum_limit",
] as const;
