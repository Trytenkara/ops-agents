import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { enrichContactViaGetProspect, isGetProspectConfigured } from "@/lib/getprospect";
import { enrichContactViaZoomInfo, enrichContactsViaZoomInfo, isZoomInfoConfigured } from "@/lib/zoominfo";
import { enrichContactViaHunter, enrichContactsViaHunter, isHunterConfigured } from "@/lib/hunter";
import { enrichContactsViaLeadMagic, enrichPrimaryViaLeadMagic, isLeadMagicConfigured } from "@/lib/leadmagic";
import { AGGREGATOR_HOSTS } from "@/lib/aggregator-hosts";
import {
  contactDomainKey,
  readContactDomainCache,
  recordContactCacheHit,
  writeContactDomainCache,
  paidLookupSuppressed,
  CACHE_TTL_DAYS,
  type CachedContact,
} from "@/lib/contact-domain-cache";
import { assessDealbreakerFit, type DealbreakerFit, type DealbreakerSpec } from "@/lib/dealbreaker-fit";

// Pre-outreach enrichment building blocks. No LLM, no email — those land
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
  // Tenkara materials.id for this lead. Present so the dealbreaker spec below can
  // be resolved per material; null on legacy rows that never had it set.
  material_id?: string | null;
  // The client's dealbreaker specs for this lead's material, resolved once per
  // batch by the caller (Tenkara lives in a different database, so enrichment
  // never fetches it per lead). Null when the client configured none.
  dealbreaker_spec?: DealbreakerSpec | null;
  payload: Record<string, any> | null;
  // Lead-creation confidence (0..1), if scored. Enrichment lowers it by any
  // marketplace-trust penalty so a down-ranked lead sorts to the bottom of the
  // confidence-ordered enrichment/outreach queues. Null when never scored.
  confidence_score?: number | null;
  // True when this lead's org is an internal test org (orgs.is_internal). Paid
  // contact providers (Hunter/LeadMagic/ZoomInfo/GetProspect) are skipped for
  // these so scarce credits go to real paying clients first; the free website
  // scrape + Tenkara lookup still run. Threaded in by the caller (Tenkara/org
  // metadata isn't on the lead row). Null/undefined = treat as real client.
  is_internal?: boolean | null;
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
  // Company-profile / data-provider / business-directory sites. These get
  // mis-captured by discovery as a supplier's "website" (e.g. a Bloomberg
  // company-profile URL). Treating them as aggregator domains stops enrichment
  // from trusting them as the supplier's own domain and rejects any contact on
  // them — otherwise a domain-search (Hunter/ZoomInfo) against bloomberg.com
  // returns Bloomberg staff, and multi-contact CCs the whole list.
  "bloomberg.com",
  "dnb.com",
  "crunchbase.com",
  "pitchbook.com",
  "zoominfo.com",
  "apollo.io",
  "lusha.com",
  "rocketreach.co",
  "opencorporates.com",
  "owler.com",
  "linkedin.com",
  // Trade/customs-data providers, directories, and social networks — same class
  // as the profile sites above (a directory URL captured as the supplier site,
  // whose domain-search then returns the platform's own staff).
  "volza.com",
  "bebee.com",
  "environmental-expert.com",
  "taiwantrade.com",
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
// platforms with thin supplier vetting, where a firm purchasable price is the
// exception and "Send Inquiry" / wide price ranges are the norm. Used only to
// *down-rank* a marketplace lead's confidence — never to drop it. Same list that
// drives the "aggregator" market kind, so both stay in step.
const LOW_TRUST_MARKETPLACE_DOMAINS = AGGREGATOR_HOSTS;

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
  source: "scout" | "sourceready" | "discovered" | "path" | "tenkara" | "hunter" | "leadmagic" | "zoominfo" | "getprospect" | "pattern_guess" | null;
  poc_name?: string | null;
  poc_title?: string | null;
}

