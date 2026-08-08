import Anthropic from "@anthropic-ai/sdk";

// Finds the real company behind a marketplace-only supplier.
//
// ~1,380 suppliers reach us as a storefront and nothing else: no website, and a
// prose "via IndiaMART inquiry" where the email should be. Every pass they fail
// the one test the pipeline applies (is there an address to write to?), so they
// are re-enriched daily and can never promote.
//
// They are not unreachable, they are unresolved. Three cheap reads usually find
// the company's own domain, and once that domain is on the lead the existing
// crawl / extract / provider cascade takes over unchanged. This module only
// supplies the missing domain and the identity needed to trust it.
//
// Ordered cheapest-first, and it stops at the first confirmed answer:
//   1. the storefront subdomain          free, deterministic
//   2. an outbound link on the listing   free
//   3. a locality-verified web search    one model call, last resort
//
// The verification is the load-bearing part, not the search. "Paramount
// Chemicals" resolves to two unrelated firms, and the wrong one (Nagpur, est.
// 1989) publishes an email while the right one (Indore, MP, 452010) does not. A
// resolver that took the first domain carrying an address would confidently
// deliver a stranger's inbox. So a candidate is accepted only when it agrees
// with identity taken from the listing itself.

const MODEL = "claude-sonnet-5";
// The model writes a full evidence line per field; at 700 it ran out mid-object
// and the answer came back unparseable after a 16s search had already been paid
// for. Sized for the whole object plus its note.
const MAX_OUTPUT_TOKENS = 1_500;
const MAX_FETCH_USES = 4;
const MAX_WEB_USES = 5;
const WEB_FETCH_BETA = "web-fetch-2025-09-10";
// The SDK defaults to a 10-minute timeout with 2 retries. Agent 06 runs this
// inside a per-lead ceiling, so an unbounded call here would spend the whole
// lead budget on one search. See contact-read.ts for the outage this prevents.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

const FETCH_TIMEOUT_MS = 9_000;
const MAX_BODY_BYTES = 700_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type WebsiteSource = "storefront_subdomain" | "listing_link" | "web_search";

export interface StorefrontIdentity {
  legal_name: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postal_code: string | null;
  phone: string | null;
}

export interface StorefrontResolution extends StorefrontIdentity {
  own_website: string | null;
  website_source: WebsiteSource | null;
  // Why we did or did not land a domain, in one line, for the operator and for
  // the next pass to read.
  note: string;
  // False when nothing was learned at all (listing unreadable), which means the
  // lead should be retried sooner than one that was genuinely searched.
  identity_found: boolean;
  attempted_at: string;
  attempts: number;
  // When the next attempt is worth making. Never terminal: a supplier with no
  // own site today may publish one, and a listing that would not load may load
  // next week. The backoff only stops us re-buying the same answer daily.
  retry_after: string | null;
}

// Days before a storefront that resolved to nothing is worth resolving again.
const RETRY_BACKOFF_DAYS = [3, 7, 14, 30, 60];

export function storefrontRetryDue(prior: StorefrontResolution | null | undefined): boolean {
  if (!prior?.retry_after) return true;
  return new Date(prior.retry_after).getTime() <= Date.now();
}

function backoffFrom(attempts: number): string {
  const days = RETRY_BACKOFF_DAYS[Math.min(attempts - 1, RETRY_BACKOFF_DAYS.length - 1)];
  return new Date(Date.now() + days * 86400000).toISOString();
}

// Hosts that are never a supplier's own site, so never a candidate answer.
const PLATFORM_HOST =
  /(alibaba|aliexpress|1688|made-in-china|indiamart|tradeindia|exportersindia|echemi|chemicalbook|ec21|globalsources|thomasnet|knowde|go4worldbusiness|tradewheel|dhgate|amazon|ebay|justdial|indianyellowpages|yellowpages|sulekha|tradeford|weiku|lookchem|guidechem|molbase|chemnet|b2bhint|exportgenius|zauba|panjiva|importyeti|linkedin|facebook|twitter|youtube|instagram|wikipedia|google|blogspot|wordpress\.com|wixsite|weebly)\./i;

