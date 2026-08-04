import type { SupabaseClient } from "@supabase/supabase-js";

export interface MarketplaceAccountRow {
  id: string;
  org_id: string;
  supplier_profile_id: string | null;
  host: string;
  slug: string;
  signup_email: string;
  password: string;
  status: string;
  last_error: string | null;
  verified_at: string | null;
  last_login_at: string | null;
  created_by: "agent" | "ops";
  created_by_email: string | null;
  created_at: string;
  // Why self-serve provisioning could not finish, as a code (migration 0081),
  // plus who to ask when clearing it needs a person at the supplier.
  gate_reason: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_url: string | null;
  contact_notes: string | null;
}

export const ACCOUNT_COLUMNS =
  "id, org_id, supplier_profile_id, host, slug, signup_email, password, status, last_error, verified_at, last_login_at, created_by, created_by_email, created_at, gate_reason, contact_name, contact_email, contact_phone, contact_url, contact_notes";

export const ACCOUNT_STATUSES = ["pending", "signing_up", "verifying", "active", "failed", "banned"] as const;

// Accept whatever ops pastes — a full listing URL, "www.knowde.com", or a bare
// hostname — and store the bare host the pull scripts match leads on.
export function normalizeHost(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return "";
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^www\./, "").split("/")[0];
  }
}

// Adapter slug the price-pull scripts key on, e.g. knowde.com → KNOWDE.
export function deriveSlug(host: string): string {
  return host.split(".")[0].replace(/[^a-z0-9]/gi, "").toUpperCase() || "MARKETPLACE";
}

export async function getMarketplaceAccounts(
  admin: SupabaseClient,
  orgId: string
): Promise<MarketplaceAccountRow[]> {
  const { data, error } = await admin
    .from("marketplace_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as MarketplaceAccountRow[];
}
