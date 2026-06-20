import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { resolveSupplierNamesWithFallback, resolveMaterialNames } from "@/lib/tenkara-names";
import { PageExplainer } from "@/components/page-explainer";
import { roleLabel } from "@/lib/roles";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";

export const dynamic = "force-dynamic";

export default async function TodayInboxPage() {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const isAccountManager = hasAnyRole(session, ["account_manager"]) && !hasAnyRole(session, ["admin","ops_lead","ops_operator"]);

  // My assigned drafts (Phase 1: drafts are the primary actionable item).
  const { data: assignedDrafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, status, created_at, org_id, orgs(slug, name)")
    .eq("assigned_operator", session.userId)
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: unassignedDrafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, status, created_at, org_id, orgs(slug, name)")
    .is("assigned_operator", null)
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: recentFailures } = await admin
    .from("agent_runs")
    .select("id, agent_id, status, summary, run_started_at, agents(name, slug)")
    .eq("status", "failure")
    .order("run_started_at", { ascending: false })
    .limit(5);

  // Resolve supplier/material UUIDs to display names via Tenkara prod
  // (read-only). draft_references stores IDs only — names live over there.
  const allDrafts = [...(assignedDrafts ?? []), ...(unassignedDrafts ?? [])];
  const supplierIds = allDrafts.map((d: any) => d.supplier_id).filter(Boolean);
  const materialIds = allDrafts.map((d: any) => d.material_id).filter(Boolean);
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  try {
    [supplierNames, materialNames] = await Promise.all([
      resolveSupplierNamesWithFallback(supplierIds),
      resolveMaterialNames(materialIds),
    ]);
  } catch {
    // If Tenkara is unreachable, fall back to UUIDs rather than failing the page.
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = session.displayName?.split(" ")[0] ?? null;

  // Role + org scope line so an operator immediately knows what they're seeing.
  const primaryRoleLabel = session.roles.length ? roleLabel(session.roles[0]) : "Operator";
  const assignedOrgIds = await getAssignedOrgIds(session);
  const orgScope = seesAllOrgs(session)
    ? "all orgs"
    : `${assignedOrgIds?.length ?? 0} org${(assignedOrgIds?.length ?? 0) === 1 ? "" : "s"}`;

  return (
    <div className="space-y-8 max-w-6xl">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          {isAccountManager
            ? "Client-facing items needing your attention."
            : "Drafts, cases, and escalations that need a human."}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          You&apos;re signed in as <span className="font-medium text-foreground">{primaryRoleLabel}</span> · covering {orgScope}.
        </p>
      </header>

      <PageExplainer tag="Your inbox.">
        Agents stage work here for human review. Nothing is sent until you click Send in the Tenkara Inbox.
        See <a href="/how-it-works" className="underline hover:text-foreground">How Tackle Box works</a> for the full pipeline.
      </PageExplainer>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">My assigned items <span className="ml-1 text-foreground">· {assignedDrafts?.length ?? 0}</span></CardTitle>
        </CardHeader>
        <CardContent>
          {assignedDrafts && assignedDrafts.length > 0 ? (
            <DraftTable rows={assignedDrafts as any} supplierNames={supplierNames} materialNames={materialNames} />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing assigned to you right now. Pick up an unassigned item below.</p>
          )}
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Unassigned <span className="ml-1 text-foreground">· {unassignedDrafts?.length ?? 0}</span></CardTitle>
        </CardHeader>
        <CardContent>
          {unassignedDrafts && unassignedDrafts.length > 0 ? (
            <DraftTable rows={unassignedDrafts as any} supplierNames={supplierNames} materialNames={materialNames} />
          ) : (
            <p className="text-sm text-muted-foreground">Inbox zero — nothing waiting for pickup.</p>
          )}
          {!isAccountManager && (
            <Link href="/work/review/leads" className="mt-3 inline-block text-sm text-primary hover:underline">
              Browse the Review queue →
            </Link>
          )}
        </CardContent>
      </Card>

      {hasAnyRole(session, ["admin","monitor"]) && (
        <Card className="tb-surface shadow-none">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Recent agent failures</CardTitle>
          </CardHeader>
          <CardContent>
            {recentFailures && recentFailures.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentFailures.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell><Link href={`/agents?run=${r.id}`} className="hover:underline">{r.agents?.name ?? r.agent_id}</Link></TableCell>
                      <TableCell className="text-muted-foreground truncate max-w-[40ch]">{r.summary ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{relativeTime(r.run_started_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No recent failures.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DraftTable({
  rows,
  supplierNames,
  materialNames,
}: {
  rows: any[];
  supplierNames: Map<string, string>;
  materialNames: Map<string, string>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Org</TableHead>
          <TableHead>Supplier</TableHead>
          <TableHead>Material</TableHead>
          <TableHead>Staged</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => {
          const supplierName = d.supplier_id ? supplierNames.get(d.supplier_id) : null;
          const materialName = d.material_id ? materialNames.get(d.material_id) : null;
          return (
            <TableRow key={d.id}>
              <TableCell className="font-medium">{d.subject ?? "(no subject)"}</TableCell>
              <TableCell>{d.orgs?.name ?? "—"}</TableCell>
              <TableCell title={d.supplier_id ?? undefined}>
                {supplierName ?? (d.supplier_id ? <code className="text-xs text-muted-foreground">{d.supplier_id.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell title={d.material_id ?? undefined}>
                {materialName ?? (d.material_id ? <code className="text-xs text-muted-foreground">{d.material_id.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.created_at)}</TableCell>
              <TableCell><Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Review →</Link></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
