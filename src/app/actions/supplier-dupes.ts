"use server";

import { revalidatePath } from "next/cache";
import { assertOrgWriteAccess } from "@/lib/org-access";
import { groupPairs } from "@/lib/supplier-dupes";

// Records what an operator decided about a suspected duplicate group.
//
// Nothing here touches Tenkara. Tenkara is read-only from this app and the
// merge itself is carried out by an operator in the Tenkara console; these
// rows are the shortlist and the audit trail, not the action.

interface ActionResult {
  ok: boolean;
  error?: string;
}

interface DecideInput {
  orgId: string;
  slug: string;
  /** Tenkara supplier ids in the group, as shown to the operator. */
  supplierIds: string[];
  /** Names as displayed, so the record survives a later rename in Tenkara. */
  names: Record<string, string>;
  /** Which row to keep. Required for same_company. */
  survivorId?: string | null;
  note?: string | null;
}

function nameOf(names: Record<string, string>, id: string): string | null {
  const n = (names[id] ?? "").trim();
  return n ? n.slice(0, 300) : null;
}

async function writePairs(
  input: DecideInput,
  decision: "not_duplicate" | "same_company"
): Promise<ActionResult> {
  const ids = [...new Set(input.supplierIds)].filter(Boolean);
  if (ids.length < 2) return { ok: false, error: "need at least two suppliers" };
  if (decision === "same_company") {
    if (!input.survivorId) return { ok: false, error: "pick which supplier to keep" };
    if (!ids.includes(input.survivorId)) return { ok: false, error: "survivor must be in the group" };
  }

  const ctx = await assertOrgWriteAccess(input.orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { session, admin } = ctx;

  const now = new Date().toISOString();
  const rows = groupPairs(ids).map(([lo, hi]) => ({
    org_id: input.orgId,
    supplier_id_lo: lo,
    supplier_id_hi: hi,
    supplier_name_lo: nameOf(input.names, lo),
    supplier_name_hi: nameOf(input.names, hi),
    decision,
    // The survivor is a property of the group, so it only makes sense on pairs
    // that are part of one. A rejected pair never carries one.
    survivor_supplier_id: decision === "same_company" ? input.survivorId : null,
    resolved_at: null,
    note: input.note?.trim() ? input.note.trim().slice(0, 1000) : null,
    decided_by: session.userId,
    decided_at: now,
    updated_at: now,
  }));

  const { error } = await admin
    .from("supplier_dupe_decisions")
    .upsert(rows, { onConflict: "org_id,supplier_id_lo,supplier_id_hi" });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/work/orgs/${input.slug}/suppliers`);
  return { ok: true };
}

/** "These are the same company." Shortlists the group for a manual merge. */
export async function confirmSupplierDupe(input: DecideInput): Promise<ActionResult> {
  return writePairs(input, "same_company");
}

/**
 * "These are different companies." Suppresses the pairing permanently.
 *
 * Recorded per pair rather than per group so it survives the next scout run
 * adding another name variant on the same domain.
 */
export async function dismissSupplierDupe(input: DecideInput): Promise<ActionResult> {
  return writePairs(input, "not_duplicate");
}

/** Undo a decision, returning the group to the suggestion list. */
export async function reopenSupplierDupe(input: {
  orgId: string;
  slug: string;
  supplierIds: string[];
}): Promise<ActionResult> {
  const ids = [...new Set(input.supplierIds)].filter(Boolean);
  if (ids.length < 2) return { ok: false, error: "need at least two suppliers" };

  const ctx = await assertOrgWriteAccess(input.orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { admin } = ctx;

  for (const [lo, hi] of groupPairs(ids)) {
    const { error } = await admin
      .from("supplier_dupe_decisions")
      .delete()
      .eq("org_id", input.orgId)
      .eq("supplier_id_lo", lo)
      .eq("supplier_id_hi", hi);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/work/orgs/${input.slug}/suppliers`);
  return { ok: true };
}

/** Operator confirms they carried the merge out in Tenkara. */
export async function markSupplierDupeResolved(input: {
  orgId: string;
  slug: string;
  supplierIds: string[];
}): Promise<ActionResult> {
  const ids = [...new Set(input.supplierIds)].filter(Boolean);
  if (ids.length < 2) return { ok: false, error: "need at least two suppliers" };

  const ctx = await assertOrgWriteAccess(input.orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { admin } = ctx;

  const now = new Date().toISOString();
  for (const [lo, hi] of groupPairs(ids)) {
    const { error } = await admin
      .from("supplier_dupe_decisions")
      .update({ resolved_at: now, updated_at: now })
      .eq("org_id", input.orgId)
      .eq("supplier_id_lo", lo)
      .eq("supplier_id_hi", hi)
      .eq("decision", "same_company");
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/work/orgs/${input.slug}/suppliers`);
  return { ok: true };
}
