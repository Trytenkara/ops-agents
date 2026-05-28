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
const MAX_WEB_USES = 10;       // cap per material to keep cost bounded
const MAX_OUTPUT_TOKENS = 4096;
const URL_PROBE_TIMEOUT_MS = 5_000;

export interface ScoutSupplier {
  supplier_name: string;
  url: string;
  country: string | null;
  email: string | null;
  site_type: "M" | "MS" | "N" | null;  // Marketplace / Marketplace-Signup / Non-marketplace
  confidence_hint: "strong" | "medium" | "lead";
  notes: string | null;
  source_citations: string[];          // URLs the model cited
}

const SYSTEM_PROMPT = `You are a B2B sourcing analyst. Given an ingredient/material, find suppliers that sell it in bulk to manufacturers.

Use the web_search tool aggressively. Run multiple queries per material:
- Generic: "<material> bulk supplier wholesale B2B manufacturer"
- India: "<material> manufacturer India bulk wholesale 25kg"
- China: "<material> manufacturer China bulk supplier exporter"
- Europe: "<material> manufacturer Europe pharmaceutical"
- If a trade name / brand is provided, also: "<trade> authorized distributor" and "<trade> Knowde"

Classify each supplier's site type:
- M  (Marketplace)         — online checkout, no signup. e.g. BulkSupplements, Lab Alley, Spectrum Chemical, PureBulk, Nutricost, Ingredi.
- MS (Marketplace-Signup)  — online checkout after registration. e.g. Knowde, IndiaMART, Alibaba, Made-in-China, Pharmaoffer, Ingredients Online.
- N  (Non-marketplace)     — quote/RFQ only. e.g. Lonza, Cargill, Brenntag, Univar, Ajinomoto, NuLiv, OmniActive.

Confidence:
- strong  — primary manufacturer or named authorized distributor.
- medium  — reputable distributor/marketplace; authorization unverified.
- lead    — needs human follow-up (unknown reseller, thin signal).

For trademark-bearing ingredients, only the brand owner / their named distributors are "strong". Unauthorized resellers are "lead".

Return ONLY a JSON code block (no prose around it) with this exact shape:

\`\`\`json
{
  "suppliers": [
    {
      "supplier_name": "string",
      "url":           "https://...",
      "country":       "string or null",
      "email":         "sales@... or null",
      "site_type":     "M | MS | N",
      "confidence_hint": "strong | medium | lead",
      "notes":         "one-line note or null",
      "source_citations": ["https://...", "..."]
    }
  ]
}
\`\`\`

Rules:
- Cap at 12 suppliers per material — quality over quantity.
- Skip suppliers without a usable public URL.
- Do NOT include retail consumer brands (Amazon listings, eBay, Walmart, Etsy).
- Do NOT fabricate URLs — only include URLs you actually visited via web_search.
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
    const res = await anthropic().messages.create({
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
    candidates.push({
      supplier_name: String((s as any).supplier_name ?? "").trim() || host,
      url,
      country: (s as any).country ?? null,
      email: (s as any).email ?? null,
      site_type: site_type === "M" || site_type === "MS" || site_type === "N" ? site_type : null,
      confidence_hint: confidence_hint === "strong" || confidence_hint === "medium" || confidence_hint === "lead"
        ? confidence_hint
        : "lead",
      notes: (s as any).notes ?? null,
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

  return live;
}

export function scoreScoutConfidence(hint: ScoutSupplier["confidence_hint"]): number {
  // Web-discovered leads should sit below graph-derived leads, even when
  // the model marks them "strong" — operators verify before promoting.
  switch (hint) {
    case "strong": return 0.65;
    case "medium": return 0.55;
    case "lead":   return 0.45;
  }
}