// A secondary reachable contact at the same supplier, gathered so outreach can
// CC additional people on the ONE supplier thread (better odds of a reply than a
// single recipient). Never includes the primary `ContactDiscovery.email`.
export interface AdditionalContact {
  email: string;
  name: string | null;
  title: string | null;
  source: "discovered" | "tenkara" | "hunter" | "leadmagic" | "zoominfo" | "getprospect" | "pattern_guess";
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
  // Extra reachable people at the same supplier, for CC on the outreach thread.
  // Empty when multi-contact is disabled or nothing else was found.
  additional_contacts: AdditionalContact[];
  tenkara_supplier: SupplierEnrichment | null;
  legitimacy_check: LegitimacyCheck | null;
  marketplace_trust: MarketplaceTrustCheck | null;
  // Non-null only for source=importyeti/sourceready leads (the backstop's scope).
  material_relevance: MaterialRelevanceCheck | null;
  // Whether the evidence we hold shows this supplier can meet the client's
  // dealbreaker grades/certs. Null when the client set no dealbreakers. Advisory:
  // an "unmet" verdict never blocks the lead (see lib/dealbreaker-fit.ts).
  dealbreaker_fit: DealbreakerFit | null;
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
  // How the primary email was obtained: "verified" for a scraped/provider/
  // validated address, "guessed" for a synthesized pattern combo (name found but
  // no verified email), null when there is no email. Operators see this on the
  // draft; guessed drafts are always human-reviewed before send.
  contact_confidence: "verified" | "guessed" | null;
}

const PROBE_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 7_000;
const MAX_PAGES = 7; // homepage + up to 6 follow-ups → always ≥3 tried before blocking
const MAX_BODY_BYTES = 700_000;
const UA = "Mozilla/5.0 (compatible; TackleBox-Enrich/1.0)";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Order matters: contact/quote pages first so we find a channel fast. The team /
// leadership pages come last: they rarely carry a direct inbox, but they are
// where a POC NAME comes from, and a name on the supplier's own domain is enough
// to build the guessed-pattern draft.
const CONTACT_PATHS = [
  "/contact", "/contact-us", "/contactus", "/contact.html", "/sales",
  "/get-a-quote", "/request-a-quote", "/rfq", "/enquiry", "/reach-us",
  // German/EU sites: an Impressum is a legal requirement and always prints a
  // real address, an email and a named managing director.
  "/impressum", "/kontakt",
  "/about", "/about-us", "/company", "/team", "/our-team", "/leadership",
];

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
// A bundled asset reference ("swiper@7.0.5-bundle.min") satisfies the email
// shape, so filter on the trailing label: a real address never ends in one of
// these, and a real TLD is alphabetic.
const NON_TLD = new Set([
  "min", "js", "css", "map", "json", "html", "htm", "php", "bundle", "esm", "cjs", "umd",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "woff", "woff2", "ttf", "eot", "less", "scss",
]);
function hasRealTld(email: string): boolean {
  const tld = email.split(".").pop()?.toLowerCase() ?? "";
  return /^[a-z]{2,24}$/.test(tld) && !NON_TLD.has(tld);
}
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

