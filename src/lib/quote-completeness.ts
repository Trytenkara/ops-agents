// Backlog #14 - keep inquiring until every approval-required quote field is
// captured (or the supplier hard-declines).
//
// The supplier reply drafter historically asked for the "basics" (price, MOQ,
// lead time, packaging, payment terms) and then stopped. Ops still has to chase
// the remaining approval-required fields by hand. This module derives, from the
// captured staged_quote state for a supplier+material, which approval-required
// fields are still MISSING, so the drafter can ask for the next few, turn by
// turn, until the quote is complete.
//
// APPROVAL-REQUIRED FIELDS (canonical source of truth in code):
//   Quote-level  - src/lib/quote-profiles.ts QUOTING_FIELDS + the staged_quotes
//                  columns (migrations 0025/0040/0042/0053): price, case_size,
//                  unit_of_measurement, case_type + case_dimensions, lead_time,
//                  moq_quantity/unit, payment_terms, grade.
//   Supplier     - src/lib/supplier-profiles.ts COMPLETENESS_FIELDS: poc_*,
//                  shipping_*, payment_* (asked/verified on the Suppliers tab).
//
// We only chase the fields a supplier can reasonably answer over email and that
// do not violate an existing drafting rule:
//   - grade is EXCLUDED: we never ask a supplier to pick/suggest a grade, and we
//     only record a grade the supplier states themselves. (existing rule)
//   - quote_expiry is EXCLUDED: ops applies a 90-day default; not chaseable.
//   - hazmat / handling is EXCLUDED here: only asked when the material is
//     actually hazardous or the supplier raised it, which the drafter's system
//     prompt already gates on relevance.
//   - supplier POC address / phone are EXCLUDED: the drafter defers on giving or
//     inventing contact/address details; we do not open new asks for them here.
//
// A missing field NEVER blocks a draft - this only adds a gentle, natural ask
// for the top couple of still-missing items.

// One row of captured pricing for a supplier+material (subset of staged_quotes
// columns we key completeness off of). All fields optional / nullable.
export interface StagedQuoteFieldState {
  price?: number | null;
  case_size?: number | null;
  unit_of_measurement?: string | null;
  case_type?: string | null;
  case_dimensions?: Record<string, any> | null;
  lead_time_days?: number | null;
  lead_time_text?: string | null;
  moq_quantity?: number | null;
  moq_unit?: string | null;
  payment_terms?: string | null;
  grade?: string | null;
  status?: string | null;
}

export interface MissingApprovalField {
  key: string;
  // A natural-language clause the drafter can drop into a sentence, e.g.
  // "Could you also share <clause>?". No em dashes (house style).
  clause: string;
}

// Env flag - the "keep asking until complete" expansion is ON by default but
// trivially disabled by setting COMPLETENESS_FOLLOWUP_ENABLED to 0/false/off/no.
// Reversible kill-switch for this live-client behavior change.
export function completenessFollowupEnabled(): boolean {
  const v = (process.env.COMPLETENESS_FOLLOWUP_ENABLED ?? "").trim().toLowerCase();
  if (v === "") return true; // default ON
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function has(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

function dimsPresent(cd: Record<string, any> | null | undefined): boolean {
  if (!cd || typeof cd !== "object") return false;
  return has(cd.width) || has(cd.height) || has(cd.length) || has(cd.packaging_case_weight);
}

// Which approval-required fields are still missing across the captured rows for
// this supplier+material, in the order we prefer to ask for them. A field counts
// as present if ANY non-dismissed row supplies it. Returns [] when complete.
export function computeMissingApprovalFields(
  rows: StagedQuoteFieldState[]
): MissingApprovalField[] {
  const live = (rows ?? []).filter((r) => (r?.status ?? "") !== "dismissed");
  const any = (pred: (r: StagedQuoteFieldState) => boolean) => live.some(pred);

  const missing: MissingApprovalField[] = [];

  // Price first - if we somehow have rows but no price yet, it's the top ask.
  if (!any((r) => has(r.price))) {
    missing.push({
      key: "price",
      clause: "your EXW pricing, including any tiered or volume price breaks",
    });
  }
  if (!any((r) => has(r.lead_time_days) || has(r.lead_time_text))) {
    missing.push({ key: "lead_time", clause: "your typical lead time" });
  }
  if (!any((r) => has(r.moq_quantity))) {
    missing.push({ key: "moq", clause: "your MOQ" });
  }
  if (!any((r) => has(r.case_size) && has(r.unit_of_measurement))) {
    missing.push({
      key: "pack_size",
      clause: "the pack or case size and the unit it ships in",
    });
  }
  if (!any((r) => has(r.payment_terms))) {
    missing.push({
      key: "payment_terms",
      clause: "your standard payment terms (for example Net 30)",
    });
  }
  if (!any((r) => has(r.case_type) || dimsPresent(r.case_dimensions))) {
    missing.push({
      key: "packaging",
      clause: "packaging details (case type, weight, and dimensions)",
    });
  }

  return missing;
}

// Build one short, natural ask sentence from the top `max` missing fields. Keeps
// it to a couple of items per message (turn-by-turn), never a full checklist.
// Returns "" when nothing is missing. No em dashes.
export function buildCompletenessAsk(
  missing: MissingApprovalField[],
  max = 2
): string {
  const clauses = (missing ?? []).slice(0, Math.max(1, max)).map((m) => m.clause);
  if (!clauses.length) return "";
  const joined =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
  return `Could you also share ${joined}?`;
}
