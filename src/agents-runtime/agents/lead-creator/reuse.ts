// DB reuse: restage suppliers already discovered for a SIBLING material whose
// catalogue name says it is the same substance (typically the same material
// intaken by a different org). Costs zero paid calls, everything comes out of
// leads_in_flight, so it runs ahead of the paid sources.

import type { SupabaseClient } from "@supabase/supabase-js";
import { GRADE_WORDS, gradeWords } from "@/lib/material-aliases";
import { isAggregatorDomain } from "../data-enrichment/enrich";

// Generic connectors only. Chemistry words like "acid" or "seed" stay
// significant: dropping them would let "Citric Acid" token-match "Citric".
const STOPWORDS = new Set(["the", "and", "with", "from"]);

type SourceRow = {
  supplier_name: string | null;
  supplier_id: string | null;
  material_name: string | null;
  payload: any;
};

type ReuseSignal = "alias_match" | "token_overlap";

interface ReuseCandidate {
  supplier_name: string;
  supplier_id: string | null;
  from_material: string | null;
  payload: any;
  signal: ReuseSignal;
}

export interface DbReuseArgs {
  material: { id: string; tenkara_org_id?: string | null };
  matLabel: string;
  aliases: string[];
  oaOrgId: string | null;
  nameSeen: (materialId: string, name: string | null | undefined) => boolean;
  existingMaterialSupplier: Set<string>;
  keepIfAllowed: <T extends { supplier_name?: string | null }>(
    rows: T[],
    get: (r: T) => { name?: string | null; website?: string | null; country?: string | null }
  ) => T[];
  runId: string;
  cap: number;
  log: (msg: string, meta?: Record<string, unknown>) => Promise<void> | void;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}

// Same trap index.ts guards: a directory/platform URL stored as
// supplier_website makes enrichment pull the platform's own staff as contacts.
function cleanSupplierWebsite(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  return host && isAggregatorDomain(host) ? null : url;
}

// Grade is a hard spec in BOTH directions: Palm Oil must not pull Crude Palm
// Oil suppliers, and Crude Palm Oil must not pull plain Palm Oil ones.
function sameGrade(a: string, b: string): boolean {
  const ga = gradeWords(a);
  const gb = gradeWords(b);
  if (ga.size !== gb.size) return false;
  for (const g of ga) if (!gb.has(g)) return false;
  return true;
}

// PostgREST or() values: quote so commas/parens in a material name don't break
// the filter grammar. Embedded double quotes are dropped rather than escaped.
const orQuote = (s: string) => `"${s.replace(/"/g, "")}"`;

