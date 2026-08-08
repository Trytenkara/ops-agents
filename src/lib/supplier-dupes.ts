import type { ClientSupplier, SupplierApproval } from "./client-suppliers";

// Finds suppliers that look like the same company recorded more than once.
//
// Suggestions only. Nothing here writes anywhere, and Tenkara is read-only from
// this app; an operator carries the merge out by hand.
//
// The one rule that matters most is what is NOT a duplicate: ops deliberately
// keeps a marketplace row and a direct row for the same company (37 rows are
// explicitly named "- Marketplace" / "- Non-Marketplace"). Groups therefore
// never span the is_marketplace boundary — the two are compared separately, so
// a legitimate pair is invisible here while a third row of either type is not.

export type DupeRule = "identical_website" | "same_domain";

export interface DupeMember {
  id: string;
  name: string;
  website: string | null;
  approval: SupplierApproval;
  is_marketplace: boolean;
}

export interface DupeGroup {
  /** Stable within a render; used as a React key and for the decision payload. */
  key: string;
  rule: DupeRule;
  /** Registrable domain the group was built on, for display. */
  domain: string;
  is_marketplace: boolean;
  members: DupeMember[];
  /** Names differ only by a place or legal-entity word, so they may be separate on purpose. */
  locationVariant: boolean;
  /** Members disagree on approval, so picking a survivor changes an approval decision. */
  mixedApproval: boolean;
  /** Built on a host many sellers share, so the rows may be different companies. */
  sharedPlatform: boolean;
}

// Multi-part public suffixes we actually see on supplier sites. Without these,
// "alphachemicals.in" and "avh.co.in" both reduce to the wrong label.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.il", "co.in", "co.th", "co.id",
  "com.au", "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.my", "com.hk", "com.tw", "com.ar",
  "com.co", "com.pe", "com.ph", "com.vn", "com.pk", "com.eg", "com.sa", "com.ua", "com.ng", "com.bd",
]);

/** Registrable domain, lowercased. Null when the URL is unusable. */
export function registrableDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = String(raw).trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0];
  host = host.split("@").pop() ?? host;
  host = host.split(":")[0];
  host = host.replace(/\.+$/, "");
  if (!host || !host.includes(".")) return null;
  // An IP address has no registrable domain worth grouping on.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join(".");
  const want = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (parts.length < want) return null;
  return parts.slice(-want).join(".");
}

/** Website compared as a string, ignoring the differences that never mean anything. */
export function canonicalWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const stripped = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
  return stripped || null;
}

const LEGAL_SUFFIXES =
  /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|gmbh|ag|sa|s\.a|srl|bv|b\.v|nv|plc|pvt|pte|sdn|bhd|kft|spa|s\.p\.a|oy|ab|as|aps|group|holdings)\b/g;

