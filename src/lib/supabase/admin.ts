import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { truncationGuardedFetch } from "@/lib/supabase/truncation-guard";

// Service-role client. Bypasses RLS. Server-only. Never import from client code.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) must be set");
  }
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // A read that comes back exactly at the 1000-row cap without asking to be
    // bounded is truncated, and PostgREST does not say so. Fail loudly here
    // rather than let a short worklist look like a complete one.
    global: { fetch: truncationGuardedFetch() },
  });
}
