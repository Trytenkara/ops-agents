import Link from "next/link";
import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { roleLabel } from "@/lib/roles";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";

export const dynamic = "force-dynamic";

// Home — the cross-client dashboard. Grounded in the ops-dash pattern: Quick-View
// count cards + a per-client "work waiting" table. Counts roll up; you click a
// client to act. No flat email list, no leaked UUIDs. (Exercise-status cards —
// stalled / ready / coverage — layer in with the Stage 2 exercise data model.)
export default async function HomePage() {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const orgIds = await getAssignedOrgIds(session); // null = sees all
  const scope = (q: any) => (orgIds ? q.in("org_id", orgIds) : q);

  const [draftsRes, quotesRes, findingsRes, casesRes, leadsRes, orgsRes] = await Promise.all([
    scope(admin.from("draft_references").select("org_id").eq("status", "staged")),
    scope(admin.from("staged_quotes").select("org_id").eq("status", "pending_review")),
    scope(admin.from("marketplace_check_findings").select("org_id").eq("status", "pending_review")),
    scope(admin.from("cases").select("org_id").in("status", ["open", "in_progress"])),
    scope(admin.from("leads_in_flight").select("org_id").eq("stage", "ready_for_approval").eq("status", "active")),
    orgIds
      ? admin.from("orgs").select("id, slug, name").in("id", orgIds)
      : admin.from("orgs").select("id, slug, name"),
  ]);

  type Row = { slug: string; name: string; drafts: number; quotes: number; changes: number; cases: number; leads: number; total: number };
  const byOrg = new Map<string, Row>();
  for (const o of (orgsRes.data ?? []) as any[]) {
    byOrg.set(o.id, { slug: o.slug, name: o.name, drafts: 0, quotes: 0, changes: 0, cases: 0, leads: 0, total: 0 });
  }
  const tally = (rows: any[], key: "drafts" | "quotes" | "changes" | "cases" | "leads") => {
    let total = 0;
    for (const r of rows ?? []) {
      total++;
      const row = byOrg.get(r.org_id);
      if (row) {
        row[key]++;
        row.total++;
      }
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

  const rows = Array.from(byOrg.values())
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = session.displayName?.split(" ")[0] ?? null;
  const primaryRoleLabel = session.roles.length ? roleLabel(session.roles[0]) : "Operator";
  const scopeLabel = seesAllOrgs(session) ? "all clients" : `${orgIds?.length ?? 0} client${(orgIds?.length ?? 0) === 1 ? "" : "s"}`;

  const cards = [
    { label: "Drafts to review", value: counts.drafts, tone: "text-blue-700" },
    { label: "Quotes to approve", value: counts.quotes, tone: "text-emerald-700" },
    { label: "Price changes", value: counts.changes, tone: "text-amber-700" },
    { label: "Open cases", value: counts.cases, tone: "text-red-700" },
    { label: "Leads ready", value: counts.leads, tone: "text-teal-700" },
  ];

  return (
    <div className="space-y-8 max-w-6xl">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground mt-2">Work waiting across your clients.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Signed in as <span className="font-medium text-foreground">{primaryRoleLabel}</span> · covering {scopeLabel}.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {cards.map((c) => (
          <Card key={c.label} className="tb-surface shadow-none">
            <CardContent className="py-5">
              <div className={`text-3xl font-serif ${c.value > 0 ? c.tone : "text-muted-foreground"}`}>{c.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{c.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Clients needing attention</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting across your clients right now. 🎣</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Drafts</TableHead>
                  <TableHead className="text-right">Quotes</TableHead>
                  <TableHead className="text-right">Price changes</TableHead>
                  <TableHead className="text-right">Cases</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.slug}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <Num n={r.drafts} />
                    <Num n={r.quotes} />
                    <Num n={r.changes} />
                    <Num n={r.cases} />
                    <Num n={r.leads} />
                    <TableCell className="text-right font-semibold">{r.total}</TableCell>
                    <TableCell className="text-right">
                      <Link href={`/clients/${r.slug}`} className="text-primary hover:underline text-sm">Open →</Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return <TableCell className={`text-right ${n > 0 ? "text-foreground" : "text-muted-foreground/40"}`}>{n || "—"}</TableCell>;
}
