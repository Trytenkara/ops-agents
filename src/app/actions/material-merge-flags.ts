"use server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeLeadsForMaterials, leadSupplierKey } from "@/lib/material-merge-flags";

interface Result {
  ok: boolean;
  error?: string;
  repointed?: number;
  redundant?: number;
  superseded?: number;
  regenerating?: number;
}

// PostgREST puts `in` lists in the query string, so a 400-lead material would
// build a URL long enough to be rejected. Update in chunks.
const ID_CHUNK = 200;

async function updateLeads(admin: any, ids: string[], patch: Record<string, unknown>) {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    await admin.from("leads_in_flight").update(patch).in("id", ids.slice(i, i + ID_CHUNK));
  }
}

// Fold a duplicate material's leads into its survivor.
//
// The load-bearing rule: a supplier already sourced under the survivor must NOT
// be repointed. Repointing it would leave two active leads for one chemical and
// the supplier would get two emails. Those leads are dropped as duplicates
// instead, and only suppliers the survivor doesn't have are carried over.
export async function applyMaterialMergeFlag(flagId: string): Promise<Result> {
  const session = await getSession();
  if (!session || !hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  const admin = createAdminClient();

  const { data: flag } = await admin
    .from("material_merge_flags")
    .select("id, org_id, keep_material_id, keep_name, drop_material_id, drop_name, status")
    .eq("id", flagId)
    .maybeSingle();
  if (!flag) return { ok: false, error: "flag not found" };
  if (flag.status !== "pending") return { ok: false, error: "already resolved" };

  const keepLeads = await activeLeadsForMaterials(admin, flag.org_id, [flag.keep_material_id]);
  const dropLeads = await activeLeadsForMaterials(admin, flag.org_id, [flag.drop_material_id]);

  const keepKeys = new Set<string>();
  for (const l of keepLeads) {
    const k = leadSupplierKey(l);
    if (k) keepKeys.add(k);
  }

  const redundant: string[] = [];
  const repoint: string[] = [];
  for (const l of dropLeads) {
    const k = leadSupplierKey(l);
    if (k && keepKeys.has(k)) {
      redundant.push(l.id);
    } else {
      repoint.push(l.id);
      // Also guards against two leads for the same supplier inside the drop side.
      if (k) keepKeys.add(k);
    }
  }

  // Supersede the staged drafts that name the duplicate material. Repointed
  // leads get re-drafted under the survivor's name; redundant ones are already
  // covered by the survivor's own lead, so their drafts are just cancelled.
  const dropLeadIds = new Set(dropLeads.map((l) => l.id));
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, metadata")
    .eq("org_id", flag.org_id)
    .eq("status", "staged");
  const repointSet = new Set(repoint);
  const supersededLeadIds = new Set<string>();
  let superseded = 0;
  for (const d of (drafts ?? []) as any[]) {
    const leadId = d.metadata?.lead_id as string | undefined;
    if (!leadId || !dropLeadIds.has(leadId)) continue;
    await admin
      .from("draft_references")
      .update({
        status: "superseded",
        metadata: {
          ...d.metadata,
          superseded: {
            reason: "material_merged",
            merged_into: flag.keep_name,
            at: new Date().toISOString(),
            needs_tenkara_delete: true,
          },
        },
      })
      .eq("id", d.id);
    superseded++;
    if (repointSet.has(leadId)) supersededLeadIds.add(leadId);
  }

  if (redundant.length) {
    await updateLeads(admin, redundant, {
      status: "terminal",
      stage: "terminal",
      drop_reason: `duplicate: supplier already sourced under "${flag.keep_name}"`,
    });
  }

  if (repoint.length) {
    // Only the material identity changes. Stage is left alone so a lead still
    // awaiting enrichment isn't promoted past it.
    await updateLeads(admin, repoint, {
      material_id: flag.keep_material_id,
      material_name: flag.keep_name,
    });
  }

  // Leads whose draft we just pulled go back to enriched so Agent 04 re-drafts
  // them with the survivor's name.
  if (supersededLeadIds.size) {
    await updateLeads(admin, Array.from(supersededLeadIds), { stage: "enriched", status: "active" });
  }

  await admin
    .from("material_merge_flags")
    .update({ status: "applied", resolved_at: new Date().toISOString(), resolved_by: session.userId })
    .eq("id", flag.id);

  return {
    ok: true,
    repointed: repoint.length,
    redundant: redundant.length,
    superseded,
    regenerating: supersededLeadIds.size,
  };
}

export async function dismissMaterialMergeFlag(flagId: string): Promise<Result> {
  const session = await getSession();
  if (!session || !hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  const admin = createAdminClient();
  await admin
    .from("material_merge_flags")
    .update({ status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: session.userId })
    .eq("id", flagId);
  return { ok: true };
}
