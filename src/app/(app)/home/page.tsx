import { Greeting } from "@/components/greeting";
import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { roleLabel } from "@/lib/roles";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { orgDisplayName } from "@/lib/org-display";
import { HomeBoard, type WorkType, type ClientRow } from "@/components/home-board";

export const dynamic = "force-dynamic";

// Home — cross-client dashboard. Quick-View count cards (click to filter) + a
// per-client "work waiting" table with an aging signal. Grounded in the ops-dash
// pattern: counts + attention, not a flat email list. Exercise-status/coverage
// cards layer in with the Stage 2 data model.
export default async function HomePage() {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const orgIds = await getAssignedOrgIds(session); // null = sees all
  const scope = (q: any) => (orgIds ? q.in("org_id", orgIds) : q);

  const [draftsRes, quotesRes, findingsRes, casesRes, leadsRes, orgsRes] = await Promise.all([
    scope(admin.from("draft_references").select("org_id, created_at").eq("status", "staged")),
    scope(admin.from("staged_quotes").select("org_id, created_at").eq("status", "pending_review")),
    scope(admin.from("marketplace_check_findings").select("org_id, created_at").eq("status", "pending_review")),
    scope(admin.from("cases").select("org_id, created_at").in("status", ["open", "in_progress"])),
    scope(admin.from("leads_in_flight").select("org_id, created_at").eq("stage", "ready_for_approval").eq("status", "active")),
    orgIds ? admin.from("orgs").select("id, slug, name, display_name").in("id", orgIds) : admin.from("orgs").select("id, slug, name, display_name"),
  ]);

  const now = Date.now();
  const acc = new Map<string, ClientRow & { _oldest: number }>();
  for (const o of (orgsRes.data ?? []) as any[]) {
    acc.set(o.id, { slug: o.slug, name: orgDisplayName(o), drafts: 0, quotes: 0, changes: 0, cases: 0, leads: 0, total: 0, oldestDays: 0, _oldest: now });
  }
  const tally = (rows: any[], key: WorkType) => {
    let total = 0;
    for (const r of rows ?? []) {
      total++;
      const row = acc.get(r.org_id);
      if (!row) continue;
      row[key]++;
      row.total++;
      const t = r.created_at ? new Date(r.created_at).getTime() : now;
      if (t < row._oldest) row._oldest = t;
    }
    return total;
  };
  const counts = {
    drafts: tally(draftsRes.data, "drafts"),
    quotes: tally(quotesRes.data, "quotes"),
    changes: tally(findingsRes.data, "changes"),
    cases: tally(casesRes.data, "cases"),
    leads: tally(leadsRes.data, "leads"),
  };

  const rows: ClientRow[] = Array.from(acc.values())
    .filter((r) => r.total > 0)
    .map((r) => ({ ...r, oldestDays: Math.floor((now - r._oldest) / 86_400_000) }))
    .sort((a, b) => b.total - a.total);

  const firstName = session.displayName?.split(" ")[0] ?? null;
  const primaryRoleLabel = session.roles.length ? roleLabel(session.roles[0]) : "Operator";
  const scopeLabel = seesAllOrgs(session) ? "all clients" : `${orgIds?.length ?? 0} client${(orgIds?.length ?? 0) === 1 ? "" : "s"}`;

  return (
    <div className="space-y-8 max-w-6xl">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">
          <Greeting firstName={firstName} />
        </h1>
        <p className="text-sm text-muted-foreground mt-2">Work waiting across your clients.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Signed in as <span className="font-medium text-foreground">{primaryRoleLabel}</span> · covering {scopeLabel}.
        </p>
      </header>

      <HomeBoard counts={counts} rows={rows} />
    </div>
  );
}
