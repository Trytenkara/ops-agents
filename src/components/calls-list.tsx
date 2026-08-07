"use client";

import { useEffect, useState, useTransition } from "react";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { logCallAttempt, addSupplierPhoneToCase, deescalateCallCase, dropSupplierFromCallCase } from "@/app/actions/cases";
import { CALL_OUTCOMES, type CallOutcome, type CallBrief, type CallAttempt } from "@/lib/call-brief";
import { zoneOffsetMinutes, isWithinWindow, shiftRangeLabel } from "@/lib/call-window";

export type CallCaseRow = {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  status: string;
  createdAt: string | null;
  assignedName: string | null;
  assignedEmail: string | null;
  assignedRole: string | null;
  materialName: string | null;
  callStage: number;
  reason: string | null;
  threadId: string | null;
  draftId: string | null;
  brief: CallBrief | null;
  recommendedAction: string | null;
  callLog: CallAttempt[];
};

// The supplier's business hours expressed in the timezone of whoever is looking
// at the screen. Rendering this server-side would have to guess the operator's
// zone; the browser knows it, so the conversion happens here.
function viewerWindow(brief: CallBrief): { label: string; viewerZone: string } | null {
  if (!brief.window.timezone) return null;
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const delta = (zoneOffsetMinutes(viewerZone, now) - zoneOffsetMinutes(brief.window.timezone, now)) / 60;
  return { label: shiftRangeLabel(brief.window.startHour, brief.window.endHour, delta), viewerZone };
}

function supplierClock(timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit", weekday: "short" }).format(
    new Date()
  );
}

