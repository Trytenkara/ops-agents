"use server";
import { revalidatePath } from "next/cache";
import { assertOrgWriteAccess } from "@/lib/org-access";
import { normalizeHost, deriveSlug } from "@/lib/marketplace-accounts";

interface ActionResult {
  ok: boolean;
  error?: string;
  accountId?: string;
}

export interface MarketplaceAccountInput {
  host: string;
  signupEmail: string;
  password: string;
  status?: string;
  supplierProfileId?: string | null;
}

export async function createMarketplaceAccount(
  orgId: string,
  input: MarketplaceAccountInput
): Promise<ActionResult> {
  const ctx = await assertOrgWriteAccess(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const host = normalizeHost(input.host);
  const signupEmail = input.signupEmail.trim();
  const password = input.password;
  if (!host) return { ok: false, error: "marketplace site is required" };
  if (!signupEmail) return { ok: false, error: "account email is required" };
  if (!password) return { ok: false, error: "password is required" };

  const { data, error } = await ctx.admin
    .from("marketplace_accounts")
    .insert({
      org_id: orgId,
      supplier_profile_id: input.supplierProfileId ?? null,
      host,
      slug: deriveSlug(host),
      signup_email: signupEmail,
      password,
      // Ops only records a login once it exists and works, so it starts usable
      // rather than in the agent's signup lifecycle.
      status: input.status ?? "active",
      created_by: "ops",
      created_by_email: ctx.session.email,
      verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    const dup = error.code === "23505";
    return { ok: false, error: dup ? `${signupEmail} is already saved for ${host}` : error.message };
  }
  revalidatePath("/work/orgs");
  return { ok: true, accountId: data.id };
}

export async function updateMarketplaceAccount(
  accountId: string,
  orgId: string,
  updates: Partial<MarketplaceAccountInput>
): Promise<ActionResult> {
  const ctx = await assertOrgWriteAccess(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.host !== undefined) {
    const host = normalizeHost(updates.host);
    if (!host) return { ok: false, error: "marketplace site is required" };
    patch.host = host;
    patch.slug = deriveSlug(host);
  }
  if (updates.signupEmail !== undefined) {
    if (!updates.signupEmail.trim()) return { ok: false, error: "account email is required" };
    patch.signup_email = updates.signupEmail.trim();
  }
  if (updates.password !== undefined) {
    if (!updates.password) return { ok: false, error: "password is required" };
    patch.password = updates.password;
  }
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.supplierProfileId !== undefined) patch.supplier_profile_id = updates.supplierProfileId;

  const { error } = await ctx.admin
    .from("marketplace_accounts")
    .update(patch)
    .eq("id", accountId)
    .eq("org_id", orgId);

  if (error) {
    const dup = error.code === "23505";
    return { ok: false, error: dup ? "that email is already saved for this marketplace" : error.message };
  }
  revalidatePath("/work/orgs");
  return { ok: true };
}

export async function deleteMarketplaceAccount(accountId: string, orgId: string): Promise<ActionResult> {
  const ctx = await assertOrgWriteAccess(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const { error } = await ctx.admin
    .from("marketplace_accounts")
    .delete()
    .eq("id", accountId)
    .eq("org_id", orgId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/work/orgs");
  return { ok: true };
}
