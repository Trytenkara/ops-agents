// Estimated per-unit cost rates for the external, usage-metered APIs this system
// fires.
//
// IMPORTANT: these are ESTIMATES. This app can only observe activity it triggers
// (discovery calls fired by Agent 03, price-pull sessions opened by Agent 05) and
// what landed. True credit/hour consumption and dollar billing live in the remote
// agents and each provider's own account, not here. Treat every figure as an
// approximation and edit it here when a real contract rate is known.
//
// This file is the single source of truth for the Settings > "API usage & cost"
// section.

export type RateConfidence = "reported" | "estimated" | "placeholder";

export interface ProviderRate {
  key: "importyeti" | "sourceready" | "browserbase";
  label: string;
  unitLabel: string; // what one billable unit is, e.g. "search", "session"
  // Effective estimated dollar cost per billable unit.
  usdPerUnit: number;
  confidence: RateConfidence;
  // Human-readable basis, shown inline in the UI for transparency.
  assumption: string;
  source: string;
  reviewedOn: string; // ISO date the estimate was last checked against public pricing
}

export const API_COST_RATES: Record<ProviderRate["key"], ProviderRate> = {
  sourceready: {
    key: "sourceready",
    label: "SourceReady",
    unitLabel: "search",
    usdPerUnit: 1.5,
    confidence: "estimated",
    assumption:
      "1 fired discovery = 1 Supplier Search (15 credits). Credit value ~$0.10 (Entry $35/300cr ≈ $0.117, Pro $379/4000cr ≈ $0.095). Excludes optional contact unlock (+20 cr).",
    source: "help.sourceready.com/en/articles/9542833-pricing-plans",
    reviewedOn: "2026-07-29",
  },
  importyeti: {
    key: "importyeti",
    label: "ImportYeti",
    unitLabel: "search",
    usdPerUnit: 0.25,
    confidence: "placeholder",
    assumption:
      "1 fired discovery = 1 supplier/company search (~1 data credit, charged only on success). ImportYeti does not publish $/credit for the beta Data API; $0.25 is a placeholder pending the real contract rate.",
    source: "data.importyeti.com (usage-based data credits, 2026-07)",
    reviewedOn: "2026-07-29",
  },
  browserbase: {
    key: "browserbase",
    label: "Browserbase",
    unitLabel: "session",
    usdPerUnit: 0.01,
    confidence: "placeholder",
    assumption:
      "1 price-pull = 1 browser session (≤15 min). Overage ~$0.20/browser-hour (Developer $20/100h, Startup $99/500h). Assumes ~3 min/session → ~$0.01; session length is not recorded here, so this is a rough floor.",
    source: "browserbase.com/pricing",
    reviewedOn: "2026-07-29",
  },
};

// Other paid services this system uses that are NOT per-call metered in this app.
// Listed for transparency; no dollar figure is computed here (we would have to
// fabricate one, and true usage is billed in the provider's own console).
export interface UnmeteredService {
  label: string;
  note: string;
}

export const UNMETERED_SERVICES: UnmeteredService[] = [
  {
    label: "Anthropic (Claude API)",
    note: "Token-metered; used for PO/document/reply extraction and material-name flags. Usage and cost are in the Anthropic console, not tracked here.",
  },
  {
    label: "Missive",
    note: "Email/inbox API on a flat per-seat subscription, not per-call metered.",
  },
];

export function estimateCostUsd(key: ProviderRate["key"], units: number): number {
  return units * API_COST_RATES[key].usdPerUnit;
}

export function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
