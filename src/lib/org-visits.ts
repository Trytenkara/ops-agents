import { createAdminClient } from "@/lib/supabase/admin";

const WINDOW_DAYS = 30;

export async function recordOrgVisit(userId: string, orgId: string): Promise<void> {
  const admin = createAdminClient();
  // Never let a bookkeeping write break the page it is bookkeeping for.
  const { error } = await admin.rpc("record_org_visit", { p_user_id: userId, p_org_id: orgId });
  if (error) console.warn("[org-visits] record failed", error.message);
}

/** org_id -> visits by this user over the trailing window. Missing = never visited. */
export async function orgVisitCounts(userId: string): Promise<Map<string, number>> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("org_visits")
    .select("org_id, hits")
    .eq("user_id", userId)
    .gte("visit_day", since);
  if (error) {
    console.warn("[org-visits] read failed", error.message);
    return new Map();
  }
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ org_id: string; hits: number }>) {
    counts.set(row.org_id, (counts.get(row.org_id) ?? 0) + row.hits);
  }
  return counts;
}
