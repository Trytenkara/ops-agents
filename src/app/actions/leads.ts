"use server";
import { revalidatePath } from "next/cache";
import { DROP_REASONS, type DropReason } from "@/app/actions/lead-drop-reasons";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { loadMatchCandidates, matchOrderToMaterial } from "@/lib/material-profile";
import { sanitizeTiers, type PriceTier } from "@/lib/price-tiers";
import { publishableTiers } from "@/lib/price-publish";
import { normalizeCompanyName, hostOf } from "@/lib/tenkara-sourcing-exclusions";
import { deleteTenkaraDrafts, getTenkaraConversationDetails } from "@/lib/tenkara";
import { isSameCompanyName } from "@/lib/fuzzy";
import { isMarketplaceLeadPayload, splitDirectLeadFromMarketplace } from "@/lib/marketplace-direct-split";
import { checkEmail, isAggregatorEmail } from "@/agents-runtime/agents/data-enrichment/enrich";
import { randomUUID } from "crypto";

interface ActionResult {
  ok: boolean;
  error?: string;
  warning?: string;
  retryRequestId?: string;
}

export interface CsvUploadResult {
  ok: boolean;
  error?: string;
  inserted?: number;
  skippedDuplicate?: number;
  skippedFuzzyDuplicate?: number;
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

  // Existing active leads for this org → per-material dedup index. A supplier is
  // a duplicate if, for the SAME material, it matches an existing lead by email,
  // website host, exact normalized name, OR a fuzzy name match (typo variants).
  const { data: existing } = await admin
    .from("leads_in_flight")
    .select("material_id, supplier_name, payload")
    .eq("org_id", orgId)
    .eq("status", "active");

  type MatIndex = { emails: Set<string>; hosts: Set<string>; names: string[] };
  const byMaterial = new Map<string, MatIndex>();
  const idxFor = (matId: string): MatIndex => {
    let m = byMaterial.get(matId);
    if (!m) { m = { emails: new Set(), hosts: new Set(), names: [] }; byMaterial.set(matId, m); }
    return m;
  };
  for (const r of existing ?? []) {
    const matId = (r.material_id as string) ?? "";
    const ix = idxFor(matId);
    const em = ((r.payload as any)?.supplier_contact_email as string | undefined)?.toLowerCase();
    if (em) ix.emails.add(em);
    const host = hostOf((r.payload as any)?.supplier_website);
    if (host) ix.hosts.add(host);
    const nm = normalizeCompanyName(r.supplier_name as string | null);
    if (nm) ix.names.push(nm);
  }

  // True if this supplier already exists for the material (exact or fuzzy).
  const isDuplicate = (ix: MatIndex, email: string, host: string | null, name: string): "exact" | "fuzzy" | null => {
    if (email && ix.emails.has(email.toLowerCase())) return "exact";
    if (host && ix.hosts.has(host)) return "exact";
    const nm = normalizeCompanyName(name);
    if (nm && ix.names.includes(nm)) return "exact";
    if (nm && ix.names.some((existing) => isSameCompanyName(nm, existing))) return "fuzzy";
    return null;
  };

  let skippedDuplicate = 0, skippedFuzzyDuplicate = 0, skippedNoMatch = 0, skippedNoEmail = 0;
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

