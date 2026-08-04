import Anthropic from "@anthropic-ai/sdk";
import {
  buildCompletenessAsk,
  completenessFollowupEnabled,
  type MissingApprovalField,
} from "@/lib/quote-completeness";

// Composes a short, professional reply to a supplier's inbound message. The
// operator reviews and sends — so this stays non-committal: acknowledge, keep
// the sourcing conversation moving, never invent prices/terms/commitments.

const MODEL = "claude-sonnet-4-5";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface ReplyInput {
  mode: "active" | "ghost";
  clientOrgName: string;
  ghostBrand?: string;
  supplierName: string | null;
  supplierContactName: string | null;
  materialName: string | null;
  originalSubject: string | null; // our outreach subject
  theirSubject: string | null;    // their reply subject
  theirPreview: string | null;    // snippet of their message
  // Non-inline files the supplier attached to THIS reply. When present, the draft
  // must acknowledge them and MUST NOT claim the attachment didn't arrive or ask
  // for it to be resent. pricingExtracted = we already read pricing out of it.
  receivedAttachments?: { name: string; pricingExtracted: boolean }[] | null;
  threadContext?: string | null;  // compact transcript of the prior thread (oldest first)
  // Phased outreach: other materials we also source from this supplier that were
  // held back from the first email. If the supplier is engaged, the reply
  // introduces them; otherwise they stay held.
  heldMaterialNames?: string[] | null;
  // Backlog #14: approval-required quote fields still MISSING for this
  // supplier+material (computed from captured staged_quote state, in priority
  // order). When present and the supplier is engaged, the reply asks for the top
  // couple of these, turn by turn, so we keep inquiring until the quote is
  // complete. A missing field NEVER blocks a draft. Gated by the caller behind
  // COMPLETENESS_FOLLOWUP_ENABLED.
  missingApprovalFields?: MissingApprovalField[] | null;
  // City/state/ZIP of the client's ship-to, mirrored from Tenkara by Agent 12.
  // Null means we genuinely don't know it and the draft must defer.
  shipToRegion?: string | null;
}

export interface ComposedReply {
  subject: string;
  body: string;
  // True when the supplier engaged genuinely (gave pricing, asked a question,
  // requested a sample/spec, or otherwise moved sourcing forward) vs declined /
  // auto-reply / off-topic. Drives whether held materials are introduced.
  engaged: boolean;
  // The held material names the draft actually introduced ([] if none).
  introducedMaterials: string[];
}

