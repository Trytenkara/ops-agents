#!/usr/bin/env node
// Bootstrap an admin user: assigns the 'admin' role to whatever auth.user already exists
// for the email you pass in. Run this after the first time you sign up at /login.
//
// Usage:
//   ADMIN_EMAIL=you@trytenkara.com node scripts/bootstrap-admin.mjs
//
// Requires SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in .env.local.

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.ADMIN_EMAIL;
if (!url || !key || !email) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL");
  process.exit(1);
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Find auth user by email via admin API.
const { data: list, error: listErr } = await admin.auth.admin.listUsers();
if (listErr) { console.error(listErr); process.exit(1); }
const user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No auth.users row for ${email}. Sign in at /login first to create one.`);
  process.exit(1);
}

// Upsert profile row.
await admin.from("users").upsert({ id: user.id, email: user.email, display_name: user.user_metadata?.name ?? null });

// Assign all roles for convenience on the bootstrap user.
const roles = ["admin", "ops_lead", "monitor"];
for (const r of roles) {
  await admin.from("user_roles").upsert({ user_id: user.id, role: r });
}
console.log(`Granted ${roles.join(", ")} to ${email}.`);
