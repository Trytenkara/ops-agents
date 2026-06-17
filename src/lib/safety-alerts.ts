// Safety alerter — DM's Sam when something noteworthy or invariant-breaking happens.
//
// Channels:
//   - SAM_SLACK_DM_ID env: Sam's Slack user/DM id. Falls back to SLACK_ESCALATION_CHANNEL_ID
//     so a misconfig doesn't silently drop alerts; the worst case is a missing env =
//     alert console.error'd and forgotten.
//
// Debounce:
//   - Error-event alerts are debounced per agent per hour via agent_state.
//   - Critical alerts (from_field, tenkara write attempt) bypass the debounce
//     because they should NEVER fire under normal operation.

import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";

const SAM_DM = () => process.env.SAM_SLACK_DM_ID ?? process.env.SLACK_ESCALATION_CHANNEL_ID;
const ERROR_DEBOUNCE_MS = 60 * 60 * 1000; // 1h per agent per error type

type AlertReason =
  | "run_failed"
  | "run_partial"
  | "error_event"
  | "missive_from_field"
  | "tenkara_write_attempt"
  | "export_failed_72h";

async function send(reason: AlertReason, lines: string[], critical = false): Promise<void> {
  const channel = SAM_DM();
  if (!channel) {
    console.error(`[safety-alerts] ${reason} fired but no SAM_SLACK_DM_ID/SLACK_ESCALATION_CHANNEL_ID configured:`, lines.join("\n"));
    return;
  }
  const prefix = critical ? ":rotating_light: *CRITICAL* — " : ":warning: ";
  await postSlackMessage({ channel, text: `${prefix}${lines.join("\n")}` });
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
  await send(reason, [
    `*${opts.agentName}* (${opts.agentSlug}) — ${opts.status.toUpperCase()}`,
    opts.summary ? `> ${opts.summary}` : "(no summary)",
    `Run: ${deepLink(`/agents/runs/${opts.runId}`)}`,
  ]);
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
  await send("error_event", [
    `*${opts.agentName}* (${opts.agentSlug}) — error event`,
    opts.step ? `step: \`${opts.step}\`` : null,
    `> ${opts.message.slice(0, 800)}`,
    `Run: ${deepLink(`/agents/runs/${opts.runId}`)}`,
    `_(debounced 1h per agent)_`,
  ].filter(Boolean) as string[]);
}

// CRITICAL — Missive client tried to POST a draft with from_field set.
// This means an agent constructed an unsafe payload; safety floor compromised.
export async function alertMissiveFromField(detail: string): Promise<void> {
  await send("missive_from_field", [
    "Missive client refused a draft with a non-empty `from_field`. This should never happen.",
    `> ${detail}`,
    "Action: stop the relevant agent immediately and inspect the drafter code.",
  ], true);
}

// CRITICAL — Tenkara client refused a connection that wasn't using the mcp_readonly role.
export async function alertTenkaraWriteAttempt(detail: string): Promise<void> {
  await send("tenkara_write_attempt", [
    "Tenkara client refused a non-readonly connection.",
    `> ${detail}`,
    "Action: audit env vars and code paths that touch Tenkara prod.",
  ], true);
}

export async function alertExportFailed72h(opts: {
  exportId: string;
  supplierName: string | null;
  supplierId: string | null;
  generatedAt: string;
}): Promise<void> {
  await send("export_failed_72h", [
    `Lead Scanner export marked *failed* (no upload confirmation for 72h)`,
    `supplier: ${opts.supplierName ?? opts.supplierId ?? "—"}`,
    `generated: ${opts.generatedAt}`,
    `Re-trigger from ${deepLink("/agents/health")}`,
  ]);
}
