import Anthropic from "@anthropic-ai/sdk";
import type { MaterialRow } from "./sql";

// Web-discovery layer for Agent 03. When Tenkara's supplier graph returns
// nothing (or thin coverage) for a material, this asks Anthropic with the
// server-side web_search tool to surface fresh B2B/marketplace suppliers.
//
// Query patterns mirror Ben's manual "Tenkara Supplier Sourcing" SKILL:
//   - "<inci|name> bulk supplier wholesale B2B manufacturer"
//   - "<inci|name> manufacturer India bulk wholesale"
//   - "<inci|name> manufacturer China bulk supplier exporter"
//   - "<inci|name> manufacturer Europe pharmaceutical"
//   - For branded ingredients: "<trade> Knowde" + "<trade> authorized distributor"
//
// The model performs the searches itself (web_search is a server-side tool);
// we just instruct it on what to look for and ask for a structured response.

const MODEL = "claude-opus-4-5";
const MAX_WEB_USES = 64;       // breadth budget — covers majors pass + marketplace seller drill-in + regional manufacturers + retail/EU shops
const MAX_OUTPUT_TOKENS = 24000;  // room for 40-60 supplier rows with the full detail schema
const MAX_SUPPLIERS = 60;
const URL_PROBE_TIMEOUT_MS = 5_000;

// Field set mirrors Ben's "Vita Organica – Supplier Sourcing" sheet so a scout
// lead carries the same actionable columns a human researcher would capture:
// trade name, role, pack sizes & pricing, contact (email/phone/path), HQ,
// background, grades offered, certifications, and MOQ.
export interface ScoutSupplier {
  supplier_name: string;
  trade_name: string | null;            // branded line, e.g. Hostapon SCI-85 P (kept out of supplier_name)
  url: string;
  country: string | null;
  role: string | null;                  // Manufacturer | Distributor | Reseller | Trader | Marketplace
  site_type: "M" | "MS" | "N" | null;   // Marketplace / Marketplace-Signup / Non-marketplace
  pack_sizes_pricing: string | null;    // published pack sizes + prices / FOB ranges
  email: string | null;                 // direct email OR contact path ("via IndiaMART inquiry")
  phone: string | null;                 // direct phone OR contact path
  hq_address: string | null;
  supplier_background: string | null;
  grades_offered: string | null;        // e.g. "SCI 80 / 85 powder, granule, noodle"
  certifications: string | null;        // e.g. "ISO 9001, Halal, Kosher, REACH"
  moq: string | null;                   // minimum order, e.g. "25 kg drum", "1,000 kg"
  confidence_hint: "strong" | "medium" | "lead";
  notes: string | null;
  source_citations: string[];           // URLs the model cited
}

