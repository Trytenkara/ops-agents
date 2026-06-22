"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { promoteLead, dropLead } from "@/app/actions/leads";
import { DROP_REASONS, type DropReason } from "@/app/actions/lead-drop-reasons";

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
  const [reason, setReason] = useState<DropReason>("duplicate");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (status !== "active") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const canPromote = !disabled && (stage === "enriched" || (stage === "raw" && hasBlockedReason));
  const canDrop = !disabled && (stage === "raw" || stage === "enriched");

  function onPromote() {
    setErr(null);
    startTransition(async () => {
      const res = await promoteLead(leadId);
      if (!res.ok) setErr(res.error ?? "failed");
    });
  }

  function onConfirmDrop() {
    setErr(null);
    startTransition(async () => {
      const res = await dropLead(leadId, reason, note);
      if (!res.ok) setErr(res.error ?? "failed");
      else setDropping(false);
    });
  }

  if (dropping) {
    return (
      <div className="flex flex-col gap-1 items-end">
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
      {canDrop && (
        <Button size="sm" variant="ghost" onClick={() => setDropping(true)} disabled={pending}>
          Drop
        </Button>
      )}
      {!canPromote && !canDrop && <span className="text-xs text-muted-foreground">—</span>}
      {err && <span className="text-[10px] text-destructive ml-1">{err}</span>}
    </div>
  );
}
