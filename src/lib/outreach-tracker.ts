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

export interface MarketplaceOutreachSummary {
  total: number;      // marketplace leads seen
  emailed: number;    // an outreach draft/email was staged
  manual: number;     // handed to an operator (no email → contact form/inquiry)
  needsPull: number;  // price couldn't be auto-pulled — operator tagged (#4)
  pending: number;    // not yet actioned
}

export interface OutreachTracker {
  materials: OutreachTrackerMaterial[];
  // Totals count DISTINCT emails/cases (a consolidated email covering N materials
  // is one email), while per-material rows credit every material an email covers.
  totals: { emails: number; qaFlagged: number; manual: number; skipped: number; suppliers: number };
  // Marketplace-specific funnel so ops can confirm marketplace suppliers are
  // being emailed (or handed to an operator), not silently missed. (#9)
  marketplace: MarketplaceOutreachSummary;
}

const UNNAMED = "(unnamed material)";
const key = (id: string | null, name: string | null) => id ?? `name:${(name ?? UNNAMED).toLowerCase()}`;

function humanizeReason(r: string | null | undefined): string {
  if (!r) return "other";
  return r.replace(/_/g, " ");
}

export async function getOutreachTracker(admin: Admin, orgId: string): Promise<OutreachTracker> {
  const [{ data: drafts }, { data: manualCases }, { data: dropped }, { data: mpLeads }] = await Promise.all([
    admin
      .from("draft_references")
      .select("supplier_id, material_id, status, metadata")
      .eq("org_id", orgId)
      // New email app only — exclude legacy Missive drafts carried over from
      // before the cutover, which otherwise inflate the counts (e.g. Nutripro
      // showing 66 old Missive drafts alongside 15 real new-app ones).
      .in("email_client", ["rod_app", "tenkara"]),
    admin
      .from("cases")
      .select("material_id, metadata")
      .eq("org_id", orgId)
      .eq("type", "manual_outreach")
      .in("status", ["open", "in_progress"]),
    admin
      .from("leads_in_flight")
      .select("material_id, material_name, drop_reason, payload")
      .eq("org_id", orgId)
      .eq("status", "dropped"),
    admin
      .from("leads_in_flight")
      .select("stage, status, drop_reason, payload")
      .eq("org_id", orgId)
      .or("payload->>site_type.in.(M,MS),payload->>supplier_role.eq.Marketplace"),
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
  const allSuppliers = new Set<string>();
  let distinctEmails = 0;
  let distinctQaFlagged = 0;

  for (const d of (drafts ?? []) as any[]) {
    const meta = (d.metadata ?? {}) as any;
    if (meta.draft_kind === "inbound_reply") continue; // outbound RFQs only
    distinctEmails++;
    const qaFlagged = Array.isArray(meta.qa_findings) && meta.qa_findings.length > 0;
    if (qaFlagged) distinctQaFlagged++;
    const supplierName = (meta.supplier_name as string | null) ?? null;
    if (supplierName) allSuppliers.add(supplierName);

    // A consolidated email covers several materials; credit each so none looks
    // un-drafted. Falls back to the single material_id/name for normal emails.
    const covered: { id: string | null; name: string | null }[] =
      Array.isArray(meta.consolidated_materials) && meta.consolidated_materials.length > 1
        ? meta.consolidated_materials.map((c: any) => ({ id: c.id ?? null, name: c.name ?? null }))
        : [{ id: d.material_id ?? null, name: meta.material_name ?? null }];

    for (const cm of covered) {
      const m = get(cm.id, cm.name);
      m.drafted++;
      if (d.status === "staged") m.staged++;
      else m.progressed++;
      if (qaFlagged) m.qaFlagged++;
      if (supplierName) {
        const set = supplierSets.get(key(cm.id, cm.name)) ?? new Set<string>();
        set.add(supplierName);
        supplierSets.set(key(cm.id, cm.name), set);
      }
    }
  }

  for (const c of (manualCases ?? []) as any[]) {
    const meta = (c.metadata ?? {}) as any;
    get(c.material_id ?? null, meta.material_name ?? null).manual++;
  }

  for (const l of (dropped ?? []) as any[]) {
    const m = get(l.material_id ?? null, l.material_name ?? null);
    m.skipped++;
    // drop_reason lives on the column (escalation) or in payload (outreach).
    const reason = humanizeReason(l.drop_reason ?? (l.payload as any)?.drop_reason);
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

  const totals = {
    emails: distinctEmails,
    qaFlagged: distinctQaFlagged,
    manual: materials.reduce((n, m) => n + m.manual, 0),
    skipped: materials.reduce((n, m) => n + m.skipped, 0),
    suppliers: allSuppliers.size,
  };

  const marketplace: MarketplaceOutreachSummary = { total: 0, emailed: 0, manual: 0, needsPull: 0, pending: 0 };
  for (const l of (mpLeads ?? []) as any[]) {
    marketplace.total++;
    const p = (l.payload ?? {}) as any;
    if (p.outreach) marketplace.emailed++;
    else if (l.status === "dropped" && (l.drop_reason ?? p.drop_reason) === "manual_outreach_case") marketplace.manual++;
    else if (p.marketplace_pull?.status === "needs_manual_pull") marketplace.needsPull++;
    else marketplace.pending++;
  }

  return { materials, totals, marketplace };
}
