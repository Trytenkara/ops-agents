import { Badge } from "@/components/ui/badge";

// One consistent way to show a draft's review state across every draft/thread
// view: staged = awaiting review, reviewed = approved (by whom), sent, discarded.
export function DraftStatusBadge({ status, reviewerName }: { status: string; reviewerName?: string | null }) {
  if (status === "staged") return <Badge variant="warn">Awaiting review</Badge>;
  if (status === "reviewed") {
    const first = reviewerName?.trim().split(/\s+/)[0];
    return <Badge variant="success" title={reviewerName ?? undefined}>{first ? `Reviewed · ${first}` : "Reviewed"}</Badge>;
  }
  if (status === "sent") return <Badge variant="default">Sent</Badge>;
  if (status === "discarded") return <Badge variant="secondary">Discarded</Badge>;
  if (status === "superseded")
    return (
      <Badge variant="warn" title="Regenerated with a corrected material spelling. Delete this old draft in the Tenkara inbox.">
        Superseded · delete in Tenkara
      </Badge>
    );
  return <Badge variant="secondary">{status}</Badge>;
}
