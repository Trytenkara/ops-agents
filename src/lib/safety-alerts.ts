// Safety alerter — says something when a run breaks or an invariant is violated.
//
// Destination: the one ops channel (COMM-06). These used to be a DM to Sam;
// nothing goes to a DM any more.
//
// Timing: a broken run waits for the 18:00 digest like everything else
// (COMM-07). It queues as p1, so it leads the digest. Only the Tenkara
// write attempt still posts on the spot, because it means a read-only
// guarantee has already been violated and every minute of it is worse.
//
// Why this is not live: 73 runs failed or went partial in 24h on 2026-08-19,
// 65 of them one agent. Live-posting that at a 4h debounce is ten-plus
// messages a day for a condition the digest states once, which is exactly the
// noise the consolidation removed.
//
// Debounce:
//   - Error-event alerts are debounced per agent per hour via agent_state,
//     then deduped again by condition in the alert policy.

import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";
import { dispatchAlert } from "@/lib/alert-policy";

const ERROR_DEBOUNCE_MS = 60 * 60 * 1000; // 1h per agent per error type

type AlertReason =
  | "run_failed"
  | "run_partial"
  | "error_event"
  | "tenkara_write_attempt"
  | "export_failed_72h";

// Queued for the daily digest. key identifies the CONDITION (an agent failing),
// not the run, so a chronically broken agent is one digest line a day.
async function queue(
  reason: AlertReason,
  key: string,
  title: string,
  lines: string[],
  digestGroup: string,
): Promise<void> {
  await dispatchAlert(`:warning: ${lines.join("\n")}`, {
    key: `${reason}:${key}`,
    severity: "p1",
    digestGroup,
    title,
  });
}

// Only for a violated invariant. Bypasses the digest deliberately.
async function sendNow(lines: string[]): Promise<void> {
  await postSlackMessage({ text: `:rotating_light: *CRITICAL* — ${lines.join("\n")}` });
}

// agent_state row used for debounce. Stores last alert timestamps per (agent_id, key).
async function shouldFire(agentId: string | null, key: string, windowMs: number): Promise<boolean> {
  if (!agentId) return true;
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_state")
    .select("value")
    .eq("agent_id", agentId)
    .eq("key", key)
    .maybeSingle();
  const lastIso = (data?.value as any)?.last_at as string | undefined;
  if (lastIso) {
    const last = new Date(lastIso).getTime();
    if (Date.now() - last < windowMs) return false;
  }
  await admin
    .from("agent_state")
    .upsert({ agent_id: agentId, key, value: { last_at: new Date().toISOString() } }, { onConflict: "agent_id,key" });
  return true;
}

export async function alertRunFinished(opts: {
  agentId: string;
  agentSlug: string;
  agentName: string;
  runId: string;
  status: "success" | "partial" | "failure";
  summary: string | null;
}): Promise<void> {
  if (opts.status === "success") return;
  const reason: AlertReason = opts.status === "failure" ? "run_failed" : "run_partial";
  // Keyed on the agent, not the run: agent-01 runs every minute, and a broken
  // agent is one fact however many times it re-runs.
  await queue(
    reason,
    opts.agentSlug,
    `${opts.agentName} — ${opts.status.toUpperCase()}: ${opts.summary ?? "no summary"}`.slice(0, 300),
    [
      `*${opts.agentName}* (${opts.agentSlug}) — ${opts.status.toUpperCase()}`,
      opts.summary ? `> ${opts.summary}` : "(no summary)",
      `Run: ${deepLink(`/agents/runs/${opts.runId}`)}`,
    ],
    "Agent runs that broke",
  );
}

export async function alertErrorEvent(opts: {
  agentId: string;
  agentSlug: string;
  agentName: string;
  runId: string;
  message: string;
  step: string | null;
}): Promise<void> {
  const fire = await shouldFire(opts.agentId, "alert_error_event", ERROR_DEBOUNCE_MS);
  if (!fire) return;
  await queue(
    "error_event",
    opts.agentSlug,
    `${opts.agentName} — error: ${opts.message.slice(0, 200)}`,
    [
      `*${opts.agentName}* (${opts.agentSlug}) — error event`,
      opts.step ? `step: \`${opts.step}\`` : null,
      `> ${opts.message.slice(0, 800)}`,
      `Run: ${deepLink(`/agents/runs/${opts.runId}`)}`,
    ].filter(Boolean) as string[],
    "Agent runs that broke",
  );
}

// CRITICAL — Tenkara client refused a connection that wasn't using the mcp_readonly role.
export async function alertTenkaraWriteAttempt(detail: string): Promise<void> {
  await sendNow([
    "Tenkara client refused a non-readonly connection.",
    `> ${detail}`,
    "Action: audit env vars and code paths that touch Tenkara prod.",
  ]);
}

export async function alertExportFailed72h(opts: {
  exportId: string;
  supplierName: string | null;
  supplierId: string | null;
  generatedAt: string;
}): Promise<void> {
  await queue(
    "export_failed_72h",
    opts.exportId,
    `Lead Scanner export failed (no upload for 72h): ${opts.supplierName ?? opts.supplierId ?? "—"}`,
    [
      `Lead Scanner export marked *failed* (no upload confirmation for 72h)`,
      `supplier: ${opts.supplierName ?? opts.supplierId ?? "—"}`,
      `generated: ${opts.generatedAt}`,
      `Re-trigger from ${deepLink("/agents/health")}`,
    ],
    "Lead Scanner exports that failed",
  );
}
