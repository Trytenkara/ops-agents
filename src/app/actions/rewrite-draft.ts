"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { createTenkaraDraft } from "@/lib/tenkara";
import { bodyToHtml } from "@/lib/email-style";
import { composeOutreachDraft } from "@/agents-runtime/agents/outreach/drafter";
import { classifyClient, type OutreachMode } from "@/agents-runtime/agents/quote-revalidation/config";
import { resolveMaterialNames } from "@/lib/tenkara-names";

type Admin = ReturnType<typeof createAdminClient>;

export interface RewriteResult {
  ok: boolean;
  error?: string;
  materialName?: string;
}
export interface RewriteBatchResult {
  ok: boolean;
  error?: string;
  rewritten: number;
  skipped: { id: string; reason: string }[];
}

// Only outbound RFQs staged in the Tenkara inbox can be rewritten in place.
// Tenkara upserts the agent's draft slot when we re-POST /api/drafts with the
// same conversation_id, so a rewrite overwrites the existing draft (no orphan,
// unlike the supersede+regenerate path). Sent/reviewed drafts are left alone.
function rewritable(d: any): string | null {
  if (d.email_client !== "rod_app" && d.email_client !== "tenkara") return "not a Tenkara draft";
  if (d.status !== "staged") return `draft is ${d.status}, not staged`;
  if (!d.thread_id) return "no Tenkara conversation id";
  if ((d.metadata as any)?.draft_kind === "inbound_reply") return "inbound reply — not an outbound RFQ";
  return null;
}

// Recompose the outbound RFQ for a staged draft from its originating lead, using
// the authoritative Tenkara material name. Returns the email to upsert, or a
// reason it can't be rebuilt.
async function recompose(
  admin: Admin,
  draft: any
): Promise<{ to: { name: string | null; address: string }; subject: string; body: string; materialName: string } | { reason: string }> {
  const meta = (draft.metadata ?? {}) as any;
  const leadId = meta.lead_id as string | undefined;
  if (!leadId) return { reason: "no originating lead on draft" };

  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("material_id, material_name, supplier_name, payload")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { reason: "originating lead not found" };

  const payload = (lead.payload ?? {}) as any;
  const email = (payload.supplier_contact_email as string | undefined) ?? null;
  if (!email) return { reason: "no recipient email on lead" };

  // Authoritative name from Tenkara, else the (now-fixed) stored name.
  let resolved: string | null = null;
  if (lead.material_id) {
    const names = await resolveMaterialNames([lead.material_id]).catch(() => new Map<string, string>());
    resolved = names.get(lead.material_id) ?? null;
  }
  const materialName = (resolved || (lead.material_name && lead.material_name.trim()) || (meta.material_name && String(meta.material_name).trim()) || "").trim();
  if (!materialName) return { reason: "material still has no name in Tenkara" };

  const { data: org } = await admin.from("orgs").select("name").eq("id", draft.org_id).maybeSingle();
  const orgName = org?.name ?? "";
  const cls = classifyClient(orgName);
  const mode: OutreachMode = (meta.outreach_mode as OutreachMode) ?? cls.mode;
  const ghostBrand = (meta.ghost_brand as string | undefined) ?? cls.ghostBrand;
  if (mode === "skip" || (mode === "ghost" && !ghostBrand)) return { reason: "client not classified for outreach" };

  const isMarketplace =
    payload.site_type === "M" ||
    payload.site_type === "MS" ||
    payload.supplier_role === "Marketplace" ||
    payload.enrichment?.tenkara_supplier?.is_marketplace === true;

  const composed = await composeOutreachDraft({
    mode,
    ghostBrand,
    clientOrgName: orgName,
    supplierContactName: payload.supplier_contact_name ?? null,
    supplierCompanyName: lead.supplier_name ?? meta.supplier_name ?? null,
    materialName,
    inciName: payload.inci_name ?? payload.inci ?? null,
    signal: payload.signal ?? null,
    isMarketplace,
  });

  return { to: { name: payload.supplier_contact_name ?? null, address: email }, subject: composed.subject, body: composed.body, materialName };
}