// Cloudflare Email Address Obfuscation replaces every mailto on a page with a
// hex blob, so a site behind it reads as having no email at all. The encoding is
// a plain XOR: first byte is the key. Decoding it is the single highest-yield
// crawl fix, because Cloudflare is in front of a large share of supplier sites.
function decodeCfEmails(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/(?:data-cfemail=["']|\/cdn-cgi\/l\/email-protection#)([0-9a-f]{8,})/gi)) {
    const hex = m[1];
    const key = parseInt(hex.slice(0, 2), 16);
    let s = "";
    for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    if (EMAIL_RE.test(s)) out.push(s.toLowerCase());
  }
  return out;
}

// Sites that write "sales (at) acme (dot) com" to dodge scrapers are publishing a
// real inbox; normalize the spellings back into an address before extraction.
function deobfuscateEmailText(html: string): string {
  return html
    .replace(/&#(?:64|x40);/gi, "@")
    .replace(/&#(?:46|x2e);/gi, ".")
    .replace(/\s*(?:\(|\[|&#40;)?\s*(?:at|AT)\s*(?:\)|\]|&#41;)?\s*/g, (m) => (/[([]|&#40;/.test(m) ? "@" : m))
    .replace(/\s*(?:\(|\[|&#40;)?\s*(?:dot|DOT)\s*(?:\)|\]|&#41;)?\s*/g, (m) => (/[([]|&#40;/.test(m) ? "." : m));
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const ok = (e: string) =>
    EMAIL_RE.test(e) && !JUNK_EMAIL_RE.test(e) && !ASSET_EXT_RE.test(e) &&
    !isPlaceholderEmail(e) && !isThirdPartyServiceEmail(e) && !isAggregatorEmail(e) && hasRealTld(e);
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = decodeURIComponent(m[1]).trim().toLowerCase();
    if (ok(e)) found.add(e);
  }
  for (const e of decodeCfEmails(html)) {
    if (ok(e)) found.add(e);
  }
  for (const m of deobfuscateEmailText(html).matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const e = m[0].trim().toLowerCase();
    if (ok(e)) found.add(e);
  }
  return Array.from(found).slice(0, 8);
}

// Named people on the supplier's own site, for the guessed-pattern fallback.
//
// Measured 2026-08-05: of 2,744 no-email leads that DO have their own corporate
// domain, zero carried a POC name, so the guessed-pattern rule (which needs a
// name plus a domain) could never fire on any of them. The names are on the
// about / team / impressum pages we now crawl; this reads them out.
//
// Deliberately conservative: a name is only taken when it sits directly against a
// commercial job title, because a false name becomes a wrong guessed address.
// That is tolerable but not free, since every guessed contact is staged as a
// human-reviewed draft.
const PERSON_TITLE_RE =
  /(chief\s+executive(\s+officer)?|managing\s+director|general\s+manager|sales\s+(manager|director|head)|head\s+of\s+sales|export\s+(manager|director)|business\s+development\s+(manager|director)|purchase\s+manager|co[-\s]?founder|founder|proprietor|owner|president|geschäftsführer|ceo|cfo|coo|cmo)/i;
const NAME_TOKEN = "[A-ZÀ-Þ][a-zà-ÿ'’-]{1,19}";
const NAME_RE = new RegExp(`${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){1,2}`);
const NAME_STOPWORDS =
  /^(contact|about|our|the|home|privacy|terms|cookie|all|rights|read|more|get|quote|send|inquiry|customer|service|new|view|learn|sign|log|add|buy)\b/i;

export function extractPeople(html: string): { name: string; title: string | null }[] {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " | ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+/g, " ");
  const out = new Map<string, { name: string; title: string | null }>();
  // "Jane Doe, Sales Director" and "Sales Director: Jane Doe" (either order, with
  // an optional tag boundary between them from the strip above).
  // The separator is generous because the tag strip above turns "</h3><span>"
  // into several pipes, but it is length-capped so a name and a title on
  // unrelated parts of the page can never be paired up.
  const SEP = "[\\s|:,·–-]{1,8}";
  const patterns = [
    new RegExp(`(${NAME_RE.source})${SEP}(${PERSON_TITLE_RE.source})`, "gi"),
    new RegExp(`(${PERSON_TITLE_RE.source})${SEP}(${NAME_RE.source})`, "gi"),
  ];
  for (let i = 0; i < patterns.length; i++) {
    for (const m of text.matchAll(patterns[i])) {
      const raw = (i === 0 ? m[1] : m[m.length - 1]) ?? "";
      const title = (i === 0 ? m[2] : m[1]) ?? null;
      const name = raw.trim().replace(/\s+/g, " ");
      // Re-test the name in isolation: the combined pattern is case-insensitive,
      // so an all-caps heading can slip through the capitalization requirement.
      if (!new RegExp(`^${NAME_RE.source}$`).test(name)) continue;
      if (NAME_STOPWORDS.test(name)) continue;
      const k = name.toLowerCase();
      if (!out.has(k)) out.set(k, { name, title: title ? title.trim() : null });
    }
  }
  return Array.from(out.values()).slice(0, 3);
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
export async function discoverContacts(website: string, maxPages = MAX_PAGES): Promise<{
  emails: string[];
  phones: string[];
  contact_url: string | null;
  pages_tried: number;
  any_ok: boolean;
  homepage_html: string;
  homepage_final_url: string | null;
  people: { name: string; title: string | null }[];
}> {
  const base = normalizeBase(website);
  const emails = new Set<string>();
  const phones = new Set<string>();
  const people = new Map<string, { name: string; title: string | null }>();
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

  while (queue.length && pagesTried < maxPages) {
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
    for (const person of extractPeople(page.html)) {
      if (!people.has(person.name.toLowerCase())) people.set(person.name.toLowerCase(), person);
    }
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
    people: Array.from(people.values()),
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
  const values = [
    payload.top_products,
    payload.product_description,
    payload.supplier_background,
    payload.trade_name,
    payload.grades_offered,
    payload.scout_notes,
    payload.importyeti?.top_products,
    payload.importyeti?.product_descriptions,
    payload.sourceready_tags,
    payload.sourceready?.tags,
    payload.sourceready?.products,
  ];
  const parts: string[] = [];
  const append = (value: any) => {
    if (value == null) return;
    if (Array.isArray(value)) value.forEach(append);
    else if (typeof value === "object") Object.values(value).forEach(append);
    else parts.push(String(value));
  };
  values.forEach(append);
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

// Standard corporate email permutations for a person on a domain, most-likely
// first. Used only as a last-resort guess (name found, no verified email) on the
// supplier's OWN domain — the most-likely form becomes the primary To:, the rest
// are CC'd, and every one is flagged `guessed` so the operator sees it before the
// human-reviewed draft is sent. Never called on a marketplace/aggregator host.
function emailPatternCombos(fullName: string | null | undefined, host: string | null): string[] {
  if (!fullName || !host) return [];
  const parts = fullName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s.-]/g, "")
    .split(/[\s.]+/)
    .filter(Boolean);
  const f = parts[0]?.replace(/[^a-z]/g, "") ?? "";
  const l = parts.length > 1 ? parts[parts.length - 1].replace(/[^a-z]/g, "") : "";
  const d = host.replace(/^www\./, "");
  const out: string[] = [];
  if (f && l) out.push(`${f}.${l}@${d}`, `${f[0]}${l}@${d}`, `${f}${l[0]}@${d}`, `${f}_${l}@${d}`);
  if (f) out.push(`${f}@${d}`);
  return Array.from(new Set(out)).filter((e) => EMAIL_RE.test(e));
}

export async function enrichLead(lead: RawLead): Promise<EnrichmentResult> {
  const payload = lead.payload ?? {};
  // Paid contact providers are real-clients-only: internal test orgs must not
  // drain the shared credit pools ahead of paying clients (a Basic LeadMagic
  // month is ~1 day of fleet volume). The free website crawl + Tenkara lookup,
  // which do ~97% of contact finding, still run for every org.
  const allowPaidProviders = !lead.is_internal;
  const website = (payload.supplier_website as string | null) || null;
  // Paid providers DO resolve aggregator storefronts, because they search by
  // company name and not only by domain: hbderek.en.alibaba.com comes back as
  // carl.export@derekchem.com. Measured over 30 days, LeadMagic hits 8.1% on
  // aggregator hosts against 7.4% on real corporate domains, and ZoomInfo 8.2%
  // against 18.5%. An earlier version of this gated them off those hosts as
  // unresolvable; that was wrong and would have dropped the 166 real seller
  // addresses found this way. Repeat spend on one domain is the actual waste,
  // and the memo below is what bounds it.
  let paidEligible = allowPaidProviders;
  const domainKey = contactDomainKey(website);
  let cached: CachedContact | null = null;
  let cacheServed = false;
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
  // A SourceReady unlock is a paid contact, not a scout find; label it so the
  // provider mix in the cost report stays honest.
  let contactSource: ContactDiscovery["source"] = email
    ? (payload.email_source === "sourceready_unlock" ? "sourceready" : "scout")
    : null;
  let pagesTried = 0;
  // Listing HTML fetched during contact discovery, reused for marketplace-trust
  // signal detection (Send Inquiry / price range) with no extra network call.
  let listingHtml = "";

  // Extra reachable people at this supplier, deduped by email. Finalized (primary
  // removed + capped) at the end. Multi-contact can be turned off fleet-wide with
  // OUTREACH_MULTI_CONTACT=0; the total-contacts cap (incl. primary) is
  // OUTREACH_MAX_CONTACTS_PER_SUPPLIER (0/unset = unlimited).
  const multiContactOn = process.env.OUTREACH_MULTI_CONTACT !== "0";
  const totalCap = Number(process.env.OUTREACH_MAX_CONTACTS_PER_SUPPLIER ?? 0);
  const extraCap = totalCap > 0 ? Math.max(0, totalCap - 1) : Infinity;
  const extraContacts = new Map<string, AdditionalContact>();
  const addExtraContact = (raw: string | null | undefined, name: string | null, title: string | null, source: AdditionalContact["source"]) => {
    if (!multiContactOn) return;
    const e = (raw ?? "").trim().toLowerCase();
    if (!e || !EMAIL_RE.test(e) || isAggregatorEmail(e) || isThirdPartyServiceEmail(e) || isPlaceholderEmail(e)) return;
    if (extraContacts.has(e)) return;
    extraContacts.set(e, { email: e, name: name?.trim() || null, title: title?.trim() || null, source });
  };

  // If we're missing a direct email or a phone, go fetch — persistently. This is
  // also the auto-resolve path when the only email we had was a marketplace one.
  // Per-domain memo, read BEFORE the crawl. Read after it (as this first
  // shipped) the cache never served anything: a domain we hold an email for is
  // usually a domain the crawl can still read, so the crawl re-found the same
  // address and the memo was only ever consulted on the leads it had nothing
  // for. Measured 0 reuses in 1,145 enrichments against a 4,015-domain seed.
  //
  // A hit does not skip the site visit entirely: the homepage HTML feeds
  // legitimacy and marketplace-trust scoring, which every lead needs on its own
  // payload. It caps the visit at that one page instead of seven.
  if (!email && domainKey) {
    cached = await readContactDomainCache(domainKey);
    const fresh =
      !!cached?.resolved_at && Date.now() - new Date(cached.resolved_at).getTime() < CACHE_TTL_DAYS * 86400000;
    if (cached?.email && fresh) {
      email = cached.email;
      contactSource = (cached.source as ContactDiscovery["source"]) ?? "discovered";
      if (!phone && cached.phone) phone = cached.phone;
      if (!contactUrl && cached.contact_url) contactUrl = cached.contact_url;
      cacheServed = true;
      await recordContactCacheHit(domainKey);
    } else if (paidLookupSuppressed(cached)) {
      paidEligible = false;
    }
  }

  let legitimacy_check: LegitimacyCheck | null = null;
  let crawledPeople: { name: string; title: string | null }[] = [];
  if (website && (!email || !phone || cacheServed)) {
    const d = await discoverContacts(website, cacheServed ? 1 : MAX_PAGES).catch(() => null);
    if (d) {
      pagesTried = d.pages_tried;
      listingHtml = d.homepage_html ?? "";
      // Run legitimacy analysis on the homepage HTML we already fetched.
      if (d.homepage_html) {
        legitimacy_check = analyzeLegitimacy(d.homepage_html, website, d.homepage_final_url);
      }
      // Every owned, domain-matching address we scraped is a candidate CC — the
      // primary pick is removed from this set when we finalize.
      if (multiContactOn && d.emails.length) {
        const siteHost = hostOf(website);
        for (const e of d.emails) {
          if (isAggregatorEmail(e) || isThirdPartyServiceEmail(e)) continue;
          const emailDomain = e.split("@")[1]?.replace(/^www\./, "");
          const domainOk = !siteHost || (!!emailDomain && (emailDomain === siteHost || siteHost.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${siteHost}`)));
          if (domainOk) addExtraContact(e, null, null, "discovered");
        }
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
      crawledPeople = d.people;
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

  // Names/titles for the resolved primary POC, filled by whichever paid
  // fallback (Hunter → ZoomInfo → GetProspect) actually lands the email.
  let zoomContactName: string | null = null;
  let zoomContactTitle: string | null = null;
  // A POC name a provider found without a deliverable email (LeadMagic role-finder
  // hits, email-finder misses). Kept only to seed the guessed-pattern fallback
  // below; never used as a contact on its own.
  let guessPersonName: string | null = null;
  let guessPersonTitle: string | null = null;
  let contactConfidence: "verified" | "guessed" | null = null;

  // Hunter.io (primary paid fallback): the web + Tenkara gave us no direct
  // email. One Domain Search returns the supplier's known POC addresses. Runs
  // first among the paid providers because it's domain-first (we already have
  // the website) and the cheapest per lookup; ZoomInfo/GetProspect only fire if
  // Hunter also misses. Fallback-only — never runs once we have a direct email.
  if (!email && paidEligible && isHunterConfigured()) {
    const hz = await enrichContactViaHunter({
      companyName: lead.supplier_name,
      website,
    }).catch(() => null);
    if (hz?.email && EMAIL_RE.test(hz.email) && !isAggregatorEmail(hz.email) && !isThirdPartyServiceEmail(hz.email)) {
      email = hz.email.toLowerCase();
      contactSource = "hunter";
      zoomContactName = hz.contactName;
      zoomContactTitle = hz.title;
      if (!phone && hz.phone) phone = hz.phone;
    } else if (!phone && hz?.phone) {
      phone = hz.phone;
      if (!contactSource) contactSource = "hunter";
      zoomContactName = hz.contactName;
      zoomContactTitle = hz.title;
    }
  }

  // LeadMagic fallback: Hunter also missed. Role Finder maps the domain to a
  // sourcing POC, then Email Finder validates their address. Pay-per-result
  // (no charge on a miss), so it's cheap to try on the hard leads before we
  // reach for ZoomInfo. Fallback-only; soft-fails to leave the lead untouched.
  if (!email && paidEligible && isLeadMagicConfigured()) {
    const lm = await enrichPrimaryViaLeadMagic({
      companyName: lead.supplier_name,
      website,
    }).catch(() => null);
    const lmEmail = lm?.contact?.email ?? null;
    if (lmEmail && EMAIL_RE.test(lmEmail) && !isAggregatorEmail(lmEmail) && !isThirdPartyServiceEmail(lmEmail)) {
      email = lmEmail.toLowerCase();
      contactSource = "leadmagic";
      zoomContactName = lm?.contact?.contactName ?? null;
      zoomContactTitle = lm?.contact?.title ?? null;
    } else if (lm?.person && !guessPersonName) {
      // Person found, no deliverable email — hold the name for the guessed-pattern
      // fallback rather than discarding it.
      guessPersonName = lm.person.name;
      guessPersonTitle = lm.person.title;
    }
  }

  // ZoomInfo fallback (#9): Hunter + LeadMagic + the web + Tenkara gave us no
  // direct email. Rather than drop the lead into the manual "needs human
  // enrichment" queue, ask ZoomInfo for the supplier's best POC. Fallback-only
  // by design — it never runs when we already resolved a direct email, so
  // credits are spent only on the leads that would otherwise be dead ends.
  // Soft: any miss leaves the lead exactly as it was.
  if (!email && paidEligible && isZoomInfoConfigured()) {
    const zi = await enrichContactViaZoomInfo({
      companyName: lead.supplier_name,
      website,
    }).catch(() => null);
    if (zi?.email && EMAIL_RE.test(zi.email) && !isAggregatorEmail(zi.email) && !isThirdPartyServiceEmail(zi.email)) {
      email = zi.email.toLowerCase();
      contactSource = "zoominfo";
      zoomContactName = zi.contactName;
      zoomContactTitle = zi.title;
      if (!phone && zi.phone) phone = zi.phone;
    } else if (!phone && zi?.phone) {
      phone = zi.phone;
      if (!contactSource) contactSource = "zoominfo";
      zoomContactName = zi.contactName;
      zoomContactTitle = zi.title;
    }
  }

  // GetProspect is the final paid-data fallback after ZoomInfo misses. The
  // provider account has a hard monthly quota and no overage purchase path, so
  // an exhausted quota simply returns null and leaves the lead for human review.
  if (!email && paidEligible && isGetProspectConfigured()) {
    const gp = await enrichContactViaGetProspect({
      companyName: lead.supplier_name,
      website,
    }).catch(() => null);
    if (gp?.email && EMAIL_RE.test(gp.email) && !isAggregatorEmail(gp.email) && !isThirdPartyServiceEmail(gp.email)) {
      email = gp.email.toLowerCase();
      contactSource = "getprospect";
      zoomContactName = gp.contactName;
      zoomContactTitle = gp.title;
    }
  }

  // Any email resolved so far came from a scraped/validated source.
  if (email) contactConfidence = "verified";

  // Guessed-pattern fallback (rule 3): every scrape/DB/provider path missed a
  // deliverable email, but a POC NAME is in hand (a paid provider found the person
  // but couldn't validate an address). On the supplier's OWN corporate domain
  // (never a marketplace/aggregator host), synthesize the standard email patterns:
  // the most-likely form becomes the primary To:, the rest are CC'd. Flagged
  // `guessed` end-to-end. Safe because outreach is always staged as a
  // human-reviewed DRAFT (Agent 04 never auto-sends), and a catch-all/unknown
  // domain cannot be verified anyway — a best-guess reviewed address beats leaving
  // a named supplier permanently unreachable. Guessed values only ever land in
  // recipient fields, never in body/subject copy (the fabrication guard's scope).
  if (!email && website) {
    // Name priority: whoever a paid provider named, else a name the cache already
    // holds for this domain, else a named person read off the supplier's own
    // about / team / impressum page. The last of these is free and is the only
    // source that fires at all on the 2,744 own-domain leads no provider covers.
    const crawled = crawledPeople[0] ?? null;
    const gName = zoomContactName ?? guessPersonName ?? cached?.poc_name ?? crawled?.name ?? null;
    const gTitle = zoomContactTitle ?? guessPersonTitle ?? cached?.poc_title ?? crawled?.title ?? null;
    const host = hostOf(website);
    if (gName && host && !isAggregatorDomain(host)) {
      const combos = emailPatternCombos(gName, host);
      if (combos.length) {
        email = combos[0];
        contactSource = "pattern_guess";
        contactConfidence = "guessed";
        zoomContactName = gName;
        zoomContactTitle = gTitle;
        for (const cc of combos.slice(1)) addExtraContact(cc, gName, gTitle, "pattern_guess");
      }
    }
  }

  // A scout-supplied contact path (e.g. "via IndiaMART inquiry") still counts.
  if (!email && !phone && !contactUrl && (isContactPath(scoutEmail) || isContactPath(scoutPhone))) {
    contactUrl = website || null;
    contactSource = "path";
  }

  // Multi-contact CC candidates from the platform + ZoomInfo. Tenkara
  // shipping/billing inboxes are free; ZoomInfo costs one credit per person
  // enriched, so we only spend it when we still want more people than the web
  // gave us (skipped entirely when we already have enough or the cap is 0).
  if (multiContactOn && tenkara_supplier) {
    addExtraContact(tenkara_supplier.shipping_email, null, null, "tenkara");
    addExtraContact(tenkara_supplier.billing_email, null, null, "tenkara");
  }
  if (multiContactOn && paidEligible && isHunterConfigured() && extraContacts.size < extraCap) {
    const want = extraCap === Infinity ? 5 : Math.min(5, extraCap + 1);
    const hzs = await enrichContactsViaHunter({ companyName: lead.supplier_name, website }, want).catch(() => [] as Awaited<ReturnType<typeof enrichContactsViaHunter>>);
    for (const hz of hzs) {
      if (extraContacts.size >= extraCap) break;
      if (hz.email) addExtraContact(hz.email, hz.contactName, hz.title, "hunter");
      if (hz.email && email && hz.email.toLowerCase() === email && !zoomContactName) {
        zoomContactName = hz.contactName;
        zoomContactTitle = hz.title;
      }
    }
  }
  if (multiContactOn && paidEligible && isLeadMagicConfigured() && extraContacts.size < extraCap) {
    const want = extraCap === Infinity ? 5 : Math.min(5, extraCap + 1);
    const lms = await enrichContactsViaLeadMagic({ companyName: lead.supplier_name, website }, want).catch(() => [] as Awaited<ReturnType<typeof enrichContactsViaLeadMagic>>);
    for (const lm of lms) {
      if (extraContacts.size >= extraCap) break;
      if (lm.email) addExtraContact(lm.email, lm.contactName, lm.title, "leadmagic");
      if (lm.email && email && lm.email.toLowerCase() === email && !zoomContactName) {
        zoomContactName = lm.contactName;
        zoomContactTitle = lm.title;
      }
    }
  }
  if (multiContactOn && paidEligible && isZoomInfoConfigured() && extraContacts.size < extraCap) {
    const want = extraCap === Infinity ? 5 : Math.min(5, extraCap + 1);
    const zis = await enrichContactsViaZoomInfo({ companyName: lead.supplier_name, website }, want).catch(() => [] as Awaited<ReturnType<typeof enrichContactsViaZoomInfo>>);
    for (const zi of zis) {
      if (extraContacts.size >= extraCap) break;
      addExtraContact(zi.email, zi.contactName, zi.title, "zoominfo");
      // Backfill a primary POC name/title if the fallback path didn't set one.
      if (zi.email && email && zi.email.toLowerCase() === email && !zoomContactName) {
        zoomContactName = zi.contactName;
        zoomContactTitle = zi.title;
      }
    }
  }

  // Finalize: drop the primary email (it's the To:, not a CC), then cap.
  const additional_contacts: AdditionalContact[] = Array.from(extraContacts.values())
    .filter((c) => !email || c.email !== email.toLowerCase())
    .slice(0, extraCap === Infinity ? undefined : extraCap);

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
  const productText = collectProductText(payload);
  const material_relevance: MaterialRelevanceCheck | null = isDiscoverySource
    ? assessMaterialRelevance({
        materialName: lead.material_name,
        inci: (payload.inci_name as string | null) ?? null,
        productText,
      })
    : null;

  // Dealbreaker fit. Runs for every source (unlike the relevance backstop): a
  // client's hard spec applies no matter how the supplier was found. Uses the
  // certs parsed off the supplier's own site as well as the discovery text, so a
  // lead that arrived with no grade data can still resolve to "meets" once we
  // have read the homepage.
  const dealbreaker_fit = assessDealbreakerFit({
    spec: lead.dealbreaker_spec ?? null,
    evidenceText: productText,
    parsedCerts: legitimacy_check?.certifications ?? null,
    scoutCerts: (payload.certifications as string | null) ?? null,
  });
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

  // Memoize whatever this cost to learn, hit or miss, so the next lead on this
  // domain starts from the answer instead of the waterfall.
  if (domainKey) {
    await writeContactDomainCache({
      domain: domainKey,
      email,
      phone,
      contact_url: contactUrl,
      poc_name: zoomContactName ?? cached?.poc_name ?? null,
      poc_title: zoomContactTitle ?? cached?.poc_title ?? null,
      source: contactSource,
      confidence: contactConfidence,
      priorMissCount: cached?.miss_count ?? 0,
      keepResolvedAt: cacheServed ? cached?.resolved_at ?? null : null,
    });
  }

  const contact: ContactDiscovery = {
    email,
    phone,
    contact_url: contactUrl,
    pages_tried: pagesTried,
    source: contactSource,
    poc_name: zoomContactName,
    poc_title: zoomContactTitle,
  };

  return {
    website_probe,
    email_check,
    contact,
    additional_contacts,
    tenkara_supplier,
    legitimacy_check,
    marketplace_trust,
    material_relevance,
    dealbreaker_fit,
    completeness_score,
    completeness_factors,
    outreach_ready,
    blocked_reason,
    aggregator_contact_email: email ? null : aggregatorEmail,
    contact_confidence: email ? contactConfidence : null,
  };
}