// Marketplace-generated microsites. TradeIndia and IndiaMART register
// <company>.in / .co.in sites for their sellers, which look like an own domain
// but are platform infrastructure: the "contact" page on one printed a
// TradeIndia sales rep's address, not the supplier's. Treated as identity
// evidence (the locality on them is real) but never as a mailable own domain.
// A microsite is a page living on PLATFORM-OWNED infrastructure (the host itself
// belongs to the marketplace, or the candidate redirects onto one). That is the
// thing we must never treat as a mailable own domain.
//
// It is NOT "the page mentions TradeIndia". Huge numbers of Indian suppliers own
// their domain but have TradeIndia build and host the site on it, and those
// pages carry a "Developed and Managed by TradeIndia" footer plus links back to
// their storefront. herbonutra.com is one: a real, supplier-registered domain
// that an earlier body-text check threw away. The domain is what we are after,
// since it is what the pattern-guess rule is allowed to build addresses on.
function isPlatformHost(url: string | null): boolean {
  const host = hostOf(url ?? "");
  return !!host && PLATFORM_HOST.test(`${host}.`);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<{ ok: boolean; html: string; finalUrl: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.startsWith("http") ? url : `https://${url}`, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    });
    const buf = await res.arrayBuffer();
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, MAX_BODY_BYTES));
    return { ok: res.ok, html, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- 1. the storefront subdomain -------------------------------------------

// Suppliers pick their own Made-in-China / Alibaba subdomain and overwhelmingly
// reuse their real domain label for it: tnjchem.en.made-in-china.com is
// tnjchem.com. Measured on a 7-supplier sample, 3 resolved and all 3 were the
// right company by title, 2 publishing an email on the homepage alone. It costs
// one HEAD-ish fetch and no credits, so it runs before anything billable.
//
// Platform-assigned ids (hex blobs, "shop123456") carry no such signal.
const OPAQUE_LABEL = /^([0-9a-f]{10,}|[a-z]{0,4}\d{4,}|shop\d+|store\d+|user\d+)$/i;

// IndiaMART carries the same signal in the path instead of the host:
// indiamart.com/herbonutra/... belongs to Herbo Nutra, whose own site is
// herbonutra.com. These are the largest single cohort, and their listings also
// publish a JSON-LD locality, so the candidate can be verified strictly.
// Product-detail URLs (/proddetail/...) carry no company slug.
const INDIAMART_NON_COMPANY = /^(proddetail|impcat|search|company|city|products?|dir|about|help|contactus|mob)$/i;

function indiamartSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)indiamart\.com$/i.test(u.hostname)) return null;
    const seg = u.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!seg || seg.length < 4 || INDIAMART_NON_COMPANY.test(seg) || /\.html?$/i.test(seg)) return null;
    return seg.toLowerCase();
  } catch {
    return null;
  }
}

export interface SlugCandidate {
  url: string;
  label: string;
  // Whether this candidate may be accepted on a name/label match alone when the
  // listing gave us no locality to check against. True only for strings the
  // SUPPLIER chose (their storefront subdomain or IndiaMART slug): finding that
  // exact string in a site's title is independent evidence. False for strings WE
  // derived, which prove nothing about who owns the domain.
  nameOnlyOk: boolean;
}

// IndiaMART slugs usually append the city ("paramount-chemicals-indore"), while
// the real domain drops it. Only strip a suffix the listing itself confirms is
// the city, so this stays evidence-driven rather than a blind trim.
function stripCitySuffix(label: string, city: string | null): string | null {
  if (!city) return null;
  const tokens = city.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const forms = [...tokens, tokens.join("")];
  // The separator is inconsistent: IndiaMART writes both "apex-nutrition-ghaziabad"
  // and "nakshenterprisesindore".
  for (const f of forms) {
    if (f.length < 3) continue;
    const re = new RegExp(`-?${f}$`);
    if (re.test(label)) {
      const stripped = label.replace(re, "").replace(/-+$/, "");
      if (stripped.length >= 4) return stripped;
    }
  }
  return null;
}

