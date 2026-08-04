import Anthropic from "@anthropic-ai/sdk";
import type { MaterialRow } from "./sql";
import { materialLabel } from "@/lib/material-label";

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

const MODEL = "claude-sonnet-5";
const EFFORT = "medium";          // measured: same 100-supplier breadth as high, fewer tokens
const MAX_OUTPUT_TOKENS = 40000;  // room for up to ~100 supplier rows with the full detail schema
const MAX_SUPPLIERS = 100;
const URL_PROBE_TIMEOUT_MS = 5_000;
// Breadth is split across PASSES that run concurrently, because a single
// ~96-search call takes 650-820s end-to-end — longer than the cron function's
// 800s maxDuration, so it could never finish inside a run no matter how high
// the per-call ceiling went. Narrow scoped passes cover the same landscape in
// roughly the time of the slowest one, and a pass that fails costs a fifth of
// the landscape instead of all of it. Sized from measurement: ~8s per search
// plus generation, so a pass must stay small to clear its ceiling reliably —
// 36-search passes were still hitting a 420s ceiling intermittently.
// Measured in prod: a 22-search pass lands at 282-308s when its scope is thin
// (majors, west) but the output-heavy scopes (asia, distributors, marketplace
// generate 2-3x the rows) ran past a 420s ceiling. Passes are concurrent, so
// the ceiling only has to leave the 800s route budget room for graph work, URL
// probing and inserts — not to be divided between passes.
// Measured across 4 prod configurations: a 22-search pass lands anywhere from
// 220s to past 600s for the SAME scope on different runs, and lowering
// concurrency did not fix it (3 concurrent passes still lost 2 to the ceiling).
// The variance is per-search latency, and it scales with search count, so the
// fix is a smaller unit of work rather than a higher ceiling: the route's 800s
// maxDuration caps how long we can ever wait. 12 searches keeps a pass well
// under the ceiling; rotation covers the whole landscape across runs instead.
const MAX_WEB_USES_PER_PASS = 12;
const SCOUT_CALL_TIMEOUT_MS = 600_000;
const PASSES_PER_RUN = 3;

// Each pass owns one slice of the landscape the system prompt defines. Together
// they cover all four buckets; overlap is harmless (merge dedups by host).
const SCOUT_PASSES: { key: string; focus: string }[] = [
  {
    key: "majors",
    focus:
      "Originator / branded manufacturers only — the trademark owners and the known major producers (BASF, Solvay, Stepan, Croda, Evonik, KLK OLEO, Galaxy Surfactants, Clariant, Innospec, Nouryon, Zschimmer & Schwarz, Jarchem, Pilot Chemical, and the recognised majors for this specific material). Run one query per producer against this material and include every one that actually makes it.",
  },
  {
    key: "distributors",
    focus:
      "Distributors and traders only (Univar, Brenntag, Azelis, IMCD, DeWolf, Parchem, Silver Fern, Shay & Company, and regional equivalents), plus the chemical/pharma B2B directories that publish direct sales emails: Chemondis, Knowde, Pharmaoffer, Echemi, ChemicalBook, Molbase, ChemBid, UL Prospector, Chemical Register.",
  },
  {
    key: "asia",
    focus:
      "Bulk manufacturers in India and China only. Use the India and China query patterns (bulk wholesale 25kg, exporter, manufacturer) including their pharma-grade variants.",
  },
  {
    key: "west",
    focus:
      "Bulk manufacturers in Europe and the USA only, including pharmaceutical/food grade producers (USP/EP manufacturer, DMF holders) and EU-language queries.",
  },
  {
    key: "marketplace",
    focus:
      "B2B marketplace seller listings only. Drill INTO the platform result pages on IndiaMART, Alibaba, Made-in-China and TradeIndia and return AT LEAST 6-8 individual seller companies per platform, each as its own row with its own company name, price/MOQ and contact path. Do not return the platform itself as a row.",
  },
  {
    key: "retail",
    focus:
      "Bulk and retail shops with published price ladders only: US shops (Bulk Apothecary, MakingCosmetics, Lotioncrafter, Wholesale Supplies Plus, Lab Alley, PureBulk, Ingredi) and EU specialty cosmetic-ingredient shops (Lerochem, Alexmo, Handymade, Gracefruit), plus anything surfaced by price-per-kg and buy-bulk queries. Capture the full pack-size price ladder for each.",
  },
];

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

