import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSupplierIdByName } from "@/lib/tenkara-supplier-linker";
import { aggregatorNameOfHost } from "@/lib/aggregator-hosts";
import {
  searchSuppliers,
  sourceReadyConfigured,
  SourceReadyUnavailableError,
  SourceReadyCreditsExceededError,
} from "@/lib/sourceready-client";

// SourceReady discovery, run in-process. Calls supplier_search_v3 over the
// upstream MCP endpoint, parses the markdown supplier profiles it answers with,
// dedups against the existing active leads for the (org, material), and stages
// the survivors as source='sourceready' stage='raw' leads.
//
// Exclusions passed here are best-effort noise reduction: Agent 04 re-applies
// client do-not-contact / excluded-country suppression before any email is sent.
//
// Disabled (no-op) unless SOURCEREADY_MCP_URL + SOURCEREADY_MCP_TOKEN are set.

// Paused while the per-fire cost is brought down (2026-08-11): the balance is
// spent, so a fire would fail anyway. This is a knob, not a verdict — clear
// SOURCEREADY_DISCOVERY_PAUSED once credits are topped up.
export function sourceReadyEnabled(): boolean {
  if (/^(1|true|yes|on)$/i.test((process.env.SOURCEREADY_DISCOVERY_PAUSED ?? "true").trim())) {
    return false;
  }
  return sourceReadyConfigured();
}

// Contact unlocking is an ops toggle, default OFF, because it is not a free upgrade:
// when the SourceReady contact-credit balance is spent, a search sent with
// unlock_contacts fails outright with CREDITS_EXCEED_LIMIT and returns NO suppliers,
// where the same search without it returns all of them. Leaving this on with an empty
// balance would silently starve discovery for exactly the real clients it is meant to
// help. Turn it on (SOURCEREADY_UNLOCK_CONTACTS=1) only when credits are topped up.
// Billed searches per fire, counting the material's own name plus trade aliases.
const MAX_TERMS_PER_FIRE = Math.max(
  1,
  Number(process.env.SOURCEREADY_MAX_TERMS_PER_FIRE ?? "") || 2
);

export function sourceReadyUnlockEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.SOURCEREADY_UNLOCK_CONTACTS ?? "").trim());
}

export interface SourceReadyRequest {
  oaOrgId: string | null;
  materialId: string;
  materialName: string;
  inci: string | null;
  tenkaraOrgId: string | null;
  excludeHosts: string[];
  excludedCountries: string[]; // client-configured country names (best-effort)
  size?: number;
  page?: number; // 1-based; each pass advances so repeated fires walk deeper
  // Pay to unmask supplier contacts on this fire. SourceReady bills a
  // view_supplier_contact credit per newly unlocked supplier, so this is on for
  // real clients only: their leads land with an address already attached, which
  // short-circuits the Agent 06 contact waterfall (crawl + Hunter/ZoomInfo/etc)
  // at its stage-0 seed. Internal test orgs keep crawling for free.
  unlockContacts?: boolean;
  aliases?: string[]; // trade names for the same material, tried when the primary term is dry
  // The term that won last time for this material. Every term tried is a billed
  // search, so starting from the known-good one turns a 5-call fan-out into 1.
  preferredTerm?: string;
  log?: (msg: string, meta?: Record<string, unknown>) => Promise<void> | void;
}

export interface SourceReadyResult {
  ok: boolean;
  received: number;
  inserted: number;
  reason?: string;
  unlocked: boolean;
  skipped: Record<string, number>;
  usedTerm?: string; // caller caches this so the next fire starts with it
  termsTried?: number;
}

interface ParsedProduct {
  name: string;
  price: string | null;
}

interface ParsedSupplier {
  supplier_id: string | null;
  supplier_name: string;
  address: string | null;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  country: string | null;
  certifications: string[];
  employee_count: string | null;
  business_types: string[];
  year_founded: number | null;
  target_markets: string[];
  highlights: string[];
  tags: string[];
  products: ParsedProduct[];
}

const FIELD_RE = /^-\s+\*\*(.+?)\*\*:\s?(.*)$/; // "- **Field**: value"
const SUPPLIER_MARKER_RE = /^\*\*Supplier\s+\d+\s+of\s+\d+\*\*/;

const clean = (s: string | null | undefined) =>
  (s ?? "").replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