/** Lowercase, punctuation and legal suffixes removed. */
export function normalizeName(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,/#!$%^*;:{}=\-_`~()'"’“”\[\]]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A place or entity word in the name is the signal that two rows may be
// deliberately separate: one per warehouse, per legal entity, per region.
// Measured against prod, this flags the sets that must not be auto-merged
// (Ingredients Online Edison NJ vs Chino CA, Smirk's California/New Jersey/Canada).
const PLACE_WORDS =
  /\b(usa|u\.s\.a|uk|france|europe|european|holland|netherlands|germany|deutschland|india|china|chinese|mexico|canada|brasil|brazil|japan|korea|italy|italia|spain|espana|asia|america|americas|africa|north|south|east|west|emea|apac|latam|california|texas|florida|jersey|nj|ca|fl|mi|michigan|ohio|illinois|georgia|carolina|shanghai|beijing|guangzhou|shenzhen|mumbai|delhi|bunbury|pty|gmbh|europe|international|global|domestic|local)\b/;

function hasPlaceWord(name: string, brand: string): boolean {
  // Strip the brand itself first, otherwise "Alliance Chemical" trips on nothing
  // but "American Elements" would match its own name.
  const withoutBrand = normalizeName(name).replace(new RegExp(brand, "gi"), " ");
  return PLACE_WORDS.test(withoutBrand);
}

/**
 * True when the domain's brand label shows up in the supplier's own name.
 *
 * This is what separates a real duplicate from a directory. Five rows on
 * tronox.com are all named "Tronox …", so the domain identifies the company.
 * Thirty rows on goldsupplier.com are named after thirty different sellers and
 * none of them is called "Goldsupplier", so the domain identifies a platform
 * and its rows are not duplicates of each other.
 */
export function brandMatchesName(domain: string, name: string): boolean {
  const brand = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (brand.length < 3) return false;
  const compact = normalizeName(name).replace(/\s+/g, "");
  if (!compact) return false;
  return compact.includes(brand) || brand.includes(compact);
}

// Hosts where the domain belongs to a platform, not to a seller. Two rows can
// share one of these and still be two unrelated companies (measured on prod:
// three Alibaba pairs are distinct sellers, e.g. "Xi'an Plant Bio-Engineering"
// and "Xi'an Plant Source biotech"). The rows stay visible, badged, because the
// other thirteen platform-host groups are genuine (UL Prospector name variants,
// HTML-entity twins) and a suggestion surface should not hide either kind.
const PLATFORM_BRANDS = new Set([
  "alibaba", "aliexpress", "made-in-china", "indiamart", "tradeindia", "exportersindia",
  "globalsources", "ec21", "tradekey", "amazon", "ebay", "etsy", "dhgate", "1688", "taobao",
  "thomasnet", "kompass", "europages", "go4worldbusiness", "linkedin", "facebook", "instagram",
  "justdial", "yellowpages", "zauba", "panjiva", "importyeti", "knowde", "ulprospector",
  "chemicalbook", "guidechem", "lookchem", "molbase", "echemi", "pharmacompass", "weiku",
  "hktdc", "tradewheel", "connect2india", "goldsupplier",
]);

function isPlatformDomain(domain: string): boolean {
  return PLATFORM_BRANDS.has(domain.split(".")[0]);
}

function approvalsDisagree(members: DupeMember[]): boolean {
  return new Set(members.map((m) => m.approval)).size > 1;
}

function toMember(s: ClientSupplier): DupeMember {
  return {
    id: s.id,
    name: s.name ?? "(unnamed)",
    website: s.website ?? null,
    approval: s.approval,
    is_marketplace: s.is_marketplace,
  };
}

/**
 * Suggested duplicate groups, strongest rule first.
 *
 * `dismissedPairs` holds "<lo>:<hi>" keys the operator already rejected. A
 * rejected pair is removed from consideration entirely, so a group that only
 * existed because of it disappears rather than reappearing minus one row.
 */
export function findDuplicateGroups(
  suppliers: ClientSupplier[],
  dismissedPairs: ReadonlySet<string> = new Set()
): DupeGroup[] {
  const rejected = (a: string, b: string) => dismissedPairs.has(pairKey(a, b));

  // Any member that every other member has been split from is not in the group.
  const dropRejected = (members: DupeMember[]): DupeMember[][] => {
    const kept: DupeMember[][] = [];
    const remaining = [...members];
    while (remaining.length) {
      const seed = remaining.shift()!;
      const cluster = [seed];
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (cluster.every((m) => !rejected(m.id, remaining[i].id))) {
          cluster.push(remaining[i]);
          remaining.splice(i, 1);
        }
      }
      if (cluster.length > 1) kept.push(cluster);
    }
    return kept;
  };

  const groups: DupeGroup[] = [];
  const claimed = new Set<string>();

  const emit = (rule: DupeRule, domain: string, members: DupeMember[]) => {
    for (const cluster of dropRejected(members)) {
      if (cluster.length < 2) continue;
      const brand = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
      cluster.forEach((m) => claimed.add(m.id));
      groups.push({
        key: `${rule}:${domain}:${cluster.map((m) => m.id).sort().join(",")}`,
        rule,
        domain,
        is_marketplace: cluster[0].is_marketplace,
        members: cluster,
        locationVariant: cluster.some((m) => hasPlaceWord(m.name, brand)),
        mixedApproval: approvalsDisagree(cluster),
        sharedPlatform: isPlatformDomain(domain),
      });
    }
  };

  // Rule 1 — the same website string, same type. Highest confidence: no name
  // reasoning involved at all.
  const byWebsite = new Map<string, DupeMember[]>();
  for (const s of suppliers) {
    const w = canonicalWebsite(s.website);
    if (!w) continue;
    const k = `${s.is_marketplace ? "m" : "d"}::${w}`;
    if (!byWebsite.has(k)) byWebsite.set(k, []);
    byWebsite.get(k)!.push(toMember(s));
  }
  for (const [k, members] of byWebsite) {
    if (members.length < 2) continue;
    const domain = registrableDomain(k.split("::")[1]) ?? k.split("::")[1];
    emit("identical_website", domain, members);
  }

  // Rule 2 — same registrable domain and same type, where the domain's brand
  // appears in the names. Catches "Clariant" / "Clariant AG" on different URLs.
  const byDomain = new Map<string, DupeMember[]>();
  for (const s of suppliers) {
    if (claimed.has(s.id)) continue;
    const d = registrableDomain(s.website);
    if (!d) continue;
    const k = `${s.is_marketplace ? "m" : "d"}::${d}`;
    if (!byDomain.has(k)) byDomain.set(k, []);
    byDomain.get(k)!.push(toMember(s));
  }
  for (const [k, members] of byDomain) {
    if (members.length < 2) continue;
    const domain = k.split("::")[1];
    const branded = members.filter((m) => brandMatchesName(domain, m.name));
    if (branded.length < 2) continue;
    emit("same_domain", domain, branded);
  }

  // Least ambiguous first, then biggest, then stable by domain.
  const rank: Record<DupeRule, number> = { identical_website: 0, same_domain: 1 };
  return groups.sort(
    (a, b) =>
      rank[a.rule] - rank[b.rule] ||
      Number(a.sharedPlatform) - Number(b.sharedPlatform) ||
      Number(a.locationVariant) - Number(b.locationVariant) ||
      b.members.length - a.members.length ||
      a.domain.localeCompare(b.domain)
  );
}

/** Canonical "<lo>:<hi>" key for a pair of supplier ids, order-independent. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Every unordered pair within a group. */
export function groupPairs(ids: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      out.push(ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]]);
    }
  }
  return out;
}
