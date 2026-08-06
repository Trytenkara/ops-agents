// Re-judge a client's EXISTING leads against their CURRENT requirements.
//
// The dealbreaker verdict (payload.enrichment.dealbreaker_fit) is written once,
// at enrichment, and the enrichment claim is hard-filtered to stage='raw', so
// nothing ever revisits it. That verdict drives the "Meets dealbreakers" badge
// and the primary lead sort, so a client who adds a dealbreaker grade, edits a
// grade, or adds a material keeps being sorted by an answer to the old question.
//
// This re-check is cheap because assessDealbreakerFit is a PURE function over
// evidence already stored on the lead (collectProductText + the certs parsed off
// the supplier's site + the scout's cert text). Nothing here re-probes a website,
// spends a contact-provider credit, or calls an LLM: it recomputes a verdict from
// what we already hold, so it can run over a whole org in one pass.
//
// It only ever writes advisory fields. No lead is dropped, re-staged, or filtered
// out, and every write is reversible by running again after the client reverts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { assessDealbreakerFit, type DealbreakerSpec } from "@/lib/dealbreaker-fit";
import { collectProductText } from "@/lib/product-text";
import { evaluateOnboardedBar } from "@/lib/onboarded-bar";
import { resolveMaterialGradeSpecs } from "@/lib/tenkara-names";
import { getClientRequirements, dealbreakerCertNames } from "@/lib/tenkara-requirements";

const PAGE = 1000;
// Bounds one invocation. A pass that stops early leaves the org's fingerprint
// unrecorded, so the next trigger resumes it; because writes only happen where a
// verdict actually changed, the resumed pass re-reads cheaply and re-writes nothing.
const DEFAULT_MAX_LEADS = 5000;
const DEFAULT_DEADLINE_MS = 60_000;
const WRITE_CHUNK = 25;

export interface RecheckOrg {
  id: string;
  tenkara_org_id: string | null;
  onboarding_stage?: string | null;
}

export interface RecheckOptions {
  // Stamped on every lead the pass touches, so an operator looking at a changed
  // verdict can see what caused it.
  reason: string;
  maxLeads?: number;
  deadlineMs?: number;
}

export interface RecheckSummary {
  orgId: string;
  scanned: number;
  updated: number;
  verdictChanged: number;
  barChanged: number;
  // True when the cap or deadline stopped the pass before the last lead. The
  // caller MUST NOT record the org as re-checked when this is set.
  truncated: boolean;
  error?: string;
}

function nowMs(): number {
  try { return Date.now(); } catch { return 0; }
}

// Key-order-independent stringify. The stored verdict came back through jsonb,
// which normalizes key order, while a freshly computed one is in insertion order,
// so a plain JSON.stringify reports every lead as changed and the pass rewrites
// the whole org on every trigger. Array order is preserved: the satisfied/unmet
// lists follow the client's grade order and a reordering there is a real change.
function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

function sameVerdict(a: any, b: any): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

export async function recheckOrgLeads(
  admin: SupabaseClient,
  org: RecheckOrg,
  opts: RecheckOptions
): Promise<RecheckSummary> {
  const summary: RecheckSummary = { orgId: org.id, scanned: 0, updated: 0, verdictChanged: 0, barChanged: 0, truncated: false };
  const maxLeads = opts.maxLeads ?? DEFAULT_MAX_LEADS;
  const deadline = nowMs() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  // Fail closed on the requirement reads. An empty cert list or a missing grade
  // spec is indistinguishable from "the client deleted their dealbreakers", and
  // acting on it would clear every real "meets" verdict this org has.
  let certs: string[];
  try {
    certs = org.tenkara_org_id ? dealbreakerCertNames(await getClientRequirements(org.tenkara_org_id)) : [];
  } catch (e: any) {
    return { ...summary, truncated: true, error: `requirements read failed: ${e?.message ?? e}` };
  }

  const onboarded = org.onboarding_stage === "onboarded";
  const gradeCache = new Map<string, string[]>();
  const stampedAt = new Date().toISOString();

  for (let from = 0; ; from += PAGE) {
    if (summary.scanned >= maxLeads || nowMs() > deadline) {
      summary.truncated = true;
      break;
    }

    // Stable total order: PostgREST pages shift and silently skip rows without it.
    const { data, error } = await admin
      .from("leads_in_flight")
      .select("id, source, material_id, confidence_score, payload")
      .eq("org_id", org.id)
      .eq("status", "active")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) return { ...summary, truncated: true, error: error.message };

    const rows = data ?? [];
    if (!rows.length) break;

    const missing = Array.from(
      new Set(rows.map((r: any) => r.material_id).filter((id: any): id is string => !!id && !gradeCache.has(id)))
    );
    if (missing.length) {
      try {
        const specs = await resolveMaterialGradeSpecs(missing);
        for (const id of missing) {
          const required = specs.get(id)?.required ?? null;
          gradeCache.set(id, required ? String(required).split(",").map((s) => s.trim()).filter(Boolean) : []);
        }
      } catch (e: any) {
        return { ...summary, truncated: true, error: `grade spec read failed: ${e?.message ?? e}` };
      }
    }

    const updates: { id: string; payload: any }[] = [];
    for (const row of rows as any[]) {
      summary.scanned++;
      const payload = (row.payload ?? {}) as Record<string, any>;

      const requiredGrades = row.material_id ? gradeCache.get(row.material_id) ?? [] : [];
      const spec: DealbreakerSpec | null =
        requiredGrades.length || certs.length ? { requiredGrades, requiredCerts: certs } : null;

      // Rebuilt from stored evidence, exactly as enrichment assembled it.
      const nextFit = assessDealbreakerFit({
        spec,
        evidenceText: collectProductText(payload),
        parsedCerts: payload.enrichment?.legitimacy_check?.certifications ?? null,
        scoutCerts: (payload.certifications as string | null) ?? null,
      });
      const priorFit = payload.enrichment?.dealbreaker_fit ?? null;
      const verdictMoved = !sameVerdict(priorFit, nextFit);

      const bar = onboarded ? evaluateOnboardedBar(row) : { below: false, reason: null };
      const priorBar = payload.below_onboarded_bar ?? null;
      const barMoved = bar.below ? priorBar?.reason !== bar.reason : !!priorBar;

      if (!verdictMoved && !barMoved) continue;

      const next: Record<string, any> = { ...payload };
      if (verdictMoved) {
        // Only the verdict key is touched; the rest of the enrichment block is the
        // enrichment agent's to own.
        next.enrichment = { ...(payload.enrichment ?? {}), dealbreaker_fit: nextFit };
        summary.verdictChanged++;
      }
      if (barMoved) {
        if (bar.below) next.below_onboarded_bar = { reason: bar.reason, at: stampedAt };
        else delete next.below_onboarded_bar;
        summary.barChanged++;
      }
      next.requirements_rechecked = { at: stampedAt, reason: opts.reason };
      updates.push({ id: row.id, payload: next });
    }

    for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
      await Promise.all(
        updates.slice(i, i + WRITE_CHUNK).map((u) =>
          admin.from("leads_in_flight").update({ payload: u.payload }).eq("id", u.id)
        )
      );
    }
    summary.updated += updates.length;

    if (rows.length < PAGE) break;
  }

  return summary;
}
