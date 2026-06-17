import type { SupabaseClient } from "@supabase/supabase-js";

// Pricing pipeline: per-supplier-thread lifecycle, derived from draft_references
// whose metadata carries a flow_status. Shared by the cross-org Review queue
// and the per-client Pipeline tab.

export const PIPELINE_STAGES: { key: string; label: string }[] = [
  { key: "outreach_sent", label: "Outreach sent" },
  { key: "reply_received", label: "Reply received" },
  { key: "responded", label: "Responded (awaiting price)" },
  { key: "price_captured", label: "Price captured" },
  { key: "finalized", label: "Finalized (live)" },
  { key: "stale", label: "Stale — needs ops" },
  { key: "closed_declined", label: "Closed (declined)" },
];

const STAGE_INDEX: Record<string, number> = Object.fromEntries(PIPELINE_STAGES.map((s, i) => [s.key, i]));

export interface PipelineThread {
  threadId: string;
  orgId: string | null;
  supplier: string;
  materials: string[];
  status: string;
  lastNote: string | null;
  updatedAt: string | null;
  draftLink: string | null;
  draftRefId: string;
}

export interface PipelineData {
  threads: PipelineThread[];
  counts: Record<string, number>;
}

// orgIds: null = all orgs (admin); [] handled by caller; otherwise scope to set.
export async function loadPricingThreads(
  admin: SupabaseClient,
  orgIds: string[] | null
): Promise<PipelineData> {
  let q = admin
    .from("draft_references")
    .select("id, org_id, thread_id, metadata, created_at")
    .not("metadata->>flow_status", "is", null);
  if (orgIds) q = q.in("org_id", orgIds);

  const { data: refs } = await q.order("created_at", { ascending: false }).limit(2000);

  const byThread = new Map<string, PipelineThread>();
  for (const r of refs ?? []) {
    const meta = (r as any).metadata ?? {};
    const key = (r as any).thread_id ?? (r as any).id;
    const history = Array.isArray(meta.flow_history) ? meta.flow_history : [];
    const last = history[history.length - 1] ?? null;
    const existing = byThread.get(key);
    const material = meta.material_name as string | undefined;
    if (existing) {
      if (material && !existing.materials.includes(material)) existing.materials.push(material);
      continue;
    }
    byThread.set(key, {
      threadId: key,
      orgId: (r as any).org_id,
      supplier: meta.supplier_name ?? meta.supplier_contact_email ?? "(unknown supplier)",
      materials: material ? [material] : [],
      status: meta.flow_status ?? "outreach_sent",
      lastNote: last?.note ?? null,
      updatedAt: last?.at ?? (r as any).created_at,
      draftLink: meta.missive_draft_link ?? null,
      draftRefId: (r as any).id,
    });
  }

  const threads = Array.from(byThread.values()).sort(
    (a, b) =>
      (STAGE_INDEX[a.status] ?? 99) - (STAGE_INDEX[b.status] ?? 99) ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  );
  const counts: Record<string, number> = {};
  for (const t of threads) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { threads, counts };
}
