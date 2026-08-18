"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Plain-English versions of the drafter's own outcome strings, so an operator who
// presses the button and gets nothing knows why.
const REASONS: Record<string, string> = {
  no_supplier_message: "No supplier message on this thread yet.",
  thread_unreadable: "Could not read the thread in the email app.",
  rate_limited: "The email app is rate limiting us. Try again in a minute.",
  no_draft: "The drafter had nothing to say to this message.",
  org_not_found: "This thread is not linked to a client.",
  deduped: "A reply to the supplier's latest message already exists in the email app.",
  already_bounced: "This address bounced, so no reply was written.",
  extract_only: "Read the attachments and captured pricing; no reply needed.",
  max_reply_turns: "This conversation hit its automatic reply limit and needs a human.",
  no_anthropic_key: "The writing service is not configured. Tell engineering.",
  recorded_unmatched: "Filed for triage: this message is not matched to a supplier thread.",
  unmatched_bounce: "This is a bounce notice, not a supplier reply.",
  error: "The email app rejected the draft. Try again, then tell engineering.",
  threw: "Something failed while drafting. Try again, then tell engineering.",
};

// Manual "draft a reply now" for a supplier reply the agent left undrafted.
export function DraftReplyNowButton({ threadId, onDone }: { threadId: string; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="inline-flex items-center gap-2">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setErr(null);
            setMsg(null);
            const res = await fetch(`/api/threads/${threadId}/redraft`, { method: "POST" });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) {
              setErr(body.error ?? `failed (${res.status})`);
              return;
            }
            if (body.drafted) {
              setMsg("Reply drafted in the email app.");
              router.refresh();
              onDone?.();
            } else {
              setMsg(REASONS[body.reason] ?? `Nothing drafted: ${body.reason}`);
            }
          })
        }
      >
        {pending ? "Drafting…" : "Draft a reply now"}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
