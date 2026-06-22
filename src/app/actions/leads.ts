"use server";
import { revalidatePath } from "next/cache";
import { DROP_REASONS, type DropReason } from "@/app/actions/lead-drop-reasons";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { loadMatchCandidates, matchOrderToMaterial } from "@/lib/material-profile";

interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface CsvUploadResult {
  ok: boolean;
  error?: string;
  inserted?: number;
  skippedDuplicate?: number;
  skippedNoMatch?: number;
  skippedNoEmail?: number;
  unmatchedSample?: string[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Minimal RFC-4180-ish CSV parser (handles quoted fields, escaped quotes, CRLF).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function colIndex(header: string[], aliases: string[]): number {
  const normHeader = header.map(norm);
  for (const a of aliases) {
    const i = normHeader.indexOf(norm(a));
    if (i >= 0) return i;
  }
  return -1;
}

// Ops bulk-upload: a CSV of suppliers (supplier, email, material) added straight
// to the outreach queue for a client. Material name is matched to the client's
// Tenkara material; rows are deduped by email+material against existing active
// leads so the agent never double-contacts. Inserted as enriched/active with a
// valid email so Agent 04 picks them up on its next sweep.
export async function uploadSuppliersCsv(orgId: string, form: FormData): Promise<CsvUploadResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) return { ok: false, error: "forbidden" };
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "no file" };
  if (file.size > 5 * 1024 * 1024) return { ok: false, error: "file too large (max 5MB)" };

  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, tenkara_org_id").eq("id", orgId).maybeSingle();
  if (!org) return { ok: false, error: "org not found" };
  if (!org.tenkara_org_id) return { ok: false, error: "client not linked to a Tenkara org — can't match materials" };

  const rows = parseCsv(await file.text());
  if (rows.length < 2) return { ok: false, error: "CSV has no data rows" };
  const header = rows[0];
  const iSupplier = colIndex(header, ["supplier_name", "supplier", "name", "company", "vendor"]);
  const iEmail = colIndex(header, ["email", "supplier_email", "contact_email", "email_address"]);
  const iMaterial = colIndex(header, ["material", "material_name", "product", "item"]);
  const iContact = colIndex(header, ["contact_name", "contact", "poc", "contact_person"]);
  const iWebsite = colIndex(header, ["website", "url", "site", "web"]);
  const iCountry = colIndex(header, ["country", "location", "region"]);
  if (iSupplier < 0 || iEmail < 0 || iMaterial < 0) {
    return { ok: false, error: "CSV needs columns: supplier, email, material" };
  }

  let candidates: Awaited<ReturnType<typeof loadMatchCandidates>>;
  try {
    candidates = await loadMatchCandidates(org.tenkara_org_id);
  } catch (e: any) {
    return { ok: false, error: `could not load materials: ${e?.message ?? "unknown"}` };
  }
  const candById = new Map(candidates.map((c) => [c.id, c]));

  // Existing active leads for this org → dedup set keyed by email|material_id.
  const { data: existing } = await admin
    .from("leads_in_flight")
    .select("material_id, payload")
    .eq("org_id", orgId)
    .eq("status", "active");
  const seen = new Set<string>();
  for (const r of existing ?? []) {
    const em = ((r.payload as any)?.supplier_contact_email as string | undefined)?.toLowerCase();
    if (em) seen.add(`${em}|${r.material_id ?? ""}`);
  }

  let skippedDuplicate = 0, skippedNoMatch = 0, skippedNoEmail = 0;
  const unmatched: string[] = [];
  const toInsert: any[] = [];

  for (const r of rows.slice(1)) {
    const supplier = (r[iSupplier] ?? "").trim();
    const email = (r[iEmail] ?? "").trim();
    const materialText = (r[iMaterial] ?? "").trim();
    if (!supplier || !materialText) continue;
    if (!EMAIL_RE.test(email)) { skippedNoEmail++; continue; }

    const materialId = matchOrderToMaterial(materialText, candidates);
    if (!materialId) { skippedNoMatch++; if (unmatched.length < 8) unmatched.push(materialText); continue; }

    const key = `${email.toLowerCase()}|${materialId}`;
    if (seen.has(key)) { skippedDuplicate++; continue; }
    seen.add(key);

    toInsert.push({
      org_id: orgId,
      supplier_name: supplier,
      supplier_id: null,
      material_name: candById.get(materialId)?.label ?? materialText,
      material_id: materialId,
      stage: "enriched",
      status: "active",
      source: "human_bulk_upload",
      payload: {
        supplier_contact_email: email,
        supplier_contact_name: iContact >= 0 ? (r[iContact] ?? "").trim() || null : null,
        supplier_website: iWebsite >= 0 ? (r[iWebsite] ?? "").trim() || null : null,
        supplier_country: iCountry >= 0 ? (r[iCountry] ?? "").trim() || null : null,
        enrichment: { email_check: { format_valid: true } },
        tenkara_org_id: org.tenkara_org_id,
        source_notes: "ops_manual_csv_upload",
        uploaded_by: session.userId,
        uploaded_at: new Date().toISOString(),
      },
      confidence_score: null,
    });
  }

  if (toInsert.length > 0) {
    const { error } = await admin.from("leads_in_flight").insert(toInsert);
    if (error) return { ok: false, error: error.message };
    await admin.from("audit_log").insert({
      actor_user_id: session.userId,
      action: "leads.bulk_upload",
      target_table: "leads_in_flight",
      target_id: orgId,
      diff: { inserted: toInsert.length, skippedDuplicate, skippedNoMatch, skippedNoEmail },
    });
  }

  revalidatePath("/work/orgs/[slug]/leads", "page");
  return {
    ok: true,
    inserted: toInsert.length,
    skippedDuplicate,
    skippedNoMatch,
    skippedNoEmail,
    unmatchedSample: unmatched,
  };
}