    const website = iWebsite >= 0 ? (r[iWebsite] ?? "").trim() || null : null;
    const host = hostOf(website);
    const ix = idxFor(materialId);
    const dup = isDuplicate(ix, email, host, supplier);
    if (dup === "exact") { skippedDuplicate++; continue; }
    if (dup === "fuzzy") { skippedFuzzyDuplicate++; continue; }
    // Accept — record this supplier in the index so later CSV rows dedup against it too.
    ix.emails.add(email.toLowerCase());
    if (host) ix.hosts.add(host);
    const nm = normalizeCompanyName(supplier);
    if (nm) ix.names.push(nm);

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
        supplier_website: website,
        supplier_country: iCountry >= 0 ? (r[iCountry] ?? "").trim() || null : null,
        enrichment: { email_check: { format_valid: true } },
        tenkara_org_id: org.tenkara_org_id,
        source_notes: "ops_manual_csv_upload",
        contact_source: "manual_operator",
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
      diff: { inserted: toInsert.length, skippedDuplicate, skippedFuzzyDuplicate, skippedNoMatch, skippedNoEmail },
    });
  }

  revalidatePath("/work/orgs/[slug]/leads", "page");
  return {
    ok: true,
    inserted: toInsert.length,
    skippedDuplicate,
    skippedFuzzyDuplicate,
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
    .select("id, stage, status, org_id, supplier_id, supplier_name, material_id, material_name, payload")
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

export async function cancelOutreachRetry(requestId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  if (!UUID_RE.test(requestId)) return { ok: false, error: "invalid_retry_request" };
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("leads_in_flight")
    .select("org_id")
    .eq("payload->outreach_retry->>request_id", requestId)
    .limit(1);
  const orgId = rows?.[0]?.org_id;
  if (orgId && !seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) return { ok: false, error: "forbidden" };
  }
  const { error } = await admin.rpc("clear_outreach_retry", { p_request_id: requestId });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function requestOutreachRetry(leadId: string): Promise<ActionResult> {
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;
  if (!lead.org_id || lead.status !== "active" || lead.stage !== "enriched") {
    return { ok: false, error: "lead_not_retryable" };
  }
  const payload = (lead.payload as any) ?? {};
  const email = String(payload.supplier_contact_email ?? "").trim().toLowerCase();
  if (!lead.supplier_id && !email) return { ok: false, error: "retry_group_unidentifiable" };

  const { data: allCandidates, error: siblingsError } = await admin
    .from("leads_in_flight")
    .select("id, supplier_id, payload")
    .eq("org_id", lead.org_id)
    .eq("status", "active")
    .eq("stage", "enriched");
  if (siblingsError) return { ok: false, error: siblingsError.message };
  const siblings = (allCandidates ?? []).filter((candidate: any) => {
    const candidateEmail = String(candidate.payload?.supplier_contact_email ?? "").trim().toLowerCase();
    return (lead.supplier_id && candidate.supplier_id === lead.supplier_id) || (!!email && candidateEmail === email);
  });
  if (!siblings.length) return { ok: false, error: "no_retryable_supplier_leads" };

  const emails = Array.from(new Set(siblings.map((s: any) => String(s.payload?.supplier_contact_email ?? "").trim().toLowerCase()).filter(Boolean)));
  const { data: activeThreads, error: existingError } = await admin
    .from("draft_references")
    .select("supplier_id, metadata")
    .eq("org_id", lead.org_id)
    .in("status", ["staged", "reviewed", "sent", "linked"])
    .limit(5000);
  if (existingError) return { ok: false, error: existingError.message };
  const emailSet = new Set(emails);
  const hasExisting = (activeThreads ?? []).some((thread: any) => {
    const threadEmail = String(thread.metadata?.supplier_contact_email ?? "").trim().toLowerCase();
    return (lead.supplier_id && thread.supplier_id === lead.supplier_id) || (!!threadEmail && emailSet.has(threadEmail));
  });
  if (hasExisting) return { ok: false, error: "supplier_already_has_live_or_sent_thread" };

  const requestId = randomUUID();
  const { error: markError } = await admin.rpc("mark_outreach_retry", {
    p_lead_ids: siblings.map((s) => s.id),
    p_request_id: requestId,
    p_actor_id: session.userId,
  });
  if (markError) return { ok: false, error: markError.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "outreach.retry_requested",
    target_table: "leads_in_flight",
    target_id: lead.id,
    diff: { request_id: requestId, lead_ids: siblings.map((s) => s.id) },
  });
  return { ok: true, retryRequestId: requestId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function linkLeadToConversation(leadId: string, conversationId: string): Promise<ActionResult> {
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;
  const threadId = conversationId.trim();
  if (!UUID_RE.test(threadId)) return { ok: false, error: "invalid_conversation_id" };
  if (!lead.org_id) return { ok: false, error: "lead_has_no_org" };

  const { data: org } = await admin
    .from("orgs")
    .select("tenkara_email_account_id")
    .eq("id", lead.org_id)
    .maybeSingle();
  if (!org?.tenkara_email_account_id) return { ok: false, error: "org_has_no_tenkara_inbox" };

  const details = await getTenkaraConversationDetails(threadId);
  if (!details.found) return { ok: false, error: "conversation_not_found" };
  if (!details.emailAccountId) return { ok: false, error: "conversation_inbox_unverifiable" };
  if (details.emailAccountId !== org.tenkara_email_account_id) return { ok: false, error: "conversation_belongs_to_other_inbox" };

  const outreach = (lead.payload as any)?.outreach;
  if (outreach?.conversation_id || outreach?.draft_id) return { ok: false, error: "lead_already_has_outreach" };
  const { error: linkError } = await admin.rpc("link_lead_conversation", {
    p_lead_id: lead.id,
    p_conversation_id: threadId,
    p_actor_id: session.userId,
    p_subject: details.messages[details.messages.length - 1]?.subject ?? "Linked Tenkara conversation",
  });
  if (linkError) return { ok: false, error: linkError.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "conversation.linked",
    target_table: "leads_in_flight",
    target_id: lead.id,
    diff: { conversation_id: threadId, local_only: true },
  });
  revalidatePath("/work/orgs/[slug]/leads", "page");
  revalidatePath("/work/orgs/[slug]/threads", "page");
  return { ok: true, warning: "Linked locally. No draft, assignee, or message was created or changed in Tenkara." };
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
  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}

// Save ops-edited tier pricing for a marketplace lead. Persists onto
// leads_in_flight.payload.price_tiers (replacing any prior set).
export async function saveLeadPriceTiers(leadId: string, tiers: PriceTier[]): Promise<ActionResult> {
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;

  // Operator-entered prices go through the same gate as scraped ones. A typo
  // that lands a negative or a nonsense figure should not be storable just
  // because a person typed it.
  const gate = publishableTiers(sanitizeTiers(tiers) as any[], { where: "operator edit" });
  if (gate.issues.length) {
    return {
      ok: false,
      error: `Price not saved: ${gate.issues.map((i) => `${i.field} ${i.reason}`).join("; ")}.`,
    };
  }
  const clean = gate.tiers;
  const { error } = await admin
    .from("leads_in_flight")
    .update({
      payload: {
        ...((lead.payload as any) ?? {}),
        price_tiers: clean,
        price_tiers_updated_by: session.userId,
        price_tiers_updated_at: new Date().toISOString(),
      },
    })
    .eq("id", leadId);
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "lead.price_tiers_saved",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: { count: clean.length },
  });

  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}