const SYSTEM_PROMPT = `You are a B2B sourcing analyst building a BROAD supplier landscape for a procurement team. Given an ingredient/material, find as many legitimate bulk suppliers as you can across the whole market, and capture the sourcing details a buyer needs to RFQ where they're available.

BREADTH IS THE PRIMARY GOAL. A good run returns 40-60 suppliers spanning the full landscape — NOT a short list of the biggest names. Do NOT stop at 20: keep issuing searches across regions and channels until the landscape is genuinely exhausted. You MUST cover every bucket below and return each legitimate supplier you find in it:
1. Originator / branded manufacturers — the trademark owners (e.g. for SCI: BASF Jordapon, Clariant Hostapon, Innospec Pureact/Iselux, Galaxy Galsoft). Never omit these.
2. Regional bulk manufacturers — India, China, EU, and USA producers.
3. Distributors & traders — e.g. Univar, Brenntag, Azelis, IMCD, DeWolf, Parchem, Silver Fern.
4. Marketplace & retail listings WITH published prices — IndiaMART, Alibaba, Made-in-China, TradeIndia sellers; bulk/retail shops like Bulk Apothecary, Natural Bulk Supplies, Wholesale Supplies Plus, MakingCosmetics, Lerochem, Alexmo, Shay & Company. These are where published price ladders live — they are valuable, not noise. Include them.

For marketplace category pages (IndiaMART, Alibaba, Made-in-China, TradeIndia): do NOT collapse them into a single "IndiaMART" row. Drill INTO the platform's result pages and return AT LEAST 6-8 individual seller companies per major marketplace, each as its own row with its own company name, price/MOQ, and contact path. Recording "IndiaMART (Marketplace)" as one row is a bug — it wastes the slot and hides the actual sellers.

DISCOVERY — use the web_search tool aggressively across regions and channels:
- Generic: "<material> bulk supplier wholesale B2B manufacturer"
- India: "<material> manufacturer India bulk wholesale 25kg" + "<material> IndiaMART" + "<material> TradeIndia"
- China: "<material> manufacturer China bulk supplier exporter" + "<material> Alibaba" + "<material> Made-in-China"
- Europe/USA: "<material> manufacturer Europe pharmaceutical" + "<material> supplier USA bulk"
- Originator brands: "<material> originator brand" + "<material> branded grade"
- KNOWN MAJOR PRODUCERS — always run one query per producer × the material and include any that actually make it: BASF, Solvay, Stepan, Croda, Evonik, KLK OLEO, Galaxy Surfactants, Clariant, Innospec, Nouryon, Zschimmer & Schwarz, Jarchem, Pilot Chemical. Missing a major producer that clearly makes this material is a failed run.
- Distributor networks: "<material> distributor Univar Brenntag Azelis IMCD DeWolf Silver Fern Shay"
- Retail/marketplace price ladders: "<material> price per kg" + "<material> buy bulk powder"
- US specialty distributors: also check Shay & Company, Silver Fern Chemical, Making Cosmetics, Lotioncrafter, Bulk Apothecary for this material.
- EU specialty cosmetic-ingredient shops: "<material> kaufen" + "<material> acheter" — and check Lerochem, Alexmo Cosmetics, Handymade, Gracefruit.
- If a trade name / brand is provided, also: "<trade> authorized distributor" and "<trade> Knowde"
- CHEMICAL & PHARMA B2B DIRECTORIES (high value — these list manufacturers/distributors that publish DIRECT sales emails, not inquiry relays): search "<material>" on Chemondis, Knowde, Pharmaoffer, Echemi, ChemicalBook, Molbase, ChemBid, GoodScents / UL Prospector, Tradewheel, and Chemical Register. For a pharma/USP grade also: "<material> USP EP manufacturer DMF". Prefer these over generic marketplaces when both list the same supplier — they surface a reachable email.

CONTACTABILITY: a supplier we can email is worth far more than one reachable only through a marketplace inquiry form. When a source publishes a direct sales/purchasing email (sales@, info@, export@ at the supplier's own domain), CAPTURE IT — do not settle for "via IndiaMART inquiry" when the same company has a real website with an address. Still include inquiry-only listings, but make sure the run also covers directly-emailable manufacturers and distributors, not just marketplace relays.

DETAIL IS SECONDARY TO BREADTH. Capture pricing, contact, MOQ, grades, and certifications where they're readily visible, but NEVER drop a legitimate supplier just because its detail is thin. Fill what you find, leave the rest null. Do not fabricate. Do not spend so long extracting detail on one supplier that you fail to cover the rest of the market.

CLASSIFY each supplier's site type:
- M  (Marketplace)         — online checkout, no signup. e.g. BulkSupplements, Lab Alley, Spectrum Chemical, PureBulk, Nutricost, Ingredi.
- MS (Marketplace-Signup)  — online checkout after registration. e.g. Knowde, IndiaMART, Alibaba, Made-in-China, Pharmaoffer, Ingredients Online.
- N  (Non-marketplace)     — quote/RFQ only. e.g. Lonza, Cargill, Brenntag, Univar, Ajinomoto, NuLiv, OmniActive.

ROLE — also tag the supplier's role in the chain: "Manufacturer", "Distributor", "Reseller", "Trader", or "Marketplace". Buyers prefer going direct to manufacturers, so this matters independently of site type.

CONFIDENCE:
- strong  — primary manufacturer or named authorized distributor.
- medium  — reputable distributor/marketplace; authorization unverified.
- lead    — needs human follow-up (unknown reseller, thin signal).
For trademark-bearing ingredients, only the brand owner / their named distributors are "strong". Unauthorized resellers are "lead".
Primary manufacturers of a branded product line are ALWAYS strong — e.g. Galaxy Surfactants (Galsoft), Clariant (Hostapon), BASF (Jordapon), Innospec (Pureact/Iselux), and the makers of Chemoryl and Elfan. Never rate a clear primary/branded manufacturer below strong.

FIELD RULES:
- supplier_name: the company's name only. Put any branded product line in trade_name, NOT in supplier_name (e.g. supplier_name "Clariant", trade_name "Hostapon SCI-85 P").
- pack_sizes_pricing: published pack sizes with prices or FOB ranges, e.g. "25 kg drum, $2.00–8.00/kg FOB" or "1 lb $12.76; 55 lb $312.95". Null only if truly none published.
- email / phone: the direct address/number if public. If contact is only via a form/relay, record the PATH instead of null, e.g. "via IndiaMART inquiry", "contact form on /contact".
- moq: minimum order, e.g. "25 kg drum", "1,000 kg", "1 lb".
- grades_offered: grades/forms available, e.g. "SCI 80 / 85 powder, granule, noodle".
- certifications: e.g. "ISO 9001, ISO 14001, Halal, Kosher, REACH". Null if none stated.
- supplier_background: one-line description of the company (capacity, years, focus).

Return ONLY a JSON code block (no prose around it) with this exact shape:

\`\`\`json
{
  "suppliers": [
    {
      "supplier_name":      "string",
      "trade_name":         "string or null",
      "url":                "https://...",
      "country":            "string or null",
      "role":               "Manufacturer | Distributor | Reseller | Trader | Marketplace",
      "site_type":          "M | MS | N",
      "pack_sizes_pricing": "string or null",
      "email":              "sales@... or 'via X inquiry' or null",
      "phone":              "+.. or 'via X inquiry' or null",
      "hq_address":         "string or null",
      "supplier_background":"string or null",
      "grades_offered":     "string or null",
      "certifications":     "string or null",
      "moq":                "string or null",
      "confidence_hint":    "strong | medium | lead",
      "notes":              "one-line sourcing note or null",
      "source_citations":   ["https://...", "..."]
    }
  ]
}
\`\`\`

Rules:
- Return up to 60 suppliers per material, spread across the four buckets above. Aim for 40+ when the market supports it; do NOT stop at 15-20 — keep searching until you've genuinely exhausted the major producers, regional manufacturers, distributors, and individual marketplace sellers.
- A run that returns only manufacturers (or only marketplace listings) is incomplete — balance non-marketplace (manufacturers/distributors) AND marketplace/retail leads.
- Skip suppliers without a usable public URL.
- Do NOT include retail consumer brands (Amazon listings, eBay, Walmart, Etsy).
- Do NOT fabricate URLs, prices, or contacts — only include data you actually saw via web_search.
- url should be the supplier's company/product page, not a search engine result.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function buildUserMessage(material: MaterialRow): string {
  const parts: string[] = [];
  parts.push(`Material to source:`);
  if (material.name) parts.push(`  name: ${material.name}`);
  if (material.trade_name) parts.push(`  trade name: ${material.trade_name}`);
  if (material.inci) parts.push(`  INCI: ${material.inci}`);
  parts.push("");
  parts.push("Run the query patterns from the system prompt and return the JSON.");
  return parts.join("\n");
}

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeUrl(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch { return null; }
}

function hostOf(raw: string): string | null {
  try { return new URL(raw).host.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}

async function probeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TackleBox-Scout/1.0)" },
    });
    // Some hosts 405 on HEAD but serve GET. Treat any non-5xx as alive.
    if (res.status >= 200 && res.status < 500) return true;
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function scoutSuppliersForMaterial(material: MaterialRow, opts?: {
  excludeHosts?: Set<string>;
  log?: (msg: string, meta?: any) => Promise<void> | void;
}): Promise<ScoutSupplier[]> {
  const log = opts?.log ?? (async () => {});
  const matLabel = material.trade_name ?? material.name ?? material.id;

  let raw: string;
  try {
    // Stream the response: a breadth run issues up to MAX_WEB_USES server-side
    // web searches and emits ~16k tokens, which routinely runs past the 6-minute
    // gateway timeout on a non-streaming request (observed: consistent 524s).
    // Streaming keeps the connection alive for the full long-running operation.
    const stream = anthropic().messages.stream({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: MAX_WEB_USES,
      } as any],
      messages: [{ role: "user", content: buildUserMessage(material) }],
    });
    const res = await stream.finalMessage();
    raw = res.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (e: any) {
    await log(`scout: Anthropic call failed for ${matLabel}: ${e.message}`, { material_id: material.id });
    return [];
  }

  let parsed: { suppliers?: ScoutSupplier[] };
  try {
    parsed = extractJson(raw);
  } catch (e: any) {
    await log(`scout: failed to parse JSON for ${matLabel}: ${e.message}`, {
      material_id: material.id,
      raw_excerpt: raw.slice(0, 300),
    });
    return [];
  }

  const suppliers = Array.isArray(parsed.suppliers) ? parsed.suppliers : [];

  // Normalize, validate, dedup by host, drop excluded hosts.
  const seenHosts = new Set<string>();
  const candidates: ScoutSupplier[] = [];
  for (const s of suppliers) {
    if (!s || typeof s !== "object") continue;
    const url = normalizeUrl((s as any).url);
    if (!url) continue;
    const host = hostOf(url);
    if (!host) continue;
    if (opts?.excludeHosts?.has(host)) continue;
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);

    const site_type = (s as any).site_type;
    const confidence_hint = (s as any).confidence_hint;
    const str = (v: any): string | null => {
      if (typeof v !== "string") return null;
      const t = v.trim();
      return t ? t : null;
    };
    candidates.push({
      supplier_name: String((s as any).supplier_name ?? "").trim() || host,
      trade_name: str((s as any).trade_name),
      url,
      country: str((s as any).country),
      role: str((s as any).role),
      site_type: site_type === "M" || site_type === "MS" || site_type === "N" ? site_type : null,
      pack_sizes_pricing: str((s as any).pack_sizes_pricing),
      email: str((s as any).email),
      phone: str((s as any).phone),
      hq_address: str((s as any).hq_address),
      supplier_background: str((s as any).supplier_background),
      grades_offered: str((s as any).grades_offered),
      certifications: str((s as any).certifications),
      moq: str((s as any).moq),
      confidence_hint: confidence_hint === "strong" || confidence_hint === "medium" || confidence_hint === "lead"
        ? confidence_hint
        : "lead",
      notes: str((s as any).notes),
      source_citations: Array.isArray((s as any).source_citations)
        ? (s as any).source_citations.filter((u: any) => typeof u === "string").slice(0, 8)
        : [],
    });
  }

  await log(`scout: ${candidates.length} candidates from model for ${matLabel} (pre-probe)`, {
    material_id: material.id,
  });

  // URL-probe in parallel to drop dead links.
  const probed = await Promise.all(candidates.map(async (c) => ({ c, alive: await probeUrl(c.url) })));
  const live = probed.filter((p) => p.alive).map((p) => p.c);

  await log(`scout: ${live.length}/${candidates.length} live after URL probe for ${matLabel}`, {
    material_id: material.id,
    dropped: candidates.length - live.length,
  });

  return live.slice(0, MAX_SUPPLIERS);
}

export function scoreScoutConfidence(hint: ScoutSupplier["confidence_hint"]): number {
  // Ben's High/Med/Low calibration. A primary manufacturer of a branded line
  // (Galsoft, Hostapon, Jordapon, Pureact, Chemoryl, Elfan) should score clearly
  // above a small unverified trader, so we spread these out rather than bunching
  // every web lead near 0.5.
  switch (hint) {
    case "strong": return 0.80; // High — primary/branded manufacturer or named authorized distributor
    case "medium": return 0.60; // Med — reputable distributor/marketplace, authorization unverified
    case "lead":   return 0.35; // Low — unverified reseller / thin signal, needs human follow-up
  }
}

// How "ready to contact" a scout lead is, based on how many of the actionable
// sourcing fields came back filled. Lets operators sort the shortlist by the
// leads they can RFQ immediately vs. ones still needing research. Range 0..1.
export function scoutCompleteness(s: ScoutSupplier): number {
  const fields = [
    s.pack_sizes_pricing,
    s.email || s.phone,   // any contact path counts once
    s.moq,
    s.grades_offered,
    s.certifications,
    s.hq_address,
  ];
  const filled = fields.filter(Boolean).length;
  return Math.round((filled / fields.length) * 100) / 100;
}
