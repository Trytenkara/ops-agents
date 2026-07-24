"use server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parsePoDocument } from "@/lib/po-parse";
import { loadMatchCandidates, matchOrderToMaterial } from "@/lib/material-profile";
import { revalidatePath } from "next/cache";

interface Result { ok: boolean; error?: string; parsed?: number }

const EDIT_ROLES = ["admin", "ops_lead", "ops_operator"] as const;
const UPLOAD_BUCKET = "client-uploads";

async function requireEditor() {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, [...EDIT_ROLES])) return { error: "forbidden" as const };
  return { session };
}


export async function uploadAndParsePO(orgId: string, form: FormData): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "no file" };
  if (file.size > 10 * 1024 * 1024) return { ok: false, error: "file too large (max 10MB)" };

  const admin = createAdminClient();
  const bytes = Buffer.from(await file.arrayBuffer());
  const path = `${orgId}/po/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  const up = await admin.storage.from(UPLOAD_BUCKET).upload(path, bytes, {
    contentType: file.type || "application/octet-stream",
    upsert: true,
  });
  if (up.error) return { ok: false, error: `upload failed: ${up.error.message}` };

  const { data: uploadRow, error: uploadErr } = await admin
    .from("client_uploads")
    .insert({ org_id: orgId, kind: "file", file_path: path, file_name: file.name, created_by: auth.session!.userId })
    .select("id")
    .single();
  if (uploadErr) return { ok: false, error: uploadErr.message };

  let lines;
  try {
    lines = await parsePoDocument({ bytes, mimeType: file.type, fileName: file.name });
  } catch (e: any) {
    return { ok: false, error: `parse failed: ${e?.message ?? "unknown"}` };
  }
  if (lines.length === 0) return { ok: true, parsed: 0 };

  // Load Tenkara materials for this org to attempt id matching (name + grade).
  let materials: Awaited<ReturnType<typeof loadMatchCandidates>> = [];
  const { data: org } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();
  if (org?.tenkara_org_id) {
    try {
      materials = await loadMatchCandidates(org.tenkara_org_id);
    } catch { /* matching is best-effort */ }
  }

  const rows = lines.map((l) => ({
    org_id: orgId,
    tenkara_material_id: matchOrderToMaterial(l.material_label, materials),
    material_label: l.material_label,
    supplier_name: l.supplier_name,
    order_date: l.order_date,
    ordered_qty: l.ordered_qty,
    qty_unit: l.qty_unit,
    po_qty: l.po_qty,
    unit_price: l.unit_price,
    coa_expiry: l.coa_expiry,
    material_expiry: l.material_expiry,
    source_upload_id: uploadRow.id,
    parsed_raw: l,
    status: "parsed",
    created_by: auth.session!.userId,
  }));

  const { error } = await admin.from("client_material_orders").insert(rows);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/work/orgs/[slug]/materials`, "page");
  return { ok: true, parsed: rows.length };
}

// Re-run name + grade matching against the org's current Tenkara materials for
// every UNCONFIRMED order and persist any change. Unlike a one-way fill, this
// also CORRECTS or CLEARS a previously wrong auto-match (the bug where "Onion
// Powder" caught "Calamine Powder" left bad links that a null-only pass could
// never undo). Confirmed orders are operator-reviewed and never touched; a
// cleared match drops the line back into "Unmatched orders" for manual filing.
export async function rematchOrders(orgId: string): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();

  const { data: org } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();
  if (!org?.tenkara_org_id) return { ok: false, error: "client not linked to a Tenkara org" };

  let materials: Awaited<ReturnType<typeof loadMatchCandidates>>;
  try {
    materials = await loadMatchCandidates(org.tenkara_org_id);
  } catch (e: any) {
    return { ok: false, error: `could not load materials: ${e?.message ?? "unknown"}` };
  }

  const { data: candidates, error: loadErr } = await admin
    .from("client_material_orders")
    .select("id, material_label, tenkara_material_id")
    .eq("org_id", orgId)
    .neq("status", "confirmed");
  if (loadErr) return { ok: false, error: loadErr.message };

  let changed = 0;
  for (const o of candidates ?? []) {
    const id = matchOrderToMaterial(o.material_label, materials);
    if (id === o.tenkara_material_id) continue; // no change — leave it
    const { error } = await admin
      .from("client_material_orders")
      .update({ tenkara_material_id: id })
      .eq("id", o.id);
    if (!error) changed++;
  }

  revalidatePath(`/work/orgs/[slug]/materials`, "page");
  return { ok: true, parsed: changed };
}

export async function confirmOrder(orderId: string): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();
  const { error } = await admin.from("client_material_orders").update({ status: "confirmed" }).eq("id", orderId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/work/orgs/[slug]/materials`, "page");
  return { ok: true };
}

export interface OrderEdit {
  material_label?: string;
  tenkara_material_id?: string | null;
  supplier_name?: string | null;
  order_date?: string | null;
  ordered_qty?: number | null;
  qty_unit?: string | null;
  po_qty?: number | null;
  unit_price?: number | null;
  coa_expiry?: string | null;
  material_expiry?: string | null;
}

export async function editOrder(orderId: string, patch: OrderEdit): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();
  const { error } = await admin.from("client_material_orders").update(patch).eq("id", orderId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/work/orgs/[slug]/materials`, "page");
  return { ok: true };
}

export async function deleteOrder(orderId: string): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();
  const { error } = await admin.from("client_material_orders").delete().eq("id", orderId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/work/orgs/[slug]/materials`, "page");
  return { ok: true };
}