// Permanently delete leads. Unlike dropLead (soft "terminal", still stored),
// this wipes the rows so a client can start fresh — e.g. after materials were
// deleted in the platform and their discovered leads are now stale. Ops-only;
// non-global operators can only remove leads for orgs they're assigned to.
export async function removeLeads(
  leadIds: string[]
): Promise<{ ok: boolean; error?: string; removed?: number }> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { ok: false, error: "forbidden" };
  }
  const ids = Array.from(new Set((leadIds ?? []).filter((id) => typeof id === "string" && id)));
  if (ids.length === 0) return { ok: false, error: "no leads selected" };

  const admin = createAdminClient();
  const { data: leads } = await admin
    .from("leads_in_flight")
    .select("id, org_id")
    .in("id", ids);
  if (!leads || leads.length === 0) return { ok: false, error: "no matching leads" };

  // Org gate: a scoped operator can only remove leads for orgs they own. Bail if
  // any selected lead is outside their scope rather than silently partial-deleting.
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null) {
      const outOfScope = leads.some((l) => !l.org_id || !assigned.includes(l.org_id));
      if (outOfScope) return { ok: false, error: "forbidden" };
    }
  }

  const found = leads.map((l) => l.id);
  const { error } = await admin.from("leads_in_flight").delete().in("id", found);
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "leads.removed",
    target_table: "leads_in_flight",
    target_id: found[0],
    diff: { removed: found.length, ids: found },
  });

  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true, removed: found.length };
}

