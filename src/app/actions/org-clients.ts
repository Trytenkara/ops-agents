"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";

export async function createOrgClient(
  orgId: string,
  name: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const session = await getSession();
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { ok: false, error: "Unauthorized" };
  }
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required" };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("org_clients")
    .insert({ org_id: orgId, name: trimmed })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data.id };
}

export async function deleteOrgClient(
  clientId: string
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSession();
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { ok: false, error: "Unauthorized" };
  }
  const admin = createAdminClient();
  const { error } = await admin.from("org_clients").delete().eq("id", clientId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
