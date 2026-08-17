export interface StagedQuoteFieldState {
  price?: number | null;
  case_size?: number | null;
  unit_of_measurement?: string | null;
  case_type?: string | null;
  case_dimensions?: Record<string, any> | null;
  dim_source?: string | null;
  raw_extract?: Record<string, any> | null;
  lead_time_days?: number | null;
  lead_time_text?: string | null;
  moq_quantity?: number | null;
  moq_unit?: string | null;
  payment_terms?: string | null;
  status?: string | null;
}

export interface SupplierApprovalState {
  poc_email?: string | null;
  poc_phone?: string | null;
  poc_name?: string | null;
  shipping_address?: string | null;
  shipping_terms?: string | null;
  shipping_email?: string | null;
  billing_email?: string | null;
  billing_poc_name?: string | null;
  payment_upfront_pct?: number | null;
  payment_net_days?: number | null;
  payment_completion?: string | null;
  payment_credit_line?: string | null;
}

// Approval fields intentionally excluded from supplier email asks:
// supplier_type is derived from marketplace/direct lead provenance; quote expiry
// uses the approved 90-day default. Operator verification checkboxes are also
// workflow state, not supplier-provided facts.
export const NON_SUPPLIER_ASKABLE_FIELDS = ["supplier_type", "quote_expiry"] as const;

export interface MissingApprovalField {
  key: string;
  clause: string;
  detect: RegExp;
}

export function completenessFollowupEnabled(): boolean {
  const value = (process.env.COMPLETENESS_FOLLOWUP_ENABLED ?? "").trim().toLowerCase();
  return value === "" || !["0", "false", "off", "no"].includes(value);
}

function has(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export function computeMissingApprovalFields(
  rows: StagedQuoteFieldState[],
  supplier: SupplierApprovalState | null = null,
): MissingApprovalField[] {
  const live = (rows ?? []).filter((row) => (row?.status ?? "") !== "dismissed");
  const any = (predicate: (row: StagedQuoteFieldState) => boolean) => live.some(predicate);
  const missing: MissingApprovalField[] = [];
  const add = (key: string, clause: string, detect: RegExp) => missing.push({ key, clause, detect });

  if (!any((row) => has(row.price))) add("price", "EXW pricing, including any tiered or volume price breaks", /\b(price|pricing|exw|usd|\$)\b/i);
  if (!any((row) => has(row.lead_time_days) || has(row.lead_time_text))) add("lead_time", "typical lead time", /\blead\s*time|turnaround|ready\s*(?:in|within)/i);
  if (!any((row) => has(row.moq_quantity) && has(row.moq_unit))) add("moq", "MOQ and its unit", /\bmoq|minimum order/i);
  if (!any((row) => has(row.case_size) && has(row.unit_of_measurement))) add("pack_size", "pack or case size and unit", /\bpack|case size|bag size|drum size/i);

  const supplierDimensions = live.map((row) => row.raw_extract?.supplier_dimensions ?? (row.dim_source === "supplier" ? row.case_dimensions ?? {} : {}));
  if (!any((row) => has(row.raw_extract?.supplier_case_type) || (row.dim_source === "supplier" && has(row.case_type)))) add("case_type", "case or packaging type", /\bcase type|packaging type|bag|drum|pail|carton|tote/i);
  if (!supplierDimensions.some((dims) => has(dims.length))) add("case_length", "outer case length", /\b(?:case|package).*length|length.*(?:case|package)/i);
  if (!supplierDimensions.some((dims) => has(dims.width))) add("case_width", "outer case width", /\b(?:case|package).*width|width.*(?:case|package)/i);
  if (!supplierDimensions.some((dims) => has(dims.height))) add("case_height", "outer case height", /\b(?:case|package).*height|height.*(?:case|package)/i);
  if (!supplierDimensions.some((dims) => has(dims.unit))) add("dimensions_unit", "dimension unit (inches or centimeters)", /\binches?|\bcm\b|centimeters?|dimension unit/i);
  if (!supplierDimensions.some((dims) => has(dims.packaging_case_weight))) add("case_weight", "gross case weight", /\bgross.*weight|case weight|package weight/i);

  const paymentPresent = any((row) => has(row.payment_terms)) || !!(supplier && (has(supplier.payment_net_days) || has(supplier.payment_completion) || has(supplier.payment_credit_line)));
  if (!paymentPresent) add("payment_terms", "standard payment terms", /\bpayment terms?|net\s*\d+|deposit|prepaid|credit line/i);
  if (!has(supplier?.payment_upfront_pct)) add("payment_upfront_pct", "upfront or deposit percentage (please confirm 0% if none)", /\bupfront|deposit|prepaid|0%/i);

  if (!has(supplier?.poc_name)) add("poc_name", "primary sales contact name", /\bcontact name|sales contact|primary contact/i);
  if (!has(supplier?.poc_email)) add("poc_email", "primary sales contact email", /\bcontact email|sales email|email address/i);
  if (!has(supplier?.poc_phone)) add("poc_phone", "primary sales contact phone number", /\bcontact phone|phone number|telephone/i);
  if (!has(supplier?.shipping_address)) add("shipping_address", "shipping or pickup address", /\bshipping address|pickup address|ship from/i);
  if (!has(supplier?.shipping_terms)) add("shipping_terms", "available shipping terms", /\bshipping terms?|incoterms?|exw|fob|ddp/i);
  if (!has(supplier?.shipping_email)) add("shipping_email", "shipping contact email", /\bshipping email|logistics email/i);
  if (!has(supplier?.billing_email)) add("billing_email", "billing contact email", /\bbilling email|accounts? receivable/i);
  if (!has(supplier?.billing_poc_name)) add("billing_poc_name", "billing contact name", /\bbilling contact|accounts? receivable contact/i);

  return missing;
}

export function buildCompletenessAsk(missing: MissingApprovalField[]): string {
  const clauses = (missing ?? []).map((field) => field.clause);
  if (!clauses.length) return "";
  const joined = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return `To complete our review, could you also share ${joined}?`;
}

export function missingAsksNotCovered(body: string, missing: MissingApprovalField[]): MissingApprovalField[] {
  return missing.filter((field) => !field.detect.test(body));
}

// How many still-missing fields one reply is allowed to ask for. Ops flagged that
// enumerating every blank field in a single sentence reads as an AI checklist and
// that suppliers will not answer it.
export const MAX_ASKS_PER_REPLY = 3;

// Which fields this reply should ask for: drop anything the drafted body already
// covers, then take at most `limit`. Deferred fields are NOT lost. The missing set
// is recomputed from live quote/supplier data on every inbound reply, so a field
// left unasked here simply comes back on the next one, which is what staggering
// the asks means.
export function selectCompletenessAsks(
  body: string,
  missing: MissingApprovalField[],
  limit: number = MAX_ASKS_PER_REPLY,
): { ask: MissingApprovalField[]; deferred: MissingApprovalField[] } {
  const uncovered = missingAsksNotCovered(body ?? "", missing ?? []);
  return { ask: uncovered.slice(0, limit), deferred: uncovered.slice(limit) };
}