export async function runDbReuse(
  admin: SupabaseClient,
  args: DbReuseArgs
): Promise<{ inserted: number; hosts: string[] }> {
  const { material, matLabel, aliases, oaOrgId, nameSeen, existingMaterialSupplier, keepIfAllowed, runId, cap, log } = args;
  if (cap <= 0) return { inserted: 0, hosts: [] };

  // Query 1, strongest signal: another material's leads staged under exactly
  // our name or one of its trade aliases (case-insensitive).
  const aliasTerms = [matLabel, ...aliases].map((t) => t.trim()).filter(Boolean);
  let aliasRows: SourceRow[] = [];
  if (aliasTerms.length) {
    const { data, error } = await admin
      .from("leads_in_flight")
      .select("supplier_name, supplier_id, material_name, payload")
      .eq("status", "active")
      .neq("material_id", material.id)
      .or(aliasTerms.map((t) => `material_name.ilike.${orQuote(t)}`).join(","))
      .limit(cap * 4);
    if (error) {
      await log(`DB reuse alias query failed (non-fatal): ${error.message}`, { level: "warn" });
    } else {
      aliasRows = (data ?? []) as SourceRow[];
    }
  }

  // Query 2, weaker signal: material names sharing our significant tokens.
  // Grade words are excluded from the tokens (they must MATCH, not overlap)
  // and enforced set-equal below, in both directions.
  const tokens = Array.from(
    new Set(
      matLabel
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !GRADE_WORDS.includes(t))
    )
  );
  let tokenRows: SourceRow[] = [];
  if (tokens.length) {
    const { data, error } = await admin
      .from("leads_in_flight")
      .select("supplier_name, supplier_id, material_name, payload")
      .eq("status", "active")
      .neq("material_id", material.id)
      .or(tokens.map((t) => `material_name.ilike.*${t}*`).join(","))
      .limit(200);
    if (error) {
      await log(`DB reuse token query failed (non-fatal): ${error.message}`, { level: "warn" });
    } else {
      tokenRows = (data ?? []) as SourceRow[];
    }
  }

  // Alias matches first so the stronger signal wins the dedup below.
  const ordered: Array<{ row: SourceRow; signal: ReuseSignal }> = [
    ...aliasRows.map((row) => ({ row, signal: "alias_match" as const })),
    ...tokenRows
      .filter((row) => sameGrade(row.material_name ?? "", matLabel))
      .map((row) => ({ row, signal: "token_overlap" as const })),
  ];

  const seenHosts = new Set<string>();
  const candidates: ReuseCandidate[] = [];
  for (const { row, signal } of ordered) {
    const name = (row.supplier_name ?? "").trim();
    if (!name) continue;
    if (row.supplier_id && existingMaterialSupplier.has(`${material.id}|${row.supplier_id}`)) continue;
    if (nameSeen(material.id, name)) continue;
    const h = hostOf(row.payload?.supplier_website ?? null);
    if (h) {
      if (seenHosts.has(h)) continue;
      seenHosts.add(h);
    }
    candidates.push({
      supplier_name: name,
      supplier_id: row.supplier_id ?? null,
      from_material: row.material_name ?? null,
      payload: row.payload ?? {},
      signal,
    });
    if (candidates.length >= cap) break;
  }

  const allowed = keepIfAllowed(candidates, (c) => ({
    name: c.supplier_name,
    website: c.payload?.supplier_website ?? null,
    country: c.payload?.supplier_country ?? null,
  }));
  if (!allowed.length) {
    if (ordered.length) {
      await log(`DB reuse for ${matLabel}: 0 staged of ${ordered.length} candidate row(s) (all deduped or excluded)`);
    }
    return { inserted: 0, hosts: [] };
  }

  const toInsert = allowed.map((c) => ({
    org_id: oaOrgId,
    supplier_name: c.supplier_name,
    supplier_id: c.supplier_id,
    material_name: matLabel,
    material_id: material.id,
    stage: "raw" as const,
    status: "active" as const,
    source: "db_reuse" as const,
    payload: {
      supplier_website: cleanSupplierWebsite(c.payload?.supplier_website ?? null),
      supplier_contact_email: c.payload?.supplier_contact_email ?? null,
      supplier_phone: c.payload?.supplier_phone ?? null,
      supplier_country: c.payload?.supplier_country ?? null,
      supplier_role: c.payload?.supplier_role ?? null,
      site_type: c.payload?.site_type ?? null,
      hq_address: c.payload?.hq_address ?? null,
      reuse_from_material: c.from_material,
      reuse_signal: c.signal,
      tenkara_org_id: material.tenkara_org_id ?? null,
    },
    confidence_score: c.signal === "alias_match" ? 0.55 : 0.45,
    agent_run_id: runId,
  }));

  const { data: inserted, error: insErr } = await admin
    .from("leads_in_flight")
    .insert(toInsert)
    .select("id");
  if (insErr) {
    await log(`DB reuse insert failed for ${matLabel}: ${insErr.message}`, { level: "error" });
    return { inserted: 0, hosts: [] };
  }

  const n = inserted?.length ?? 0;
  const aliasN = allowed.filter((c) => c.signal === "alias_match").length;
  await log(`DB reuse for ${matLabel}: staged ${n} (${aliasN} alias match, ${allowed.length - aliasN} token overlap)`, {
    inserted: n,
    candidate_rows: ordered.length,
  });

  const hosts: string[] = [];
  for (const c of allowed) {
    const h = hostOf(c.payload?.supplier_website ?? null);
    if (h) hosts.push(h);
  }
  return { inserted: n, hosts };
}
