import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type AppRole = "admin" | "ops_lead" | "ops_operator" | "account_manager" | "monitor";

export interface SessionContext {
  userId: string;
  email: string;
  displayName: string | null;
  status: "active" | "out_of_office";
  roles: AppRole[];
}

export async function getSession(): Promise<SessionContext | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Use service-role to fetch profile + roles to avoid an RLS round-trip.
  const admin = createAdminClient();
  const [{ data: profile }, { data: roleRows }] = await Promise.all([
    admin.from("users").select("display_name, status, email").eq("id", user.id).maybeSingle(),
    admin.from("user_roles").select("role").eq("user_id", user.id),
  ]);

  // Bootstrap a profile row on first login.
  if (!profile) {
    await admin.from("users").insert({
      id: user.id,
      email: user.email ?? "",
      display_name: user.user_metadata?.name ?? null,
    });
  }

  return {
    userId: user.id,
    email: profile?.email ?? user.email ?? "",
    displayName: profile?.display_name ?? null,
    status: (profile?.status as any) ?? "active",
    roles: (roleRows ?? []).map((r: any) => r.role as AppRole),
  };
}

export function hasAnyRole(session: SessionContext | null, roles: AppRole[]): boolean {
  if (!session) return false;
  return session.roles.some((r) => roles.includes(r));
}

export function canSeeAgentTab(session: SessionContext | null): boolean {
  return hasAnyRole(session, ["admin", "monitor"]);
}
