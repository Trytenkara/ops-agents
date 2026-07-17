"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Bug } from "lucide-react";

// Global "Report Issue" button. Captures the page the operator is on and files a
// real-time bug report; the agent triages it (auto-fixes trivial UI, opens a
// PR for anything backend, bounces feature requests). Intentionally scoped to
// bugs, not feature requests — the copy nudges toward that.
export function ReportIssue() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setDescription("");
    setState("idle");
    setErrMsg(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function submit() {
    if (title.trim().length < 3 || description.trim().length < 1) return;
    setState("sending");
    setErrMsg(null);
    const orgSlug = pathname.match(/\/work\/orgs\/([^/]+)/)?.[1];
    const res = await fetch("/api/report-issue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        description: description.trim(),
        page_path: pathname,
        org_slug: orgSlug,
      }),
    }).catch(() => null);

    if (res?.ok) {
      setState("done");
    } else {
      setState("error");
      setErrMsg("Could not send — try again in a moment.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Report an issue"
        aria-label="Report an issue"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground hover:border-accent"
      >
        <Bug className="h-[18px] w-[18px]" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24"
          onClick={close}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {state === "done" ? (
              <div className="space-y-3">
                <div className="text-sm font-medium">Thanks — the agent is on it.</div>
                <p className="text-xs text-muted-foreground">
                  Small UI fixes go live automatically; anything deeper comes back as a PR for
                  review. Watch <span className="font-medium">#control-room-feedback</span> for
                  updates.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-semibold">Report an issue</div>
                  <p className="text-xs text-muted-foreground">
                    For bugs and small fixes on this page — not large feature requests. The agent
                    triages it in real time.
                  </p>
                </div>
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What's wrong? (short summary)"
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  placeholder="What did you expect vs. what happened? Steps to reproduce help."
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="text-[11px] text-muted-foreground">
                  Reporting from <span className="font-mono">{pathname}</span>
                </div>
                {errMsg && <div className="text-xs text-destructive">{errMsg}</div>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={state === "sending" || title.trim().length < 3 || description.trim().length < 1}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {state === "sending" ? "Sending…" : "Send report"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
