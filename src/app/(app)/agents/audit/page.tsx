import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { operatorRoles, primaryRole } from "@/lib/operator";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  "draft.mark_reviewed": "Draft marked reviewed",
  "approval.approved": "Approval approved",
  "approval.rejected": "Approval rejected",
  "approval.exported_pending_upload": "CSV downloaded",
  "approval.exported_confirmed": "Marked uploaded to Tenkara",
  "agent.stamp_approved": "Stamp approved",
  "agent.stamp_revoked": "Stamp revoked",
  "agent.key_rotated": "API key rotated",
  "operator.invited": "Operator invited",
  "operator.invite_resent": "Invite resent",
  "operator.role_changed": "Role changed",
  "operator.org_assignments_changed": "Org assignments changed",
  "operator.deactivated": "Operator deactivated",
  "operator.reactivated": "Operator reactivated",
  "org.operators_set": "Org operators set",
  "user.status_change": "Status (OOO) changed",
};

export default async function AuditLogPage({ searchParams }: { searchParams: { action?: string; actor?: string } }) {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  let q = admin
    .from("audit_log")
    .select(
      "id, actor_user_id, actor_agent_id, action, target_table, target_id, diff, at, " +
      "users:users!audit_log_actor_user_id_fkey(display_name, email, user_roles(role)), " +
      "agents:agents!audit_log_actor_agent_id_fkey(name, slug)"
    )
    .order("at", { ascending: false })
    .limit(200);
  if (searchParams.action) q = q.eq("action", searchParams.action);
  if (searchParams.actor) q = q.eq("actor_user_id", searchParams.actor);
  const { data: rows } = await q;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground mt-1">Every approval, override, role change, stamp flip, CSV download. Last 200.</p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Diff</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(rows ?? []).map((r: any) => (
            <TableRow key={r.id}>
              <TableCell>
                {r.users ? (
                  <OperatorChip name={r.users.display_name} email={r.users.email} role={primaryRole(operatorRoles(r.users))} />
                ) : r.agents ? (
                  <span className="inline-flex items-center gap-2">
                    <Badge variant="secondary">agent</Badge>
                    <span className="text-sm">{r.agents.name}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">system</span>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {ACTION_LABELS[r.action] ?? <code className="text-xs">{r.action}</code>}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {r.target_table ? <><code>{r.target_table}</code>{r.target_id && <> · <span className="font-mono">{r.target_id.slice(0, 8)}…</span></>}</> : "—"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground font-mono truncate max-w-[28ch]">
                {r.diff ? JSON.stringify(r.diff) : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">{relativeTime(r.at)}</TableCell>
            </TableRow>
          ))}
          {(!rows || rows.length === 0) && (
            <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">Nothing logged yet.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
