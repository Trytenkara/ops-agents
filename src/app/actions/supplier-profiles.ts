"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import {
  updateSupplierProfile,
  upsertSupplierProfile,
  seedProfilesFromLeads,
  type SupplierProfileUpdate,
} from "@/lib/supplier-profiles";

interface ActionResult {
  ok: boolean;
  error?: string;
  profileId?: string;
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

export async function saveSupplierProfile(
  profileId: string,
  orgId: string,
  updates: SupplierProfileUpdate
): Promise<ActionResult> {
  const ctx = await assertCanAct(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    await updateSupplierProfile(ctx.admin, profileId, updates);
    revalidatePath(`/work/orgs`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "update failed" };
  }
}

export async function createSupplierProfile(
  orgId: string,
  supplierId: string | null,
  supplierName: string,
  seed: SupplierProfileUpdate = {}
): Promise<ActionResult> {
  const ctx = await assertCanAct(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const profile = await upsertSupplierProfile(ctx.admin, orgId, supplierId, supplierName, seed);
    revalidatePath(`/work/orgs`);
    return { ok: true, profileId: profile.id };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "create failed" };
  }
}

export async function seedSupplierProfiles(orgId: string): Promise<ActionResult & { count?: number }> {
  const ctx = await assertCanAct(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const count = await seedProfilesFromLeads(ctx.admin, orgId);
    revalidatePath(`/work/orgs`);
    return { ok: true, count };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "seed failed" };
  }
}
