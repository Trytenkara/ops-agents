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

// Three-stage ask cadence. Backlog #14 always intended to ask for "the top couple,
// turn by turn", but both the prompt and the backstop asked for everything at once.
// A supplier is only asked for what the NEXT decision needs:
//   1 commercial   - is this even worth pursuing
//   2 logistics    - how it packs and ships, and on what terms
//   3 onboarding   - who we transact with, asked only once we intend to buy
const ASK_STAGE_BY_KEY: Record<string, 1 | 2 | 3> = {
  price: 1,
  moq: 1,
  lead_time: 1,
  pack_size: 2,
  case_type: 2,
  case_length: 2,
  case_width: 2,
  case_height: 2,
  dimensions_unit: 2,
  case_weight: 2,
  payment_terms: 2,
  payment_upfront_pct: 2,
  shipping_terms: 2,
  shipping_address: 3,
  poc_name: 3,
  poc_email: 3,
  poc_phone: 3,
  shipping_email: 3,
  billing_email: 3,
  billing_poc_name: 3,
  // Merged group keys produced by collapseRelatedAsks. They must be staged
  // explicitly: the default below is stage 3, which would quietly push case
  // dimensions to the end of the conversation.
  case_dimensions: 2,
  poc_contact: 3,
  billing_contact: 3,
};

export function askStage(key: string): 1 | 2 | 3 {
  return ASK_STAGE_BY_KEY[key] ?? 3;
}

// Groups a person asks as ONE question. Left as separate fields they eat the
// per-reply cap and read as a form: "outer case length, outer case width, outer
// case height, dimension unit" is four asks for one question, and so is
// "primary sales contact name, primary sales contact email, primary sales
// contact phone number".
const ASK_GROUPS: { keys: string[]; merged: MissingApprovalField }[] = [
  {
    keys: ["case_length", "case_width", "case_height", "dimensions_unit"],
    merged: {
      key: "case_dimensions",
      clause: "outer case dimensions (length, width, height) and whether those are inches or centimeters",
      detect: /\b(?:case|package|carton)\s*dimensions|\bl\s*[x×]\s*w\s*[x×]\s*h\b/i,
    },
  },
  {
    keys: ["poc_name", "poc_email", "poc_phone"],
    merged: {
      key: "poc_contact",
      clause: "your primary sales contact's name, email and phone number",
      detect: /\b(?:sales|primary)\s*contact\b|\bcontact details\b/i,
    },
  },
  {
    keys: ["billing_email", "billing_poc_name"],
    merged: {
      key: "billing_contact",
      clause: "your billing contact's name and email",
      detect: /\bbilling contact\b|\baccounts? receivable\b/i,
    },
  },
];

export function collapseRelatedAsks(fields: MissingApprovalField[]): MissingApprovalField[] {
  let out = fields;
  for (const group of ASK_GROUPS) {
    if (out.filter((f) => group.keys.includes(f.key)).length < 2) continue;
    const next: MissingApprovalField[] = [];
    let placed = false;
    for (const f of out) {
      if (!group.keys.includes(f.key)) { next.push(f); continue; }
      if (!placed) { next.push(group.merged); placed = true; }
    }
    out = next;
  }
  return out;
}

// Which fields this reply may ask for. Drop anything the drafted body already
// covers, keep only the EARLIEST stage that still has anything outstanding, then
// cap. Later stages are not lost: the missing set is recomputed from live data on
// every reply, so once stage 1 is answered stage 2 becomes the current stage.
export function selectStagedAsks(
  body: string,
  missing: MissingApprovalField[],
  limit: number = MAX_ASKS_PER_REPLY,
): { stage: 1 | 2 | 3 | null; ask: MissingApprovalField[]; deferred: MissingApprovalField[] } {
  const uncovered = collapseRelatedAsks(missingAsksNotCovered(body ?? "", missing ?? []));
  if (!uncovered.length) return { stage: null, ask: [], deferred: [] };
  const stage = uncovered.reduce<1 | 2 | 3>((lowest, f) => (askStage(f.key) < lowest ? askStage(f.key) : lowest), 3);
  const inStage = uncovered.filter((f) => askStage(f.key) === stage);
  return {
    stage,
    ask: inStage.slice(0, limit),
    deferred: [...inStage.slice(limit), ...uncovered.filter((f) => askStage(f.key) !== stage)],
  };
}

// How many distinct things the drafted body already asks the supplier for. Used to
// suppress the appended paragraph entirely when the reply is already asking enough:
// a second list under a reply that asks four questions is what reads as a form.
export function countAsksInBody(body: string): number {
  const text = body ?? "";
  const bullets = (text.match(/^\s*(?:[-*•]|\(?\d+[.)])\s+\S/gm) ?? []).length;
  // Models very often enumerate inline: "could you confirm (1) the MOQ, (2) ...".
  // That is one question mark but three asks, so count the markers too.
  const inlineEnumerated = (text.match(/\(\s*\d+\s*\)\s*\S/g) ?? []).length;
  const questions = (text.match(/\?/g) ?? []).length;
  return Math.max(bullets, inlineEnumerated, questions);
}
