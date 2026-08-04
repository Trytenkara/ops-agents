"use server";
import { revalidatePath } from "next/cache";
import { assertOrgWriteAccess } from "@/lib/org-access";
import { normalizeHost, deriveSlug } from "@/lib/marketplace-accounts";

interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface MarketplaceAccountDraft {
  id?: string;
  host: string;
  signupEmail: string;
  password: string;
  status: string;
}

// The Supplier Validation card saves a supplier's whole login set with the rest
// of the profile, so this takes the desired end state: rows with an id are
// updated, rows without one are created as ops-entered, and anything already
// linked to this supplier but absent from the list is removed.
export async function saveSupplierMarketplaceAccounts(
  orgId: string,
  supplierProfileId: string,
  rows: MarketplaceAccountDraft[]
): Promise<ActionResult> {
  const ctx = await assertOrgWriteAccess(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const cleaned = rows
    .map((r) => ({
      id: r.id,
      host: normalizeHost(r.host),
      signup_email: r.signupEmail.trim(),
      password: r.password,
      status: r.status,
    }))
    .filter((r) => r.host || r.signup_email || r.password);

  const incomplete = cleaned.find((r) => !r.host || !r.signup_email || !r.password);
  if (incomplete) return { ok: false, error: "each login needs a site, an account email, and a password" };

  const { data: existing } = await ctx.admin
    .from("marketplace_accounts")
    .select("id")
    .eq("org_id", orgId)
    .eq("supplier_profile_id", supplierProfileId);

  const keep = new Set(cleaned.map((r) => r.id).filter(Boolean));
  const removed = (existing ?? []).map((r) => r.id).filter((id) => !keep.has(id));
  if (removed.length) {
    const { error } = await ctx.admin.from("marketplace_accounts").delete().in("id", removed).eq("org_id", orgId);
    if (error) return { ok: false, error: error.message };
  }

  for (const row of cleaned) {
    const payload = {
      host: row.host,
      slug: deriveSlug(row.host),
      signup_email: row.signup_email,
      password: row.password,
      status: row.status,
      supplier_profile_id: supplierProfileId,
      // An operator saying the login works retires whatever gate the agent
      // diagnosed, so the row stops advertising a blocker that is now cleared.
      ...(row.status === "active" ? { gate_reason: null } : {}),
    };
    const { error } = row.id
      ? await ctx.admin
          .from("marketplace_accounts")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", row.id)
          .eq("org_id", orgId)
      : await ctx.admin.from("marketplace_accounts").insert({
          ...payload,
          org_id: orgId,
          created_by: "ops",
          created_by_email: ctx.session.email,
          verified_at: new Date().toISOString(),
        });
    if (error) {
      const dup = error.code === "23505";
      return { ok: false, error: dup ? `${row.signup_email} is already saved for ${row.host}` : error.message };
    }
  }

  revalidatePath("/work/orgs");
  return { ok: true };
}

// Attach an agent-provisioned login whose host didn't resolve to a supplier.
export async function assignMarketplaceAccount(
  accountId: string,
  orgId: string,
  supplierProfileId: string
): Promise<ActionResult> {
  const ctx = await assertOrgWriteAccess(orgId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const { error } = await ctx.admin
    .from("marketplace_accounts")
    .update({ supplier_profile_id: supplierProfileId, updated_at: new Date().toISOString() })
    .eq("id", accountId)
    .eq("org_id", orgId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/work/orgs");
  return { ok: true };
}