function CallWindowBlock({ brief }: { brief: CallBrief }) {
  // Rendered only after mount: the supplier's current local time depends on the
  // browser clock, and rendering it on the server produces a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const tz = brief.window.timezone;
  if (!tz) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">When to call</div>
        <div>{brief.window.note ?? "Calling window unknown."}</div>
      </div>
    );
  }

  const viewer = mounted ? viewerWindow(brief) : null;
  const open = mounted ? isWithinWindow(tz) : false;

  return (
    <div className="rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">When to call</span>
        {mounted && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              open ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-secondary text-muted-foreground"
            }`}
          >
            {open ? "Open now" : "Closed now"}
          </span>
        )}
      </div>
      <div className="mt-1 text-muted-foreground">
        {viewer ? (
          <>
            <span className="text-foreground font-medium">{viewer.label}</span> your time ({viewer.viewerZone})
          </>
        ) : (
          <span className="text-foreground font-medium">{brief.window.localLabel}</span>
        )}
      </div>
      <div className="text-muted-foreground">
        {brief.window.localLabel} in {tz}
        {mounted ? `, now ${supplierClock(tz)} there` : ""}
      </div>
      {brief.window.note && <div className="mt-1 text-amber-700 dark:text-amber-500">{brief.window.note}</div>}
    </div>
  );
}

function PhoneBlock({ row }: { row: CallCaseRow }) {
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const known = row.brief?.contact.phone ?? null;

  if (known) {
    return (
      <div>
        <div className="text-xs text-muted-foreground">Call this number</div>
        <a href={`tel:${known.replace(/[^\d+]/g, "")}`} className="text-lg font-semibold tracking-tight text-primary hover:underline">
          {known}
        </a>
        <div className="text-xs text-muted-foreground">
          {row.brief?.contact.name ? `${row.brief.contact.name}, ` : ""}
          {row.brief?.contact.email ?? "no email on file"}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-500">No phone number on file</div>
      <div className="flex items-center gap-2">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 555 123 4567"
          className="w-48 rounded-md border border-border px-2 py-1 text-xs"
        />
        <button
          type="button"
          disabled={pending || !phone.trim()}
          onClick={() => {
            setErr(null);
            start(async () => {
              const r = await addSupplierPhoneToCase(row.id, phone);
              if (!r.ok) setErr(r.error);
              else setPhone("");
            });
          }}
          className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          {pending ? "…" : "Save number"}
        </button>
      </div>
      {row.brief?.supplierWebsite && (
        <a
          href={row.brief.supplierWebsite}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary underline hover:no-underline"
        >
          Open their site to find one
        </a>
      )}
      {err && <div className="text-xs text-destructive">{err}</div>}
    </div>
  );
}

function OutcomeButtons({ row }: { row: CallCaseRow }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium">Log the outcome</div>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What they said (optional)"
        className="w-full rounded-md border border-border px-2 py-1 text-xs"
      />
      <div className="flex flex-wrap gap-2">
        {(Object.keys(CALL_OUTCOMES) as CallOutcome[]).map((outcome) => (
          <button
            key={outcome}
            type="button"
            disabled={pending}
            onClick={() => {
              setErr(null);
              start(async () => {
                const r = await logCallAttempt(row.id, outcome, note);
                if (!r.ok) setErr(r.error);
                else setNote("");
              });
            }}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {CALL_OUTCOMES[outcome].label}
          </button>
        ))}
      </div>
      {err && <div className="text-xs text-destructive">{err}</div>}
    </div>
  );
}

// Why the task was raised, in the words an operator would use. Falls back to the
// raw code so a reason added later still shows something rather than nothing.
const REASON_LABEL: Record<string, string> = {
  scheduled_intro_call: "Scheduled intro call, the day after the inquiry went out",
  scheduled_intro_call_replied: "Scheduled intro call, they already replied by email",
  no_reply_after_followups: "No reply to the inquiry or the follow-ups",
};

// The two ways a call task ends other than by outcome: hand the supplier back to
// the email cadence, or drop them for good. Both take notes, because the next
// person to look at this supplier has only what was written here.
function ClosingActions({ row }: { row: CallCaseRow }) {
  const [open, setOpen] = useState<"back" | "drop" | null>(null);
  const [results, setResults] = useState<Record<string, "success" | "failure">>({});
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const stages = Array.from({ length: Math.max(row.callStage, 1) }, (_, i) => String(i + 1));

  function reset() {
    setOpen(null);
    setResults({});
    setNote("");
    setErr(null);
  }

  return (
    <div className="space-y-2 border-t pt-3">
      {open === null ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen("back")}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            Send back to the email loop
          </button>
          <button
            type="button"
            onClick={() => setOpen("drop")}
            className="rounded-md border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            Drop this supplier
          </button>
        </div>
      ) : open === "back" ? (
        <div className="space-y-2">
          <div className="text-xs font-medium">Send back to the email loop</div>
          <p className="text-xs text-muted-foreground">
            The follow-up emails start again from where they stopped. Mark how each call went first.
          </p>
          <div className="flex flex-wrap gap-4">
            {stages.map((stage) => (
              <div key={stage} className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">Call {stage}</span>
                {(["success", "failure"] as const).map((v) => (
                  <label key={v} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={results[stage] === v}
                      disabled={pending}
                      onChange={() =>
                        setResults((r) => {
                          const next = { ...r };
                          if (next[stage] === v) delete next[stage];
                          else next[stage] = v;
                          return next;
                        })
                      }
                    />
                    <span className={results[stage] === v ? "" : "text-muted-foreground"}>{v}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened, and what the email side should know"
            rows={2}
            className="w-full rounded-md border border-border px-2 py-1 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setErr(null);
                start(async () => {
                  const r = await deescalateCallCase(row.id, { callResults: results, note });
                  if (!r.ok) setErr(r.error ?? "failed");
                  else reset();
                });
              }}
              className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
            >
              {pending ? "Sending..." : "Send back"}
            </button>
            <button type="button" disabled={pending} onClick={reset} className="rounded-md border border-border px-2 py-1 text-xs">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs font-medium text-destructive">Drop this supplier</div>
          <p className="text-xs text-muted-foreground">
            Use this when they never came back, by email or by phone. The lead stops being worked and no further emails go
            out.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why they are being dropped (required)"
            rows={2}
            className="w-full rounded-md border border-border px-2 py-1 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending || !note.trim()}
              onClick={() => {
                setErr(null);
                start(async () => {
                  const r = await dropSupplierFromCallCase(row.id, note);
                  if (!r.ok) setErr(r.error ?? "failed");
                  else reset();
                });
              }}
              className="rounded-md bg-destructive px-2 py-1 text-xs text-destructive-foreground disabled:opacity-50"
            >
              {pending ? "Dropping..." : "Drop supplier"}
            </button>
            <button type="button" disabled={pending} onClick={reset} className="rounded-md border border-border px-2 py-1 text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <div className="text-xs text-destructive">{err}</div>}
    </div>
  );
}

function CallCard({ row }: { row: CallCaseRow }) {
  const brief = row.brief;

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider">
              Call {row.callStage}
            </span>
            <span className="font-medium">{row.supplierName ?? row.supplierId ?? "Unknown supplier"}</span>
            {row.materialName && <span className="text-sm text-muted-foreground">for {row.materialName}</span>}
          </div>
          <div className="text-xs text-muted-foreground">
            {REASON_LABEL[row.reason ?? ""] ?? "Call this supplier"}, raised {relativeTime(row.createdAt)}
            {row.status === "in_progress" ? ", attempted" : ""}
            {brief?.country ? `, ${brief.country}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <OperatorChip name={row.assignedName} email={row.assignedEmail} role={row.assignedRole} />
          {row.draftId && (
            <a href={`/work/drafts/${row.draftId}`} className="text-xs text-primary underline hover:no-underline">
              Read the emails
            </a>
          )}
        </div>
      </div>

      {!brief ? (
        <p className="text-sm text-muted-foreground">{row.recommendedAction ?? "Call this supplier."}</p>
      ) : (
        <>
          {brief.materialNames.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Quoting:</span> {brief.materialNames.join(", ")}
              {brief.requiredGrade ? `, ${brief.requiredGrade} grade` : ""}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <PhoneBlock row={row} />
            <CallWindowBlock brief={brief} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs font-medium">Why we are calling</div>
              <p className="mt-1 text-xs text-muted-foreground">{brief.purpose}</p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {brief.context.map((line, i) => (
                  <li key={i}>• {line}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium">What to ask for</div>
              <ol className="mt-1 space-y-1 text-xs text-muted-foreground">
                {brief.asks.map((line, i) => (
                  <li key={i}>
                    {i + 1}. {line}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}

      {row.callLog.length > 0 && (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Attempts:</span>{" "}
          {row.callLog
            .map((a) => `${CALL_OUTCOMES[a.outcome]?.label ?? a.outcome} ${relativeTime(a.at)}${a.note ? ` (${a.note})` : ""}`)
            .join("; ")}
        </div>
      )}

      <OutcomeButtons row={row} />
      <ClosingActions row={row} />
    </div>
  );
}

export function CallsList({ rows }: { rows: CallCaseRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Calls to make ({rows.length})
      </div>
      <p className="text-xs text-muted-foreground">
        Call 1 is the intro call, made the day after the sourcing inquiry goes out while it is still fresh. Call 2 comes
        five days in, and only for suppliers who never wrote back.
      </p>
      {rows.map((r) => (
        <CallCard key={r.id} row={r} />
      ))}
    </div>
  );
}
