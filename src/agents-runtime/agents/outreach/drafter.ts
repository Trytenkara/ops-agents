import type { OutreachMode } from "../quote-revalidation/config";

// Pure template — no LLM in v1. Mirrors the tone of Agent 02's revalidation
// templates so suppliers see consistent voice across both flows.

export interface DraftInput {
  mode: OutreachMode; // 'active' | 'ghost'
  ghostBrand?: string;
  clientOrgName: string;
  supplierContactName: string | null;
  materialName: string;
  inciName: string | null;
  signal: string | null; // how we found them — informs the lede
}

export interface ComposedDraft {
  subject: string;
  body: string;
}

function greeting(name: string | null): string {
  if (!name) return "Hi there,";
  // Pick the first token — many POC fields are "First Last", a few are full
  // company-style names. Keep it simple.
  const first = name.trim().split(/\s+/)[0];
  return `Hi ${first},`;
}

function lede(signal: string | null, materialName: string): string {
  switch (signal) {
    case "quoted_same_material":
      return `We're sourcing ${materialName} and noticed you've quoted it before — wanted to see if you can quote again.`;
    case "quoted_similar_inci":
      return `We're sourcing ${materialName} and saw you've quoted materials with the same INCI in the past.`;
    case "quoted_similar_name":
      return `We're sourcing ${materialName} and saw you've quoted very similar material before.`;
    case "catalog_match":
      return `We're sourcing ${materialName} and saw it listed in your catalog — checking if you can quote.`;
    default:
      return `We're sourcing ${materialName} and would like to see if you can quote.`;
  }
}

export function composeOutreachDraft(input: DraftInput): ComposedDraft {
  const senderLabel =
    input.mode === "ghost" ? `${input.ghostBrand} Sourcing` : `${input.clientOrgName} Purchasing Team`;
  const inciLine = input.inciName ? ` (INCI: ${input.inciName})` : "";

  const subject = `Sourcing inquiry: ${input.materialName}`;
  const body = [
    greeting(input.supplierContactName),
    "",
    lede(input.signal, input.materialName) + inciLine + ".",
    "",
    "To move quickly, could you share:",
    "  • Pricing at typical volumes (e.g. 25 kg, 100 kg, 500 kg)",
    "  • Current lead time",
    "  • Whether you carry it in stock or produce to order",
    "  • Country of origin and COA / spec sheet availability",
    "",
    "Happy to send a more detailed RFQ if helpful.",
    "",
    "Thanks,",
    senderLabel,
  ].join("\n");

  return { subject, body };
}