BREADTH IS THE PRIMARY GOAL. A good run returns as many legitimate suppliers as the market holds — aim for 80-100+ spanning the full landscape, NOT a short list of the biggest names. Do NOT stop at 20, and do NOT stop at 60: keep issuing searches across regions and channels until the landscape is genuinely exhausted. You MUST cover every bucket below and return each legitimate supplier you find in it:
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

CLASSIFY each supplier's site type. THE DECIDING TEST IS CHECKOUT, NOT A VISIBLE PRICE: a site is only M/MS if you can actually place the order online (add-to-cart / buy-now / online checkout / online order). A page that merely shows a price or price range but has NO way to check out is NOT a marketplace, it is a price listing (classify N). Same for a B2B listing that shows list pricing but routes every order through a quote/inquiry form (classify N). Do not upgrade to M/MS just because a number is printed on the page.
- M  (Marketplace)         — online checkout, no signup. There is a working add-to-cart / buy-now path. e.g. BulkSupplements, Lab Alley, Spectrum Chemical, PureBulk, Nutricost, Ingredi.
- MS (Marketplace-Signup)  — online checkout after registration (checkout exists, but only once you sign up / log in). e.g. Knowde, IndiaMART, Alibaba, Made-in-China, Pharmaoffer, Ingredients Online.
- N  (Non-marketplace)     — no online checkout: quote/RFQ only, OR a plain price listing / B2B listing that shows pricing but has no way to buy online. e.g. Lonza, Cargill, Brenntag, Univar, Ajinomoto, NuLiv, OmniActive.

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
- Return up to 100 suppliers per material, spread across the four buckets above. Aim for 80+ when the market supports it; do NOT stop at 15-20 or 60 — keep searching until you've genuinely exhausted the major producers, regional manufacturers, distributors, and individual marketplace sellers.
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

