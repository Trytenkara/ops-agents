import Anthropic from "@anthropic-ai/sdk";
import type { OutreachMode } from "../quote-revalidation/config";
import { sanitizeDraft } from "@/lib/email-style";
import { correctMaterialSpelling } from "@/lib/material-spelling";

// The initial RFQ. Language is generated per-email by the model so a campaign
// isn't a wall of identical copy (ops flagged the repeated template). The
// deterministic template below (composeTemplateDraft) is the fallback when the
// model call fails, so a staged draft is never blocked on the API.
//
// Voice mirrors the Bobber Labs / Notion "EMAIL 1: Initial RFQ" workflow: short
// paragraphs separated by blank lines, conversational tone, no em dashes,
// catalog ask, "Procurement Team / {Org}" sign-off.

export interface DraftMaterial {
  name: string;
  inciName?: string | null;
}

export interface DraftInput {
  mode: OutreachMode; // 'active' | 'ghost'
  ghostBrand?: string;
  clientOrgName: string;
  supplierContactName: string | null;
  supplierCompanyName?: string | null;
  materialName: string;
  inciName: string | null;
  // When set (>1 entry), the email is consolidated: one RFQ listing every
  // material we're sourcing from this supplier. Single-material callers can keep
  // passing materialName/inciName and omit this.
  materials?: DraftMaterial[];
  signal: string | null; // how we found them — kept for telemetry, no longer changes copy
  isMarketplace?: boolean; // marketplace supplier → ask for bulk/wholesale pricing beyond listed retail
}

export interface ComposedDraft {
  subject: string;
  body: string;
}

function greeting(contactName: string | null, supplierCompany: string | null | undefined): string {
  if (contactName) {
    const first = contactName.trim().split(/\s+/)[0];
    return `Hi ${first},`;
  }
  if (supplierCompany) return `Hi ${supplierCompany.trim()} Team,`;
  return "Hi there,";
}

// Subject variation: ops flagged that every outreach used an identical subject.
// Vary it deterministically by a stable hash of the recipient + material, so a
// campaign isn't a wall of identical subjects, while staying idempotent (the
// same draft re-renders to the same subject).
const SUBJECT_TEMPLATES: ((m: string) => string)[] = [
  (m) => `Sourcing inquiry: ${m}`,
  (m) => `${m} — pricing and availability?`,
  (m) => `Do you supply ${m}?`,
  (m) => `Quote request: ${m}`,
  (m) => `Looking for a ${m} supplier`,
  (m) => `${m}: current pricing and MOQ?`,
  (m) => `RFQ — ${m}`,
];

// Consolidated emails cover several materials, so the subject can't name one.
// Keep it generic but still varied so a campaign isn't a wall of identical subjects.
const MULTI_SUBJECT_TEMPLATES: string[] = [
  "Sourcing inquiry",
  "Wholesale pricing request",
  "Supplier inquiry: pricing and availability",
  "Quote request for several materials",
  "RFQ — multiple raw materials",
];

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Normalize to the list of materials this email covers. Consolidated callers
// pass `materials`; single-material callers still pass materialName/inciName.
// Every name is run through correctMaterialSpelling here — the single chokepoint
// feeding the subject, the LLM prompt, and the template — so a known typo can
// never reach a drafted email.
function materialList(input: DraftInput): DraftMaterial[] {
  const raw = (input.materials ?? []).filter((m) => m.name && m.name.trim());
  const list = raw.length ? raw : [{ name: input.materialName, inciName: input.inciName }];
  return list.map((m) => ({ ...m, name: correctMaterialSpelling(m.name) }));
}

function labelFor(m: DraftMaterial): string {
  return m.inciName ? `${m.name} (INCI: ${m.inciName})` : m.name;
}

function pickSubject(input: DraftInput): string {
  const mats = materialList(input);
  const seed = `${input.supplierCompanyName ?? input.supplierContactName ?? ""}|${mats.map((m) => m.name).join(",")}`;
  if (mats.length > 1) {
    return MULTI_SUBJECT_TEMPLATES[stableHash(seed) % MULTI_SUBJECT_TEMPLATES.length];
  }
  const tpl = SUBJECT_TEMPLATES[stableHash(seed) % SUBJECT_TEMPLATES.length];
  return tpl(mats[0].name);
}

