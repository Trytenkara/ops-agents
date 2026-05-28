// Inline signal chips for draft_references rows.
//   - reply_detected (Agent 08) → green "↩ replied" badge
//   - qa_findings (Agent 10) → color-coded by max severity
// Both consume `draft_references.metadata`; safe to render anywhere a draft row appears.

import { cn } from "@/lib/utils";

type Finding = { severity?: string; code?: string; message?: string } | string;

interface Props {
  metadata?: Record<string, any> | null;
  className?: string;
}

const SEV_CLASS: Record<string, string> = {
  error: "bg-destructive/15 text-destructive",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  info: "bg-secondary text-secondary-foreground",
};

export function DraftSignals({ metadata, className }: Props) {
  if (!metadata) return null;
  const replyDetected = metadata.reply_detected;
  const findings: Finding[] = Array.isArray(metadata.qa_findings) ? metadata.qa_findings : [];

  // Determine max severity for the QA badge.
  let maxSev: string = "info";
  for (const f of findings) {
    const sev = typeof f === "string" ? "info" : (f.severity ?? "info");
    if (sev === "error") { maxSev = "error"; break; }
    if (sev === "warn" || sev === "warning") maxSev = "warn";
  }
  const qaClass = SEV_CLASS[maxSev] ?? SEV_CLASS.info;
  const qaTitle = findings
    .map((f) => (typeof f === "string" ? f : `${f.severity ?? "info"}: ${f.code ?? ""} — ${f.message ?? ""}`))
    .join("\n");

  if (!replyDetected && findings.length === 0) return null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {replyDetected && (
        <span
          title={replyDetected.detected_at ? `Reply detected ${replyDetected.detected_at}` : "Reply detected"}
          className="inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        >
          ↩ replied
        </span>
      )}
      {findings.length > 0 && (
        <span
          title={qaTitle}
          className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", qaClass)}
        >
          QA · {findings.length}
        </span>
      )}
    </span>
  );
}
