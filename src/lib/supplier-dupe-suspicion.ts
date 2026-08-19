import { registrableDomain, normalizeName, brandRelates } from "@/lib/lead-dupe-guard";
import { isSameCompanyName } from "@/lib/fuzzy";
import { isAggregatorHost } from "@/lib/aggregator-hosts";

// Suppliers a client holds more than once under different names.
//
// This is a suspicion surface, never a merge. Two names can be one company
// (ADM, Archer Daniels Midland (ADM), Archer Daniels Midland Company (ADM) —
// all three live on SaponIQ today) or two genuinely different firms that happen
// to start with the same word. Only an operator can tell, and merging suppliers
// is a human call, so this names the group, says why it is suspicious, and
// stops.
//
// What is deliberately NOT flagged: the first word of the name. On live data
// California Chemicals has 72 direct suppliers beginning "Shandong" and SaponIQ
// 26 beginning "Aceites" (Spanish for oils). That is geography and trade, not
// duplication, and flagging it would bury the 135 real pairs underneath it.
//
// A marketplace listing and a direct relationship for one company are a
// deliberate pair, not a duplicate, so the two lanes are grouped separately.

export type SuspicionReason = "same_website" | "near_identical_name";
export type SupplierLane = "direct" | "marketplace";

export interface SuspectSupplier {
  id: string;
  name: string;
  website: string | null;
  lane: SupplierLane;
  owner: string | null;
}

export interface SuspicionGroup {
  key: string;
  reason: SuspicionReason;
  lane: SupplierLane;
  /** The domain, for a same-website group. */
  domain: string | null;
  members: SuspectSupplier[];
}

// A domain carrying more names than this is a directory or a listing site, not
// a company with variant spellings. Five unrelated Vietnamese firms sit under
// one yellow-pages host and six under a sourcing directory; treating those as
// one supplier would invent duplicates rather than find them. The aggregator
// list catches the known platforms, this catches the rest.
const MAX_NAMES_PER_REAL_DOMAIN = 3;

// Words too common in this trade to block on. Two suppliers sharing only one of
// these have nothing in common worth comparing.
const WEAK_TOKENS = new Set([
  "the", "and", "for", "co", "ltd", "llc", "inc", "corp", "corporation", "company", "gmbh", "bhd", "sdn",
  "pvt", "pte", "plc", "sa", "srl", "spa", "bv", "nv", "ag", "kg", "as",
  "group", "holding", "holdings", "international", "global", "world", "worldwide",
  "industry", "industries", "industrial", "chemical", "chemicals", "chem",
  "technology", "technologies", "tech", "trading", "trade", "traders", "import", "export",
  "imports", "exports", "products", "product", "supply", "supplies", "solutions",
  "new", "food", "foods", "bio", "science", "sciences", "material", "materials",
]);

function tokensOf(name: string): string[] {
  return normalizeName(name)
    .split(/\s+/)
    .filter((t) => t.length > 2 && !WEAK_TOKENS.has(t));
}

/**
 * Group a client's suppliers into sets that look like the same company.
 *
 * Compared within a lane only, and within a token block rather than every name
 * against every other: a client can hold 3,000 direct suppliers, and the naive
 * comparison is nine million string similarities on a page render.
 */