export async function dropLead(leadId: string, reason: DropReason, note?: string): Promise<ActionResult> {
  if (!DROP_REASONS.some((r) => r.value === reason)) {
    return { ok: false, error: "invalid_reason" };
  }
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;

  if (lead.status !== "active") return { ok: false, error: "lead_already_terminal" };

  const payload = (lead.payload as any) ?? {};
  const reasonText = note?.trim() ? `${reason}: ${note.trim()}` : reason;
  const { error } = await admin
    .from("leads_in_flight")
    .update({
      status: "terminal",
      drop_reason: reasonText,
      payload: {
        ...payload,
        dropped_by: session.userId,
        dropped_at: new Date().toISOString(),
        drop_reason_code: reason,
        ...(note?.trim() ? { drop_reason_note: note.trim() } : {}),
      },
    })
    .eq("id", leadId)
    .eq("status", "active");
  if (error) return { ok: false, error: error.message };

  // If this lead already reached outreach, an agent staged a draft in the email
  // app (Tenkara). Delete that draft so a dropped lead never leaves a live draft
  // an operator could still send. Best-effort: a delete miss is logged, not fatal
  // — the lead is already dropped locally. Only rod_app (Tenkara) drafts are
  // deletable here; Missive drafts have no delete path and are left as-is.
  let draftWarning: string | undefined;
  let draftDeleteThreadScoped = false;
  const outreach = payload.outreach as
    | { email_client?: string; draft_id?: string; conversation_id?: string }
    | undefined;
  if (outreach?.email_client === "rod_app" && (outreach.draft_id || outreach.conversation_id)) {
    const del = await deleteTenkaraDrafts({
      draftId: outreach.draft_id,
      conversationId: outreach.conversation_id,
    });
    draftDeleteThreadScoped = del.threadScoped ?? false;
    if (del.ok) {
      // Mirror the deletion onto the local draft_references record so the
      // Outreach tracker and All Threads view stop showing it as a live draft.
      // A thread-scoped delete clears our draft across the whole conversation, so
      // mirror that breadth locally by keying on the conversation (any row
      // carrying a rotated draft_id is caught too).
      const keyByThread = del.threadScoped || !outreach.draft_id;
      let ref = admin.from("draft_references").update({ status: "discarded" });
      ref = keyByThread && outreach.conversation_id
        ? ref.eq("thread_id", outreach.conversation_id)
        : ref.eq("draft_id", outreach.draft_id!);
      await ref.in("status", ["staged", "reviewed", "blocked"]);
    } else {
      draftWarning = `lead dropped, but the email draft could not be deleted (${del.error ?? "unknown"}) — remove it in the Inbox`;
    }
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "lead.dropped",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: {
      from_stage: lead.stage,
      reason,
      note: note?.trim() || undefined,
      ...(outreach?.email_client === "rod_app"
        ? { draft_delete_warning: draftWarning ?? null, draft_delete_thread_scoped: draftDeleteThreadScoped }
        : {}),
    },
  });

  revalidatePath("/work/review/leads");
  revalidatePath("/work/orgs/[slug]/leads", "page");
  return draftWarning ? { ok: true, warning: draftWarning } : { ok: true };
}