async function assertCanActOnLead(leadId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { error: "forbidden" as const };
  }
  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("id, stage, status, org_id, payload")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "lead_not_found" as const };

  // Org gate: leads with a non-null org_id require the user to have access
  // (assignment, or a global role). Cross-org leads (null org_id) are
  // restricted to global roles.
  if (!seesAllOrgs(session)) {
    if (!lead.org_id) return { error: "forbidden" as const };
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(lead.org_id)) {
      return { error: "forbidden" as const };
    }
  }
  return { session, admin, lead };
}

export async function promoteLead(leadId: string): Promise<ActionResult> {
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;

  // Promote semantics: hand a lead to Agent 04 (Outreach). Acceptable
  // starting points are `enriched` (the happy path from Agent 06) and `raw`
  // with a blocked_reason (a human override saying "yes, contact them
  // anyway"). We park them on stage=ready_for_outreach so the next Agent 04
  // run picks them up.
  const fromStage = lead.stage as string;
  const blocked = (lead.payload as any)?.enrichment_blocked_reason;
  const isRawOverride = fromStage === "raw" && !!blocked;
  if (fromStage !== "enriched" && !isRawOverride) {
    return { ok: false, error: "lead_not_promotable" };
  }

  const { error } = await admin
    .from("leads_in_flight")
    .update({
      stage: "ready_for_outreach",
      payload: {
        ...((lead.payload as any) ?? {}),
        promoted_by: session.userId,
        promoted_at: new Date().toISOString(),
        ...(isRawOverride ? { promote_override: true } : {}),
      },
    })
    .eq("id", leadId)
    .eq("status", "active");
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "lead.promoted",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: { from_stage: fromStage, to_stage: "ready_for_outreach", override: isRawOverride || undefined },
  });

  revalidatePath("/work/review/leads");
  return { ok: true };
}

export async function dropLead(leadId: string, reason: DropReason, note?: string): Promise<ActionResult> {
  if (!DROP_REASONS.some((r) => r.value === reason)) {
    return { ok: false, error: "invalid_reason" };
  }
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;

  if (lead.status !== "active") return { ok: false, error: "lead_already_terminal" };

  const reasonText = note?.trim() ? `${reason}: ${note.trim()}` : reason;
  const { error } = await admin
    .from("leads_in_flight")
    .update({
      status: "terminal",
      drop_reason: reasonText,
      payload: {
        ...((lead.payload as any) ?? {}),
        dropped_by: session.userId,
        dropped_at: new Date().toISOString(),
        drop_reason_code: reason,
        ...(note?.trim() ? { drop_reason_note: note.trim() } : {}),
      },
    })
    .eq("id", leadId)
    .eq("status", "active");
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "lead.dropped",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: { from_stage: lead.stage, reason, note: note?.trim() || undefined },
  });

  revalidatePath("/work/review/leads");
  return { ok: true };
}
