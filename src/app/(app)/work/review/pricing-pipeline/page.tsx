import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { ListPageHeader } from "@/components/list-page-header";

export const dynamic = "force-dynamic";

// Pipeline lifecycle, in board order, with a human label.
const STAGES: { key: string; label: string }[] = [
  { key: "outreach_sent", label: "Outreach sent" },
  { key: "reply_received", label: "Reply received" },
  { key: "responded", label: "Responded (awaiting price)" },
  { key: "price_captured", label: "Price captured" },
  { key: "finalized", label: "Finalized (live)" },
  { key: "stale", label: "Stale — needs ops" },
  { key: "closed_declined", label: "Closed (declined)" },
];
const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

interface Thread {
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

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function PricingPipelinePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const admin = createAdminClient();
  let q = admin
    .from("draft_references")
    .select("id, org_id, thread_id, metadata, created_at")
    .not("metadata->>flow_status", "is", null);

  if (!seesAllOrgs(session)) {
    const orgIds = (await getAssignedOrgIds(session)) ?? [];
    if (orgIds.length === 0) {
      return <EmptyState reason="No orgs assigned to you yet." />;
    }
    q = q.in("org_id", orgIds);
  }

  const { data: refs } = await q.order("created_at", { ascending: false }).limit(2000);

  // Collapse to one row per thread.
  const byThread = new Map<string, Thread>();
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
    (a, b) => (STAGE_INDEX[a.status] ?? 99) - (STAGE_INDEX[b.status] ?? 99) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  );
  const counts: Record<string, number> = {};
  for (const t of threads) counts[t.status] = (counts[t.status] ?? 0) + 1;

  return (
    <div className="space-y-6">
      <ListPageHeader title="Pricing Pipeline" description="Every supplier thread, from outreach to a finalized price." />

      <div className="flex flex-wrap gap-2">
        {STAGES.map((s) => (
          <div key={s.key} className="rounded-md border px-3 py-2 text-sm">
            <div className="font-medium">{counts[s.key] ?? 0}</div>
            <div className="text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      {threads.length === 0 ? (
        <EmptyState reason="No tracked threads yet. They appear here once outreach is staged." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead>Materials</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last update</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {threads.map((t) => (
              <TableRow key={t.threadId}>
                <TableCell className="font-medium">{t.supplier}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {t.materials.slice(0, 4).join(", ")}
                  {t.materials.length > 4 ? ` +${t.materials.length - 4}` : ""}
                </TableCell>
                <TableCell>
                  <span className="rounded-full border px-2 py-0.5 text-xs">
                    {STAGES.find((s) => s.key === t.status)?.label ?? t.status}
                  </span>
                  {t.lastNote ? <div className="mt-1 text-xs text-muted-foreground">{t.lastNote}</div> : null}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{relTime(t.updatedAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-3 text-sm">
                    <Link href={`/work/drafts/${t.draftRefId}`} className="underline">Open</Link>
                    {t.draftLink ? (
                      <a href={t.draftLink} target="_blank" rel="noreferrer" className="underline">Missive</a>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function EmptyState({ reason }: { reason: string }) {
  return (
    <div className="space-y-6">
      <ListPageHeader title="Pricing Pipeline" description="Every supplier thread, from outreach to a finalized price." />
      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">{reason}</div>
    </div>
  );
}
