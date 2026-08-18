import {
  completenessFollowupEnabled,
  computeMissingApprovalFields,
  type MissingApprovalField,
} from "@/lib/quote-completeness";

// Reads everything captured for one supplier+material and works out which
// approval-required fields are still blank. Shared by the reply drafter (so a
// reply asks for the current stage) and the stalled-conversation nudge (so a
// chase restates what we are actually waiting on instead of "did you see my
// last note"). Best-effort: any failure returns [], which means no ask rather
// than a wrong ask.
export async function loadMissingApprovalFields(
  admin: any,
  orgId: string | null,
  supplierId: string | null,
  materialId: string | null,
): Promise<MissingApprovalField[]> {
  if (!completenessFollowupEnabled() || !supplierId || !orgId || !materialId) return [];
  try {
    const { data: capturedRows, error: quoteError } = await admin
      .from("staged_quotes")
      .select(
        "price, case_size, unit_of_measurement, case_type, case_dimensions, dim_source, raw_extract, lead_time_days, lead_time_text, moq_quantity, moq_unit, payment_terms, status",
      )
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .eq("material_id", materialId)
      .not("status", "eq", "dismissed");
    if (quoteError) throw quoteError;
    const { data: supplierProfile, error: profileError } = await admin
      .from("supplier_profiles")
      .select(
        "poc_email, poc_phone, poc_name, shipping_address, shipping_terms, shipping_email, billing_email, billing_poc_name, payment_upfront_pct, payment_net_days, payment_completion, payment_credit_line",
      )
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .maybeSingle();
    if (profileError) throw profileError;
    return computeMissingApprovalFields((capturedRows ?? []) as any, supplierProfile as any);
  } catch {
    return [];
  }
}
