import Anthropic from "@anthropic-ai/sdk";
import { sanitizeDraft } from "@/lib/email-style";

// Voice anchored to the team's Notion "EMAIL 1 / EMAIL 2 / EMAIL 6" templates.
// Every paragraph stands alone with a blank line above and below. No em dashes.
// Sign-off is always: "Thanks," / blank line / "Procurement Team" / "{Org}".

const STYLE_ANCHOR = `REFERENCE VOICE (real examples from our workflow guide — match this tone exactly):

Example A (initial outreach):
  Hi The Green Labs,
  ${""}
  We are expanding our supplier network at Bobber Labs and are looking for Organic Barley.
  ${""}
  Do you supply this? If so, could you kindly share current pricing, estimated lead times, and MOQs?
  ${""}
  We may have follow-up questions as we go along. Quick responses are always appreciated.
  ${""}
  Thanks,
  ${""}
  Procurement Team
  Bobber Labs

Example B (a check-in / follow-up):
  Hi Herbal Creations Team,
  ${""}
  Bumping this up one more time from my email on January 20.
  ${""}
  No worries if this isn't something you can help with. We'd just appreciate a quick note either way so we can close the loop.
  ${""}
  Thanks,
  ${""}
  Procurement Team
  Bobber Labs`;

const SYSTEM_BASE = `You are writing a supplier outreach email asking them to re-validate a quote (or set of quotes) we have on file that are past their reanalyze date.

Write it like a human sourcing coordinator wrote it from scratch. Warm, lightly informal, professional. Every email should read uniquely.

${STYLE_ANCHOR}

STYLE RULES (non-negotiable):
- First-name basis when we know it. Otherwise "Hi {Company} Team,".
- EVERY thought is its own paragraph with a blank line above and below it. Do not chain ideas in one block.
- Sentences stay short. Whole body under 130 words.
- Tone is hopeful and non-accusatory. We're keeping records fresh, not complaining.
- Sign-off ALWAYS exactly:
    Thanks,
    ${""}
    Procurement Team
    {sender org on its own line}
- NEVER use em dashes (—) or en dashes (–). Use commas, periods, or "and" instead.
- NEVER use phrases like "I hope this email finds you well", "Per our records", "I am reaching out to", "In conclusion", "Please don't hesitate", "circle back", "touch base", "jump on a call", "hop on a quick call", "schedule a meeting".
- NEVER fabricate prior conversations, relationships, or call references.

WHEN PREV PRICING / LEAD TIME IS PROVIDED:
- Mention it naturally (inline for one material, in a clean bullet list for 2+) and ask if it's still the same.

FORMATTING:
- Multiple materials (2+): one short intro paragraph, then a clean bullet list (one per line) with prev pricing/lead time + last-quote date, then the ask, then sign-off. Blank line between every section.
- Single material: brief paragraph mentioning the prev pricing inline. No bullet list.

OUTPUT: respond with a JSON object exactly matching this schema:
{
  "subject": "<short, friendly subject line, no em dashes>",
  "body": "<full email body with the exact sign-off block above>"
}`;

export interface DraftPayload {
  subject: string;
  body: string;
}

export interface DraftUsage {
  inputTokens: number;
  outputTokens: number;
}

function systemPromptFor(mode: "active" | "ghost", clientName: string, ghostBrand?: string): string {
  if (mode === "active") {
    return SYSTEM_BASE + `

SIGN-OFF FOR THIS EMAIL (use exactly this format, blank lines included):
Thanks,

Procurement Team
${clientName}`;
  }
  return SYSTEM_BASE + `

SIGN-OFF FOR THIS EMAIL (use exactly this format, blank lines included):
Thanks,

Procurement Team
${ghostBrand}

IMPORTANT: Do NOT name the underlying client (${clientName}) anywhere in the email body or subject.`;
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const MODEL = "claude-opus-4-5";  // Opus 4.5 — closest currently-supported family member to Opus 4.7 named in the original spec

export async function generateRevalidationEmail(opts: {
  mode: "active" | "ghost";
  clientName: string;
  ghostBrand?: string;
  userMessage: string;
}): Promise<{ draft: DraftPayload; usage: DraftUsage }> {
  const system = systemPromptFor(opts.mode, opts.clientName, opts.ghostBrand);
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: opts.userMessage }],
  });
  // First text block, parse the JSON object out of it.
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  const parsed = extractJsonObject(text);
  if (!parsed.subject || !parsed.body) {
    throw new Error(`Anthropic response missing subject/body. Raw text: ${text.slice(0, 400)}`);
  }
  return {
    draft: sanitizeDraft({ subject: String(parsed.subject), body: String(parsed.body) }),
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
  };
}

function extractJsonObject(text: string): any {
  // Accept either a bare JSON object or one wrapped in fences.
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  // Find the first { ... } span.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function formatUserMessage(group: {
  client_org_name: string;
  supplier_name: string;
  supplier_contact_name: string | null;
  rows: Array<{
    material_name: string;
    grade: any[] | null;
    quote_date: string | null;
    price: number | null;
    lead_time_days: number | null;
  }>;
}, mode: "active" | "ghost", ghostBrand: string | undefined): string {
  const materials = group.rows;
  const signoff = mode === "ghost"
    ? `${mode} (sign as ${ghostBrand} Sourcing)`
    : `${mode} (sign as ${group.client_org_name} Purchasing Team)`;
  const lines = [
    `Supplier company: ${group.supplier_name}`,
    `Supplier contact: ${group.supplier_contact_name ?? "—"}`,
    `Number of materials to re-validate: ${materials.length}`,
    `Classification mode: ${signoff}`,
    "",
    "Materials with last-quote date (and prev pricing / lead time if known):",
  ];
  for (const r of materials) {
    const qd = r.quote_date ? new Date(r.quote_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "unknown";
    const extras: string[] = [];
    if (r.price != null) extras.push(`prev $${r.price.toFixed(2)}`);
    if (r.lead_time_days != null) extras.push(`${r.lead_time_days}-day lead`);
    const suffix = extras.length ? ` [${extras.join(", ")}]` : "";
    const gradeStr = gradeToString(r.grade);
    const label = gradeStr ? `${r.material_name} (${gradeStr})` : r.material_name;
    lines.push(`  - ${label}, last quoted ${qd}${suffix}`);
  }
  return lines.join("\n") + "\n\nWrite the email.";
}

export function gradeToString(grade: any): string {
  if (!Array.isArray(grade)) return "";
  return grade.map((g) => (g && typeof g === "object" ? g.grade_name : null)).filter(Boolean).join(", ");
}
