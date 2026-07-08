"use server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

interface Result { ok: boolean; error?: string; corrected?: number }

// Apply a material-name spelling flag: mark it applied (an active OA override)
// and rename every existing lead + staged draft for that org from the misspelled
// name to the suggested one. Future leads/drafts pick up the override at creation.
export async function applyMaterialNameFlag(flagId: string): Promise<Result> {
  const session = await getSession();
  if (!session || !hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  const admin = createAdminClient();

  const { data: flag } = await admin
    .from("material_name_flags")
    .select("id, org_id, wrong_name, suggested_name, status")
    .eq("id", flagId)
    .maybeSingle();
  if (!flag) return { ok: false, error: "flag not found" };

  await admin
    .from("material_name_flags")
    .update({ status: "applied", resolved_at: new Date().toISOString(), resolved_by: session.userId })
    .eq("id", flag.id);

  const wrongLc = (flag.wrong_name as string).toLowerCase();
  let corrected = 0;

  // Leads: one case-insensitive exact-match update (wrong_name has no % wildcards).
  const { data: leads } = await admin
    .from("leads_in_flight")
    .update({ material_name: flag.suggested_name })
    .eq("org_id", flag.org_id)
    .ilike("material_name", flag.wrong_name)
    .select("id");
  corrected += (leads ?? []).length;

  // Drafts: material_name lives in the jsonb metadata, so patch matching rows.
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, metadata")
    .eq("org_id", flag.org_id);
  for (const d of (drafts ?? []) as any[]) {
    const mn = d.metadata?.material_name;
    if (mn && String(mn).toLowerCase() === wrongLc) {
      await admin.from("draft_references").update({ metadata: { ...d.metadata, material_name: flag.suggested_name } }).eq("id", d.id);
      corrected++;
    }
  }

  return { ok: true, corrected };
}

export async function dismissMaterialNameFlag(flagId: string): Promise<Result> {
  const session = await getSession();
  if (!session || !hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  const admin = createAdminClient();
  await admin
    .from("material_name_flags")
    .update({ status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: session.userId })
    .eq("id", flagId);
  return { ok: true };
}