export function storefrontSubdomainCandidates(sourceUrl: string | null, city?: string | null): SlugCandidate[] {
  if (!sourceUrl) return [];
  const host = hostOf(sourceUrl);
  if (!host) return [];
  const sub = host.match(/^([a-z0-9-]+)\.(?:en\.)?(?:made-in-china\.com|alibaba\.com|globalsources\.com)$/i)?.[1];
  const label = sub ?? indiamartSlug(sourceUrl);
  if (!label || label.length < 4 || OPAQUE_LABEL.test(label) || label === "www") return [];

  // The label as given plus its de-hyphenated form: IndiaMART writes
  // "vidisha-group" where the domain is usually vidishagroup.com.
  const chosen = Array.from(new Set([label, label.replace(/-/g, "")]));
  const stripped = stripCitySuffix(label, city ?? null);
  const derived = stripped && stripped.length >= 4
    ? Array.from(new Set([stripped, stripped.replace(/-/g, "")]))
    : [];

  // Indian suppliers register .in and .co.in at least as often as .com, and the
  // IndiaMART cohort is overwhelmingly Indian. A dead host now costs one fetch,
  // so widening the TLD list is close to free.
  const tlds = sub ? ["com"] : ["com", "in", "co.in"];

  const out: SlugCandidate[] = [];
  for (const [labels, nameOnlyOk] of [[chosen, true], [derived, false]] as const) {
    for (const l of labels) {
      for (const tld of tlds) {
        out.push({ url: `https://www.${l}.${tld}`, label: l, nameOnlyOk });
        out.push({ url: `https://${l}.${tld}`, label: l, nameOnlyOk });
      }
    }
  }
  return out;
}

// ---- identity off the listing ----------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function pickJsonLdOrg(html: string): any | null {
  const blocks = html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(decodeEntities(b[1]));
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of arr) {
        const type = node?.["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (types.some((t: any) => typeof t === "string" && /organization|localbusiness|store|corporation/i.test(t))) {
          return node;
        }
      }
    } catch {
      /* one malformed block must not lose the others */
    }
  }
  return null;
}

const CLEAN = (v: any): string | null => {
  const s = typeof v === "string" ? decodeEntities(v) : "";
  return s && s.length < 200 ? s : null;
};

// Listing pages state the seller's registered name and locality even when they
// mask every contact detail, because that part is what makes the listing
// credible to buyers. That locality is the only independent fact we have to
// check a candidate domain against, so it is worth reading on its own.
export function identityFromListing(html: string): StorefrontIdentity {
  const org = pickJsonLdOrg(html);
  const addr = org?.address ?? {};
  const id: StorefrontIdentity = {
    legal_name: CLEAN(org?.name),
    city: CLEAN(addr?.addressLocality),
    region: CLEAN(addr?.addressRegion),
    country: CLEAN(addr?.addressCountry) ?? CLEAN(org?.address?.addressCountry),
    postal_code: CLEAN(addr?.postalCode),
    phone: CLEAN(org?.telephone),
  };
  if (!id.city) {
    const m = html.match(/"(?:city|addressLocality)"\s*:\s*"([^"]{2,60})"/i);
    if (m) id.city = decodeEntities(m[1]);
  }
  if (!id.region) {
    const m = html.match(/"(?:state|addressRegion|province)"\s*:\s*"([^"]{2,60})"/i);
    if (m) id.region = decodeEntities(m[1]);
  }
  return id;
}

// ---- verification ----------------------------------------------------------

const CORPORATE_SUFFIX =
  /\b(co|inc|ltd|limited|llc|llp|pvt|private|corp|corporation|company|gmbh|bv|sa|srl|plc|group|industries|industry|international|imp|exp|import|export|trading|trade|technology|technologies|chemical|chemicals|enterprise|enterprises|manufacturing|factory|and|the)\b/gi;

export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(CORPORATE_SUFFIX, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2);
}

