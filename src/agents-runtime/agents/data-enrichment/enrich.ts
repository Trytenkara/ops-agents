import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Pre-outreach enrichment building blocks. No LLM, no Missive — those land
// when Agent 04 (Outreach) and Agent 08 (Email Scanner) ship.
//
// Contact discovery is PERSISTENT and multi-step (mirrors Ben's manual method):
// we fetch the homepage, then follow Contact/About/Sales links and try common
// contact paths, parsing emails/phones (incl. footers) and capturing a
// request-a-quote/contact-form URL when no direct email exists. We only stamp
// `all_contact_channels_invalid` after genuinely trying 3+ pages.

export interface RawLead {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  material_name: string | null;
  // Lead origin (e.g. 'importyeti', 'sourceready', 'ai_discovery'). The material-
  // relevance backstop below only runs for the customs/directory discovery sources,
  // which surface suppliers on a loose keyword/shipment match and can drag in
  // wrong-industry companies. Null when unknown.
  source?: string | null;
  payload: Record<string, any> | null;
  // Lead-creation confidence (0..1), if scored. Enrichment lowers it by any
  // marketplace-trust penalty so a down-ranked lead sorts to the bottom of the
  // confidence-ordered enrichment/outreach queues. Null when never scored.
  confidence_score?: number | null;
}

export interface WebsiteProbe {
  url: string;
  ok: boolean;
  status_code: number | null;
  final_url: string | null;
  error?: string;
}

export interface EmailCheck {
  email: string;
  format_valid: boolean;
  // True when the email's domain matches the supplier_website's host (modulo www.).
  // Null when we can't compute (no website or invalid email).
  domain_matches_website: boolean | null;
  // True when the email belongs to a marketplace / B2B directory / aggregator
  // (e.g. concierge@knowde.com). We never cold-email these — it reaches the
  // marketplace, not the supplier.
  is_aggregator_domain: boolean;
}

// Marketplaces, B2B directories, and sourcing aggregators. An email at one of
// these domains is the platform's inbox, not the supplier's — cold outreach to
// it is wrong (the KH Neochem draft that went to concierge@knowde.com). Match is
// on the registrable-ish host suffix so sub-domains (x.knowde.com) also hit.
const AGGREGATOR_DOMAINS = [
  "knowde.com",
  "alibaba.com",
  "aliexpress.com",
  "1688.com",
  "made-in-china.com",
  "indiamart.com",
  "tradeindia.com",
  "exportersindia.com",
  "thomasnet.com",
  "globalsources.com",
  "ec21.com",
  "tradekey.com",
  "go4worldbusiness.com",
  "dhgate.com",
  "europages.com",
  "kompass.com",
  "echemi.com",
  "chemicalbook.com",
  "guidechem.com",
  "molbase.com",
  "ingredientsonline.com",
  "chemondis.com",
  "spotchemi.com",
];

export function isAggregatorDomain(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  return AGGREGATOR_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

export function isAggregatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return isAggregatorDomain(email.split("@")[1] ?? null);
}

// Low-trust B2B marketplaces (subset of AGGREGATOR_DOMAINS). These are RFQ-relay
// directories with thin supplier vetting, where a firm purchasable price is the
// exception and "Send Inquiry" / wide price ranges are the norm. Used only to
// *down-rank* a marketplace lead's confidence — never to drop it.
const LOW_TRUST_MARKETPLACE_DOMAINS = [
  "alibaba.com",
  "aliexpress.com",
  "1688.com",
  "made-in-china.com",
  "dhgate.com",
  "indiamart.com",
  "tradeindia.com",
  "exportersindia.com",
  "ec21.com",
  "tradekey.com",
  "globalsources.com",
  "go4worldbusiness.com",
];

// China-only supplier platforms: every listing is a mainland-China supplier, so
// the host alone establishes China origin without any other signal.
const CHINA_ONLY_MARKETPLACE_DOMAINS = ["made-in-china.com", "1688.com"];

function hostMatchesAny(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

export function isLowTrustMarketplace(host: string | null | undefined): boolean {
  return !!host && hostMatchesAny(host, LOW_TRUST_MARKETPLACE_DOMAINS);
}

// Placeholder / no-reply / script-artifact emails that are clearly not a real
// supplier contact. Occurs when scrapers pick up JS library references
// (swiper@7.0.5-bundle.min), social tracking IDs (7b04453cdd26@apps.messenger.live.com),
// marketing automation senders (back-in-stock@notifyboost.net), no-reply
// addresses (noreply@envato.com), or explicit placeholder text (test@test.com,
// eg.sample@xyz.com). Applied before accepting any email, regardless of source.
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "test.com", "example.com", "xyz.com", "email.com", "sample.com", "email.tst",
  "foo.com", "bar.com", "abc.com", "placeholder.com", "demo.com",
]);

// Email prefixes that are never a supplier's real inbox.
const PLACEHOLDER_PREFIX_RE =
  /^(?:noreply|no[_-]reply|do[_-]not[_-]reply|donotreply|unsubscribe|bounce|back-in-stock|backinstock|notification|no\.reply|auto(?:reply|mated)|postmaster|mailer-daemon|reply-noreply|swiper|eg\.sample|eg-sample)\@/i;

