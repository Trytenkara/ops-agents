import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notFound } from "next/navigation";
import { getSession, hasAnyRole, type AppRole } from "@/lib/auth";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { OrgOperatorsEditor } from "@/components/org-operators-editor";
import { getOrgNudgeCounts } from "@/lib/org-nudges";
import { orgDisplayName } from "@/lib/org-display";

export const dynamic = "force-dynamic";

export default async function OrgOverview({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, display_name, tenkara_org_id, is_internal")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  const [draftsRes, casesRes, approvalsRes, quotesRes, opsRes, candidatesRes] = await Promise.all([
    admin.from("draft_references").select("id, status").eq("org_id", org.id),
    admin.from("cases").select("id, status").eq("org_id", org.id).eq("status", "open"),
    admin.from("pending_approvals").select("id").eq("org_id", org.id).eq("status", "pending"),
    admin.from("staged_quotes").select("id", { count: "exact", head: true }).eq("org_id", org.id).eq("status", "pending_review"),
    admin
      .from("org_default_operators")
      .select(
        "primary_user_id, backup_user_id, " +
        "primary_user:users!org_default_operators_primary_user_id_fkey(id, display_name, email, status, user_roles(role)), " +
        "backup_user:users!org_default_operators_backup_user_id_fkey(id, display_name, email, status, user_roles(role))"
      )
      .eq("org_id", org.id)
      .maybeSingle(),
    // Candidates for primary/backup: anyone active with a role that can act on supplier-facing work
    // (Lead Operator, Operator, Admin). Account Manager can't be primary on supplier work.
    admin
      .from("users")
      .select("id, display_name, email, status, deactivated_at, user_roles(role)")
      .is("deactivated_at", null)
      .order("display_name", { nullsFirst: false }),
  ]);

  const drafts = draftsRes.data ?? [];
  const staged = drafts.filter((d: any) => d.status === "staged").length;
  const reviewed = drafts.filter((d: any) => d.status === "reviewed").length;
  const nudges = await getOrgNudgeCounts(admin, org.id);
  const ops = opsRes.data as any;
  const base = `/work/orgs/${org.slug}`;

  // Filter candidates: only people who can act as primary/backup operators for an org.
  const eligibleRoles: AppRole[] = ["admin", "ops_lead", "ops_operator"];
  const candidates = (candidatesRes.data ?? [])
    .map((u: any) => {
      const roles = operatorRoles(u);
      const role = primaryRole(roles);
      return {
        id: u.id,
        display_name: u.display_name,
        email: u.email,
        role,
        status: u.status,
      };
    })
    .filter((c) => c.role && eligibleRoles.includes(c.role));

  const initialPrimary = ops?.primary_user
    ? {
        id: ops.primary_user.id,
        display_name: ops.primary_user.display_name,
        email: ops.primary_user.email,
        role: primaryRole(operatorRoles(ops.primary_user)),
        status: ops.primary_user.status,
      }
    : null;
  const initialBackup = ops?.backup_user
    ? {
        id: ops.backup_user.id,
        display_name: ops.backup_user.display_name,
        email: ops.backup_user.email,
        role: primaryRole(operatorRoles(ops.backup_user)),
        status: ops.backup_user.status,
      }
    : null;
  const canEditAssignment = hasAnyRole(session, ["admin", "ops_lead"]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Metric label="New leads" value={nudges.newLeads} note="to review" href={`${base}/leads`} tone="blue" />
        <Metric label="Drafts to send" value={staged} note={`${reviewed} reviewed`} href={`${base}/threads`} tone="indigo" />
        <Metric label="Quotes to approve" value={quotesRes.count ?? 0} note="pending review" href={`${base}/materials`} tone="amber" />
        <Metric label="Price changes" value={nudges.priceChanges} note="pending review" href={`${base}/price-index`} tone="violet" />
        <Metric label="Open cases" value={casesRes.data?.length ?? 0} href={`${base}/cases`} tone="red" />
        <Metric label="Pending approvals" value={approvalsRes.data?.length ?? 0} href={`${base}/materials`} tone="emerald" />
      </div>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Operator assignment</CardTitle>
        </CardHeader>
        <CardContent>
          <OrgOperatorsEditor
            orgId={org.id}
            orgName={orgDisplayName(org)}
            initialPrimary={initialPrimary as any}
            initialBackup={initialBackup as any}
            candidates={candidates as any}
            canEdit={canEditAssignment}
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
    <Card className={`tb-surface shadow-none border-l-4 ${t ? t.border : "border-l-transparent"} ${href ? "transition-colors hover:bg-secondary/40" : ""}`}>
      <CardHeader>
        <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground font-medium">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`font-serif text-4xl ${valueColor}`}>{value}</div>
        {note && <p className="text-xs text-muted-foreground mt-1">{note}</p>}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="block">{card}</Link> : card;
}