function buildUserMessage(material: MaterialRow, focus: string): string {
  const parts: string[] = [];
  parts.push(`Material to source:`);
  if (material.name) parts.push(`  name: ${material.name}`);
  if (material.trade_name) parts.push(`  trade name: ${material.trade_name}`);
  if (material.inci) parts.push(`  INCI: ${material.inci}`);
  parts.push("");
  parts.push(`THIS RUN'S SCOPE — search for these suppliers only: ${focus}`);
  parts.push("");
  parts.push(
    "Other buckets are covered by parallel runs, so do not spend searches on them. Your search budget is small, so make each search wide and harvest every supplier named on the result pages you get (aim for 20+), applying all classification and field rules from the system prompt."
  );
  return parts.join("\n");
}

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0) throw new Error("no JSON object found in model output");
  if (end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // fall through to salvage
    }
  }
  // A pass that runs out of output tokens leaves the array unterminated, which
  // used to discard every supplier it had already written. Salvage the complete
  // objects instead: scan for balanced top-level braces inside "suppliers".
  const arrStart = candidate.indexOf("[", candidate.indexOf("suppliers"));
  if (arrStart < 0) throw new Error("no JSON object found in model output");
  const salvaged: any[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = arrStart; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          salvaged.push(JSON.parse(candidate.slice(objStart, i + 1)));
        } catch {
          // skip the one malformed object
        }
        objStart = -1;
      }
    }
  }
  if (!salvaged.length) throw new Error("no JSON object found in model output");
  return { suppliers: salvaged };
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
  const matLabel = materialLabel(material, material.id) as string;

  // Stream the response: each pass issues up to MAX_WEB_USES_PER_PASS server-side
  // web searches, which runs past the 6-minute gateway timeout on a non-streaming
  // request (observed: consistent 524s). Streaming keeps the connection alive.
  async function runPass(pass: { key: string; focus: string }): Promise<ScoutSupplier[]> {
    const startedAt = Date.now();
    const stream = anthropic().messages.stream({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: EFFORT },
      system: SYSTEM_PROMPT,
      tools: [{
        type: "web_search_20260209",
        name: "web_search",
        max_uses: MAX_WEB_USES_PER_PASS,
      } as any],
      messages: [{ role: "user", content: buildUserMessage(material, pass.focus) }],
    } as any);
    // Accumulate text as it streams. abort() rejects finalMessage(), so without
    // this every supplier the model had already written is lost — the pass reports
    // "Request was aborted" and returns nothing, even when it was nearly done.
    let streamed = "";
    stream.on("text", (delta: string) => {
      streamed += delta;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stream.abort();
    }, SCOUT_CALL_TIMEOUT_MS);
    let raw: string;
    try {
      const res = await stream.finalMessage();
      raw = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    } catch (err) {
      // Only our own timeout is recoverable, and only once the model had begun
      // writing JSON. Real API errors — and timeouts that landed while it was
      // still searching — keep their original error, which is the true cause.
      // extractJson salvages the complete objects out of the unterminated array.
      if (!timedOut || !streamed.includes("{")) throw err;
      raw = streamed;
    } finally {
      clearTimeout(timer);
    }
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const found = extractJson(raw).suppliers;
    const list = Array.isArray(found) ? found : [];
    await log(
      `scout: pass ${pass.key} returned ${list.length} for ${matLabel} in ${secs}s${timedOut ? " (salvaged from timeout)" : ""}`,
      { material_id: material.id, pass: pass.key, secs, count: list.length, salvaged: timedOut }
    );
    return list;
  }

  // Run a rotating SLICE of the passes per invocation, not all of them. Measured
  // in prod: 5 concurrent passes → 3 finished, 6 concurrent → 2 finished, so
  // per-pass latency degrades with concurrency (shared web_search throughput).
  // Fewer at a time all complete, and breadth still accumulates across runs
  // because excludeHosts means each scout only adds hosts we don't already have.
  // The slice rotates hourly, so successive scouts of a material (6-12h apart)
  // cover different buckets.
  const offset =
    (Array.from(material.id).reduce((a, ch) => a + ch.charCodeAt(0), 0) +
      Math.floor(Date.now() / 3_600_000)) %
    SCOUT_PASSES.length;
  const slice = Array.from(
    { length: PASSES_PER_RUN },
    (_, i) => SCOUT_PASSES[(offset + i) % SCOUT_PASSES.length]
  );
  await log(`scout: running passes ${slice.map((p) => p.key).join(", ")} for ${matLabel}`, {
    material_id: material.id,
  });
  const settled = await Promise.allSettled(slice.map(runPass));
  const suppliers: ScoutSupplier[] = [];
  const failures: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") suppliers.push(...r.value);
    else failures.push(`${slice[i].key}: ${r.reason?.message ?? r.reason}`);
  });
  if (failures.length) {
    await log(`scout: ${failures.length}/${slice.length} passes failed for ${matLabel} — ${failures.join("; ")}`, {
      material_id: material.id, level: "warn",
    });
  }
  // All passes down means the scout is broken (model/timeout/key), not that the
  // market is empty. Throw so the caller records a hard failure and retries next
  // window instead of banking a "0 new suppliers" result and backing off.
  if (failures.length === slice.length) {
    throw new Error(`all ${slice.length} scout passes failed: ${failures.join("; ")}`);
  }

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

// Human-readable rationale for scoreScoutConfidence, stored on the lead so the
// reason is visible to operators instead of just the bare score.
export function describeScoutConfidence(hint: ScoutSupplier["confidence_hint"]): string {
  switch (hint) {
    case "strong": return "High — primary/branded manufacturer or named authorized distributor";
    case "medium": return "Med — reputable distributor/marketplace, authorization unverified";
    case "lead":   return "Low — unverified reseller / thin signal, needs human follow-up";
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
