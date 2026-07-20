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
  // Consolidated outreach: when a supplier can quote SEVERAL of a client's
  // materials we send one email listing them all, instead of one email per
  // material. When set with 2+ entries this drives the copy; otherwise the
  // single materialName/inciName above is used. (#11)
  materials?: { name: string; inci?: string | null }[];
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

// Body variation: ops flagged that every outreach used an identical body, so a
// campaign read as an obvious template blast. Each variant carries the SAME asks
// (does-it-supply, pricing, lead time, MOQ, catalog) in different phrasing; we
// pick one deterministically by a stable hash of recipient + material so the
// same draft always re-renders identically (idempotent), while neighbouring
// suppliers get visibly different copy. Sign-off stays constant on purpose.
const COLD_BODIES: ((org: string, mat: string) => string[])[] = [
  (org, mat) => [
    `We are expanding our supplier network at ${org} and are looking for ${mat}.`,
    "",
    "Do you supply this? If so, could you kindly share current pricing, estimated lead times, and MOQs?",
    "",
    "Additionally, if you have a product catalog, please share it. We're evaluating suppliers across multiple raw materials and will share what you carry with the rest of our procurement team.",
    "",
    "We may have follow-up questions as we go along, and any context you can share is helpful.",
  ],
  (org, mat) => [
    `${org} is actively sourcing ${mat} and your company came up as a potential supplier.`,
    "",
    "Could you let us know whether this is something you carry? A current price, typical lead time, and minimum order quantity would help us move quickly.",
    "",
    "If you have a catalog or line card handy, feel free to include it. We buy across a range of raw materials, so we'll keep what you offer on file for the rest of the team.",
  ],
  (org, mat) => [
    `I'm reaching out from ${org}. We have ongoing demand for ${mat} and are looking to add a reliable supplier.`,
    "",
    "Is this in your range? If so, what does current pricing look like, and what are your lead times and MOQs?",
    "",
    "A product catalog would be great to have as well. We source many materials and share supplier capabilities across our procurement team.",
  ],
  (org, mat) => [
    `We're building out sourcing for ${mat} at ${org} and would like to see if there's a fit.`,
    "",
    "Could you confirm availability and share pricing, lead times, and minimum order quantities?",
    "",
    "If it's easy to send a catalog or product list, please do. We evaluate suppliers across several raw materials and pass along what you carry to the wider team.",
  ],
  (org, mat) => [
    `${org} is looking for a supplier of ${mat}, and we'd value a quote.`,
    "",
    "If you carry it, please share your current pricing along with lead times and MOQs so we can compare options.",
    "",
    "Any catalog or capability sheet is welcome too. We source a broad set of materials and keep strong suppliers on our shortlist.",
  ],
];

const MARKETPLACE_BODIES: ((org: string, mat: string) => string[])[] = [
  (org, mat) => [
    `We are sourcing ${mat} at ${org} and saw your listing.`,
    "",
    "Beyond your published pricing, could you share your bulk and wholesale rates? We're after volume price breaks (e.g. at larger pack sizes or full pallet/ton quantities), along with lead times and MOQs.",
    "",
    "If you have a wholesale price list or catalog, please send it over. We evaluate suppliers across multiple raw materials and will share what you carry with the rest of our procurement team.",
  ],
  (org, mat) => [
    `Your listing for ${mat} came up while we were sourcing for ${org}.`,
    "",
    "We typically buy in volume, so we'd like to understand your wholesale and bulk tiers rather than the listed retail price. What do price breaks look like at larger pack sizes or pallet quantities, and what are your lead times and MOQs?",
    "",
    "A wholesale price list or catalog would be helpful. We source across many materials and share supplier options with the rest of our team.",
  ],
  (org, mat) => [
    `${org} is interested in ${mat} and found your listing.`,
    "",
    "Could you quote your bulk/wholesale pricing beyond the published rate? We're comparing volume price breaks, lead times, and MOQs across suppliers.",
    "",
    "If you can share a wholesale catalog or line card, we'll keep it on file. We buy a range of raw materials and route capabilities to the whole procurement team.",
  ],
];

function pickBody(input: DraftInput, org: string, mat: string): string[] {
  const seed = `body|${input.supplierCompanyName ?? input.supplierContactName ?? ""}|${input.materialName}`;
  const pool = input.isMarketplace ? MARKETPLACE_BODIES : COLD_BODIES;
  return pool[stableHash(seed) % pool.length](org, mat);
}