const SYSTEM = `You draft short, professional replies to suppliers on behalf of a procurement team. The operator will review and send — so:
- Acknowledge their message and keep the sourcing conversation moving (e.g. confirm interest, ask for the next concrete thing: pricing for a stated quantity, MOQ, lead time, a sample, or a spec/COA).
- MATERIAL SCOPE — stay on the material(s) we asked for. Only pursue the material named as "Material being sourced" (plus any listed under "Other materials we also source from this supplier"). If the supplier says they cannot supply our material and instead pitches DIFFERENT materials we never requested (e.g. we asked for Sulfuric Acid and they offer Hydrochloric Acid / Nitric Acid / Hydrogen Peroxide), do NOT ask for pricing, MOQ, samples, or terms on those substitutes. Politely acknowledge, thank them, and treat this as a decline. Never open a new sourcing ask for an unrequested material.
- MATERIAL IDENTITY — a materially different product is NOT our material even if the name is similar (e.g. "paprika colorant / oleoresin" is not "paprika powder"; a technical grade is not a food grade if we asked for food grade). If what they offer is a different product than we requested, do not proceed as if it matches — ask a clarifying question or treat as a decline; do not request pricing on the wrong product.
- SHIPPING TERMS — when you ask for pricing, also cover shipping: tell them we can arrange our own shipping and prefer EXW (Ex Works) terms. If they can't do EXW that's fine, but still ask for their EXW price so we can compare. Fold this into the pricing ask naturally (EXW price for the stated quantity, plus MOQ and lead time).
- PAYMENT TERMS — when asking for pricing, also request payment terms (net-30, net-60, etc.) if the supplier hasn't already provided them. Fold this naturally into the pricing ask alongside MOQ and lead time.
- ASK ONLY WHAT'S RELEVANT — do NOT ask for hazmat / DOT / dangerous-goods / special-handling details unless the material is actually hazardous or the supplier themselves raised it. For a non-hazardous material, never request hazmat classification. Do not hard-block or withhold a pricing ask because details are missing.
- KEEP INQUIRING UNTIL COMPLETE. If the input lists "Still needed to complete this quote", those are approval-required details we do not have yet. When the supplier is engaged (not declining), ask for all of them in one concise, organized question. Never re-ask for something already provided, and never ask the supplier to pick or suggest a grade.
- Be concise (3-6 sentences). Warm, businesslike, no fluff.
- NEVER invent prices, quantities, commitments, ship dates, or terms. If a specific is needed, ask for it rather than stating one.
- SHIP-TO: the input may include a "Confirmed ship-to" line, synced from our system of record. When present, that destination is verified and you SHOULD give it if the supplier asks where the material ships, or when a destination helps them quote freight. Quote it EXACTLY as written; never append a street address, building number, or suite to it. When there is no "Confirmed ship-to" line, DEFER — say the delivery location will be confirmed shortly — and never guess a city, state, or ZIP.
- NEVER state a street address, phone number, or email address. You do not have real ones. If a supplier asks for a full mailing address or a contact number (e.g. to "assign a representative"), DEFER — say it will be provided once terms are agreed, and keep the thread as the point of contact. Do not make one up under any circumstances.
- Do not fabricate names or sign with a real person's name — end with the team sign-off provided.
- In ghost mode, only reference the ghost brand; never name the underlying client.
- Attachments: if the input lists files the supplier attached to this reply, treat them as RECEIVED. NEVER tell the supplier an attachment didn't arrive / isn't coming through / is missing, and never ask them to resend or re-share it. Acknowledge it (e.g. "thanks, we've got your quote/price sheet") and, if pricing was already read from it, say you're reviewing it. Only ask for a specific document if it is genuinely not among the attached files.

Also judge engagement: set "engaged" true when the supplier showed genuine interest or willingness IN OUR REQUESTED MATERIAL (gave pricing for it, asked a question about it, requested a sample/spec, said they can supply it, or otherwise moved that sourcing forward); false for a decline / "can't supply our material" / out-of-office / automated / off-topic message. A reply that declines our material and only pitches other materials we did not ask for is NOT engagement — set "engaged" false and do not introduce held materials.

If "Other materials we also source from this supplier" is provided AND engaged is true, ALSO briefly introduce those materials in the same reply — naturally ask whether they can supply/quote them too (one short sentence or a compact list, never a wall of items). List the exact material names you introduced in "introduced_materials". If engaged is false, do NOT introduce them and return "introduced_materials": [].

Return ONLY a JSON object: {"subject": "...", "body": "...", "engaged": true|false, "introduced_materials": ["..."]}. The body is plain text with line breaks; no greeting placeholders left unfilled.`;

function extractJson(text: string): ComposedReply {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in reply output");
  const obj = JSON.parse(candidate.slice(start, end + 1));
  return {
    subject: String(obj.subject ?? ""),
    body: String(obj.body ?? ""),
    engaged: obj.engaged === true,
    introducedMaterials: Array.isArray(obj.introduced_materials) ? obj.introduced_materials.map((m: any) => String(m)) : [],
  };
}