// Upsert the recomposed draft into Tenkara and sync our mirror row. Assumes the
// caller has already authorized + scope-checked the draft.
async function rewriteOne(admin: Admin, draft: any): Promise<RewriteResult> {
  const guard = rewritable(draft);
  if (guard) return { ok: false, error: guard };

  const built = await recompose(admin, draft);
  if ("reason" in built) return { ok: false, error: built.reason };

  let newDraftId: string;
  try {
    const t = await createTenkaraDraft({
      conversationId: draft.thread_id,
      to: built.to,
      subject: built.subject,
      bodyHtml: bodyToHtml(built.body),
      bodyText: built.body,
    });
    newDraftId = t.id || draft.draft_id;
  } catch (e: any) {
    return { ok: false, error: `Tenkara: ${e?.message ?? e}` };
  }

  await admin
    .from("draft_references")
    .update({
      draft_id: newDraftId,
      subject: built.subject,
      body_preview: built.body.slice(0, 1500),
      metadata: {
        ...(draft.metadata ?? {}),
        material_name: built.materialName,
        rewritten: { at: new Date().toISOString(), material_name: built.materialName },
      },
    })
    .eq("id", draft.id);

  return { ok: true, materialName: built.materialName };
}

async function loadForActor(admin: Admin, ids: string[], session: any) {
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, org_id, email_client, status, thread_id, draft_id, subject, metadata")
    .in("id", ids);
  const rows = drafts ?? [];
  if (seesAllOrgs(session)) return rows;
  const assigned = await getAssignedOrgIds(session);
  if (assigned === null) return rows;
  return rows.filter((d: any) => d.org_id && assigned.includes(d.org_id));
}

export async function rewriteDraft(draftId: string): Promise<RewriteResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };

  const admin = createAdminClient();
  const [draft] = await loadForActor(admin, [draftId], session);
  if (!draft) return { ok: false, error: "draft not found or out of scope" };

  const res = await rewriteOne(admin, draft);
  if (res.ok) {
    await admin.from("audit_log").insert({
      actor_user_id: session.userId,
      action: "draft.rewritten",
      target_table: "draft_references",
      target_id: draftId,
      diff: { material_name: res.materialName },
    });
    revalidatePath("/work/drafts/[id]", "page");
    revalidatePath("/work/orgs/[slug]/threads", "page");
  }
  return res;
}

export async function rewriteDrafts(draftIds: string[]): Promise<RewriteBatchResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated", rewritten: 0, skipped: [] };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden", rewritten: 0, skipped: [] };

  const ids = Array.from(new Set((draftIds ?? []).filter((id) => typeof id === "string" && id))).slice(0, 100);
  if (ids.length === 0) return { ok: false, error: "no drafts selected", rewritten: 0, skipped: [] };

  const admin = createAdminClient();
  const drafts = await loadForActor(admin, ids, session);
  const byId = new Map(drafts.map((d: any) => [d.id, d]));

  let rewritten = 0;
  const skipped: { id: string; reason: string }[] = [];
  // Serial: one Tenkara POST at a time keeps us clear of rate limits and makes a
  // partial failure easy to reason about.
  for (const id of ids) {
    const draft = byId.get(id);
    if (!draft) {
      skipped.push({ id, reason: "not found or out of scope" });
      continue;
    }
    const res = await rewriteOne(admin, draft);
    if (res.ok) rewritten++;
    else skipped.push({ id, reason: res.error ?? "failed" });
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "draft.rewritten_batch",
    target_table: "draft_references",
    target_id: ids[0],
    diff: { rewritten, skipped: skipped.length },
  });
  revalidatePath("/work/orgs/[slug]/threads", "page");
  return { ok: true, rewritten, skipped };
}