// Manually update the contact email for a single lead. Updates both the
// top-level supplier_contact_email (read by outreach) and enrichment.contact.email
// (read by the UI).
export async function updateLeadEmail(leadId: string, email: string): Promise<ActionResult> {
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { admin, lead } = guard;

  const trimmed = email.trim().toLowerCase();
  if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, error: "invalid_email" };
  }

  const payload = (lead.payload as any) ?? {};

  // Same rule the case resolver follows: a listing does not become a direct
  // supplier because we now hold an address. Writing the address here instead
  // would make the marketplace row cold-emailable, so the listing and the direct
  // relationship would both mail the same person.
  if (trimmed && isMarketplaceLeadPayload(payload) && !isAggregatorEmail(trimmed)) {
    const split = await splitDirectLeadFromMarketplace(admin, { leadId, contactEmail: trimmed, trigger: "operator" });
    if (!split.split) return { ok: false, error: `could not create the direct lead (${split.reason})` };
    revalidatePath("/work/review/leads");
    revalidatePath("/work/orgs/[slug]/leads", "page");
    return { ok: true };
  }

  const previous = typeof payload.supplier_contact_email === "string" ? payload.supplier_contact_email.toLowerCase() : null;
  const enrichment = payload.enrichment ? { ...payload.enrichment } : {};
  enrichment.contact = { ...(enrichment.contact ?? {}), email: trimmed || null };

  // email_check describes ONE address. Carrying the old verdict onto a new
  // address is how a stale domain_matches_website ends up authorising outreach
  // to somewhere we never checked, and leaving it behind after a delete keeps
  // the deleted address alive for anything that reads the check instead of the
  // contact. Rewrite it for the new address, drop it entirely on delete.
  if (trimmed) enrichment.email_check = checkEmail(trimmed, payload.supplier_website ?? null);
  else delete enrichment.email_check;

  const nextPayload: Record<string, any> = {
    ...payload,
    supplier_contact_email: trimmed || null,
    enrichment,
    contact_source: trimmed ? "manual_operator" : null,
  };

  if (trimmed) {
    nextPayload.manual_email_added_at = new Date().toISOString();
    nextPayload.manual_email_added_by = guard.session.userId;
  }

  // A delete has to remove every copy of the address, not just the one the row
  // renders. Anything left behind is a live send target: additional_contacts is
  // CC'd on first contact, and an alias row reserves the address org-wide so no
  // other thread can ever use it again.
  const purge = (target: string | null) => {
    if (!target) return;
    if (Array.isArray(nextPayload.additional_contacts)) {
      nextPayload.additional_contacts = nextPayload.additional_contacts.filter(
        (c: any) => String(c?.email ?? "").toLowerCase() !== target
      );
    }
    if (String(nextPayload.aggregator_contact_email ?? "").toLowerCase() === target) {
      nextPayload.aggregator_contact_email = null;
    }
    if (enrichment.aggregator_contact_email && String(enrichment.aggregator_contact_email).toLowerCase() === target) {
      enrichment.aggregator_contact_email = null;
    }
  };
  purge(trimmed ? null : previous);
  purge(trimmed || null);

  if (!trimmed) {
    delete nextPayload.contact_confidence;
    delete nextPayload.manual_email_added_at;
    delete nextPayload.manual_email_added_by;
    delete nextPayload.email_source;
  }

  const { error } = await admin.from("leads_in_flight").update({ payload: nextPayload }).eq("id", leadId);

  if (error) return { ok: false, error: error.message };

  // Release the org-wide reservation on a deleted address. Without this the
  // alias row outlives the contact and silently blocks the address forever.
  if (!trimmed && previous && lead.org_id) {
    await admin.from("supplier_email_aliases").delete().eq("org_id", lead.org_id).eq("email", previous);
  }

  await admin.from("audit_log").insert({
    actor_user_id: guard.session.userId,
    action: trimmed ? "lead.email_set" : "lead.email_deleted",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: { from: previous, to: trimmed || null },
  });

  revalidatePath("/work/review/leads");
  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}