// Non-real TLD extensions from minified JS bundles (e.g. swiper@7.0.5-bundle.min).
const SCRIPT_TLD_RE = /\.(min|js|ts|css|jsx|tsx|mjs|cjs|map)$/i;

// Hex string local part (16+ hex chars) — messenger/social tracking IDs
// injected into page markup (e.g. 7b04453cdd26b12c@apps.messenger.live.com).
const HEX_LOCAL_RE = /^[0-9a-f]{16,}\@/i;

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  const atIdx = e.indexOf("@");
  if (atIdx < 0) return false;
  const domain = e.slice(atIdx + 1);
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return true;
  if (PLACEHOLDER_PREFIX_RE.test(e)) return true;
  if (SCRIPT_TLD_RE.test(e)) return true;
  if (HEX_LOCAL_RE.test(e)) return true;
  return false;
}

export interface ContactDiscovery {
  email: string | null;        // best discovered/known direct email
  phone: string | null;        // best discovered/known phone
  contact_url: string | null;  // contact page / quote-form URL used as a channel
  pages_tried: number;         // how many pages we actually fetched
  source: "scout" | "discovered" | "path" | "tenkara" | null; // where the channel came from
}

export interface SupplierEnrichment {
  // From Tenkara `suppliers` — anything we didn't already have in payload.
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  poc_phone: string | null;
  shipping_email: string | null;
  billing_email: string | null;
  is_marketplace: boolean | null;
  responsiveness_score: number | null;
  payment_terms: any | null;
  supplier_type: string[] | null;
}

// One contribution to the completeness score, so the UI/CSV can explain *why* a
// lead scored what it did instead of just showing a bare number.
export interface CompletenessFactor {
  label: string;   // human-readable reason, e.g. "valid email"
  points: number;  // signed contribution to the 0..1 score
}

// Supplier legitimacy signals extracted from the website HTML — no extra
// network calls needed, all parsed from pages already fetched during contact
// discovery. Score is 0..1; signals list the supporting evidence for the UI.
export interface LegitimacyCheck {
  is_https: boolean;
  certifications: string[];         // e.g. ["ISO 9001", "GMP", "FDA registered"]
  is_established_entity: boolean;   // mentions Inc / LLC / Corp / Ltd on site
  established_year: number | null;  // "Since 1985" → 1985, else null
  has_bbb_accreditation: boolean;   // BBB badge or bbb.org link on site
  has_linkedin_link: boolean;       // linkedin.com/company/ link in HTML
  score: number;                    // 0..1 composite
  signals: string[];                // human-readable for UI / CSV
}

// Marketplace-listing confidence signals (Ben's enrichment rules). A firm,
// purchasable price is what makes a marketplace lead trustworthy; "Send Inquiry"
// / RFQ-only CTAs and wide price ranges are not. Low-trust marketplaces hosting a
// China-based supplier are down-weighted further. All penalties are SOFT — they
// lower completeness_score (so the lead sorts to the bottom of the queue) but
// never block outreach or drop the lead.
export interface MarketplaceTrustCheck {
  marketplace_host: string | null;    // the aggregator/marketplace host of the listing
  is_low_trust_marketplace: boolean;  // one of the shady low-trust directories
  send_inquiry_only: boolean;         // listing pushes an inquiry/quote CTA, no firm price
  price_range_only: boolean;          // price shown as a range, not a firm number
  china_origin: boolean;              // supplier appears to be China-based
  penalty: number;                    // total confidence penalty applied (0..1 magnitude)
  factors: CompletenessFactor[];      // negative contributions, surfaced in the UI/CSV
  signals: string[];                  // human-readable reasons
}

// Advisory material-relevance backstop for customs/directory discovery leads
// (source=importyeti/sourceready). Those sources surface suppliers on a loose
// keyword/shipment match, so a company whose product text has nothing to do with
// the target material can slip through (fruit farms, a tractor maker, textile
// traders staged under "Nano Silica"). This is a FLAG, never a filter: we only
// down-rank + annotate, never drop the lead or block outreach.
export interface MaterialRelevanceCheck {
  // False only when there was product text to check AND it shared ZERO meaningful
  // material tokens. No product text at all → relevant=true (we can't judge).
  relevant: boolean;
  matchedTokens: string[];        // material/INCI tokens found in the product text
  note: string | null;           // human-readable advisory when not relevant, else null
}

export interface EnrichmentResult {
  website_probe: WebsiteProbe | null;
  email_check: EmailCheck | null;
  contact: ContactDiscovery;
  tenkara_supplier: SupplierEnrichment | null;
  legitimacy_check: LegitimacyCheck | null;
  marketplace_trust: MarketplaceTrustCheck | null;
  // Non-null only for source=importyeti/sourceready leads (the backstop's scope).
  material_relevance: MaterialRelevanceCheck | null;
  completeness_score: number; // 0..1
  // The factors that produced completeness_score, in scoring order.
  completeness_factors: CompletenessFactor[];
  // Fields we consider "minimum to outreach". When this is false we leave the
  // lead at stage=raw with payload.enrichment_blocked_reason set.
  outreach_ready: boolean;
  blocked_reason: string | null;
  // The marketplace/aggregator email we rejected (e.g. concierge@knowde.com),
  // kept for the operator's reference on the manual-contact case. Null when the
  // resolved email is the supplier's own.
  aggregator_contact_email: string | null;
}

