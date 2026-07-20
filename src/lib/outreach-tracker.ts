import { createAdminClient } from "@/lib/supabase/admin";

// Per-material outreach funnel for a client. Ops complaint: once a material
// moves to outreach it collapses into a single row, hiding how many suppliers
// were actually drafted, to whom, how many were skipped, and how many drafts QA
// flagged. This aggregates the three surfaces that hold that state:
//   - draft_references  -> outbound drafts staged per supplier (+ QA findings)
//   - cases (manual_outreach) -> suppliers with no email, handed to an operator
//   - leads_in_flight (dropped) -> leads skipped, with a drop reason
// Read-only; safe to call from the Leads page server component.

type Admin = ReturnType<typeof createAdminClient>;

export interface OutreachTrackerMaterial {
  materialId: string | null;
  materialName: string;
  drafted: number;        // outbound drafts staged (any status)
  staged: number;         // drafts still awaiting operator review
  progressed: number;     // reviewed / sent
  qaFlagged: number;      // drafts carrying QA findings
  manual: number;         // suppliers with no email (manual_outreach cases)
  skipped: number;        // dropped leads
  suppliers: string[];    // "to whom" — distinct drafted supplier names
  skipReasons: Record<string, number>; // drop_reason -> count
}

export interface OutreachTracker {
  materials: OutreachTrackerMaterial[];
  totals: { drafted: number; qaFlagged: number; manual: number; skipped: number; suppliers: number };
}

const UNNAMED = "(unnamed material)";
const key = (id: string | null, name: string | null) => id ?? `name:${(name ?? UNNAMED).toLowerCase()}`;

function humanizeReason(r: string | null | undefined): string {
  if (!r) return "other";
  return r.replace(/_/g, " ");
}

export async function getOutreachTracker(admin: Admin, orgId: string): Promise<OutreachTracker> {
  const [{ data: drafts }, { data: manualCases }, { data: dropped }] = await Promise.all([
    admin
      .from("draft_references")
      .select("supplier_id, material_id, status, metadata")
      .eq("org_id", orgId),
    admin
      .from("cases")
      .select("material_id, metadata")
      .eq("org_id", orgId)
      .eq("type", "manual_outreach")
      .in("status", ["open", "in_progress"]),
    admin
      .from("leads_in_flight")
      .select("material_id, material_name, drop_reason")
      .eq("org_id", orgId)
      .eq("status", "dropped"),
  ]);

  const byKey = new Map<string, OutreachTrackerMaterial>();
  const get = (id: string | null, name: string | null): OutreachTrackerMaterial => {
    const k = key(id, name);
    let m = byKey.get(k);
    if (!m) {
      m = {
        materialId: id,
        materialName: (name && name.trim()) || UNNAMED,
        drafted: 0, staged: 0, progressed: 0, qaFlagged: 0, manual: 0, skipped: 0,
        suppliers: [], skipReasons: {},
      };
      byKey.set(k, m);
    } else if (m.materialName === UNNAMED && name && name.trim()) {
      m.materialName = name.trim();
    }
    return m;
  };

  const supplierSets = new Map<string, Set<string>>(); // material key -> supplier names

  for (const d of (drafts ?? []) as any[]) {
    const meta = (d.metadata ?? {}) as any;
    if (meta.draft_kind === "inbound_reply") continue; // outbound RFQs only
    const m = get(d.material_id ?? null, meta.material_name ?? null);
    m.drafted++;
    if (d.status === "staged") m.staged++;
    else m.progressed++;
    if (Array.isArray(meta.qa_findings) && meta.qa_findings.length > 0) m.qaFlagged++;
    const supplierName = (meta.supplier_name as string | null) ?? null;
    if (supplierName) {
      const set = supplierSets.get(key(d.material_id ?? null, meta.material_name ?? null)) ?? new Set<string>();
      set.add(supplierName);
      supplierSets.set(key(d.material_id ?? null, meta.material_name ?? null), set);
    }
  }

  for (const c of (manualCases ?? []) as any[]) {
    const meta = (c.metadata ?? {}) as any;
    get(c.material_id ?? null, meta.material_name ?? null).manual++;
  }

  for (const l of (dropped ?? []) as any[]) {
    const m = get(l.material_id ?? null, l.material_name ?? null);
    m.skipped++;
    const reason = humanizeReason(l.drop_reason);
    m.skipReasons[reason] = (m.skipReasons[reason] ?? 0) + 1;
  }

  for (const [k, set] of supplierSets) {
    const m = byKey.get(k);
    if (m) m.suppliers = Array.from(set).sort();
  }

  // Only materials that have any outreach activity are worth showing; sort by
  // most drafts, then most skipped.
  const materials = Array.from(byKey.values())
    .filter((m) => m.drafted + m.manual + m.skipped > 0)
    .sort((a, b) => b.drafted - a.drafted || b.skipped - a.skipped || a.materialName.localeCompare(b.materialName));

  const totals = materials.reduce(
    (t, m) => ({
      drafted: t.drafted + m.drafted,
      qaFlagged: t.qaFlagged + m.qaFlagged,
      manual: t.manual + m.manual,
      skipped: t.skipped + m.skipped,
      suppliers: t.suppliers + m.suppliers.length,
    }),
    { drafted: 0, qaFlagged: 0, manual: 0, skipped: 0, suppliers: 0 }
  );

  return { materials, totals };
}