export function findSupplierDupeSuspicions(rows: SuspectSupplier[]): SuspicionGroup[] {
  const groups: SuspicionGroup[] = [];
  const lanes: SupplierLane[] = ["direct", "marketplace"];

  for (const lane of lanes) {
    const inLane = rows.filter((r) => r.lane === lane && r.name.trim());

    // 1. Same website, different names. The strongest signal there is: one
    //    domain is one company, unless the domain is a directory.
    const byDomain = new Map<string, SuspectSupplier[]>();
    for (const r of inLane) {
      const domain = registrableDomain(r.website);
      if (!domain || isAggregatorHost(domain)) continue;
      const bucket = byDomain.get(domain);
      if (bucket) bucket.push(r);
      else byDomain.set(domain, [r]);
    }
    const claimed = new Set<string>();
    for (const [domain, members] of byDomain) {
      const distinct = new Map<string, SuspectSupplier>();
      for (const m of members) if (!distinct.has(normalizeName(m.name))) distinct.set(normalizeName(m.name), m);
      if (distinct.size < 2 || distinct.size > MAX_NAMES_PER_REAL_DOMAIN) continue;
      // The domain has to actually be theirs. Three unrelated firms sharing one
      // host is a directory we have not listed yet, and it produced "BASF SE |
      // Sinopec | BASF" on the first run of this. A real variant carries the
      // brand the domain is named after.
      const picked = [...distinct.values()].filter((m) => brandRelates(domain, normalizeName(m.name)));
      if (picked.length < 2) continue;
      picked.forEach((m) => claimed.add(m.id));
      groups.push({ key: `${lane}:site:${domain}`, reason: "same_website", lane, domain, members: picked });
    }

    // 2. Near-identical names. Blocked on the significant words of the name, so
    //    only plausible pairs are ever compared.
    const blocks = new Map<string, SuspectSupplier[]>();
    for (const r of inLane) {
      if (claimed.has(r.id)) continue;
      for (const t of tokensOf(r.name)) {
        const b = blocks.get(t);
        if (b) b.push(r);
        else blocks.set(t, [r]);
      }
    }
    const groupOf = new Map<string, string>(); // supplier id → group leader id
    const leaderMembers = new Map<string, Map<string, SuspectSupplier>>();
    const join = (a: SuspectSupplier, b: SuspectSupplier) => {
      const leader = groupOf.get(a.id) ?? groupOf.get(b.id) ?? a.id;
      for (const m of [a, b]) {
        groupOf.set(m.id, leader);
        const set = leaderMembers.get(leader) ?? leaderMembers.set(leader, new Map()).get(leader)!;
        set.set(m.id, m);
      }
    };
    for (const bucket of blocks.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = bucket[i];
          const b = bucket[j];
          if (a.id === b.id) continue;
          if (normalizeName(a.name) === normalizeName(b.name)) continue;
          if (isSameCompanyName(a.name, b.name, 0.88)) join(a, b);
        }
      }
    }
    for (const [leader, members] of leaderMembers) {
      if (members.size < 2) continue;
      groups.push({
        key: `${lane}:name:${leader}`,
        reason: "near_identical_name",
        lane,
        domain: null,
        members: [...members.values()],
      });
    }
  }

  return groups.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
}

/**
 * The same company held once as a marketplace listing and once as a direct
 * relationship.
 *
 * This is NOT a duplicate. The two lanes are deliberate: they are sourced by
 * different agents, priced differently (a listing price versus a quoted price)
 * and, by the assignment rules, usually owned by different operators. The only
 * problem is that each one looks like the whole story on its own, so an
 * operator can negotiate a direct price without knowing the listing exists.
 * This names the other version and who holds it, and changes nothing.
 */
export function findCrossLaneVersions(rows: SuspectSupplier[]): Map<string, SuspectSupplier[]> {
  const direct = rows.filter((r) => r.lane === "direct" && r.name.trim());
  const market = rows.filter((r) => r.lane === "marketplace" && r.name.trim());
  const out = new Map<string, SuspectSupplier[]>();
  if (!direct.length || !market.length) return out;

  const blocks = new Map<string, SuspectSupplier[]>();
  for (const r of market) for (const t of tokensOf(r.name)) {
    const b = blocks.get(t);
    if (b) b.push(r);
    else blocks.set(t, [r]);
  }
  const link = (a: SuspectSupplier, b: SuspectSupplier) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const list = out.get(x.id);
      if (list) { if (!list.some((m) => m.id === y.id)) list.push(y); }
      else out.set(x.id, [y]);
    }
  };
  for (const d of direct) {
    const seen = new Set<string>();
    const dDomain = registrableDomain(d.website);
    for (const t of tokensOf(d.name)) {
      for (const m of blocks.get(t) ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const mDomain = registrableDomain(m.website);
        const sameSite = !!dDomain && dDomain === mDomain && !isAggregatorHost(dDomain);
        if (sameSite || isSameCompanyName(d.name, m.name, 0.88)) link(d, m);
      }
    }
  }
  return out;
}
