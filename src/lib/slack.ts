// Slack notifier. Token + channel from env. Fails soft so a missing token doesn't
// blow up an API request — the endpoint logs and returns ok:false.

interface PostArgs {
  channel?: string;
  text: string;
  blocks?: any[];
}

interface PostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

export async function postSlackMessage(args: PostArgs): Promise<PostResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = args.channel ?? process.env.SLACK_ESCALATION_CHANNEL_ID;
  if (!token || !channel) {
    return { ok: false, error: "slack_not_configured" };
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text: args.text, blocks: args.blocks }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) return { ok: false, error: data.error ?? `http_${res.status}` };
  return { ok: true, ts: data.ts };
}

export function deepLink(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
