import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { Shell, type OrgItem } from "@/components/nav";
import { createAdminClient } from "@/lib/supabase/admin";
import { orgDisplayName } from "@/lib/org-display";
import { orgVisitCounts } from "@/lib/org-visits";
import { compareOrgPriority } from "@/lib/org-priority";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const admin = createAdminClient();

  // Admins, monitors, and ops_leads see every org. Operators and account managers
  // only see the orgs they're explicitly assigned to.
  const seesAllOrgs = hasAnyRole(session, ["admin", "monitor", "ops_lead"]);

  let orgRows: Array<{ id: string; slug: string; name: string; display_name: string | null; is_internal: boolean }> = [];
  if (seesAllOrgs) {
    const { data } = await admin
      .from("orgs")
      .select("id, slug, name, display_name, is_internal")
      .neq("hidden", true);
    orgRows = (data ?? []) as any;
  } else {
    const { data } = await admin
      .from("user_org_assignments")
      .select("orgs(id, slug, name, display_name, is_internal)")
      .eq("user_id", session.userId);
    orgRows = ((data ?? []) as any).map((row: any) => row.orgs).filter(Boolean);
  }

  // Real clients before internal test orgs, then this operator's own most-visited
  // (trailing 30d), then A→Z. Everyone starts at zero visits, so a fresh user or
  // a fresh org degrades cleanly to the old alphabetical list.
  const visits = await orgVisitCounts(session.userId);
  orgRows.sort(
    (a, b) =>
      compareOrgPriority(a, b) ||
      (visits.get(b.id) ?? 0) - (visits.get(a.id) ?? 0) ||
      orgDisplayName(a).localeCompare(orgDisplayName(b)),
  );

  const orgs: OrgItem[] = orgRows.map((o) => ({
    slug: o.slug,
    name: orgDisplayName(o),
    isInternal: o.is_internal ?? false,
  }));

  return <Shell session={session} orgs={orgs}>{children}</Shell>;
}
