import { createClient as createSupabaseClient } from "@supabase/supabase-js";
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
    admin.from("users").select("display_name, status, email, last_login_at, deactivated_at").eq("id", user.id).maybeSingle(),
    admin.from("user_roles").select("role").eq("user_id", user.id),
  ]);

  // Bootstrap a profile row on first login.
  if (!profile) {
    await admin.from("users").insert({
      id: user.id,
      email: user.email ?? "",
      display_name: user.user_metadata?.name ?? null,
      last_login_at: new Date().toISOString(),
    });
  } else {
    // Bump last_login_at lazily — only if it's missing or > 1 hour stale.
    // This is cheap and lets the Operators page show real activity without a hot write loop.
    const last = profile.last_login_at ? new Date(profile.last_login_at).getTime() : 0;
    if (Date.now() - last > 3600 * 1000) {
      await admin.from("users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
    }
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

// Re-authenticate the signed-in user before a destructive action ("sudo" check).
// Uses a throwaway client so the cookie-bound session is never touched, and never
// signs out — a global signOut here would revoke the caller's real session.
export async function verifyPassword(email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const verifier = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data, error } = await verifier.auth.signInWithPassword({ email, password });
  return !error && !!data.user;
}

export function canSeeAgentTab(session: SessionContext | null): boolean {
  return hasAnyRole(session, ["admin", "monitor"]);
}
