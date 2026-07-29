// Estimated per-call cost rates for the external discovery providers.
//
// IMPORTANT: these are ESTIMATES. This app can only observe discovery calls
// fired from Agent 03 (the lead-creator) and the leads that landed. True credit
// consumption and dollar billing live in the remote discovery agent and each
// provider's own account, not here. Treat every figure below as an approximation
// and edit it here when a real contract rate is known.
//
// This file is the single source of truth for the Settings > "API usage & cost"
// section. To adjust an estimate, change usdPerCredit / creditsPerCall (or
// usdPerCall directly) and the caveat/source note.

export type RateConfidence = "reported" | "estimated" | "placeholder";

export interface ProviderRate {
  key: "importyeti" | "sourceready";
  label: string;
  // What one fired discovery call is assumed to consume.
  creditsPerCall: number;
  usdPerCredit: number;
  // Effective estimated dollar cost per fired (successful) discovery call.
  usdPerCall: number;
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
    creditsPerCall: 15,
    usdPerCredit: 0.1,
    usdPerCall: 1.5,
    confidence: "estimated",
    assumption:
      "1 fired discovery = 1 Supplier Search (15 credits). Credit value ~$0.10 (Entry $35/300cr ≈ $0.117, Pro $379/4000cr ≈ $0.095). Excludes optional contact unlock (+20 cr).",
    source: "help.sourceready.com/en/articles/9542833-pricing-plans",
    reviewedOn: "2026-07-29",
  },
  importyeti: {
    key: "importyeti",
    label: "ImportYeti",
    creditsPerCall: 1,
    usdPerCredit: 0.25,
    usdPerCall: 0.25,
    confidence: "placeholder",
    assumption:
      "1 fired discovery = 1 supplier/company search (~1 data credit, charged only on success). ImportYeti does not publish $/credit for the beta Data API; $0.25/credit is a placeholder pending the real contract rate.",
    source: "data.importyeti.com (usage-based data credits, 2026-07)",
    reviewedOn: "2026-07-29",
  },
};

export function estimateCostUsd(key: ProviderRate["key"], firedCalls: number): number {
  return firedCalls * API_COST_RATES[key].usdPerCall;
}

export function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
