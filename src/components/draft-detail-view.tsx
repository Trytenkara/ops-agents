"use client";

import { Badge } from "@/components/ui/badge";
import { MarkReviewedButton } from "@/components/mark-reviewed-button";
import { RewriteDraftButton } from "@/components/rewrite-draft-button";
import { OperatorChip } from "@/components/operator-chip";
import { relativeTime } from "@/lib/utils";
import type { DraftDetail } from "@/lib/draft-detail";

// The body of a staged draft, shared by the full /work/drafts/[id] page and the
// side panel on the thread list so both stay in step.
export function DraftDetailView({
  detail,
  canReview,
  onChanged,
}: {
  detail: DraftDetail;
  canReview: boolean;
  onChanged?: () => void;
}) {
  const d = detail;
  return (
    <div className="space-y-4">
      <div className="text-sm flex items-center gap-2">
        <span className="text-muted-foreground text-xs uppercase tracking-wider">Assigned to</span>
        {d.assigned ? (
          <OperatorChip name={d.assigned.name} email={d.assigned.email} role={d.assigned.role} />
        ) : (
          <span className="text-muted-foreground text-sm">no one</span>
        )}
      </div>

      <DetailRow label="Supplier" value={d.supplierName} />
      <DetailRow label="Material" value={d.materialName} />
      <DetailRow label="Quote" value={d.quoteId} />

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Conversation</div>
        {d.reply ? (
          <div className="rounded border border-border bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant="success">↩ Supplier replied</Badge>
              {d.flowLabel && <span className="text-xs text-muted-foreground">{d.flowLabel}</span>}
            </div>
            <div className="text-xs text-muted-foreground">
              From {d.reply.senderName || d.reply.senderEmail || "supplier"}
              {d.reply.repliedAt ? ` · ${relativeTime(d.reply.repliedAt)}` : ""}
            </div>
            {d.reply.subject && <div className="font-medium">{d.reply.subject}</div>}
            {d.reply.preview && <p className="text-muted-foreground whitespace-pre-wrap">{d.reply.preview}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No supplier reply yet
            {d.followupCount ? ` · ${d.followupCount} follow-up${d.followupCount === 1 ? "" : "s"} sent` : ""}
            {d.flowLabel ? ` · ${d.flowLabel}` : ""}.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground mt-1 font-mono break-all">Thread {d.threadId ?? "—"}</p>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Body preview</div>
        <pre className="text-sm whitespace-pre-wrap rounded border border-border bg-muted/40 p-3 font-sans">
          {d.bodyPreview ?? `(no preview — open in ${d.inboxName})`}
        </pre>
      </div>

      <div className="flex flex-wrap gap-2 pt-2">
        <a
          href={d.inboxUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center rounded-md border border-border h-9 px-4 text-sm hover:bg-secondary"
        >
          Open full thread in {d.inboxName} ↗
        </a>
        {canReview && d.status === "staged" && <MarkReviewedButton draftId={d.id} onDone={onChanged} />}
        {canReview && d.status === "staged" && d.isTenkara && d.draftKind !== "inbound_reply" && (
          <RewriteDraftButton draftId={d.id} onDone={onChanged} />
        )}
      </div>

      {d.reviewer && (
        <p className="text-xs text-muted-foreground flex items-center gap-2 pt-1">
          <span>Marked reviewed {relativeTime(d.reviewedAt)} by</span>
          <OperatorChip name={d.reviewer.name} email={d.reviewer.email} role={d.reviewer.role} />
        </p>
      )}
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
