import Anthropic from "@anthropic-ai/sdk";
import { classifyFailure } from "@/lib/retry-verdict";

// No supplier-facing email may ignore what the supplier already said.
//
// Three drafters (the no-reply nudge, the stalled-thread chase, the call
// follow-up) were fixed string templates with no model call and no sight of the
// conversation, so a chase re-asked for price, pack size, lead time and MOQ on a
// thread where the supplier had already answered all four in prose. Telling each
// drafter to "read the thread" is the spot fix; every new drafter would have to
// remember. So the pass lives at the staging chokepoint instead, and applies to
// any draft that goes into an existing conversation.
//
// Deliberately narrow. The model may only DROP an ask the thread already
// answers and adjust the wording around it. It may not add facts, numbers,
// commitments, contacts, or a new ask. Anything unexpected in the response and
// we keep the original body, because a template that repeats itself is a much
// smaller failure than a draft that invents.

const MODEL = "claude-sonnet-4-5";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface TailorInput {
  body: string;
  threadContext: string;
}

export interface TailorResult {
  body: string;
  tailored: boolean;
  reason?: string;
  attempts?: number;
}

// PERS-01: a transport failure earns another attempt, it is not an answer.
// PERS-04: this run is bounded, so the bound is named here and in the rules.
// Three attempts inside the staging request; a still-failing draft is staged
// UNTAILORED AND FLAGGED (needsTailorRetry) rather than silently shipped, so
// the sweep can pick it up on a later run. Bounding attempts inside one run is
// a spend control on a synchronous request, not a verdict on the work.
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SYSTEM = `You adjust an already-written supplier email so it does not ask for information the supplier has already provided earlier in the conversation.

Rules, in priority order:
1. Never add a fact, price, quantity, date, commitment, company name, person, phone number or email address. You may only remove or rephrase what is already in the draft.
2. Remove any request for information the thread shows the supplier already gave. If they gave part of it, keep the ask for the missing part only.
3. If the supplier's most recent message asks us something or raises a concern, you may add ONE short sentence acknowledging it. Do not answer it with invented detail.
4. Do not mention internal state: call attempts, voicemails, how many follow-ups have been sent, dates or times of our own activity.
5. Never use the term RFQ (say sourcing inquiry) and never use an em dash or en dash.
6. Keep it the same length or shorter, same greeting, same sign-off, same plain-text formatting.
7. If nothing in the draft needs to change, return it unchanged.

Return ONLY the email body text. No preamble, no explanation, no markdown fences.`;

// Guardrail on the model's output. A tailored body that grows, empties, or
// starts talking about itself is discarded in favour of the original.
function acceptable(original: string, candidate: string): boolean {
  const c = candidate.trim();
  if (c.length < 40) return false;
  if (c.length > original.length + 200) return false;
  if (/^(here|sure|certainly|i've|i have|revised|updated)\b/i.test(c)) return false;
  if (/```/.test(c)) return false;
  return true;
}

export async function tailorToThread(input: TailorInput): Promise<TailorResult> {
  const { body, threadContext } = input;
  if (!threadContext.trim()) return { body, tailored: false, reason: "no_thread_context" };
  if (!process.env.ANTHROPIC_API_KEY) return { body, tailored: false, reason: "no_api_key" };

  let lastReason = "unknown";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await anthropic().messages.create({
        model: MODEL,
        max_tokens: 1200,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `Conversation so far (oldest first):\n\n${threadContext}\n\n---\n\nDraft email to adjust:\n\n${body}`,
          },
        ],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      // A rejected rewrite is a verdict about the OUTPUT, not the attempt: the
      // model answered, we declined its answer. Retrying is not going to make a
      // hallucinating rewrite acceptable, so this one does not loop.
      if (!acceptable(body, text)) {
        return { body, tailored: false, reason: "rejected_by_guardrail", attempts: attempt + 1 };
      }
      return { body: text, tailored: true, attempts: attempt + 1 };
    } catch (e: any) {
      const verdict = classifyFailure(e, { attempt, maxAttempts: MAX_ATTEMPTS });
      lastReason = verdict.reason;
      if (verdict.verdict === "terminal") {
        return { body, tailored: false, reason: `terminal: ${verdict.reason}`, attempts: attempt + 1 };
      }
      if (attempt < MAX_ATTEMPTS - 1) await sleep(Math.min(verdict.backoffMs, 4000));
    }
  }
  return { body, tailored: false, reason: `retryable_exhausted: ${lastReason}`, attempts: MAX_ATTEMPTS };
}

// A draft staged without tailoring because the ATTEMPT failed (not because the
// rewrite was declined, and not because there was nothing to tailor against).
// These are the ones a later sweep should redraft.
export function needsTailorRetry(note: { tailored?: boolean; reason?: string | null } | null | undefined): boolean {
  if (!note || note.tailored) return false;
  const r = note.reason ?? "";
  return r.startsWith("retryable_exhausted") || r === "thread_context_unavailable";
}
