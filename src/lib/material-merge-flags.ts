import { dispatchAlert } from "@/lib/alert-policy";
import { hostOf, normalizeCompanyName } from "@/lib/tenkara-sourcing-exclusions";

// Detect duplicate material records within one org — two rows for the same
// substance, each scouted independently, so the same supplier gets discovered
// (and would be emailed) twice for one chemical. Names come from Tenkara
// (read-only), so we flag the pair for an operator instead of renaming at source.


export type MergeReason = "identical_name" | "locant_variant";

export interface MergeMaterial {
  id: string;
  name: string | null;
  grades: string[];
  created_at: string;
}

// Identity form for name comparison: parentheticals dropped (they're synonym or
// packaging asides, not the substance), punctuation flattened, tokens sorted so
// word order can't hide a duplicate ("Butylene Glycol 1,3" vs "1,3 Butylene Glycol").
export function normalizeMaterialName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Split off bare-number tokens, which in a chemical name are locants (the "1,3"
// of 1,3-Butylene Glycol) — a position prefix rather than the substance itself.
function splitLocants(normalized: string): { locants: string[]; rest: string } {
  const tokens = normalized.split(" ").filter(Boolean);
  return {
    locants: tokens.filter((t) => /^\d+$/.test(t)),
    rest: tokens.filter((t) => !/^\d+$/.test(t)).join(" "),
  };
}

// Why two names are the same material, or null if they aren't.
//
// Deliberately NOT a reason: one name being a token subset of the other.
// "Caffeine" vs "Di-Caffeine Malate", "Sugar" vs "Coconut Palm Sugar" and
// "Elderberry" vs "Elderberry Juice" are all different substances, so subset
// matching would propose chemically wrong merges.
export function mergeReasonFor(a: string, b: string): MergeReason | null {
  const na = normalizeMaterialName(a);
  const nb = normalizeMaterialName(b);
  if (!na || !nb) return null;
  if (na === nb) return "identical_name";

  const la = splitLocants(na);
  const lb = splitLocants(nb);
  // Safe only when exactly ONE side carries locants. When both do and they
  // differ the substances differ (1,2-Propanediol is not 1,3-Propanediol), and
  // that is the one mistake a merge must never make.
  const oneSided = (la.locants.length === 0) !== (lb.locants.length === 0);
  if (oneSided && la.rest && la.rest === lb.rest) return "locant_variant";
  return null;
}

// Grades don't conflict when both sides name the same set, or when one side
// names none at all (unspecified, rather than a competing spec). Anything else
// is two deliberate line items for different specs of the same material.
export function gradesMergeable(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  if (a.length !== b.length) return false;
  const norm = (g: string[]) => g.map((x) => x.trim().toLowerCase()).sort();
  const [sa, sb] = [norm(a), norm(b)];
  return sa.every((g, i) => g === sb[i]);
}

// The graded side survives, so a merge never silently drops a grade the client
// asked for. With grades equal (or absent on both) the older record wins, since
// it is the one that has accumulated leads and outreach history.
export function chooseSurvivor(a: MergeMaterial, b: MergeMaterial): [MergeMaterial, MergeMaterial] {
  if (a.grades.length && !b.grades.length) return [a, b];
  if (b.grades.length && !a.grades.length) return [b, a];
  return Date.parse(a.created_at) <= Date.parse(b.created_at) ? [a, b] : [b, a];
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// How we decide two leads are the same supplier: the website host, falling back
// to the normalized company name. Mirrors Agent 03's own discovery dedup.
export function leadSupplierKey(lead: { supplier_name?: string | null; payload?: any }): string | null {
  const host = hostOf(lead.payload?.supplier_website ?? lead.payload?.source_url ?? "");
  if (host) return `host:${host}`;
  const name = normalizeCompanyName(lead.supplier_name);
  return name ? `name:${name}` : null;
}

type Admin = { from: (t: string) => any };

export interface PairLead {
  id: string;
  material_id: string | null;
  supplier_name: string | null;
  payload: any;
}

// Active leads for the given materials, paged past PostgREST's 1000-row cap.
export async function activeLeadsForMaterials(admin: Admin, orgId: string, materialIds: string[]): Promise<PairLead[]> {
  const out: PairLead[] = [];
  if (!materialIds.length) return out;
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("leads_in_flight")
      .select("id, material_id, supplier_name, payload")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("material_id", materialIds)
      .range(from, from + 999);
    const batch = (data ?? []) as PairLead[];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

async function sizePair(admin: Admin, orgId: string, keepId: string, dropId: string) {
  const rows = await activeLeadsForMaterials(admin, orgId, [keepId, dropId]);
  const keepKeys = new Set<string>();
  const dropKeys = new Set<string>();
  let dropLeadCount = 0;
  for (const r of rows) {
    const key = leadSupplierKey(r);
    if (r.material_id === keepId) {
      if (key) keepKeys.add(key);
    } else {
      dropLeadCount++;
      if (key) dropKeys.add(key);
    }
  }
  let shared = 0;
  for (const k of dropKeys) if (keepKeys.has(k)) shared++;
  return { dropLeadCount, shared };
}

// Flag duplicate-material pairs for an org, Slack-pinging once per new pair.
// Dedup is by unordered pair against every existing flag (any status), so a
// re-scan never re-flags or re-pings, and a dismissal is permanent.
export async function flagDuplicateMaterials(
  admin: Admin,
  orgId: string,
  materials: MergeMaterial[],
  orgLabel: string
): Promise<number> {
  const live = materials.filter((m) => m.name && m.name.trim());
  if (live.length < 2) return 0;

  const candidates: { keep: MergeMaterial; drop: MergeMaterial; reason: MergeReason }[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const reason = mergeReasonFor(live[i].name!, live[j].name!);
      if (!reason) continue;
      if (!gradesMergeable(live[i].grades, live[j].grades)) continue;
      const [keep, drop] = chooseSurvivor(live[i], live[j]);
      candidates.push({ keep, drop, reason });
    }
  }
  if (!candidates.length) return 0;

  const { data: existing } = await admin
    .from("material_merge_flags")
    .select("keep_material_id, drop_material_id")
    .eq("org_id", orgId);
  const seen = new Set((existing ?? []).map((r: any) => pairKey(r.keep_material_id, r.drop_material_id)));

  let flagged = 0;
  for (const c of candidates) {
    if (seen.has(pairKey(c.keep.id, c.drop.id))) continue;
    seen.add(pairKey(c.keep.id, c.drop.id));

    const { dropLeadCount, shared } = await sizePair(admin, orgId, c.keep.id, c.drop.id);
    const keepGrades = c.keep.grades.join(", ") || null;
    const dropGrades = c.drop.grades.join(", ") || null;

    const { error } = await admin.from("material_merge_flags").insert({
      org_id: orgId,
      keep_material_id: c.keep.id,
      keep_name: c.keep.name,
      keep_grades: keepGrades,
      drop_material_id: c.drop.id,
      drop_name: c.drop.name,
      drop_grades: dropGrades,
      reason: c.reason,
      drop_lead_count: dropLeadCount,
      shared_supplier_count: shared,
      status: "pending",
    });
    if (error) continue; // unique-index race: another run flagged this pair
    flagged++;

    const why =
      c.reason === "locant_variant"
        ? "the names differ only by a chemical locant"
        : "the names are the same once punctuation and word order are normalized";
    const gradeNote = keepGrades
      ? dropGrades
        ? ` Both ask for *${keepGrades}*.`
        : ` *${c.drop.name}* names no grade, so the merged record keeps *${keepGrades}*.`
      : "";
    // Bookkeeping, not an alert: the material_merge_flags row above IS the queue,
    // and it surfaces on the client's Leads page. Recorded in the alert ledger so
    // the volume is still countable, but it no longer posts to Slack.
    await dispatchAlert(
      `:link: *Duplicate material* — *${orgLabel}*: "${c.drop.name}" looks like the same material as "${c.keep.name}" (${why}).${gradeNote}` +
        ` Sourcing both means paying twice to find one chemical: *${dropLeadCount}* lead(s) sit under the duplicate and *${shared}* of its suppliers are already sourced under "${c.keep.name}".` +
        ` Review on the client's Leads page to fold it in (or dismiss if they really are different).`,
      {
        severity: "p3",
        key: `duplicate_material:${orgId}:${(c.drop.name ?? c.drop.id).toLowerCase()}`,
        digestGroup: "Duplicate materials flagged",
        title: `${orgLabel}: "${c.drop.name}" duplicates "${c.keep.name}"`,
      },
    ).catch(() => {});
  }
  return flagged;
}
