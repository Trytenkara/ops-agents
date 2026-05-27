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

export function composeOutreachDraft(input: DraftInput): ComposedDraft {
  const senderOrg = input.mode === "ghost" ? input.ghostBrand! : input.clientOrgName;
  const materialLabel = input.inciName
    ? `${input.materialName} (INCI: ${input.inciName})`
    : input.materialName;

  const subject = `Sourcing inquiry: ${input.materialName}`;
  const body = [
    greeting(input.supplierContactName, input.supplierCompanyName),
    "",
    `We are expanding our supplier network at ${senderOrg} and are looking for ${materialLabel}.`,
    "",
    "Do you supply this? If so, could you kindly share current pricing, estimated lead times, and MOQs?",
    "",
    "Additionally, if you have a product catalog, please share it. We're evaluating suppliers across multiple raw materials and will share what you carry with the rest of our procurement team.",
    "",
    "We may have follow-up questions as we go along. Quick responses are always appreciated.",
    "",
    "Thanks,",
    "",
    "Procurement Team",
    senderOrg,
  ].join("\n");

  return sanitizeDraft({ subject, body });
}
