// Is a whole email DOMAIN safe to treat as one company?
//
// Several places ask "have we already contacted this supplier?" and answer it by
// matching every draft whose recipient shares the address's domain. That is only
// correct when the domain belongs to the supplier itself. On a shared consumer
// mailbox it collapses unrelated companies into one: 16 distinct California
// Chemicals suppliers on 126.com / 163.com / qq.com / foxmail.com were read as
// five already-contacted suppliers, and none of them was ever written to.
//
// The list below is a backstop, not the rule. No list of consumer providers can
// ever be complete (the previous one held ten Western providers and nothing
// else), so the primary test is positive: widen to the domain ONLY when it is
// demonstrably the supplier's own corporate domain. Anything we cannot prove
// belongs to the supplier is matched on the exact address instead, which is
// always safe.

const CONSUMER_MAILBOX_DOMAINS = new Set([
  // Western
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.co.jp",
  "ymail.com", "rocketmail.com", "hotmail.com", "hotmail.co.uk", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "gmx.com", "gmx.de", "gmx.net", "mail.com",
  "zoho.com", "fastmail.com", "hushmail.com", "tutanota.com", "yandex.com",
  "yandex.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru", "web.de", "t-online.de",
  "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "libero.it", "virgilio.it",
  "terra.com.br", "uol.com.br", "bol.com.br", "seznam.cz", "wp.pl", "o2.pl",
  "interia.pl", "onet.pl", "abv.bg", "mynet.com", "hotmail.fr", "hotmail.es",
  "hotmail.it", "outlook.fr", "outlook.es", "outlook.in", "live.co.uk",
  // China (the ones that actually caused the collapse)
  "126.com", "163.com", "qq.com", "foxmail.com", "vip.163.com", "vip.126.com",
  "sina.com", "sina.cn", "sohu.com", "yeah.net", "aliyun.com", "21cn.com",
  "tom.com", "139.com", "189.cn", "wo.cn", "hotmail.com.cn", "263.net",
  // India
  "rediffmail.com", "sify.com", "indiatimes.com", "in.com", "vsnl.net",
  "vsnl.com", "bsnl.in", "airtelmail.in",
  // Other regions
  "naver.com", "hanmail.net", "daum.net", "nate.com", "kakao.com",
  "docomo.ne.jp", "ezweb.ne.jp", "softbank.ne.jp", "nifty.com", "ocn.ne.jp",
  "hotmail.co.jp", "yahoo.com.tw", "hinet.net", "pchome.com.tw",
  "walla.com", "walla.co.il", "bezeqint.net",
  "mweb.co.za", "webmail.co.za", "telkomsa.net",
  "bigpond.com", "optusnet.com.au", "xtra.co.nz",
  "hotmail.com.ar", "prodigy.net.mx", "yahoo.com.mx",
]);

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function emailDomain(email: string | null | undefined): string | null {
  const d = String(email ?? "").trim().toLowerCase().split("@")[1];
  return d || null;
}

/** A mailbox provider shared by unrelated companies (gmail, 163, qq, rediffmail...). */
export function isConsumerMailboxDomain(domainOrEmail: string | null | undefined): boolean {
  const raw = String(domainOrEmail ?? "").trim().toLowerCase();
  if (!raw) return false;
  const domain = raw.includes("@") ? emailDomain(raw) : raw;
  return !!domain && CONSUMER_MAILBOX_DOMAINS.has(domain);
}

/**
 * May an "already contacted this company" lookup widen from the exact address to
 * the whole domain? Only when the address sits on the supplier's own corporate
 * domain AND that domain is not a shared consumer provider. Returns null when it
 * must stay an exact-address match.
 */
export function corporateDomainForMatch(
  email: string | null | undefined,
  supplierWebsite: string | null | undefined
): string | null {
  const domain = emailDomain(email);
  if (!domain || isConsumerMailboxDomain(domain)) return null;
  const site = hostOf(supplierWebsite);
  if (!site) return null;
  const same = domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`);
  return same ? domain : null;
}
