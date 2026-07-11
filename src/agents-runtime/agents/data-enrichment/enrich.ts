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
  payload: Record<string, any> | null;
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

export interface EnrichmentResult {
  website_probe: WebsiteProbe | null;
  email_check: EmailCheck | null;
  contact: ContactDiscovery;
  tenkara_supplier: SupplierEnrichment | null;
  completeness_score: number; // 0..1
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

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = decodeURIComponent(m[1]).trim().toLowerCase();
    if (EMAIL_RE.test(e) && !JUNK_EMAIL_RE.test(e) && !ASSET_EXT_RE.test(e)) found.add(e);
  }
  for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const e = m[0].trim().toLowerCase();
    if (EMAIL_RE.test(e) && !JUNK_EMAIL_RE.test(e) && !ASSET_EXT_RE.test(e)) found.add(e);
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
export async function discoverContacts(website: string): Promise<{
  emails: string[];
  phones: string[];
  contact_url: string | null;
  pages_tried: number;
  any_ok: boolean;
}> {
  const base = normalizeBase(website);
  const emails = new Set<string>();
  const phones = new Set<string>();
  let contactUrl: string | null = null;
  let pagesTried = 0;
  let anyOk = false;

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

  return { emails: Array.from(emails), phones: Array.from(phones), contact_url: contactUrl, pages_tried: pagesTried, any_ok: anyOk };
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

// Cheap heuristic score from what we know. A lead with a valid website + valid
// email + domain match + a phone clears ~0.85.
function scoreCompleteness(args: {
  websiteProbe: WebsiteProbe | null;
  emailCheck: EmailCheck | null;
  hasPhone: boolean;
  hasContactUrl: boolean;
  hasCountry: boolean;
}): number {
  let s = 0;
  if (args.websiteProbe?.ok) s += 0.3;
  else if (args.websiteProbe) s += 0.1; // we tried, didn't resolve
  if (args.emailCheck?.format_valid) s += 0.25;
  if (args.emailCheck?.domain_matches_website === true) s += 0.1;
  if (args.hasPhone) s += 0.15;
  else if (args.hasContactUrl) s += 0.05; // a contact form is a weaker channel than a phone
  if (args.hasCountry) s += 0.15;
  return Math.min(1, Math.round(s * 100) / 100);
}

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

  // A marketplace/aggregator email (concierge@knowde.com) is NOT the supplier's
  // inbox — never seed outreach from it. Remember it for the operator, then try
  // to resolve the supplier's real email below (site discovery / Tenkara record).
  const scoutIsAggregator = isAggregatorEmail(scoutEmail);
  let aggregatorEmail: string | null = scoutIsAggregator ? (scoutEmail as string).toLowerCase() : null;

  // Seed channels from what we already have.
  let email: string | null =
    scoutEmail && EMAIL_RE.test(scoutEmail) && !scoutIsAggregator ? scoutEmail.toLowerCase() : null;
  let phone: string | null =
    (scoutPhone && !isContactPath(scoutPhone) ? scoutPhone : null) ?? tenkara_supplier?.poc_phone ?? null;
  let contactUrl: string | null = isContactPath(scoutEmail) ? null : null;
  let contactSource: ContactDiscovery["source"] = email ? "scout" : null;
  let pagesTried = 0;

  // If we're missing a direct email or a phone, go fetch — persistently. This is
  // also the auto-resolve path when the only email we had was a marketplace one.
  if (website && (!email || !phone)) {
    const d = await discoverContacts(website).catch(() => null);
    if (d) {
      pagesTried = d.pages_tried;
      if (!email && d.emails.length) {
        // Only accept the supplier's own inbox — skip any aggregator addresses
        // the site might list. Prefer an email whose domain matches the site.
        const siteHost = hostOf(website);
        const own = d.emails.filter((e) => !isAggregatorEmail(e));
        const pick = own.find((e) => e.split("@")[1]?.replace(/^www\./, "") === siteHost) ?? own[0] ?? null;
        if (pick) {
          email = pick;
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

  const completeness_score = scoreCompleteness({
    websiteProbe: website_probe,
    emailCheck: email_check,
    hasPhone: !!phone,
    hasContactUrl: !!contactUrl,
    hasCountry: !!(tenkara_supplier?.country || payload.supplier_country),
  });

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
    completeness_score,
    outreach_ready,
    blocked_reason,
    aggregator_contact_email: email ? null : aggregatorEmail,
  };
}
