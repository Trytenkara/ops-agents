"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { promoteLead, dropLead, linkLeadToConversation, requestOutreachRetry, cancelOutreachRetry } from "@/app/actions/leads";
import { DROP_REASONS, type DropReason } from "@/app/actions/lead-drop-reasons";

// The retry action answers in codes; operators need sentences.
const RETRY_ERRORS: Record<string, string> = {
  lead_not_retryable: "This lead is not ready for outreach yet. Promote it first.",
  retry_group_unidentifiable: "No contact email or supplier on this lead, so there is nobody to write to.",
  no_retryable_supplier_leads: "Nothing left to write for this supplier.",
  supplier_already_has_live_or_sent_thread: "This supplier already has a live email thread. Open it and use Draft a reply now.",
  forbidden: "You do not have access to this client.",
  unauthenticated: "Session expired. Reload the page.",
};

interface Props {
  leadId: string;
  stage: string;
  status: string;
  hasBlockedReason: boolean;
  disabled?: boolean;
}

export function LeadRowActions({ leadId, stage, status, hasBlockedReason, disabled }: Props) {
  const [pending, startTransition] = useTransition();
  const [dropping, setDropping] = useState(false);
  const [linking, setLinking] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [reason, setReason] = useState<DropReason>("duplicate");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  if (status !== "active") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const canPromote = !disabled && (stage === "enriched" || (stage === "raw" && hasBlockedReason));
  const canDrop =
    !disabled &&
    (stage === "raw" || stage === "enriched" || stage === "ready_for_outreach" || stage === "ready_for_approval");
  // Leads past outreach have a draft staged in the email app; dropping deletes it.
  const dropDeletesDraft = stage === "ready_for_outreach" || stage === "ready_for_approval";

  function onPromote() {
    setErr(null);
    startTransition(async () => {
      const res = await promoteLead(leadId);
      if (!res.ok) setErr(res.error ?? "failed");
    });
  }

  function onRetry() {
    setErr(null);
    setWarn(null);
    startTransition(async () => {
      const requested = await requestOutreachRetry(leadId);
      if (!requested.ok || !requested.retryRequestId) {
        setErr(RETRY_ERRORS[requested.error ?? ""] ?? requested.error ?? "failed");
        return;
      }
      const response = await fetch("/api/agents/run/agent-04-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { retryRequestId: requested.retryRequestId } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        await cancelOutreachRetry(requested.retryRequestId);
        setErr(RETRY_ERRORS[body.error ?? ""] ?? body.error ?? `HTTP ${response.status}`);
      } else setWarn("Drafting outreach for this supplier now.");
    });
  }

  function onConfirmDrop() {
    setErr(null);
    setWarn(null);
    startTransition(async () => {
      const res = await dropLead(leadId, reason, note);
      if (!res.ok) setErr(res.error ?? "failed");
      else {
        setDropping(false);
        if (res.warning) setWarn(res.warning);
      }
    });
  }

  function onLink() {
    setErr(null);
    setWarn(null);
    startTransition(async () => {
      const res = await linkLeadToConversation(leadId, conversationId);
      if (!res.ok) setErr(res.error ?? "failed");
      else {
        setLinking(false);
        setConversationId("");
        setWarn(res.warning ?? null);
      }
    });
  }

  if (linking) {
    return (
      <div className="flex flex-col gap-1 items-end">
        <span className="text-[10px] text-muted-foreground text-right w-48">Links locally only. Tenkara messages, drafts, and assignment stay unchanged.</span>
        <input
          value={conversationId}
          onChange={(e) => setConversationId(e.target.value)}
          placeholder="Tenkara conversation UUID"
          className="text-xs border border-border rounded px-2 py-1 bg-background w-48"
          disabled={pending}
        />
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={onLink} disabled={pending || !conversationId.trim()}>{pending ? "…" : "Link"}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setLinking(false); setErr(null); }} disabled={pending}>Cancel</Button>
        </div>
        {err && <span className="text-[10px] text-destructive">{err}</span>}
      </div>
    );
  }

  if (dropping) {
    return (
      <div className="flex flex-col gap-1 items-end">
        {dropDeletesDraft && (
          <span className="text-[10px] text-muted-foreground text-right w-40">
            Also deletes the staged draft in the email app.
          </span>
        )}
        <Select
          size="sm"
          className="w-40"
          ariaLabel="Drop reason"
          value={reason}
          onValueChange={(v) => setReason(v as DropReason)}
          disabled={pending}
          options={DROP_REASONS.map((r) => ({ value: r.value, label: r.label }))}
        />
        {reason === "other" && (
          <input
            type="text"
            placeholder="Note (optional)"
            className="text-xs border border-border rounded px-1 py-0.5 bg-background w-40"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
          />
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="destructive" onClick={onConfirmDrop} disabled={pending}>
            {pending ? "…" : "Confirm drop"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setDropping(false); setErr(null); }} disabled={pending}>
            Cancel
          </Button>
        </div>
        {err && <span className="text-[10px] text-destructive">{err}</span>}
      </div>
    );
  }

  return (
    <div className="flex gap-1 justify-end">
      {canPromote && (
        <Button size="sm" variant="outline" onClick={onPromote} disabled={pending}>
          {pending ? "…" : "Promote"}
        </Button>
      )}
      {!disabled && stage === "enriched" && (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={pending}>
          {pending ? "…" : "Draft outreach now"}
        </Button>
      )}
      {!disabled && (
        <Button size="sm" variant="ghost" onClick={() => setLinking(true)} disabled={pending}>Link thread</Button>
      )}
      {canDrop && (
        <Button size="sm" variant="ghost" onClick={() => setDropping(true)} disabled={pending}>
          Drop
        </Button>
      )}
      {!canPromote && !canDrop && <span className="text-xs text-muted-foreground">—</span>}
      {err && <span className="text-[10px] text-destructive ml-1">{err}</span>}
      {warn && <span className="text-[10px] text-amber-600 ml-1">{warn}</span>}
    </div>
  );
}
