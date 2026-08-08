import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notFound } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { OrgAssignmentSettings } from "@/components/org-assignment-settings";
import { ALL_SUPPLIER_TYPES } from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";
import { OrgSourcingToggle } from "@/components/org-sourcing-toggle";
import { OrgOnboardingToggle } from "@/components/org-onboarding-toggle";
import { OrgTenkaraInbox } from "@/components/org-tenkara-inbox";
import { OrgBounceAlert } from "@/components/org-bounce-alert";
import { getOrgNudgeCounts } from "@/lib/org-nudges";
import { caseCategory } from "@/lib/org-cases";
import { orgDisplayName } from "@/lib/org-display";
import { SourcingPipelineStrip, type StageKey } from "@/components/sourcing-pipeline-strip";
import type { RunStat } from "@/components/agent-runs-strip";
import { resolveMaterialNames } from "@/lib/tenkara-names";

export const dynamic = "force-dynamic";

export default async function OrgOverview({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, display_name, tenkara_org_id, is_internal, sourcing_status, onboarding_stage, bounce_alert_status, tenkara_email_account_id, tenkara_email_address, assignment_mode, assignment_supplier_types")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  const [draftsRes, casesRes, approvalsRes, quotesRes, membersRes] = await Promise.all([
    admin.from("draft_references").select("id, status").eq("org_id", org.id),
    admin.from("cases").select("id, status, type").eq("org_id", org.id).in("status", ["open", "in_progress"]),
    admin.from("pending_approvals").select("id").eq("org_id", org.id).eq("status", "pending"),
    admin.from("staged_quotes").select("id", { count: "exact", head: true }).eq("org_id", org.id).eq("status", "pending_review"),
    // Org members for the auto-loop include/exclude list. Unlike the assignment
    // pool this keeps out-of-office people visible, so an ops lead can see the
    // whole membership they're toggling.
    admin
      .from("user_org_assignments")
      .select("auto_assignable, operator_type, lanes, users:users!user_org_assignments_user_id_fkey(id, display_name, email, status, deactivated_at, user_roles(role))")
      .eq("org_id", org.id),
  ]);

  const drafts = draftsRes.data ?? [];
  const staged = drafts.filter((d: any) => d.status === "staged").length;
  const reviewed = drafts.filter((d: any) => d.status === "reviewed").length;
  const nudges = await getOrgNudgeCounts(admin, org.id);

  // Live sourcing funnel — same four stages as the Agent Supplier Leads tab.
  // Held mirrors that page's rule exactly: an active lead whose material has no
  // resolvable name (stored or Tenkara). Everything else counts by stage.
  const pipelineCounts: Record<StageKey, number> = { raw: 0, enriched: 0, ready: 0, held: 0 };
  let pipelineRuns: RunStat[] = [];
  {
    const { data: pipelineLeads } = await admin
      .from("leads_in_flight")
      .select("stage, material_id, material_name")
      .eq("org_id", org.id)
      .eq("status", "active");
    let leadNames = new Map<string, string>();
    try {
      leadNames = await resolveMaterialNames((pipelineLeads ?? []).map((r: any) => r.material_id).filter(Boolean));
    } catch {
      // Tenkara unreachable — fall back to the stored name only.
    }
    for (const r of (pipelineLeads ?? []) as any[]) {
      const resolvedName = (r.material_id ? leadNames.get(r.material_id) : null) || (r.material_name && r.material_name.trim()) || null;
      if (!resolvedName) pipelineCounts.held++;
      else if (r.stage === "raw") pipelineCounts.raw++;
      else if (r.stage === "enriched") pipelineCounts.enriched++;
      else if (r.stage === "ready_for_outreach") pipelineCounts.ready++;
    }
    const RUN_LABELS: Record<string, string> = {
      "agent-03-lead-creator": "Discovery",
      "agent-06-enrichment": "Enrichment",
      "agent-04-outreach": "Outreach",
    };
    const { data: runRows } = await admin
      .from("agent_runs")
      .select("summary, status, run_started_at, agents!inner(slug)")
      .in("agents.slug", Object.keys(RUN_LABELS))
      .order("run_started_at", { ascending: false })
      .limit(40);
    const latestBySlug = new Map<string, RunStat>();
    for (const r of (runRows ?? []) as any[]) {
      const slug = r.agents?.slug;
      if (slug && !latestBySlug.has(slug)) {
        latestBySlug.set(slug, { label: RUN_LABELS[slug], summary: r.summary, status: r.status, at: r.run_started_at });
      }
    }
    pipelineRuns = Object.keys(RUN_LABELS).map((s) => latestBySlug.get(s)).filter(Boolean) as RunStat[];
  }
  // Call rows live on the Call Tracker, not the Cases page, so the two metrics
  // split the same table the way the two pages do.
  const allCases = (casesRes.data ?? []) as any[];
  const openCalls = allCases.filter((c) => caseCategory(c.type) === "call").length;
  const openCases = allCases.length - openCalls;
  const base = `/work/orgs/${org.slug}`;

  const canEditSourcing = hasAnyRole(session, ["admin", "ops_lead"]);
  const canEditAssignment = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  const assignmentOperators = (membersRes.data ?? [])
    .map((m: any) => {
      const u = m.users;
      if (!u || u.deactivated_at) return null;
      const role = primaryRole(operatorRoles(u));
      if (role !== "ops_operator" && role !== "ops_lead") return null;
      return {
        id: u.id as string,
        name: (u.display_name ?? u.email ?? "-") as string,
        email: (u.email ?? null) as string | null,
        role,
        autoAssignable: m.auto_assignable !== false,
        operatorType: m.operator_type === "call" ? ("call" as const) : ("email" as const),
        lanes: (Array.isArray(m.lanes)
          ? m.lanes.filter((l: string) => (ALL_SUPPLIER_TYPES as string[]).includes(l))
          : ALL_SUPPLIER_TYPES) as MarketKind[],
      };
    })
    .filter((m): m is NonNullable<typeof m> => !!m)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Metric label="New leads" value={nudges.newLeads} note="to review" href={`${base}/leads`} tone="blue" />
        <Metric label="Drafts to send" value={staged} note={`${reviewed} reviewed`} href={`${base}/threads`} tone="indigo" />
        <Metric label="Quotes to approve" value={quotesRes.count ?? 0} note="pending review" href={`${base}/materials`} tone="amber" />
        <Metric label="Price changes" value={nudges.priceChanges} note="pending review" href={`${base}/price-index`} tone="violet" />
        <Metric label="Open cases" value={openCases} href={`${base}/cases`} tone="red" />
        <Metric label="Calls owed" value={openCalls} note="to make" href={`${base}/calls`} tone="red" />
        <Metric label="Pending approvals" value={approvalsRes.data?.length ?? 0} href={`${base}/materials`} tone="emerald" />
      </div>

      <SourcingPipelineStrip counts={pipelineCounts} runs={pipelineRuns} leadsHref={`${base}/leads`} />

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Sourcing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <OrgSourcingToggle
            orgId={org.id}
            orgName={orgDisplayName(org)}
            initial={(org.sourcing_status ?? "off") as any}
            canEdit={canEditSourcing}
          />
          <OrgOnboardingToggle
            orgId={org.id}
            orgName={orgDisplayName(org)}
            initial={(org.onboarding_stage ?? "motherlode") as any}
            canEdit={canEditSourcing}
          />
          <OrgTenkaraInbox
            orgId={org.id}
            orgName={orgDisplayName(org)}
            initialAccountId={org.tenkara_email_account_id ?? null}
            initialEmail={org.tenkara_email_address ?? null}
            canEdit={canEditSourcing}
          />
          {(org.bounce_alert_status ?? "none") !== "none" && (
            <OrgBounceAlert
              orgId={org.id}
              orgName={orgDisplayName(org)}
              status={(org.bounce_alert_status ?? "none") as any}
              canEdit={canEditSourcing}
            />
          )}
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Operator assignment</CardTitle>
        </CardHeader>
        <CardContent>
          <OrgAssignmentSettings
            orgId={org.id}
            orgSlug={org.slug}
            orgName={orgDisplayName(org)}
            initialMode={((org as any).assignment_mode ?? "auto_new") as any}
            initialSupplierTypes={(((org as any).assignment_supplier_types ?? ALL_SUPPLIER_TYPES) as any)}
            operators={assignmentOperators}
            canEdit={canEditAssignment}
            canRebalance={canEditSourcing}
          />
        </CardContent>
      </Card>
    </div>
  );
}