function composeTemplateDraft(input: DraftInput): ComposedDraft {
  const senderOrg = input.mode === "ghost" ? input.ghostBrand! : input.clientOrgName;
  const mats = materialList(input);
  const multi = mats.length > 1;

  const subject = pickSubject(input);

  // Single material reads as a sentence; multiple materials read as a bulleted
  // list so the supplier can quote each line item.
  const bulletBlock = multi ? ["", ...mats.map((m) => `- ${labelFor(m)}`), ""] : [""];

  const body = (
    input.isMarketplace
      ? [
          // Marketplace supplier: they have public/listed retail pricing, so we
          // ask for the bulk/wholesale tier and volume breaks beyond the listing.
          greeting(input.supplierContactName, input.supplierCompanyName),
          "",
          multi
            ? `We are sourcing the following raw materials at ${senderOrg} and saw your listing:`
            : `We are sourcing ${labelFor(mats[0])} at ${senderOrg} and saw your listing.`,
          ...bulletBlock,
          `Beyond your published pricing, could you share your bulk and wholesale rates${multi ? " for these" : ""}? We're after volume price breaks (e.g. at larger pack sizes or full pallet/ton quantities), along with lead times and MOQs.`,
          "",
          "If you have a wholesale price list or catalog, please send it over. We evaluate suppliers across multiple raw materials and will share what you carry with the rest of our procurement team.",
          "",
          "Thanks,",
          "",
          "Procurement Team",
          senderOrg,
        ]
      : [
          greeting(input.supplierContactName, input.supplierCompanyName),
          "",
          multi
            ? `We are expanding our supplier network at ${senderOrg} and are looking for the following raw materials:`
            : `We are expanding our supplier network at ${senderOrg} and are looking for ${labelFor(mats[0])}.`,
          ...bulletBlock,
          `Do you supply ${multi ? "any of these" : "this"}? If so, could you kindly share current pricing, estimated lead times, and MOQs${multi ? " for each" : ""}?`,
          "",
          "Additionally, if you have a product catalog, please share it. We're evaluating suppliers across multiple raw materials and will share what you carry with the rest of our procurement team.",
          "",
          "We may have follow-up questions as we go along, and any context you can share is helpful.",
          "",
          "Thanks,",
          "",
          "Procurement Team",
          senderOrg,
        ]
  ).join("\n");

  return sanitizeDraft({ subject, body });
}

// Same model family the reply drafter uses — plenty for short RFQ copy, and
// cheap/fast enough for Agent 04's per-supplier batch run.
const MODEL = "claude-sonnet-4-5";

let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

const SYSTEM = `You write the FIRST cold outreach email (an RFQ) from a procurement team to a raw-material supplier. An operator reviews it before it sends.

Write it like a human sourcing coordinator wrote it from scratch. Warm, businesslike, concise. Every email must read uniquely — vary the wording, sentence shapes, and structure between emails. Never reuse a fixed template.

STYLE RULES (non-negotiable):
- Greeting: first name if we know the contact's name ("Hi Dana,"), else "Hi {Company} Team,", else "Hi there,".
- Short paragraphs. Each thought is its own paragraph with a blank line above and below. Whole body under 130 words.
- NEVER use em dashes or en dashes. Use commas, periods, or "and".
- Avoid clichés: "I hope this email finds you well", "I am reaching out", "Per our records", "circle back", "touch base", "hop on a call".
- NEVER invent prices, quantities, terms, prior conversations, or relationships. This is a cold first contact.
- Sign-off ALWAYS exactly, blank lines included:
    Thanks,

    Procurement Team
    {sender org on its own line}

WHAT THE EMAIL MUST DO:
- Say we're sourcing the listed material(s) at {sender org}.
- Ask whether they supply it/them and request current pricing, estimated lead times, and MOQs.
- Ask for a product catalog or line card, noting we evaluate suppliers across multiple raw materials.
- One material: write it inline as a sentence. Two or more: a short intro line, then a clean bullet list (one material per line), then the ask.
- MARKETPLACE supplier: they already publish retail pricing, so instead ask for their bulk/wholesale rates and volume price breaks (larger pack sizes, pallet/ton quantities) beyond the listing.

GHOST MODE: only ever name the sender org given. NEVER name any underlying client.

Use the material names EXACTLY as provided; do not "correct", translate, or expand them.

OUTPUT: respond with ONLY a JSON object: {"subject": "<short subject, no em dashes>", "body": "<full body with the exact sign-off block>"}`;

function buildUserMessage(input: DraftInput): string {
  const senderOrg = input.mode === "ghost" ? input.ghostBrand! : input.clientOrgName;
  const mats = materialList(input);
  const lines = [
    `Sender org (sign as this): ${senderOrg}`,
    `Outreach mode: ${input.mode}${input.mode === "ghost" ? " (ghost brand — never name the underlying client)" : ""}`,
    `Supplier company: ${input.supplierCompanyName ?? "(unknown)"}`,
    `Supplier contact name: ${input.supplierContactName ?? "(unknown)"}`,
    `Marketplace supplier: ${input.isMarketplace ? "yes — ask for bulk/wholesale beyond listed retail" : "no"}`,
    `Materials we are sourcing (${mats.length}):`,
    ...mats.map((m) => `  - ${labelFor(m)}`),
    "",
    "Write the RFQ email.",
  ];
  return lines.join("\n");
}

function extractJsonObject(text: string): { subject?: string; body?: string } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in outreach draft output");
  return JSON.parse(candidate.slice(start, end + 1));
}

// Generate the RFQ with the model for varied language. Any failure (missing
// key, API error, malformed/short output) falls back to the deterministic
// template so a draft still gets staged.
export async function composeOutreachDraft(input: DraftInput): Promise<ComposedDraft> {
  try {
    const res = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 900,
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });
    const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const parsed = extractJsonObject(text);
    const subject = String(parsed.subject ?? "").trim();
    const body = String(parsed.body ?? "").trim();
    if (!subject || body.length < 50) throw new Error("model returned empty/short subject or body");
    return sanitizeDraft({ subject, body });
  } catch {
    return composeTemplateDraft(input);
  }
}
