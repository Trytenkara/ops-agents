import { notFound } from "next/navigation";
import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { loadDraftDetail } from "@/lib/draft-detail";
import { DraftDetailView } from "@/components/draft-detail-view";

export const dynamic = "force-dynamic";

export default async function DraftDetail({ params }: { params: { id: string } }) {
  const session = (await getSession())!;
  const detail = await loadDraftDetail(params.id);
  if (!detail) notFound();

  const canReview = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link href={`/work/orgs/${detail.orgSlug ?? ""}`} className="text-sm text-muted-foreground hover:underline">
          ← {detail.orgName ?? "Org"}
        </Link>
      </div>
      <Card className="tb-surface shadow-none">
        <CardHeader>
          <div className="flex items-baseline justify-between gap-4">
            <CardTitle className="font-serif text-2xl">{detail.subject ?? "(no subject)"}</CardTitle>
            <Badge variant={detail.status === "staged" ? "warn" : "success"}>{detail.status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Staged {relativeTime(detail.createdAt)} by {detail.agentName ?? "agent"}
          </p>
        </CardHeader>
        <CardContent>
          <DraftDetailView detail={detail} canReview={canReview} />
        </CardContent>
      </Card>
    </div>
  );
}
