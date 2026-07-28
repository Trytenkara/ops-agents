"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";

export async function saveClientTag(
  orgId: string,
  tenkaraMaterialId: string,
  materialName: string,
  orgClientId: string | null,
  isPriority: boolean
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSession();
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { ok: false, error: "Unauthorized" };
  }
  const admin = createAdminClient();
  const { error } = await admin.from("material_client_tags").upsert(
    {
      org_id: orgId,
      tenkara_material_id: tenkaraMaterialId,
      material_name: materialName,
      org_client_id: orgClientId,
      is_priority: isPriority,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,tenkara_material_id" }
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}
