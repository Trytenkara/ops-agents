"use server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

interface Result { ok: boolean; error?: string; corrected?: number; superseded?: number; regenerating?: number }

// Apply a material-name spelling flag:
//  1. Mark it applied (an active OA override — future leads/drafts get the fix).
//  2. Rename every existing lead + draft for the org (wrong → suggested).
//  3. Supersede the already-staged (wrong-spelling) email drafts and reset their
//     leads so Agent 04 REGENERATES them with the corrected name (the externalId
//     is name-aware, so a fresh Tenkara draft is created). The old drafts stay
//     flagged 'superseded' in the threads view for ops to delete in Tenkara.
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
  const wrongLc = (flag.wrong_name as string).toLowerCase();

  // 1. Override active.
  await admin
    .from("material_name_flags")
    .update({ status: "applied", resolved_at: new Date().toISOString(), resolved_by: session.userId })
    .eq("id", flag.id);

  // 2a. Identify affected leads BEFORE renaming (so we can regenerate them).
  const { data: affectedLeads } = await admin
    .from("leads_in_flight")
    .select("id")
    .eq("org_id", flag.org_id)
    .ilike("material_name", flag.wrong_name);
  const affectedLeadIds = new Set((affectedLeads ?? []).map((l: any) => l.id as string));

  // 2b. Supersede the staged outreach drafts that used the wrong name (match by
  //     their originating lead, or by the name showing in the preview).
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, status, metadata, body_preview")
    .eq("org_id", flag.org_id)
    .eq("status", "staged");
  let superseded = 0;
  for (const d of (drafts ?? []) as any[]) {
    const leadId = d.metadata?.lead_id as string | undefined;
    const previewHit = typeof d.body_preview === "string" && d.body_preview.toLowerCase().includes(wrongLc);
    const metaHit = String(d.metadata?.material_name ?? "").toLowerCase() === wrongLc;
    if ((leadId && affectedLeadIds.has(leadId)) || previewHit || metaHit) {
      await admin
        .from("draft_references")
        .update({
          status: "superseded",
          metadata: {
            ...d.metadata,
            superseded: {
              reason: "material_spelling_corrected",
              corrected_to: flag.suggested_name,
              at: new Date().toISOString(),
              needs_tenkara_delete: true,
            },
          },
        })
        .eq("id", d.id);
      superseded++;
    }
  }

  // 2c. Rename remaining leads + drafts to the corrected spelling.
  const { data: renamed } = await admin
    .from("leads_in_flight")
    .update({ material_name: flag.suggested_name })
    .eq("org_id", flag.org_id)
    .ilike("material_name", flag.wrong_name)
    .select("id");
  const corrected = (renamed ?? []).length;
  const { data: mdDrafts } = await admin
    .from("draft_references")
    .select("id, metadata")
    .eq("org_id", flag.org_id)
    .neq("status", "superseded");
  for (const d of (mdDrafts ?? []) as any[]) {
    if (String(d.metadata?.material_name ?? "").toLowerCase() === wrongLc) {
      await admin.from("draft_references").update({ metadata: { ...d.metadata, material_name: flag.suggested_name } }).eq("id", d.id);
    }
  }

  // 3. Reset the affected leads so Agent 04 re-drafts them (corrected name →
  //    name-aware externalId → fresh Tenkara draft on the next outreach run).
  if (affectedLeadIds.size) {
    await admin
      .from("leads_in_flight")
      .update({ stage: "enriched", status: "active" })
      .in("id", Array.from(affectedLeadIds));
  }

  return { ok: true, corrected, superseded, regenerating: affectedLeadIds.size };
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
