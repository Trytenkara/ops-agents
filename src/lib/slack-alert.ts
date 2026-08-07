// Posts an agent alert to the ops Slack channel via the bot. Used when an agent
// needs a human (gap-fill, bounce, etc.). Posts as the bot so it actually
// notifies, unlike posting via a user's connected account.
// Pass opts.channel to target a specific channel; otherwise falls back to the
// SLACK_ESCALATION_CHANNEL_ID default.
export async function postAgentAlert(
  text: string,
  opts?: { mentionUserId?: string; mentionUserIds?: string[]; channel?: string }
): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = opts?.channel ?? process.env.SLACK_ESCALATION_CHANNEL_ID;
  if (!token || !channel) return false;
  const ids = [...new Set([opts?.mentionUserId, ...(opts?.mentionUserIds ?? [])].filter(Boolean))] as string[];
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