// A candidate is the supplier's own site only when the page itself agrees.
//
// When the listing gave us a locality, locality is MANDATORY and a name match
// cannot substitute for it. That asymmetry is the whole point: searching
// "Paramount Chemicals" returns both the Indore firm we are looking for and an
// unrelated Nagpur firm of the same name, and it is the Nagpur one that
// publishes an email. A name-in-title rule would take it. Only "does this page
// say Indore / 452010" separates them.
//
// A name match is allowed only when there is no locality to check at all, which
// is the normal case for a Made-in-China storefront (their pages carry no
// address block). There the subdomain itself is the evidence: the supplier
// chose `tnjchem.en.made-in-china.com`, so tnjchem.com agreeing on the name is
// a second independent signal rather than a coincidence. A candidate that came
// from a search has no such prior, so it never gets the name-only route.
export function domainAgreesWithIdentity(
  html: string,
  supplierName: string | null,
  id: StorefrontIdentity,
  opts: { allowNameOnly: boolean; subdomainLabel?: string | null }
): { agrees: boolean; how: string | null } {
  const text = html.replace(/<[^>]+>/g, " ").toLowerCase();
  if (id.postal_code && text.includes(id.postal_code.toLowerCase())) {
    return { agrees: true, how: `postcode ${id.postal_code}` };
  }
  if (id.city && id.city.length > 3 && text.includes(id.city.toLowerCase())) {
    return { agrees: true, how: `city ${id.city}` };
  }
  const haveLocality = !!(id.postal_code || (id.city && id.city.length > 3));
  if (haveLocality || !opts.allowNameOnly) return { agrees: false, how: null };

  const title = (html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ?? "").toLowerCase();
  const label = opts.subdomainLabel?.toLowerCase() ?? "";
  if (label && title.includes(label)) return { agrees: true, how: `storefront label "${label}" in title` };
  const tokens = nameTokens(id.legal_name ?? supplierName);
  const hit = tokens.filter((t) => title.includes(t));
  if (hit.length) return { agrees: true, how: `name in title (${hit.join(", ")})` };
  return { agrees: false, how: null };
}

// A company states its city on the contact or about page far more often than on
// the homepage, so checking only the homepage would reject correct answers for
// the wrong reason. These are cheap same-host reads and it stops at the first
// page that confirms.
const VERIFY_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/contact.html"];

async function verifyCandidateSite(
  baseUrl: string,
  supplierName: string | null,
  id: StorefrontIdentity,
  opts: { allowNameOnly: boolean; subdomainLabel?: string | null },
  root?: Awaited<ReturnType<typeof fetchHtml>>
): Promise<{ agrees: boolean; how: string | null; finalUrl: string | null; microsite: boolean }> {
  const host = hostOf(baseUrl);
  if (!host) return { agrees: false, how: null, finalUrl: null, microsite: false };
  if (isPlatformHost(baseUrl)) return { agrees: false, how: null, finalUrl: baseUrl, microsite: true };
  let finalUrl: string | null = null;
  let reachable = false;
  for (const path of VERIFY_PATHS) {
    const page = path === "" && root ? root : await fetchHtml(`https://${host}${path}`);
    // Most candidates are domains that simply do not exist. Give up on the whole
    // host the moment its root fails rather than paying for five more 404s, which
    // is what makes it affordable to try several labels and TLDs per supplier.
    if (!page?.ok && !reachable) break;
    if (!page?.ok) continue;
    reachable = true;
    finalUrl = finalUrl ?? page.finalUrl;
    // Parked/expired domains often 302 onto the marketplace that still hosts the
    // listing, which would otherwise read as a confirmed own site.
    if (isPlatformHost(page.finalUrl)) return { agrees: false, how: null, finalUrl: page.finalUrl, microsite: true };
    const verdict = domainAgreesWithIdentity(page.html, supplierName, id, opts);
    if (verdict.agrees) return { agrees: true, how: verdict.how, finalUrl: page.finalUrl, microsite: false };
  }
  return { agrees: false, how: null, finalUrl: reachable ? finalUrl : null, microsite: false };
}

function usableOwnDomain(url: string | null): string | null {
  const host = hostOf(url ?? "");
  if (!host || PLATFORM_HOST.test(`${host}.`)) return null;
  return url;
}

// ---- 2. an outbound link on the listing ------------------------------------

// Some storefronts print the company's own URL in the profile copy even though
// the platform strips the email. Cheap to look for while the listing HTML is
// already in hand.
function ownLinkOnListing(html: string, supplierName: string | null): string[] {
  const out = new Set<string>();
  const tokens = nameTokens(supplierName);
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?([a-z0-9-]+(?:\.[a-z]{2,10}){1,2})/gi)) {
    const host = m[1].toLowerCase();
    if (PLATFORM_HOST.test(`${host}.`)) continue;
    if (/\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?)$/i.test(m[0])) continue;
    const label = host.split(".")[0];
    if (tokens.some((t) => label.includes(t) || t.includes(label))) out.add(`https://${host}`);
  }
  return Array.from(out).slice(0, 3);
}

// ---- 3. locality-verified search -------------------------------------------