export async function composeReply(input: ReplyInput): Promise<ComposedReply> {
  const signoff = input.mode === "ghost" ? `${input.ghostBrand ?? "Sourcing"} Sourcing` : `${input.clientOrgName} Purchasing Team`;
  const held = (input.heldMaterialNames ?? []).filter((n) => n && n.trim());
  const atts = (input.receivedAttachments ?? []).filter((a) => a && a.name && a.name.trim());
  // Backlog #14: still-missing approval-required fields, honored only when the
  // completeness follow-up flag is on. Empty when off, so behavior is unchanged.
  const missing: MissingApprovalField[] = completenessFollowupEnabled()
    ? (input.missingApprovalFields ?? []).filter((m) => m && m.key && m.clause)
    : [];
  const lines = [
    `Mode: ${input.mode}`,
    `Sign off as: ${signoff}`,
    `Supplier company: ${input.supplierName ?? "(unknown)"}`,
    `Supplier contact: ${input.supplierContactName ?? "(unknown)"}`,
    `Material being sourced: ${input.materialName ?? "(unspecified)"}`,
    `Our original outreach subject: ${input.originalSubject ?? "(none)"}`,
    `Their reply subject: ${input.theirSubject ?? "(none)"}`,
    `Their message (snippet): ${input.theirPreview ?? "(not available)"}`,
    ...(input.shipToRegion ? [`Confirmed ship-to: ${input.shipToRegion}`] : []),
    ...(atts.length
      ? [
          "",
          `The supplier ATTACHED ${atts.length} file(s) to this reply: ${atts
            .map((a) => a.name + (a.pricingExtracted ? " [pricing already read from this file]" : ""))
            .join(", ")}.`,
          `These files DID come through to us. Do NOT say the attachment is missing or ask them to resend it — acknowledge receipt.`,
        ]
      : []),
    ...(held.length ? ["", `Other materials we also source from this supplier (introduce only if engaged): ${held.join(", ")}`] : []),
    ...(missing.length
      ? [
          "",
          `Still needed to complete this quote (ask for the all only, naturally, if the supplier is engaged; do not list them all, and never ask them to choose a grade): ${missing
            .map((m) => m.clause)
            .join("; ")}`,
        ]
      : []),
    ...(input.threadContext
      ? ["", "Full thread so far (oldest first — use it to avoid repeating yourself and to answer what they actually asked):", input.threadContext]
      : []),
    "",
    "Draft the reply.",
  ].join("\n");

  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{ role: "user", content: lines }],
  });
  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  const draft = extractJson(text);
  if (!draft.subject) {
    draft.subject = input.theirSubject ? `Re: ${input.theirSubject.replace(/^re:\s*/i, "")}` : `Re: ${input.materialName ?? "your message"}`;
  }

  // Deterministic completeness backstop: one canonical question always lists
  // every missing supplier/quote field. This guarantees coverage regardless of
  // how the model phrases its conversational response.
  if (missing.length && draft.engaged && draft.body) {
    const ask = buildCompletenessAsk(missing);
    if (ask && !draft.body.includes(ask)) draft.body = insertBeforeSignoff(draft.body, ask, signoff);
  }
  return draft;
}

// Insert `ask` as its own paragraph just before the sign-off block, or append it
// to the end when the sign-off can't be located. No em dashes are introduced.
function insertBeforeSignoff(body: string, ask: string, signoff: string): string {
  const trimmed = body.trimEnd();
  const idx = signoff ? trimmed.indexOf(signoff) : -1;
  if (idx > 0) {
    // Back up over any short sign-off lead-in ("Thanks,", "Best,", etc.).
    let cut = trimmed.lastIndexOf("\n", idx);
    const lead = /\n\s*(thanks|thank you|best|regards|warm regards|sincerely)[,!.]?\s*$/i;
    const upto = cut > 0 ? trimmed.slice(0, cut) : trimmed.slice(0, idx);
    const m = upto.match(lead);
    const head = m ? upto.slice(0, m.index) : upto;
    const tail = trimmed.slice(head.length).replace(/^\n+/, "");
    return `${head.trimEnd()}\n\n${ask}\n\n${tail}`;
  }
  return `${trimmed}\n\n${ask}`;
}