const PROBE_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 7_000;
const MAX_PAGES = 4; // homepage + up to 3 follow-ups → always ≥3 tried before blocking
const MAX_BODY_BYTES = 700_000;
const UA = "Mozilla/5.0 (compatible; TackleBox-Enrich/1.0)";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Order matters: contact/quote pages first so we find a channel fast.
const CONTACT_PATHS = ["/contact", "/contact-us", "/contactus", "/sales", "/get-a-quote", "/request-a-quote", "/rfq", "/about", "/about-us"];

function hostOf(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeBase(url: string): string {
  return url.startsWith("http") ? url : `https://${url}`;
}

export async function probeWebsite(url: string): Promise<WebsiteProbe> {
  const target = normalizeBase(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(target, { method: "HEAD", redirect: "follow", signal: ctl.signal, headers: { "user-agent": UA } });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(target, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": UA } });
      }
    } catch {
      res = await fetch(target, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": UA } });
    }
    return { url: target, ok: res.ok, status_code: res.status, final_url: res.url || target };
  } catch (e: any) {
    return {
      url: target,
      ok: false,
      status_code: null,
      final_url: null,
      error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e),
    };
  } finally {
    clearTimeout(t);
  }
}

export function checkEmail(email: string, websiteUrl: string | null): EmailCheck {
  const format_valid = EMAIL_RE.test(email);
  const emailHost = email.split("@")[1]?.toLowerCase().replace(/^www\./, "") ?? null;
  let domain_matches_website: boolean | null = null;
  if (websiteUrl) {
    const siteHost = hostOf(websiteUrl);
    if (emailHost && siteHost) {
      domain_matches_website = emailHost === siteHost || emailHost.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${emailHost}`);
    }
  }
  return { email, format_valid, domain_matches_website, is_aggregator_domain: isAggregatorDomain(emailHost) };
}

// ---- Contact discovery (persistent multi-step fetch) -----------------------

async function fetchPageText(url: string): Promise<{ ok: boolean; status: number; html: string; finalUrl: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (bytes >= MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } else {
      html = await res.text();
    }
    return { ok: res.ok, status: res.status, html, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$/i;
const JUNK_EMAIL_RE = /(sentry|wixpress|example\.|your-?email|email@|name@|user@|domain\.com|@2x|\.png|\.jpg)/i;

// Third-party service domains whose emails frequently appear embedded on corporate
// websites (tracking pixels, HR widgets, analytics tools, CMS/marketing automation).
// These are never a supplier's sales inbox.
const THIRD_PARTY_SERVICE_DOMAINS = new Set([
  "personio.de", "personio.com", "greenhouse.io", "lever.co", "workday.com",
  "researchdive.com", "grandviewresearch.com", "mordorintelligence.com",
  "hubspot.com", "mailchimp.com", "constantcontact.com", "marketo.com",
  "zendesk.com", "intercom.io", "freshdesk.com", "salesforce.com",
  "typeform.com", "surveymonkey.com", "jotform.com",
  "cloudflare.com", "akamai.com", "fastly.com",
  "google.com", "facebook.com", "twitter.com", "linkedin.com", "instagram.com",
  "youtube.com", "tiktok.com", "pinterest.com",
  "shopify.com", "squarespace.com", "wix.com", "wordpress.com", "webflow.com",
  "stripe.com", "paypal.com",
  "trustpilot.com", "capterra.com", "g2.com",
  "zoominfo.com", "apollo.io", "lusha.com", "clearbit.com",
  "calendly.com", "gong.io", "drift.com",
]);

function isThirdPartyServiceEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return THIRD_PARTY_SERVICE_DOMAINS.has(domain);
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const ok = (e: string) =>
    EMAIL_RE.test(e) && !JUNK_EMAIL_RE.test(e) && !ASSET_EXT_RE.test(e) &&
    !isPlaceholderEmail(e) && !isThirdPartyServiceEmail(e) && !isAggregatorEmail(e);
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = decodeURIComponent(m[1]).trim().toLowerCase();
    if (ok(e)) found.add(e);
  }
  for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const e = m[0].trim().toLowerCase();
    if (ok(e)) found.add(e);
  }
  return Array.from(found).slice(0, 8);
}

function digits(s: string): string {
  return s.replace(/[^\d]/g, "");
}

export function extractPhones(html: string): string[] {
  const found = new Map<string, string>(); // digits -> display
  for (const m of html.matchAll(/tel:([+\d][\d\s().-]{6,}\d)/gi)) {
    const raw = decodeURIComponent(m[1]).trim();
    const d = digits(raw);
    if (d.length >= 8 && d.length <= 15) found.set(d, raw);
  }
  // International (+CC ...) and US-style patterns, deduped by digit string.
  const patterns = [/\+\d[\d\s().-]{7,}\d/g, /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const raw = m[0].trim();
      const d = digits(raw);
      if (d.length >= 9 && d.length <= 15 && !found.has(d)) found.set(d, raw);
    }
  }
  return Array.from(found.values()).slice(0, 4);
}

function findContactLinks(html: string, base: string): string[] {
  const host = hostOf(base);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>(.*?)<\/a>/gis)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ");
    if (!/contact|about|sales|enquir|inquir|reach\s*us|quote/i.test(href + " " + text)) continue;
    try {
      const abs = new URL(href, base).toString();
      if (hostOf(abs) === host) out.add(abs.split("#")[0]);
    } catch {
      /* skip bad href */
    }
  }
  return Array.from(out).slice(0, 6);
}

function hasQuoteForm(html: string): boolean {
  return /request\s*(a)?\s*quote|get\s*(a)?\s*quote|sales\s*(inquiry|enquiry)|\brfq\b|request\s*(a)?\s*sample|<form/i.test(html);
}

// Walks the supplier site to find a usable contact channel. Always attempts the
// homepage plus several common contact paths, so even when the homepage blocks
// bots we still try ≥3 pages before declaring the channels invalid.
// Also returns the homepage HTML + finalUrl so the caller can run legitimacy
// analysis without an extra network round-trip.
export async function discoverContacts(website: string): Promise<{
  emails: string[];
  phones: string[];
  contact_url: string | null;
  pages_tried: number;
  any_ok: boolean;
  homepage_html: string;
  homepage_final_url: string | null;
}> {
  const base = normalizeBase(website);
  const emails = new Set<string>();
  const phones = new Set<string>();
  let contactUrl: string | null = null;
  let pagesTried = 0;
  let anyOk = false;
  let homepageHtml = "";
  let homepageFinalUrl: string | null = null;

  const seen = new Set<string>();
  const keyOf = (u: string) => {
    try {
      const p = new URL(u);
      return (p.host + p.pathname).replace(/\/$/, "").toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  };

  const queue: string[] = [base, ...CONTACT_PATHS.map((p) => new URL(p, base).toString())];
  let enqueuedLinks = false;

  while (queue.length && pagesTried < MAX_PAGES) {
    const url = queue.shift()!;
    const k = keyOf(url);
    if (seen.has(k)) continue;
    seen.add(k);

    const page = await fetchPageText(url);
    pagesTried++;
    if (!page) continue;
    if (page.ok) anyOk = true;

    // Capture homepage HTML for legitimacy analysis (first page = homepage).
    if (pagesTried === 1) {
      homepageHtml = page.html;
      homepageFinalUrl = page.finalUrl;
    }

    for (const e of extractEmails(page.html)) emails.add(e);
    for (const p of extractPhones(page.html)) phones.add(p);
    if (!contactUrl && hasQuoteForm(page.html) && /contact|sales|quote|enquir|inquir/i.test(page.finalUrl)) {
      contactUrl = page.finalUrl;
    }

    // After the homepage, enqueue any contact-ish links we actually saw (these
    // beat guessed paths when present).
    if (!enqueuedLinks && page.ok) {
      enqueuedLinks = true;
      const links = findContactLinks(page.html, page.finalUrl);
      // contact links jump the queue ahead of the guessed paths
      queue.unshift(...links);
    }

    // Got a direct email + phone — that's enough, stop early.
    if (emails.size > 0 && phones.size > 0) break;
  }

  // If we found a quote/contact page but no direct email, the contact page URL
  // is itself the channel.
  if (!contactUrl && emails.size === 0) {
    // fall back to the homepage as a last-resort contact channel only if it loaded
    contactUrl = anyOk ? base : null;
  }

  return {
    emails: Array.from(emails),
    phones: Array.from(phones),
    contact_url: contactUrl,
    pages_tried: pagesTried,
    any_ok: anyOk,
    homepage_html: homepageHtml,
    homepage_final_url: homepageFinalUrl,
  };
}

export async function fetchTenkaraSupplier(supplierId: string): Promise<SupplierEnrichment | null> {
  const rows = await tenkaraQuery<any>(
    `select address, city, state, zip, country, poc_phone, shipping_email, billing_email,
            is_marketplace, responsiveness_score, payment_terms, supplier_type
       from public.suppliers where id = $1::uuid limit 1`,
    [supplierId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    address: r.address ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    zip: r.zip ?? null,
    country: r.country ?? null,
    poc_phone: r.poc_phone ?? null,
    shipping_email: r.shipping_email ?? null,
    billing_email: r.billing_email ?? null,
    is_marketplace: r.is_marketplace ?? null,
    responsiveness_score: r.responsiveness_score ?? null,
    payment_terms: r.payment_terms ?? null,
    supplier_type: r.supplier_type ?? null,
  };
}

// ---------- Legitimacy analysis (no extra network calls) --------------------
//
// All signals are extracted from the HTML already fetched during contact
// discovery. Cost: zero extra round-trips.

const CERT_PATTERNS: [RegExp, string][] = [
  [/\biso\s*9001\b/i, "ISO 9001"],
  [/\biso\s*14001\b/i, "ISO 14001"],
  [/\biso\s*22000\b/i, "ISO 22000"],
  [/\biso\s*45001\b/i, "ISO 45001"],
  [/\bgmp\b/i, "GMP"],
  [/\bfda[\s-]?registered\b/i, "FDA registered"],
  [/\bfda[\s-]?approved\b/i, "FDA approved"],
  [/\bnsf\s+(?:certified|international)\b/i, "NSF certified"],
  [/\busda\s+organic\b/i, "USDA Organic"],
  [/\bhaccp\b/i, "HACCP"],
  [/\bkosher\s+certified\b/i, "Kosher certified"],
  [/\bhalal\s+certified\b/i, "Halal certified"],
  [/\borganic\s+certified\b/i, "Organic certified"],
  [/\bcGMP\b/, "cGMP"],
];

function extractCertifications(html: string): string[] {
  const found = new Set<string>();
  for (const [re, label] of CERT_PATTERNS) {
    if (re.test(html)) found.add(label);
  }
  return Array.from(found);
}

function extractEstablishedYear(html: string): number | null {
  const m = html.match(/(?:since|founded(?:\s+in)?|est\.?\s*|established\s*)(\d{4})/i);
  if (!m) return null;
  const yr = parseInt(m[1]);
  const now = new Date().getFullYear();
  return yr >= 1850 && yr <= now ? yr : null;
}

function analyzeLegitimacy(html: string, websiteUrl: string, finalUrl: string | null): LegitimacyCheck {
  const is_https =
    websiteUrl.startsWith("https://") || (finalUrl ?? "").startsWith("https://");
  const certifications = extractCertifications(html);
  const is_established_entity = /\b(?:inc\.|inc\b|llc\b|corp\.|corp\b|ltd\.|ltd\b|limited\b|incorporated\b|co\.\s*ltd|pty\s+ltd)\b/i.test(html);
  const established_year = extractEstablishedYear(html);
  const has_bbb_accreditation = /bbb\.org|better\s+business\s+bureau|bbb\s+accredited/i.test(html);
  const has_linkedin_link = /linkedin\.com\/company\//i.test(html);

  const signals: string[] = [];
  let score = 0;

  if (is_https) { score += 0.15; signals.push("HTTPS"); }
  if (is_established_entity) { score += 0.2; signals.push("legal entity (Inc/LLC/Corp/Ltd)"); }
  if (certifications.length > 0) {
    score += Math.min(0.35, 0.1 + certifications.length * 0.05);
    signals.push(...certifications);
  }
  if (established_year != null) {
    const age = new Date().getFullYear() - established_year;
    score += age >= 10 ? 0.15 : age >= 3 ? 0.08 : 0.03;
    signals.push(`Est. ${established_year} (${age}yr)`);
  }
  if (has_bbb_accreditation) { score += 0.1; signals.push("BBB accredited"); }
  if (has_linkedin_link) { score += 0.05; signals.push("LinkedIn company link"); }

  return {
    is_https,
    certifications,
    is_established_entity,
    established_year,
    has_bbb_accreditation,
    has_linkedin_link,
    score: Math.min(1, Math.round(score * 100) / 100),
    signals,
  };
}

// Cheap heuristic score from what we know. A lead with a valid website + valid
// email + domain match + a phone clears ~0.85. Returns the score alongside the
// factors that produced it so the reason can be surfaced to operators.
function scoreCompleteness(args: {
  websiteProbe: WebsiteProbe | null;
  emailCheck: EmailCheck | null;
  hasPhone: boolean;
  hasContactUrl: boolean;
  hasCountry: boolean;
}): { score: number; factors: CompletenessFactor[] } {
  const factors: CompletenessFactor[] = [];
  if (args.websiteProbe?.ok) factors.push({ label: "website resolves", points: 0.3 });
  else if (args.websiteProbe) factors.push({ label: "website tried, didn't resolve", points: 0.1 });
  if (args.emailCheck?.format_valid) factors.push({ label: "valid email", points: 0.25 });
  if (args.emailCheck?.domain_matches_website === true) factors.push({ label: "email domain matches site", points: 0.1 });
  if (args.hasPhone) factors.push({ label: "phone found", points: 0.15 });
  else if (args.hasContactUrl) factors.push({ label: "contact form only (no direct phone)", points: 0.05 });
  if (args.hasCountry) factors.push({ label: "country known", points: 0.15 });
  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.min(1, Math.round(raw * 100) / 100);
  return { score, factors };
}

// ---------- Marketplace-listing confidence penalties ------------------------
//
// Applied only to marketplace/aggregator listings (a direct manufacturer site
// with a quote form is a normal RFQ-only supplier, not a low-confidence one).

// "Send Inquiry" / quote-only CTAs — the listing wants you to ask, not buy.
const SEND_INQUIRY_RE =
  /send\s+inquiry|send\s+enquiry|contact\s+supplier|inquire\s+now|price\s+on\s+request|request\s+(?:a\s+)?(?:quote|quotation|for\s+quotation)|get\s+(?:a\s+)?quote|post\s+(?:my\s+)?rfq|chat\s+now|start\s+order/i;

// A currency price *range* (e.g. "US$1,100.00-1,300.00", "$5.00 - $10.00",
// "€10–€20") rather than a single firm number.
const PRICE_RANGE_RE =
  /(?:US\s*\$|\$|€|£|₹|¥|RMB|CNY)\s?\d[\d,]*(?:\.\d+)?\s?[-–—~]\s?(?:US\s*\$|\$|€|£|₹|¥|RMB|CNY)?\s?\d[\d,]*(?:\.\d+)?/;

const MP_PENALTY_SEND_INQUIRY = 0.2;
const MP_PENALTY_PRICE_RANGE = 0.15;
const MP_PENALTY_LOW_TRUST_CN = 0.25;

function detectChinaOrigin(args: {
  listingHost: string | null;
  country: string | null;
  phone: string | null;
  emailHost: string | null;
}): boolean {
  if (args.listingHost && hostMatchesAny(args.listingHost, CHINA_ONLY_MARKETPLACE_DOMAINS)) return true;
  const c = (args.country ?? "").toLowerCase();
  if (/\bchina\b|\bp\.?\s*r\.?\s*china\b|\bprc\b|\bcn\b/.test(c)) return true;
  if (args.phone) {
    const d = args.phone.replace(/[^\d+]/g, "");
    if (/^\+?86\d/.test(d)) return true;
  }
  if (args.emailHost && /\.cn$/.test(args.emailHost)) return true;
  return false;
}

// Assess a marketplace listing for the two confidence rules. Returns null for a
// non-marketplace host (rules don't apply). `html` is the listing HTML already
// fetched during contact discovery — empty when we couldn't fetch it, in which
// case only the host/origin-based penalty can fire.
export function assessMarketplaceTrust(args: {
  listingHost: string | null;
  html: string;
  country: string | null;
  phone: string | null;
  emailHost: string | null;
}): MarketplaceTrustCheck | null {
  const host = args.listingHost;
  if (!host || !isAggregatorDomain(host)) return null;

  const isLowTrust = isLowTrustMarketplace(host);
  const china = detectChinaOrigin(args);
  const html = args.html ?? "";
  const sendInquiryOnly = html ? SEND_INQUIRY_RE.test(html) : false;
  const priceRangeOnly = html ? PRICE_RANGE_RE.test(html) : false;

  const factors: CompletenessFactor[] = [];
  const signals: string[] = [];
  if (sendInquiryOnly) {
    factors.push({ label: "marketplace: inquiry/quote only (no firm price)", points: -MP_PENALTY_SEND_INQUIRY });
    signals.push("inquiry/quote only");
  }
  if (priceRangeOnly) {
    factors.push({ label: "marketplace: price shown as a range", points: -MP_PENALTY_PRICE_RANGE });
    signals.push("price range, not firm");
  }
  if (isLowTrust && china) {
    factors.push({ label: "low-trust marketplace, China-based supplier", points: -MP_PENALTY_LOW_TRUST_CN });
    signals.push("low-trust marketplace (China supplier)");
  }

  const penalty = Math.round(-factors.reduce((s, f) => s + f.points, 0) * 100) / 100;
  return {
    marketplace_host: host,
    is_low_trust_marketplace: isLowTrust,
    send_inquiry_only: sendInquiryOnly,
    price_range_only: priceRangeOnly,
    china_origin: china,
    penalty,
    factors,
    signals,
  };
}

// ---------- Material-relevance backstop (advisory) --------------------------
//
// Only for source=importyeti/sourceready leads. Tokenizes the target material
// name + INCI into meaningful keywords and checks for ANY overlap with the
// supplier's captured product text. Zero overlap (when there IS product text to
// check) → flag as capability-unverified. This is a first, safe keyword backstop:
// it catches obviously-off leads (a fruit farm under "Nano Silica") but does NOT
// judge a company that legitimately ships the material yet is a buyer / wrong
// side of the trade. See PR notes for the limitation.

// Generic English + commerce/grade words that carry no material identity. Dropped
// from both sides so they can't manufacture a false "match" (e.g. both a farm and
// a silica maker say "food grade" / "high quality").
const RELEVANCE_STOPWORDS = new Set([
  "and", "the", "for", "with", "from", "our", "your", "all", "new", "top",
  "grade", "grades", "pure", "purity", "raw", "material", "materials",
  "product", "products", "high", "quality", "fine", "bulk", "wholesale",
  "supplier", "suppliers", "supply", "manufacturer", "manufacturers", "factory",
  "best", "price", "prices", "cheap", "natural", "organic", "industrial",
  "food", "cosmetic", "cosmetics", "pharma", "pharmaceutical", "technical",
  "usp", "fcc", "ansi", "cas", "powder", "powdered", "granular", "granule",
  "liquid", "solution", "anhydrous", "min", "max", "per", "type", "form",
  "assorted", "various", "trading", "trade", "company", "limited", "inc",
]);

// Split a free-text string into lowercase alphanumeric tokens, dropping stopwords,
// tokens shorter than 3 chars, and pure numbers.
function relevanceTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !RELEVANCE_STOPWORDS.has(t));
}

// Collect the free-text product/description fields the discovery sources populate
// into one lowercased blob for overlap checking. Guards each field; several may
// be arrays (e.g. top_products).
export function collectProductText(payload: Record<string, any> | null | undefined): string {
  if (!payload) return "";
  const fields = ["top_products", "product_description", "supplier_background", "trade_name", "grades_offered", "scout_notes"];
  const parts: string[] = [];
  for (const f of fields) {
    const v = payload[f];
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) if (item != null) parts.push(String(item));
    } else {
      parts.push(String(v));
    }
  }
  return parts.join(" ").trim();
}

// Advisory relevance check. `productText` is the supplier's captured product/
// description blob (see collectProductText). Returns relevant=false ONLY when
// there was product text AND it shared zero meaningful material tokens.
export function assessMaterialRelevance(args: {
  materialName: string | null | undefined;
  inci: string | null | undefined;
  productText: string | null | undefined;
}): MaterialRelevanceCheck {
  const materialTokens = Array.from(new Set([...relevanceTokens(args.materialName), ...relevanceTokens(args.inci)]));
  const text = (args.productText ?? "").toLowerCase();
  const textTokens = new Set(relevanceTokens(args.productText));

  // No material tokens to test against, or no product text captured → can't judge,
  // so treat as relevant (never flag on absence of information).
  if (materialTokens.length === 0 || text.trim().length === 0) {
    return { relevant: true, matchedTokens: [], note: null };
  }

  // A token matches if the product text contains it as a token or as a substring
  // (handles plurals / compounds like "silica" in "silicas"/"nanosilica"). Lenient
  // by design: we only flag on genuinely ZERO overlap.
  const matchedTokens = materialTokens.filter((t) => textTokens.has(t) || text.includes(t));
  if (matchedTokens.length > 0) {
    return { relevant: true, matchedTokens, note: null };
  }

  const label = (args.materialName || args.inci || "the target material").trim();
  return {
    relevant: false,
    matchedTokens: [],
    note: `No product-text match to ${label}; verify this supplier actually handles it.`,
  };
}

// Advisory completeness penalty applied when a discovery lead's product text has
// zero overlap with the target material. Soft only: sorts the lead down, never
// blocks outreach. Kept modest so a false flag doesn't bury an otherwise good lead.
const RELEVANCE_PENALTY = 0.15;

// Treat scout-captured "via IndiaMART inquiry" / "contact form" strings as a
// (weak) contact channel rather than a broken email.
function isContactPath(s: string | null | undefined): boolean {
  return !!s && !EMAIL_RE.test(s) && /via |form|inquir|enquir|contact/i.test(s);
}

export async function enrichLead(lead: RawLead): Promise<EnrichmentResult> {
  const payload = lead.payload ?? {};
  const website = (payload.supplier_website as string | null) || null;
  const scoutEmail = (payload.supplier_contact_email as string | null) || null;
  const scoutPhone = (payload.supplier_phone as string | null) || null;

  const [website_probe, tenkara_supplier] = await Promise.all([
    website ? probeWebsite(website) : Promise.resolve(null),
    lead.supplier_id ? fetchTenkaraSupplier(lead.supplier_id).catch(() => null) : Promise.resolve(null),
  ]);

  // A placeholder/no-reply email is not a real inbox at all — discard entirely.
  // A marketplace/aggregator email (concierge@knowde.com) is not the supplier's
  // inbox — remember it for the operator, then resolve the real email below.
  const scoutIsPlaceholder = isPlaceholderEmail(scoutEmail);
  const scoutIsAggregator = !scoutIsPlaceholder && isAggregatorEmail(scoutEmail);
  let aggregatorEmail: string | null = scoutIsAggregator ? (scoutEmail as string).toLowerCase() : null;

  // Seed channels from what we already have.
  let email: string | null =
    scoutEmail && EMAIL_RE.test(scoutEmail) && !scoutIsAggregator && !scoutIsPlaceholder
      ? scoutEmail.toLowerCase() : null;
  let phone: string | null =
    (scoutPhone && !isContactPath(scoutPhone) ? scoutPhone : null) ?? tenkara_supplier?.poc_phone ?? null;
  let contactUrl: string | null = isContactPath(scoutEmail) ? null : null;
  let contactSource: ContactDiscovery["source"] = email ? "scout" : null;
  let pagesTried = 0;
  // Listing HTML fetched during contact discovery, reused for marketplace-trust
  // signal detection (Send Inquiry / price range) with no extra network call.
  let listingHtml = "";

  // If we're missing a direct email or a phone, go fetch — persistently. This is
  // also the auto-resolve path when the only email we had was a marketplace one.
  let legitimacy_check: LegitimacyCheck | null = null;
  if (website && (!email || !phone)) {
    const d = await discoverContacts(website).catch(() => null);
    if (d) {
      pagesTried = d.pages_tried;
      listingHtml = d.homepage_html ?? "";
      // Run legitimacy analysis on the homepage HTML we already fetched.
      if (d.homepage_html) {
        legitimacy_check = analyzeLegitimacy(d.homepage_html, website, d.homepage_final_url);
      }
      if (!email && d.emails.length) {
        // Only accept emails from the supplier's own domain. Emails scraped from
        // corporate sites often include third-party services (HR, analytics,
        // tracking) that are not the supplier's inbox. Hard-require a domain
        // match against the supplier website; fall back to contact_url only.
        const siteHost = hostOf(website);
        const own = d.emails.filter((e) => !isAggregatorEmail(e) && !isThirdPartyServiceEmail(e));
        const domainMatch = siteHost
          ? own.filter((e) => {
              const emailDomain = e.split("@")[1]?.replace(/^www\./, "");
              if (!emailDomain) return false;
              return emailDomain === siteHost || siteHost.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${siteHost}`);
            })
          : [];
        const pick = domainMatch[0] ?? null;
        if (pick) {
          email = pick;
          contactSource = "discovered";
        } else if (own.length && !siteHost) {
          email = own[0];
          contactSource = "discovered";
        } else if (!aggregatorEmail) {
          aggregatorEmail = d.emails.find((e) => isAggregatorEmail(e)) ?? null;
        }
      }
      if (!phone && d.phones.length) phone = d.phones[0];
      if (!contactUrl && d.contact_url) {
        contactUrl = d.contact_url;
        if (!contactSource) contactSource = "discovered";
      }
    }
  }

  // Platform fallback: if the public web gave us no direct email, use one the
  // Tenkara supplier record already holds (shipping/billing). Generic addresses
  // (info@, sales@) are fine — a reachable inbox beats a contact form — but an
  // aggregator address is never a valid fallback.
  if (!email && tenkara_supplier) {
    const tenkEmail = [tenkara_supplier.shipping_email, tenkara_supplier.billing_email]
      .map((e) => (e ?? "").trim().toLowerCase())
      .find((e) => EMAIL_RE.test(e) && !isAggregatorEmail(e));
    if (tenkEmail) {
      email = tenkEmail;
      contactSource = "tenkara";
    }
  }

  // A scout-supplied contact path (e.g. "via IndiaMART inquiry") still counts.
  if (!email && !phone && !contactUrl && (isContactPath(scoutEmail) || isContactPath(scoutPhone))) {
    contactUrl = website || null;
    contactSource = "path";
  }

  // Couldn't resolve the supplier's own email and all we had was a marketplace
  // address — keep the lead reachable as a manual-contact case rather than cold-
  // emailing the marketplace. Prefer the supplier site, else the listing URL.
  if (!email && aggregatorEmail && !contactUrl) {
    contactUrl = website || (payload.source_url as string | null) || null;
    if (contactUrl && !contactSource) contactSource = "path";
  }

  const email_check = email ? checkEmail(email, website) : null;

  const base = scoreCompleteness({
    websiteProbe: website_probe,
    emailCheck: email_check,
    hasPhone: !!phone,
    hasContactUrl: !!contactUrl,
    hasCountry: !!(tenkara_supplier?.country || payload.supplier_country),
  });

  // Marketplace-listing confidence penalties (soft down-rank only). Resolve the
  // listing host from the supplier website or the scanner's source URL.
  const listingHost = hostOf(website || (payload.source_url as string | null) || "");
  const marketplace_trust = assessMarketplaceTrust({
    listingHost,
    html: listingHtml,
    country: tenkara_supplier?.country ?? (payload.supplier_country as string | null) ?? null,
    phone,
    emailHost: (email ?? scoutEmail)?.split("@")[1]?.toLowerCase() ?? null,
  });

  // Material-relevance backstop: advisory, and only for the customs/directory
  // discovery sources whose loose matching can drag in wrong-industry companies.
  const isDiscoverySource = lead.source === "importyeti" || lead.source === "sourceready";
  const material_relevance: MaterialRelevanceCheck | null = isDiscoverySource
    ? assessMaterialRelevance({
        materialName: lead.material_name,
        inci: (payload.inci_name as string | null) ?? null,
        productText: collectProductText(payload),
      })
    : null;
  // A small negative completeness factor when there's genuinely zero material-token
  // overlap, so the unverified lead sorts down. Recomputed from scratch each run, so
  // re-enriching never stacks the penalty (idempotent).
  const relevanceFactors: CompletenessFactor[] =
    material_relevance && !material_relevance.relevant
      ? [{ label: "no product-text match to target material", points: -RELEVANCE_PENALTY }]
      : [];

  const completeness_factors = [
    ...base.factors,
    ...(marketplace_trust ? marketplace_trust.factors : []),
    ...relevanceFactors,
  ];
  const completeness_score = Math.max(
    0,
    Math.min(1, Math.round(completeness_factors.reduce((s, f) => s + f.points, 0) * 100) / 100)
  );

  // Outreach-ready = we have at least one usable way to reach the supplier:
  // a format-valid email, a phone, a contact/quote-form URL, or a live website.
  const hasViableEmail = !!email_check?.format_valid;
  const outreach_ready = hasViableEmail || !!phone || !!contactUrl || !!website_probe?.ok;

  let blocked_reason: string | null = null;
  if (!outreach_ready) {
    blocked_reason = !website && !scoutEmail && !scoutPhone ? "no_contact_channels" : "all_contact_channels_invalid";
  }

  const contact: ContactDiscovery = { email, phone, contact_url: contactUrl, pages_tried: pagesTried, source: contactSource };

  return {
    website_probe,
    email_check,
    contact,
    tenkara_supplier,
    legitimacy_check,
    marketplace_trust,
    material_relevance,
    completeness_score,
    completeness_factors,
    outreach_ready,
    blocked_reason,
    aggregator_contact_email: email ? null : aggregatorEmail,
  };
}
