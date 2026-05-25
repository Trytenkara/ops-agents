import { notFound } from "next/navigation";
import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkReviewedButton } from "@/components/mark-reviewed-button";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DraftDetail({ params }: { params: { id: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: draft } = await admin
    .from("draft_references")
    .select("*, orgs(slug, name), agents(name, slug), assigned:users!draft_references_assigned_operator_fkey(display_name, email), reviewer:users!draft_references_reviewer_fkey(display_name, email)")
    .eq("id", params.id)
    .maybeSingle();
  if (!draft) notFound();

  const canReview = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);
  const missiveUrl = `https://mail.missiveapp.com/#inbox/conversations/${(draft as any).thread_id}/drafts/${(draft as any).draft_id}`;

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link href={`/orgs/${(draft as any).orgs?.slug ?? ""}`} className="text-sm text-muted-foreground hover:underline">
          ← {(draft as any).orgs?.name ?? "Org"}
        </Link>
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between gap-4">
            <CardTitle className="text-lg">{(draft as any).subject ?? "(no subject)"}</CardTitle>
            <Badge variant={(draft as any).status === "staged" ? "warn" : "success"}>{(draft as any).status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Staged {relativeTime((draft as any).created_at)} by {(draft as any).agents?.name ?? "agent"} ·
            assigned to {(draft as any).assigned?.display_name ?? (draft as any).assigned?.email ?? "no one"}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailRow label="Supplier" value={(draft as any).supplier_id} />
          <DetailRow label="Material" value={(draft as any).material_id} />
          <DetailRow label="Quote" value={(draft as any).quote_id} />
          <DetailRow label="Missive thread" value={(draft as any).thread_id} />

          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Body preview</div>
            <pre className="text-sm whitespace-pre-wrap rounded border bg-muted/40 p-3">{(draft as any).body_preview ?? "(no preview — open in Missive)"}</pre>
          </div>

          <div className="flex gap-2 pt-2">
            <a
              href={missiveUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-md border h-9 px-4 text-sm hover:bg-accent"
            >
              Open in Missive ↗
            </a>
            {canReview && (draft as any).status === "staged" && (
              <MarkReviewedButton draftId={(draft as any).id} />
            )}
          </div>

          {(draft as any).reviewer && (
            <p className="text-xs text-muted-foreground">
              Marked reviewed {relativeTime((draft as any).reviewed_at)} by {(draft as any).reviewer.display_name ?? (draft as any).reviewer.email}
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
