import type { OutreachMode } from "../quote-revalidation/config";
import { sanitizeDraft } from "@/lib/email-style";

// Template mirrors the Bobber Labs / Notion "EMAIL 1: Initial RFQ" workflow:
// short paragraphs separated by blank lines, conversational tone, no em
// dashes, catalog ask, "Procurement Team / {Org}" sign-off.

export interface DraftInput {
  mode: OutreachMode; // 'active' | 'ghost'
  ghostBrand?: string;
  clientOrgName: string;
  supplierContactName: string | null;
  supplierCompanyName?: string | null;
  materialName: string;
  inciName: string | null;
  signal: string | null; // how we found them — kept for telemetry, no longer changes copy
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

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickSubject(input: DraftInput): string {
  const seed = `${input.supplierCompanyName ?? input.supplierContactName ?? ""}|${input.materialName}`;
  const tpl = SUBJECT_TEMPLATES[stableHash(seed) % SUBJECT_TEMPLATES.length];
  return tpl(input.materialName);
}

export function composeOutreachDraft(input: DraftInput): ComposedDraft {
  const senderOrg = input.mode === "ghost" ? input.ghostBrand! : input.clientOrgName;
  const materialLabel = input.inciName
    ? `${input.materialName} (INCI: ${input.inciName})`
    : input.materialName;

  const subject = pickSubject(input);
  const body = [
    greeting(input.supplierContactName, input.supplierCompanyName),
    "",
    `We are expanding our supplier network at ${senderOrg} and are looking for ${materialLabel}.`,
    "",
    "Do you supply this? If so, could you kindly share current pricing, estimated lead times, and MOQs?",
    "",
    "Additionally, if you have a product catalog, please share it. We're evaluating suppliers across multiple raw materials and will share what you carry with the rest of our procurement team.",
    "",
    "We may have follow-up questions as we go along, and any context you can share is helpful.",
    "",
    "Thanks,",
    "",
    "Procurement Team",
    senderOrg,
  ].join("\n");

  return sanitizeDraft({ subject, body });
}
