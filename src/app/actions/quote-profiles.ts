"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import {
  updateQuoteProfile,
  insertQuoteProfile,
  type QuoteProfileUpdate,
} from "@/lib/quote-profiles";

interface ActionResult {
  ok: boolean;
  error?: string;
  profileId?: string;
  count?: number;
}

async function assertCanAct(orgId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { error: "forbidden" as const };
  }
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) {
      return { error: "forbidden" as const };
    }
  }
  return { session, admin: createAdminClient() };
}

export async function saveQuoteProfile(
  profileId: string,
  orgId: string,
  updates: QuoteProfileUpdate
): Promise<ActionResult> {
  const ctx = await assertCanAct(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    await updateQuoteProfile(ctx.admin, profileId, updates);
    revalidatePath(`/work/orgs`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "update failed" };
  }
}

export async function createQuoteProfile(
  orgId: string,
  fields: QuoteProfileUpdate
): Promise<ActionResult> {
  const ctx = await assertCanAct(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    // A quote an operator types in is one we were given, never a scraped
    // listing, so it belongs to the direct relationship.
    const profile = await insertQuoteProfile(ctx.admin, orgId, { ...fields, lane: "direct" });
    revalidatePath(`/work/orgs`);
    return { ok: true, profileId: profile.id };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "create failed" };
  }
}