// A contact the account hasn't paid to unlock renders as literal asterisks.
const isMasked = (s: string | null | undefined) => !s || /^[*\s,]+$/.test(s);
const isNA = (s: string | null | undefined) => /^(n\/a|none|null|-)$/i.test((s ?? "").trim());
const val = (s: string | null | undefined) => {
  const c = clean(s);
  return c && !isNA(c) ? c : null;
};
const splitCsv = (s: string | null | undefined) =>
  clean(s)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && !/^\*+$/.test(x) && !isNA(x));
const firstCsv = (s: string | null | undefined) => clean(s).split(",")[0]?.trim() ?? "";

// supplier_search_v3 answers in markdown, one "**Supplier N of M**" block per
// profile, rather than JSON — so the blocks are parsed structurally here.
export function parseSupplierMarkdown(md: string): ParsedSupplier[] {
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of md.split(/\r?\n/)) {
    if (SUPPLIER_MARKER_RE.test(line.trim())) {
      if (cur) blocks.push(cur);
      cur = [];
      continue;
    }
    if (cur) cur.push(line);
  }
  if (cur) blocks.push(cur);

  return blocks
    .map(parseBlock)
    .filter((s): s is ParsedSupplier => !!s.supplier_name && !/^\*+$/.test(s.supplier_name));
}

function parseBlock(bl: string[]): ParsedSupplier {
  const o: ParsedSupplier = {
    supplier_id: null, supplier_name: "", address: null, description: null,
    email: null, phone: null, website: null, country: null, certifications: [],
    employee_count: null, business_types: [], year_founded: null,
    target_markets: [], highlights: [], tags: [], products: [],
  };
  let i = 0;
  let inProducts = false;

  while (i < bl.length) {
    const raw = bl[i];
    const line = raw.trim();

    if (inProducts) {
      // product name is a 4-space "- <name>"; its subfields are indented deeper
      const nameM = raw.match(/^ {4}-\s+(?!\*\*)(.+)$/);
      const subM = raw.match(/^ {6,}-\s+(id|category|purchase_price|price):\s*(.*)$/);
      if (subM) {
        const prod = o.products[o.products.length - 1];
        if (prod && (subM[1] === "purchase_price" || subM[1] === "price")) {
          const v = subM[2].trim();
          if (v) prod.price = v;
        }
        i++;
        continue;
      }
      if (nameM) {
        o.products.push({ name: clean(nameM[1]), price: null });
        i++;
        continue;
      }
      if (FIELD_RE.test(line)) inProducts = false;
      else { i++; continue; }
    }

    const m = line.match(FIELD_RE);
    if (!m) { i++; continue; }
    const key = m[1].trim();
    const rawVal = m[2] ?? "";

    switch (key) {
      case "Supplier ID": o.supplier_id = val(rawVal); break;
      case "Supplier Name": o.supplier_name = clean(rawVal); break;
      case "Address": o.address = isMasked(rawVal) ? null : val(rawVal); break;
      case "Description": {
        // free text that wraps until the next top-level "- **" field
        const parts = [clean(rawVal)];
        let j = i + 1;
        while (j < bl.length && !FIELD_RE.test(bl[j].trim())) {
          if (bl[j].trim()) parts.push(clean(bl[j]));
          j++;
        }
        o.description = parts.filter(Boolean).join("\n\n") || null;
        i = j;
        continue;
      }
      case "Email": { const f = firstCsv(rawVal); o.email = isMasked(f) ? null : f; break; }
      case "Phone Numbers": { const f = firstCsv(rawVal); o.phone = isMasked(f) ? null : f; break; }
      case "Website": { const f = firstCsv(rawVal); o.website = f && !/^\*+$/.test(f) ? f : null; break; }
      case "Country": o.country = val(rawVal); break;
      case "Certifications": o.certifications = splitCsv(rawVal); break;
      case "Employee Count": o.employee_count = val(rawVal); break;
      case "Business Types": o.business_types = splitCsv(rawVal); break;
      case "Year Founded": {
        const n = parseInt(clean(rawVal), 10);
        o.year_founded = Number.isFinite(n) ? n : null;
        break;
      }
      case "Target Markets": o.target_markets = splitCsv(rawVal); break;
      case "Highlights": o.highlights = splitCsv(rawVal); break;
      case "Tags": o.tags = splitCsv(rawVal); break;
      case "Products": inProducts = true; break;
      default: break;
    }
    i++;
  }
  return o;
}

