import { getTenkaraConversationMessages } from "@/lib/tenkara";

// The prior conversation, rendered for a model prompt.
//
// Two bugs this module exists to make impossible:
//
//  1. The inbound reply path built the transcript oldest-first and then did
//     `.slice(0, 8000)`, a HEAD slice. On a long thread that throws away the
//     most recent messages, the exact ones the reply must answer, while the
//     prompt still announced "Full thread so far". Trimming is now
//     newest-preserving: oldest messages drop first and the omission is stated
//     in the text the model reads.
//  2. The fetch was wrapped in a bare `catch {}`, so a Tenkara outage silently
//     produced a context-free draft with nothing recorded. Loading now reports
//     its failure to the caller instead of returning a bare null.

const PER_MESSAGE_CHARS = 1200;
const TOTAL_CHARS = 8000;

export interface ThreadMessageLike {
  sent_at?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  body_text?: string | null;
}

// Oldest first (a model reads a conversation in order), but when the budget is
// tight the OLDEST messages are the ones dropped.
export function renderThreadContext(
  messages: ThreadMessageLike[],
  totalChars: number = TOTAL_CHARS
): string | null {
  if (!messages.length) return null;
  const rendered = messages.map(
    (m) =>
      `[${m.sent_at ?? "?"}] ${m.from_name || m.from_email || "?"}: ${(m.body_text ?? "")
        .trim()
        .slice(0, PER_MESSAGE_CHARS)}`
  );

  const kept: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = rendered[i].length + 2;
    if (used + cost > totalChars && kept.length) break;
    kept.unshift(rendered[i]);
    used += cost;
  }

  const dropped = rendered.length - kept.length;
  const header = dropped > 0 ? `[${dropped} earlier message(s) omitted for length]\n\n` : "";
  return header + kept.join("\n\n");
}

export interface ThreadContextResult {
  // Null means there is genuinely no prior conversation, OR the load failed.
  // `ok` is what tells the two apart, so a caller can never mistake an outage
  // for a first-contact thread.
  text: string | null;
  ok: boolean;
  error?: string;
}

export async function loadThreadContext(conversationId: string | null | undefined): Promise<ThreadContextResult> {
  if (!conversationId || conversationId.startsWith("blocked:")) return { text: null, ok: true };
  try {
    const messages = await getTenkaraConversationMessages(conversationId);
    return { text: renderThreadContext(messages as ThreadMessageLike[]), ok: true };
  } catch (e: any) {
    return { text: null, ok: false, error: e?.message ?? String(e) };
  }
}