// Manually update the contact phone for a single lead. Mirrors updateLeadEmail:
// updates both the top-level supplier_phone (read by outreach) and
// enrichment.contact.phone (read by the UI). Phone is free-form, so no format
// validation — trim and store, empty clears it.
export async function updateLeadPhone(leadId: string, phone: string): Promise<ActionResult> {
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { admin, lead } = guard;

  const trimmed = phone.trim();

  const payload = (lead.payload as any) ?? {};
  const enrichment = payload.enrichment ? { ...payload.enrichment } : {};
  enrichment.contact = { ...(enrichment.contact ?? {}), phone: trimmed || null };

  const { error } = await admin
    .from("leads_in_flight")
    .update({ payload: { ...payload, supplier_phone: trimmed || null, enrichment } })
    .eq("id", leadId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/work/review/leads");
  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}

export interface EmailImportResult {
  ok: boolean;
  error?: string;
  matched?: number;
  unmatched?: number;
  unmatchedSample?: string[];
}

// Bulk-import supplier emails from a CSV. Matches rows by supplier_name
// (case-insensitive) against all active leads_in_flight for the org and patches
// supplier_contact_email on each match.
export async function importEmailsFromCsv(orgId: string, form: FormData): Promise<EmailImportResult> {
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

  const rows = parseCsv(await file.text());
  if (rows.length < 2) return { ok: false, error: "CSV has no data rows" };
  const header = rows[0];
  const iSupplier = colIndex(header, ["supplier_name", "supplier", "name", "company", "vendor", "supplier name"]);
  const iEmail = colIndex(header, ["email", "supplier_email", "contact_email", "email_address", "e-mail"]);
  if (iSupplier < 0 || iEmail < 0) {
    return { ok: false, error: "CSV needs a supplier name column and an email column" };
  }

  const admin = createAdminClient();
  const { data: leads } = await admin
    .from("leads_in_flight")
    .select("id, supplier_name, payload")
    .eq("org_id", orgId)
    .eq("status", "active");

  const byName = new Map<string, { id: string; payload: any }[]>();
  for (const l of leads ?? []) {
    const key = normalizeCompanyName(l.supplier_name ?? "");
    if (!key) continue;
    const arr = byName.get(key) ?? [];
    arr.push({ id: l.id, payload: l.payload });
    byName.set(key, arr);
  }

  let matched = 0;
  const unmatched: string[] = [];

  for (const row of rows.slice(1)) {
    const supplierName = (row[iSupplier] ?? "").trim();
    const email = (row[iEmail] ?? "").trim().toLowerCase();
    if (!supplierName || !email) continue;
    const key = normalizeCompanyName(supplierName);
    const hits = byName.get(key);
    if (!hits?.length) { unmatched.push(supplierName); continue; }
    for (const hit of hits) {
      const payload = (hit.payload as any) ?? {};
      // A listing stays a listing: give the address its own direct lead rather
      // than making the marketplace row cold-emailable.
      if (isMarketplaceLeadPayload(payload) && !isAggregatorEmail(email)) {
        const split = await splitDirectLeadFromMarketplace(admin, { leadId: hit.id, contactEmail: email, trigger: "operator" });
        if (split.split) matched++;
        continue;
      }
      const enrichment = payload.enrichment ? { ...payload.enrichment } : {};
      enrichment.contact = { ...(enrichment.contact ?? {}), email };
      enrichment.email_check = checkEmail(email, payload.supplier_website ?? null);
      await admin
        .from("leads_in_flight")
        .update({
          payload: {
            ...payload,
            supplier_contact_email: email,
            enrichment,
            contact_source: "manual_operator",
            manual_email_added_at: new Date().toISOString(),
          },
        })
        .eq("id", hit.id);
      matched++;
    }
  }

  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true, matched, unmatched: unmatched.length, unmatchedSample: unmatched.slice(0, 5) };
}