const METRIC_TONE: Record<string, { border: string; value: string }> = {
  blue: { border: "border-l-blue-500", value: "text-blue-600 dark:text-blue-400" },
  indigo: { border: "border-l-indigo-500", value: "text-indigo-600 dark:text-indigo-400" },
  amber: { border: "border-l-amber-500", value: "text-amber-600 dark:text-amber-400" },
  violet: { border: "border-l-violet-500", value: "text-violet-600 dark:text-violet-400" },
  red: { border: "border-l-red-500", value: "text-red-600 dark:text-red-400" },
  emerald: { border: "border-l-emerald-500", value: "text-emerald-600 dark:text-emerald-400" },
};

function Metric({ label, value, note, href, tone }: { label: string; value: number; note?: string; href?: string; tone?: string }) {
  const t = (tone && METRIC_TONE[tone]) || null;
  // Zero is a non-event — keep it muted; only color a value that needs attention.
  const valueColor = value > 0 && t ? t.value : "text-foreground";
  const card = (
    <Card className={`tb-surface shadow-none h-full border-l-4 ${t ? t.border : "border-l-transparent"} ${href ? "transition-colors hover:bg-secondary/40" : ""}`}>
      <CardHeader>
        <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground font-medium">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`font-serif text-4xl ${valueColor}`}>{value}</div>
        <p className="text-xs text-muted-foreground mt-1">{note ?? " "}</p>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="block h-full">{card}</Link> : card;
}
