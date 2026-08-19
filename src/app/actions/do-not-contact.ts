"use server";

import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { hostOf, normalizeCompanyName } from "@/lib/tenkara-sourcing-exclusions";

// The ops half of the do-not-contact list. The client half lives in their own
// Tenkara settings and is read-only to us; both are enforced in one place, at
// draft time. See lib/do-not-contact.ts.

async function canActOnOrg(orgId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { error: "forbidden" as const };
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) return { error: "forbidden" as const };
  }
  return { session, admin: createAdminClient() };
}

export interface DncInput {
  supplierId?: string | null;
  companyName?: string | null;
  website?: string | null;
  email?: string | null;
  reason?: string | null;
}

export async function addDoNotContact(orgId: string, input: DncInput) {
  const guard = await canActOnOrg(orgId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin } = guard;

  const nameKey = normalizeCompanyName(input.companyName) || null;
  const host = hostOf(input.website);
  const email = input.email?.trim().toLowerCase() || null;
  const supplierId = input.supplierId ? String(input.supplierId) : null;
  if (!supplierId && !nameKey && !host && !email) return { ok: false, error: "nothing_to_block" };

  const { error } = await admin.from("supplier_do_not_contact").insert({
    org_id: orgId,
    supplier_id: supplierId,
    company_name: input.companyName?.trim() || null,
    name_key: nameKey,
    host,
    email,
    reason: input.reason?.trim() || null,
    created_by: session.userId,
  });
  if (error) return { ok: false, error: error.message };

  // A company we just blocked must not be left with a live draft an operator
  // could still send. Blocking is only credible if it also stops what is
  // already staged.
  const { data: refs } = await admin
    .from("draft_references")
    .select("id, metadata, supplier_id")
    .eq("org_id", orgId)
    .in("status", ["staged", "reviewed", "blocked"]);
  const kill: string[] = [];
  for (const r of (refs ?? []) as any[]) {
    const meta = r.metadata ?? {};
    const matches =
      (supplierId && r.supplier_id && String(r.supplier_id) === supplierId) ||
      (email && String(meta.supplier_contact_email ?? "").trim().toLowerCase() === email) ||
      (nameKey && normalizeCompanyName(meta.supplier_name ?? meta.supplier_company) === nameKey);
    if (matches) kill.push(r.id);
  }
  if (kill.length) {
    await admin.from("draft_references").update({ status: "discarded" }).in("id", kill);
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "supplier.do_not_contact.added",
    target_table: "supplier_do_not_contact",
    target_id: supplierId ?? nameKey ?? host ?? email,
    diff: { org_id: orgId, ...input, drafts_discarded: kill.length },
  });

  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true, draftsDiscarded: kill.length };
}

export async function removeDoNotContact(orgId: string, id: string) {
  const guard = await canActOnOrg(orgId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin } = guard;
  const { error } = await admin
    .from("supplier_do_not_contact")
    .update({ removed_at: new Date().toISOString(), removed_by: session.userId })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}

export async function listDoNotContact(orgId: string) {
  const guard = await canActOnOrg(orgId);
  if ("error" in guard) return { ok: false as const, error: guard.error, rows: [] };
  const { admin } = guard;
  const { data } = await admin
    .from("supplier_do_not_contact")
    .select("id, company_name, host, email, reason, created_at")
    .eq("org_id", orgId)
    .is("removed_at", null)
    .order("created_at", { ascending: false });
  return { ok: true as const, rows: (data ?? []) as any[] };
}