function hostOf(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const s = String(u).trim();
    const withProto = /^https?:\/\//i.test(s) ? s : `http://${s}`;
    return new URL(withProto).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

const normName = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Non-material-supplier denylist: freight forwarders / chartering / logistics /
// customs brokers move goods, they don't make the material — drop them.
// KEEP IN SYNC with the copy in importyeti.ts.
const NON_MATERIAL_KEYWORDS = [
  "freight", "forwarder", "forwarders", "forwarding", "chartering", "charterers",
  "logistics", "logistic", "cargo", "shipping", "maritime", "stevedore", "stevedoring",
  "3pl", "courier", "haulage", "trucking", "transport", "transportation",
  "warehousing", "customs broker", "customs brokerage", "supply chain",
  "shipping line", "container line", "shipping agency", "shipping agencies",
  "textile", "textiles", "garment", "apparel", "clothing", "knitting",
  "pet products", "pet food", "pet supplies", "animal feed",
  "injection molding", "plastic molding", "mold making", "die casting",
  "printing", "print shop", "tractor", "machinery", "equipment rental",
];
const NON_MATERIAL_RE = new RegExp(
  "\\b(?:" +
    NON_MATERIAL_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")\\b",
  "i"
);
const nonMaterialReason = (name: string) => {
  const m = NON_MATERIAL_RE.exec(name ?? "");
  return m ? m[0].toLowerCase() : null;
};

const ROLE_MAP: Record<string, string | null> = {
  MANUFACTURER: "Manufacturer", TRADING_COMPANY: "Trader", WHOLESALER: "Distributor",
  DISTRIBUTOR: "Distributor", SERVICE_COMPANY: "Service", OTHERS: null,
};
function mapRole(types: string[]): string | null {
  for (const t of types) if (ROLE_MAP[t]) return ROLE_MAP[t];
  return null;
}

function packPricing(s: ParsedSupplier): string | null {
  if (!s.products.length) return null;
  const withPrice = s.products.filter((pr) => pr.price != null && String(pr.price).trim() !== "");
  const rows = (withPrice.length ? withPrice : s.products)
    .slice(0, 8)
    .map((pr) =>
      pr.price != null && String(pr.price).trim() !== "" ? `${pr.name} — $${pr.price}` : pr.name
    );
  return rows.length ? rows.join("; ") : null;
}

// Completeness heuristic (0-1) mirroring scoutCompleteness: reward presence of
// the actionable sourcing fields.
function completeness(s: ParsedSupplier, email: string | null): number {
  const fields = [
    s.website, s.country, email, s.address, s.description,
    s.certifications.length ? "y" : "", packPricing(s), mapRole(s.business_types),
  ];
  const have = fields.filter((f) => f && String(f).trim()).length;
  return Math.round((have / fields.length) * 100) / 100;
}

// Strong signal when it's a manufacturer with certs + published pricing.
function confidenceScore(s: ParsedSupplier): number {
  let sc = 0.4;
  if (mapRole(s.business_types) === "Manufacturer") sc += 0.2;
  if (s.certifications.length) sc += 0.15;
  if (packPricing(s)) sc += 0.15;
  if (s.year_founded) sc += 0.1;
  return Math.min(1, Math.round(sc * 100) / 100);
}

const confidenceHint = (sc: number) => (sc >= 0.75 ? "strong" : sc >= 0.55 ? "medium" : "lead");

interface ExistingLead {
  supplier_name: string | null;
  supplier_website: string | null;
  supplier_contact_email: string | null;
}

// Existing active leads for the (org, material). Paginated: a single PostgREST
// select silently caps at 1000 rows, which would degrade the dedup on
// well-covered materials and re-stage suppliers already in flight.
async function loadExisting(
  admin: SupabaseClient,
  orgId: string,
  materialId: string
): Promise<ExistingLead[]> {
  const out: ExistingLead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("leads_in_flight")
      .select(
        "supplier_name,supplier_website:payload->>supplier_website,supplier_contact_email:payload->>supplier_contact_email"
      )
      .eq("org_id", orgId)
      .eq("material_id", materialId)
      .eq("status", "active")
      .range(from, from + 999);
    if (error) throw new Error(`dedup query failed: ${error.message}`);
    out.push(...((data ?? []) as unknown as ExistingLead[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function runSourceReadyDiscovery(
  admin: SupabaseClient,
  req: SourceReadyRequest,
  agentRunId: string
): Promise<SourceReadyResult> {
  const empty = { received: 0, inserted: 0, unlocked: false, skipped: {} as Record<string, number> };
  if (!sourceReadyEnabled()) return { ok: false, reason: "not_configured", ...empty };
  if (!req.oaOrgId) return { ok: false, reason: "no_org", ...empty };

  const size = req.size && req.size > 0 ? req.size : 25;
  const page = req.page && req.page > 0 ? req.page : 1;

  let unlocked = !!req.unlockContacts;
  const runQuery = async (productQuery: string): Promise<string> => {
    try {
      return await searchSuppliers({
        title: `${productQuery} suppliers`,
        productQuery,
        size,
        page,
        unlockContacts: unlocked,
      });
    } catch (e) {
      // A spent contact-credit balance fails the whole search and returns no
      // suppliers at all, so fall back to the unpaid search rather than lose the page.
      if (!(e instanceof SourceReadyCreditsExceededError)) throw e;
      unlocked = false;
      return await searchSuppliers({ title: `${productQuery} suppliers`, productQuery, size, page });
    }
  };

  // Our name first, then the trade's names for the same material. A supplier
  // index only knows the vocabulary its sellers used.
  //
  // Every term in this list is a SEPARATELY BILLED search, and getMaterialAliases
  // returns up to 4, so an unguarded loop costs 5 credits per fire and did: the
  // 2026-08-11 burn measured ~5.2 billed calls per logged fire. Two guards:
  // start from the term that won last time (usually a 1-call fire), and cap the
  // fan-out so a genuinely dry material costs a bounded amount to confirm.
  const ordered = [req.materialName, ...(req.aliases ?? [])];
  if (req.preferredTerm) {
    const i = ordered.findIndex((t) => t.toLowerCase() === req.preferredTerm!.toLowerCase());
    if (i > 0) ordered.unshift(ordered.splice(i, 1)[0]);
    else if (i < 0) ordered.unshift(req.preferredTerm);
  }
  const terms = ordered.slice(0, MAX_TERMS_PER_FIRE);
  let suppliers: ReturnType<typeof parseSupplierMarkdown> = [];
  let usedTerm = terms[0];
  let termsTried = 0;
  for (const term of terms) {
    termsTried++;
    suppliers = parseSupplierMarkdown(await runQuery(term));
    if (suppliers.length) {
      usedTerm = term;
      break;
    }
  }
  if (!suppliers.length) {
    // Zero is not "this market is empty". It is requeued and retried like any
    // other dry pass. It only means these terms were dry on this page today.
    return {
      ok: true, reason: "no_results", received: 0, inserted: 0, unlocked, skipped: {}, termsTried,
    };
  }
  if (usedTerm !== terms[0]) {
    await req.log?.(
      `SourceReady: "${terms[0]}" returned nothing, "${usedTerm}" returned ${suppliers.length}`,
      { material_id: req.materialId, alias_used: usedTerm }
    );
  }

  const excludedCountries = new Set(
    (req.excludedCountries ?? []).map((c) => String(c).toUpperCase())
  );
  const seenHosts = new Set(
    (req.excludeHosts ?? []).map((h) => hostOf(h)).filter((h): h is string => !!h)
  );
  const seenEmails = new Set<string>();
  const seenNames = new Set<string>();
  for (const r of await loadExisting(admin, req.oaOrgId, req.materialId)) {
    const h = hostOf(r.supplier_website);
    if (h) seenHosts.add(h);
    const em = (r.supplier_contact_email ?? "").toLowerCase();
    if (em) seenEmails.add(em);
    const nm = normName(r.supplier_name);
    if (nm) seenNames.add(nm);
  }

  // Material keywords for product/tag matching: significant (3+ char) words
  // from the material name and INCI.
  const materialWords = new Set<string>();
  // Aliases count as material words, otherwise the relevance filter discards
  // exactly the suppliers the alias search just found.
  for (const raw of [req.materialName, req.inci, ...(req.aliases ?? [])].filter(Boolean) as string[]) {
    for (const w of raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length >= 3) materialWords.add(w);
    }
  }
  const productMatchesMaterial = (s: ParsedSupplier): boolean => {
    if (!materialWords.size) return true;
    const texts = [...s.tags, ...s.products.map((pr) => pr.name), s.description ?? ""];
    if (!texts.some((t) => t && String(t).trim())) return true; // nothing to check against
    const joined = texts.join(" ").toLowerCase();
    for (const w of materialWords) if (joined.includes(w)) return true;
    return false;
  };

  let skipDup = 0, skipCountry = 0, skipNoName = 0, skipNonMaterial = 0, skipProductMismatch = 0;
  const rows = [];

  for (const s of suppliers) {
    const name = s.supplier_name.trim();
    if (!name) { skipNoName++; continue; }
    if (nonMaterialReason(name)) { skipNonMaterial++; continue; }
    const country = (s.country ?? "").toString().trim().toUpperCase() || null;
    if (country && excludedCountries.has(country)) { skipCountry++; continue; }
    if (!productMatchesMaterial(s)) { skipProductMismatch++; continue; }

    const host = hostOf(s.website);
    // SourceReady returns sellers hosted ON aggregator platforms (Alibaba,
    // IndiaMART, Made-in-China, ...) as ordinary supplier profiles. Left
    // unclassified they land in the direct lane, never badged, never routed to
    // the aggregator-inquiry / price-index path. Classify from the host so the
    // lead is an "A" (aggregator) kind from the moment it's staged. True
    // marketplace ("M") requires the per-page checkout test, which Agent 05 owns.
    const aggregatorName = aggregatorNameOfHost(host);
    const email = EMAIL_RE.test((s.email ?? "").trim()) ? s.email!.trim() : null;
    const nm = normName(name);
    if (
      (host && seenHosts.has(host)) ||
      (email && seenEmails.has(email.toLowerCase())) ||
      (nm && seenNames.has(nm))
    ) {
      skipDup++;
      continue;
    }
    if (host) seenHosts.add(host);
    if (email) seenEmails.add(email.toLowerCase());
    if (nm) seenNames.add(nm);

    const sc = confidenceScore(s);
    const notesBits: string[] = [];
    if (s.employee_count) notesBits.push(`employees ${s.employee_count}`);
    if (s.year_founded) notesBits.push(`founded ${s.year_founded}`);
    if (s.target_markets.length) notesBits.push(`markets ${s.target_markets.join("/")}`);
    if (s.highlights.length) notesBits.push(s.highlights.join(", "));

    rows.push({
      org_id: req.oaOrgId,
      supplier_name: name,
      supplier_id: await resolveSupplierIdByName(name),
      material_name: req.materialName,
      material_id: req.materialId,
      stage: "raw" as const,
      status: "active" as const,
      source: "sourceready" as const,
      payload: {
        inci_name: req.inci ?? null,
        trade_name: null,
        supplier_website: s.website ?? null,
        supplier_contact_email: email,
        // Agent 06 reads this to label the contact 'sourceready' instead of 'scout'.
        email_source: email ? "sourceready_unlock" : null,
        supplier_phone: s.phone ?? null,
        supplier_country: country,
        supplier_role: mapRole(s.business_types),
        hq_address: s.address ?? null,
        supplier_background: s.description ?? null,
        pack_sizes_pricing: packPricing(s),
        grades_offered: null,
        certifications: s.certifications.length ? s.certifications.join(", ") : null,
        moq: null,
        site_type: aggregatorName ? "A" : null,
        ...(aggregatorName ? { aggregator: aggregatorName } : {}),
        confidence_hint: confidenceHint(sc),
        completeness_score: completeness(s, email),
        needs_contact_resolution: !email,
        source_url: s.website ?? null,
        source_citations: s.website ? [s.website] : [],
        scout_notes: notesBits.length ? `SourceReady — ${notesBits.join("; ")}` : "SourceReady",
        sourceready_id: s.supplier_id ?? null,
        sourceready_tags: s.tags.slice(0, 30),
        tenkara_org_id: req.tenkaraOrgId ?? null,
      },
      confidence_score: sc,
      agent_run_id: agentRunId,
    });
  }

  const skipped = {
    duplicate: skipDup,
    excludedCountry: skipCountry,
    noName: skipNoName,
    nonMaterial: skipNonMaterial,
    productMismatch: skipProductMismatch,
  };

  if (!rows.length) {
    return {
      ok: true, reason: "all_filtered", received: suppliers.length, inserted: 0,
      unlocked, skipped, usedTerm, termsTried,
    };
  }

  const { data: inserted, error } = await admin
    .from("leads_in_flight")
    .insert(rows)
    .select("id");
  if (error) throw new Error(`lead insert failed: ${error.message}`);

  return {
    ok: true,
    received: suppliers.length,
    inserted: inserted?.length ?? 0,
    unlocked,
    skipped,
    usedTerm,
    termsTried,
  };
}

export { SourceReadyUnavailableError };
