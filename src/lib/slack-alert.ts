// Posts an agent alert to the ops Slack channel via the bot. Used when an agent
// needs a human (gap-fill, bounce, etc.). Posts as the bot so it actually
// notifies, unlike posting via a user's connected account.
// Every alert lands in the one ops channel; callers do not choose a destination.
//
// Pass opts.severity + opts.key to route through the alert policy (dedupe by
// condition, rolled into the daily digest). See src/lib/alert-policy.ts. A
// call without them posts live and unconditionally, which is correct only for
// one-off, operator-triggered alerts.

import { dispatchAlert, type AlertSeverity } from "@/lib/alert-policy";
import { OPS_CHANNEL_ID } from "@/lib/slack";

export async function postAgentAlert(
  text: string,
  opts?: {
    mentionUserId?: string;
    mentionUserIds?: string[];
    severity?: AlertSeverity;
    key?: string;
    ttlMinutes?: number;
    digestGroup?: string;
    title?: string;
  }
): Promise<boolean> {
  const ids = [...new Set([opts?.mentionUserId, ...(opts?.mentionUserIds ?? [])].filter(Boolean))] as string[];

  if (opts?.severity && opts.key) {
    const outcome = await dispatchAlert(text, {
      key: opts.key,
      severity: opts.severity,
      ttlMinutes: opts.ttlMinutes,
      mentionUserIds: ids,
      digestGroup: opts.digestGroup,
      title: opts.title,
    });
    return outcome !== "suppressed";
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = OPS_CHANNEL_ID();
  if (!token) return false;
  const body = ids.length ? `${ids.map((id) => `<@${id}>`).join(" ")} ${text}` : text;
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text: body }),
    });
    const j = (await r.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}
