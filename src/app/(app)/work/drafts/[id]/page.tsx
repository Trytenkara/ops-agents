import { notFound } from "next/navigation";
import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkReviewedButton } from "@/components/mark-reviewed-button";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { tenkaraInboxUrl } from "@/lib/tenkara";

export const dynamic = "force-dynamic";

export default async function DraftDetail({ params }: { params: { id: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: draft } = await admin
    .from("draft_references")
    .select("*, orgs(slug, name), agents(name, slug), assigned:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), reviewer:users!draft_references_reviewer_fkey(display_name, email, user_roles(role))")
    .eq("id", params.id)
    .maybeSingle();
  if (!draft) notFound();

  const d = draft as any;
  const canReview = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);
  const isTenkara = d.email_client === "rod_app" || d.email_client === "tenkara";
  const inboxUrl = isTenkara
    ? tenkaraInboxUrl(d.thread_id)
    : `https://mail.missiveapp.com/#inbox/conversations/${d.thread_id}/drafts/${d.draft_id}`;
  const inboxName = isTenkara ? "Tenkara Inbox" : "Missive";

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link href={`/work/orgs/${d.orgs?.slug ?? ""}`} className="text-sm text-muted-foreground hover:underline">
          ← {d.orgs?.name ?? "Org"}
        </Link>
      </div>
      <Card className="tb-surface shadow-none">
        <CardHeader>
          <div className="flex items-baseline justify-between gap-4">
            <CardTitle className="font-serif text-2xl">{d.subject ?? "(no subject)"}</CardTitle>
            <Badge variant={d.status === "staged" ? "warn" : "success"}>{d.status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Staged {relativeTime(d.created_at)} by {d.agents?.name ?? "agent"}
          </p>
          <div className="text-sm pt-2 flex items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase tracking-wider">Assigned to</span>
            {d.assigned ? (
              <OperatorChip name={d.assigned.display_name} email={d.assigned.email} role={primaryRole(operatorRoles(d.assigned))} />
            ) : (
              <span className="text-muted-foreground text-sm">no one</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailRow label="Supplier" value={(d.metadata as any)?.supplier_name ?? d.supplier_id} />
          <DetailRow label="Material" value={(d.metadata as any)?.material_name ?? d.material_id} />
          <DetailRow label="Quote" value={d.quote_id} />
          <DetailRow label="Conversation" value={d.thread_id} />

          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Body preview</div>
            <pre className="text-sm whitespace-pre-wrap rounded border border-border bg-muted/40 p-3 font-sans">{d.body_preview ?? `(no preview — open in ${inboxName})`}</pre>
          </div>

          <div className="flex gap-2 pt-2">
            <a
              href={inboxUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-md border border-border h-9 px-4 text-sm hover:bg-secondary"
            >
              Open in {inboxName} ↗
            </a>
            {canReview && d.status === "staged" && <MarkReviewedButton draftId={d.id} />}
          </div>

          {d.reviewer && (
            <p className="text-xs text-muted-foreground flex items-center gap-2 pt-1">
              <span>Marked reviewed {relativeTime(d.reviewed_at)} by</span>
              <OperatorChip name={d.reviewer.display_name} email={d.reviewer.email} role={primaryRole(operatorRoles(d.reviewer))} />
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-[140px_1fr] text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono text-xs break-all">{value ?? "—"}</div>
    </div>
  );
}
