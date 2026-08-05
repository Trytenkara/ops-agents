import Anthropic from "@anthropic-ai/sdk";

// Reads contact details off page text the crawl already fetched.
//
// The regex battery in enrich.ts only matches the formats it was written for.
// Measured 2026-08-05: across 8,109 enriched leads with a website and no email,
// the named-POC extractor had produced zero names, and a page printing
// "Phone: 86 - 175 - 03221173 / Contact: kevin zhao" read as "no phone, no
// contact" because the number is grouped 2-3-8 with no plus and the label is
// "Contact" rather than a job title. Every unanticipated layout, separator or
// language is invisible to a pattern list, and the list can only ever grow by
// one page at a time.
//
// So the residual is read instead of matched. This runs ONLY when the patterns
// came back empty, on text already in memory (no extra fetch), and it is told
// to copy what is printed rather than infer: a supplier we invent an address
// for is worse than one we leave blank.

const MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 400;
const MAX_CHARS_PER_PAGE = 6000;
const MAX_PAGES = 4;

export interface ReadContact {
  email: string | null;
  phone: string | null;
  poc_name: string | null;
  poc_title: string | null;
}

export interface ContactPage {
  url: string;
  html: string;
}

const SYSTEM_PROMPT = `You read contact details off a supplier's web page. You copy, you do not infer.

Return ONLY a JSON object, no prose:
{"email": string|null, "phone": string|null, "poc_name": string|null, "poc_title": string|null}

Rules:
- Copy values exactly as printed. Keep the phone's country code; strip nothing but surrounding label text. "Phone: 86 - 175 - 03221173" is a phone.
- Any format, any separator, any language counts (Tel, Tél, Telefon, 电话, Mobile, WhatsApp, Contact, Kontakt, Ansprechpartner, 联系人).
- poc_name is a specific human named on the page. A department ("Sales Team"), a company name, or a page label ("Contact Us") is NOT a name. Copy the name in the case it is printed.
- poc_title only when the page states that person's role. Otherwise null.
- Never construct an address from a name and a domain. Never return an example, placeholder or template value.
- Prefer a sales or general enquiry contact over careers, press, abuse, webmaster, privacy or legal.
- A value you cannot see on the page is null.`;

function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The contact block is usually near a contact-ish word, and the page is usually
// far longer than the block. Keep the neighbourhoods of those words rather than
// the first N characters, which on a long homepage is all navigation.
const ANCHOR_RE =
  /(e-?mail|mail to|tel\b|tél|telefon|phone|mobile|whatsapp|wechat|fax|contact|kontakt|enquir|inquir|ansprechpartner|电话|邮箱|联系)/gi;

function condense(text: string): string {
  if (text.length <= MAX_CHARS_PER_PAGE) return text;
  const spans: [number, number][] = [];
  for (const m of text.matchAll(ANCHOR_RE)) {
    const i = m.index ?? 0;
    spans.push([Math.max(0, i - 300), Math.min(text.length, i + 500)]);
  }
  if (!spans.length) return text.slice(0, MAX_CHARS_PER_PAGE);
  const merged: [number, number][] = [];
  for (const s of spans.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s] as [number, number]);
  }
  let out = "";
  for (const [a, b] of merged) {
    if (out.length >= MAX_CHARS_PER_PAGE) break;
    out += text.slice(a, b) + "\n...\n";
  }
  return out.slice(0, MAX_CHARS_PER_PAGE);
}

const CONTACTISH_URL = /contact|kontakt|about|impressum|enquir|inquir|sales|company|team/i;

function parseJson(raw: string): ReadContact | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const s = (v: unknown) => {
      const t = typeof v === "string" ? v.trim() : "";
      return t && t.toLowerCase() !== "null" ? t : null;
    };
    return { email: s(o.email)?.toLowerCase() ?? null, phone: s(o.phone), poc_name: s(o.poc_name), poc_title: s(o.poc_title) };
  } catch {
    return null;
  }
}

export async function readContactsFromPages(
  supplierName: string,
  pages: ContactPage[]
): Promise<ReadContact | null> {
  if (!process.env.ANTHROPIC_API_KEY || !pages.length) return null;

  // Contact pages first, then whatever else loaded, so the budget is spent on
  // the pages that carry the block.
  const ordered = [...pages].sort(
    (a, b) => Number(CONTACTISH_URL.test(b.url)) - Number(CONTACTISH_URL.test(a.url))
  );
  const blocks: string[] = [];
  for (const p of ordered.slice(0, MAX_PAGES)) {
    const text = condense(toText(p.html));
    if (text.length > 40) blocks.push(`--- ${p.url}\n${text}`);
  }
  if (!blocks.length) return null;

  try {
    const res = await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Supplier: ${supplierName}\n\n${blocks.join("\n\n")}` }],
    });
    const raw = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const out = parseJson(raw);
    if (!out) return null;
    // The model is told to copy, but a returned address still has to look like
    // one before it can reach a draft.
    if (out.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(out.email)) out.email = null;
    if (out.phone && (out.phone.replace(/\D/g, "").length < 7 || out.phone.replace(/\D/g, "").length > 15)) out.phone = null;
    if (out.poc_name && (out.poc_name.length > 60 || !/[a-zÀ-ɏ一-鿿]/i.test(out.poc_name))) out.poc_name = null;
    return out.email || out.phone || out.poc_name ? out : null;
  } catch {
    return null;
  }
}
