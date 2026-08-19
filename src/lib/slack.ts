// Slack notifier. Token from env. Fails soft so a missing token doesn't
// blow up an API request — the endpoint logs and returns ok:false.
//
// There is ONE destination for everything the fleet says: #op-assistant-agents.
// Callers cannot choose a channel — see COMM-06 in rules/10-communication.md.
// The env var exists only so the channel can be moved without a deploy.

export const OPS_CHANNEL_ID = (): string =>
  process.env.SLACK_OPS_CHANNEL_ID ?? "C0B5M1QCE9E";

interface PostArgs {
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
  const channel = OPS_CHANNEL_ID();
  if (!token) {
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