const SYSTEM_PROMPT = `You find whether a B2B supplier has its OWN company website, separate from the marketplace storefront it was found on.

You are given the supplier's name and the identity printed on their marketplace listing (registered name, city, state/region, country, postcode). That identity is ground truth. Your job is to find a website that provably belongs to THAT company, or to report that there is none.

Method:
1. web_search for the company's own site, using the locality as part of the query ("<name> <city> <state> official website", "<name> <city> contact").
2. web_fetch the most promising candidate and READ it.
3. Confirm identity before accepting: the site must show the SAME locality (city / state / postcode) or otherwise be unmistakably the same company. Company names repeat across cities constantly, and an unrelated firm with the same name is the single most likely wrong answer here.

Return ONLY a JSON object:
{
  "website": string|null,     // homepage URL of the company's OWN site, null if none found or none confirmed
  "confirmed_by": string|null,// the specific evidence, e.g. "contact page lists Indore, MP 452010"
  "email": string|null,       // only if printed on their own site
  "phone": string|null,       // only if printed
  "note": string              // one short line: what you found, or why you concluded there is no own site
}

Rules:
- NEVER return a marketplace, directory, or aggregator page as the website (alibaba, made-in-china, indiamart, tradeindia, exportersindia, echemi, chemicalbook, ec21, globalsources, thomasnet, yellowpages, justdial, importyeti, panjiva, zauba). Those are where we already found them.
- Marketplace-generated microsites (a <company>.in or .co.in site that is "powered by" TradeIndia or IndiaMART) are NOT an own site. Report them in the note, do not return them as website.
- If locality cannot be confirmed, return website: null and say so. An unconfirmed guess is worse than nothing here: it sends a client's sourcing inquiry to a stranger.
- Never construct an email from a name and a domain. Only copy an address actually printed on the page.
- Many of these suppliers genuinely sell only through the platform and have no own site. "No own website found" is a correct, expected answer. Do not stretch to fill it.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }
  return client;
}

function extractJson(text: string): any {
  const fenced = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

async function searchForOwnSite(
  supplierName: string | null,
  id: StorefrontIdentity
): Promise<{ website: string | null; email: string | null; phone: string | null; note: string }> {
  const lines = [
    `Supplier name: ${supplierName ?? "unknown"}`,
    id.legal_name && id.legal_name !== supplierName ? `Registered name on listing: ${id.legal_name}` : null,
    `City: ${id.city ?? "unknown"}`,
    `State/region: ${id.region ?? "unknown"}`,
    `Country: ${id.country ?? "unknown"}`,
    id.postal_code ? `Postcode: ${id.postal_code}` : null,
    "",
    "Does this company have its own website? Confirm identity by locality before answering.",
  ].filter(Boolean);

  const res = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    betas: [WEB_FETCH_BETA],
    system: SYSTEM_PROMPT,
    tools: [
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: MAX_FETCH_USES } as any,
      { type: "web_search_20260209", name: "web_search", max_uses: MAX_WEB_USES } as any,
    ],
    messages: [{ role: "user", content: lines.join("\n") }],
  });

  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  const parsed = extractJson(text);
  const site = usableOwnDomain(CLEAN(parsed.website));
  return {
    website: site,
    email: CLEAN(parsed.email),
    phone: CLEAN(parsed.phone),
    note: CLEAN(parsed.note) ?? (site ? `Own site found: ${CLEAN(parsed.confirmed_by) ?? "confirmed"}` : "No own site confirmed"),
  };
}

// ---- orchestration ---------------------------------------------------------

export interface StorefrontInput {
  supplierName: string | null;
  sourceUrl: string | null;
  // Off when the org may not spend on the model step. The free steps still run.
  allowSearch: boolean;
  // The previous attempt for this lead, so repeated failures back off instead of
  // re-running the same search every pass.
  prior?: StorefrontResolution | null;
}

export async function resolveStorefrontSupplier(input: StorefrontInput): Promise<StorefrontResolution> {
  const attempts = (input.prior?.attempts ?? 0) + 1;
  const attempted_at = new Date().toISOString();
  const done = (r: Omit<StorefrontResolution, "attempted_at" | "attempts" | "retry_after">): StorefrontResolution => ({
    ...r,
    attempted_at,
    attempts,
    retry_after: r.own_website ? null : backoffFrom(attempts),
  });
  const empty = {
    legal_name: null, city: null, region: null, country: null, postal_code: null, phone: null,
    own_website: null, website_source: null, identity_found: false, note: "",
  } as Omit<StorefrontResolution, "attempted_at" | "attempts" | "retry_after">;
  if (!input.sourceUrl) return done({ ...empty, note: "No listing URL on the lead to resolve from" });

  const listing = await fetchHtml(input.sourceUrl);
  if (!listing) {
    return done({ ...empty, note: "Listing page could not be read; retrying on a later pass" });
  }
  const id = identityFromListing(listing.html);
  const identity_found = !!(id.legal_name || id.city || id.postal_code || id.phone);
  const base = { ...empty, ...id, identity_found, note: "" };

  // 1 + 2: free candidates, verified against the listing identity.
  const subdomains = storefrontSubdomainCandidates(input.sourceUrl, id.city);
  const candidates = [
    ...subdomains.map((c) => ({
      url: c.url,
      src: "storefront_subdomain" as const,
      label: c.label,
      nameOnlyOk: c.nameOnlyOk,
    })),
    ...ownLinkOnListing(listing.html, input.supplierName).map((u) => ({
      url: u,
      src: "listing_link" as const,
      label: null,
      nameOnlyOk: false,
    })),
  ];
  // Guessing labels and TLDs means most candidates are domains that do not
  // exist. Probing them one at a time would spend the whole per-lead budget on
  // DNS failures, so every root is probed at once and only the hosts that turn
  // out to be real get the deeper contact/about crawl.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const host = hostOf(c.url);
    if (!host || seen.has(host)) return false;
    seen.add(host);
    return true;
  });
  const roots = await Promise.all(
    unique.map((c) => (isPlatformHost(c.url) ? Promise.resolve(null) : fetchHtml(c.url)))
  );

  for (let i = 0; i < unique.length; i++) {
    const c = unique[i];
    const host = hostOf(c.url)!;
    const root = roots[i];
    if (!root?.ok && !isPlatformHost(c.url)) continue;
    // A platform-generated microsite is identity evidence but not a mailable
    // own domain, so it can never be the answer regardless of how it matched.
    const v = await verifyCandidateSite(
      c.url,
      input.supplierName,
      id,
      { allowNameOnly: c.nameOnlyOk, subdomainLabel: c.label },
      root
    );
    if (v.agrees) {
      return done({
        ...base,
        own_website: `https://${hostOf(v.finalUrl ?? c.url) ?? host}`,
        website_source: c.src,
        note: `Own site ${host} confirmed by ${v.how} (${c.src.replace(/_/g, " ")})`,
      });
    }
  }

  if (!input.allowSearch) {
    return done({ ...base, note: identity_found ? "Identity read off the listing; search step not run for this org" : "Listing carried no identity" });
  }

  try {
    const found = await searchForOwnSite(input.supplierName, id);
    if (!found.website) return done({ ...base, phone: base.phone ?? found.phone, note: found.note });

    // The model proposes, this verifies. Told plainly not to return a
    // marketplace microsite, it returned paramountchemicals.in anyway (a
    // TradeIndia-hosted site) because the GST number and address genuinely
    // matched; the identity was right and the conclusion was still wrong. So
    // the same fetch-and-check the free path uses is applied to the answer,
    // and an unverifiable answer is discarded rather than written to the lead.
    const host = hostOf(found.website);
    const v = await verifyCandidateSite(found.website, input.supplierName, id, {
      // No name-only route here: a search's most likely wrong answer is a
      // same-named company elsewhere, which a name check cannot detect.
      allowNameOnly: !identity_found,
      subdomainLabel: null,
    });
    if (v.microsite) {
      return done({ ...base, phone: base.phone ?? found.phone, note: `${host} is a marketplace-hosted microsite, not the supplier's own domain` });
    }
    if (!v.agrees) {
      const why = v.finalUrl ? `it does not confirm ${id.city ?? id.postal_code ?? "the listing identity"}` : "it could not be read";
      return done({ ...base, phone: base.phone ?? found.phone, note: `Proposed ${host} but ${why}; not accepted` });
    }
    return done({
      ...base,
      phone: base.phone ?? found.phone,
      own_website: `https://${hostOf(v.finalUrl ?? found.website) ?? host}`,
      website_source: "web_search",
      note: `Own site ${host} confirmed by ${v.how} (web search)`,
    });
  } catch (e: any) {
    return done({ ...base, note: `Own-site search failed (${String(e?.message ?? e).slice(0, 80)}); retrying on a later pass` });
  }
}
