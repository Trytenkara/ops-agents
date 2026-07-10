import type { OutreachMode } from "../quote-revalidation/config";
import { sanitizeDraft } from "@/lib/email-style";

// Template mirrors the Bobber Labs / Notion "EMAIL 1: Initial RFQ" workflow:
// short paragraphs separated by blank lines, conversational tone, no em
// dashes, catalog ask, "Procurement Team / {Org}" sign-off.

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
function materialList(input: DraftInput): DraftMaterial[] {
  const list = (input.materials ?? []).filter((m) => m.name && m.name.trim());
  if (list.length) return list;
  return [{ name: input.materialName, inciName: input.inciName }];
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

export function composeOutreachDraft(input: DraftInput): ComposedDraft {
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