// ---- Consolidated (multi-material) copy (#11) ----

function materialLabel(m: { name: string; inci?: string | null }): string {
  return m.inci ? `${m.name} (INCI: ${m.inci})` : m.name;
}

const MULTI_SUBJECTS: ((first: string, n: number) => string)[] = [
  (first, n) => `Sourcing inquiry: ${first} + ${n - 1} more`,
  (first, n) => `RFQ — ${n} materials`,
  (first, n) => `Do you supply these ${n} materials?`,
  (first, n) => `Quote request: ${first} and ${n - 1} others`,
];

// Each variant lists the materials as bullets, then asks for pricing/lead
// time/MOQ across the list. Same content, varied phrasing (#10 + #11).
const MULTI_COLD_BODIES: ((org: string, list: string[]) => string[])[] = [
  (org, list) => [
    `We are expanding our supplier network at ${org} and are sourcing the following materials:`,
    "",
    ...list.map((m) => `- ${m}`),
    "",
    "Do you supply any of these? If so, could you share current pricing, estimated lead times, and MOQs for each you carry?",
    "",
    "If you have a product catalog, please send it along. We source across many raw materials and share what you carry with the rest of our procurement team.",
  ],
  (org, list) => [
    `${org} has ongoing demand for several raw materials and is looking to add a reliable supplier. We're currently after:`,
    "",
    ...list.map((m) => `- ${m}`),
    "",
    "Could you let us know which of these you carry, along with current pricing, lead times, and minimum order quantities?",
    "",
    "A catalog or line card would be great to have on file — we buy a broad range of materials and route capabilities to the whole team.",
  ],
];

const MULTI_MARKETPLACE_BODIES: ((org: string, list: string[]) => string[])[] = [
  (org, list) => [
    `We are sourcing several materials at ${org} and saw your listings for the following:`,
    "",
    ...list.map((m) => `- ${m}`),
    "",
    "Beyond your published pricing, could you share bulk and wholesale rates for the ones you carry? We're after volume price breaks (larger pack sizes or pallet/ton quantities), plus lead times and MOQs.",
    "",
    "If you have a wholesale price list or catalog, please send it over. We evaluate suppliers across many materials and share what you carry with the rest of our procurement team.",
  ],
];

function composeMultiMaterialDraft(input: DraftInput, senderOrg: string, materials: { name: string; inci?: string | null }[]): ComposedDraft {
  const list = materials.map(materialLabel);
  const seed = `${input.supplierCompanyName ?? input.supplierContactName ?? ""}|${materials.map((m) => m.name).join(",")}`;
  const h = stableHash(seed);
  const subject = MULTI_SUBJECTS[h % MULTI_SUBJECTS.length](materials[0].name, materials.length);
  const pool = input.isMarketplace ? MULTI_MARKETPLACE_BODIES : MULTI_COLD_BODIES;
  const body = [
    greeting(input.supplierContactName, input.supplierCompanyName),
    "",
    ...pool[h % pool.length](senderOrg, list),
    "",
    "Thanks,",
    "",
    "Procurement Team",
    senderOrg,
  ].join("\n");
  return sanitizeDraft({ subject, body });
}

export function composeOutreachDraft(input: DraftInput): ComposedDraft {
  const senderOrg = input.mode === "ghost" ? input.ghostBrand! : input.clientOrgName;

  // De-dup (keep first occurrence, preserving its casing) and drop blanks; a
  // supplier quoting 2+ materials gets one listing.
  const seenMat = new Set<string>();
  const uniqueMulti = (input.materials ?? []).filter((m) => {
    const name = m.name?.trim();
    if (!name) return false;
    const k = name.toLowerCase();
    if (seenMat.has(k)) return false;
    seenMat.add(k);
    return true;
  });
  if (uniqueMulti.length >= 2) return composeMultiMaterialDraft(input, senderOrg, uniqueMulti);

  const materialLabelStr = input.inciName
    ? `${input.materialName} (INCI: ${input.inciName})`
    : input.materialName;

  const subject = pickSubject(input);
  const body = [
    greeting(input.supplierContactName, input.supplierCompanyName),
    "",
    ...pickBody(input, senderOrg, materialLabelStr),
    "",
    "Thanks,",
    "",
    "Procurement Team",
    senderOrg,
  ].join("\n");

  return sanitizeDraft({ subject, body });
}
