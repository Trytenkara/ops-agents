"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AppRole } from "@/lib/auth";

// Self-serve sign-up is intentionally limited to the company domain. Control Room
// is an internal ops tool — this gate is the only thing standing between the public
// URL and an account, so keep it strict.
const ALLOWED_DOMAIN = "trytenkara.com";
const EMAIL_RE = new RegExp(`^[^@\\s]+@${ALLOWED_DOMAIN.replace(/\./g, "\\.")}$`, "i");
const DEFAULT_ROLE: AppRole = "ops_operator";

interface Result { ok: boolean; error?: string }

export async function selfSignUp(input: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<Result> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: `Sign-up is limited to @${ALLOWED_DOMAIN} email addresses.` };
  }
  if (input.password.length < 10) return { ok: false, error: "Use at least 10 characters." };

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: { name: input.displayName?.trim() || null },
  });
  if (error) {
    const exists = /already|registered|exists/i.test(error.message);
    return { ok: false, error: exists ? "An account with that email already exists — sign in instead." : error.message };
  }
  const userId = data.user?.id;
  if (!userId) return { ok: false, error: "Sign-up failed — no account was created." };

  await admin.from("users").upsert({
    id: userId,
    email,
    display_name: input.displayName?.trim() || null,
  });
  await admin.from("user_roles").upsert({ user_id: userId, role: DEFAULT_ROLE });
  await admin.from("audit_log").insert({
    actor_user_id: userId,
    action: "operator.self_signup",
    target_table: "users",
    target_id: userId,
    diff: { email, role: DEFAULT_ROLE },
  });

  return { ok: true };
}
