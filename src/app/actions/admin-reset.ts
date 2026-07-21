"use server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

// Admin-only, per-client "reset data" — wipes this client's OA-side working data
// so its sourcing can be re-run clean (mainly for testing a client end-to-end).
// IRREVERSIBLE. Does NOT touch:
//   - the org row itself or its default-operator setup (client stays owned)
//   - Tenkara (materials/suppliers/quotes live there; we're read-only, no delete)
// Order: dependent/leaf tables first so a foreign key can't block the wipe.
const RESET_TABLES: string[] = [
  "pending_approvals",
  "draft_references",
  "marketplace_check_findings",
  "staged_quotes",
  "cases",
  "material_name_flags",
  "material_attributes",
  "client_material_orders",
  "client_uploads",
  "supplier_assignment",
  "leads_in_flight",
  "client_profiles",
  "client_settings",
];

export interface ResetResult {
  ok: boolean;
  error?: string;
  cleared?: Record<string, number>;
  failed?: Record<string, string>;
}

export async function resetClientData(orgId: string, confirm: string): Promise<ResetResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  // Admin only — this is destructive and not scoped by client ownership.
  if (!hasAnyRole(session, ["admin"])) return { ok: false, error: "forbidden — admin only" };
  if (confirm !== "DELETE") return { ok: false, error: "type DELETE to confirm" };
  if (!orgId) return { ok: false, error: "no client selected" };

  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("id", orgId).maybeSingle();
  if (!org) return { ok: false, error: "client not found" };

  const cleared: Record<string, number> = {};
  const failed: Record<string, string> = {};
  for (const table of RESET_TABLES) {
    const { count, error } = await admin.from(table).delete({ count: "exact" }).eq("org_id", orgId);
    if (error) failed[table] = error.message;
    else cleared[table] = count ?? 0;
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "client.data_reset",
    target_table: "orgs",
    target_id: orgId,
    diff: { org_name: org.name, cleared, failed },
  });

  // Refresh the client's working surfaces.
  revalidatePath("/work/orgs/[slug]/leads", "page");
  revalidatePath("/work/orgs/[slug]/materials", "page");
  revalidatePath("/work/orgs/[slug]/savings", "page");
  revalidatePath("/work/orgs/[slug]/threads", "page");

  if (Object.keys(failed).length) {
    return { ok: false, error: `Partial reset — ${Object.keys(failed).length} table(s) failed`, cleared, failed };
  }
  return { ok: true, cleared };
}
