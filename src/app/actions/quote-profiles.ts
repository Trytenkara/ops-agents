"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import {
  updateQuoteProfile,
  insertQuoteProfile,
  seedQuoteProfilesFromStaged,
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
    const profile = await insertQuoteProfile(ctx.admin, orgId, fields);
    revalidatePath(`/work/orgs`);
    return { ok: true, profileId: profile.id };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "create failed" };
  }
}

export async function seedQuoteProfiles(orgId: string): Promise<ActionResult> {
  const ctx = await assertCanAct(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const count = await seedQuoteProfilesFromStaged(ctx.admin, orgId);
    revalidatePath(`/work/orgs`);
    return { ok: true, count };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "seed failed" };
  }
}
