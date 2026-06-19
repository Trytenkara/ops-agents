import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNamesWithFallback, resolveMaterialNames } from "@/lib/tenkara-names";
import { OutreachList, type DraftRow } from "@/components/outreach-list";

export const dynamic = "force-dynamic";

export default async function OutreachPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  // Agent 04 writes draft_references with source_agent='agent-04-outreach' in metadata.
  // We filter for non-revalidation outreach by looking for outreach-style metadata.
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), agents(name, slug)")
    .eq("org_id", org.id)
    .neq("agents.slug", "agent-02-revalidation")
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = drafts ?? [];
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  try {
    [supplierNames, materialNames] = await Promise.all([
      resolveSupplierNamesWithFallback(rows.map((d: any) => d.supplier_id).filter(Boolean)),
      resolveMaterialNames(rows.map((d: any) => d.material_id).filter(Boolean)),
    ]);
  } catch {
    // Fall back to UUID prefixes if Tenkara is unreachable.
  }

  const draftRows: DraftRow[] = rows.map((d: any) => ({
    id: d.id,
    subject: d.subject ?? null,
    supplierId: d.supplier_id ?? null,
    supplierName: d.supplier_id ? supplierNames.get(d.supplier_id) ?? null : null,
    materialId: d.material_id ?? null,
    materialName: d.material_id ? materialNames.get(d.material_id) ?? null : null,
    status: d.status,
    createdAt: d.created_at ?? null,
    metadata: d.metadata,
    assignedName: d.users?.display_name ?? null,
    assignedEmail: d.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(d.users)),
  }));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl">Outreach</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Outreach drafts staged by Agent 04 — initial RFQs for promoted leads. Review in Missive, then click Send.
        </p>
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Agent 04 (Outreach)</span>{" "}
        drafts a Missive email per promoted lead with the From field empty. A human picks the sender and clicks Send — no agent sends automatically.{" "}
        QA findings come from Agent 10 (lint pass); reply detections come from Agent 08.
      </div>

      {rows.length === 0 ? (
        <p className="text-center text-muted-foreground py-8 text-sm">No outreach drafts yet. Promote an enriched lead on Leads in Flight to stage one.</p>
      ) : (
        <OutreachList rows={draftRows} slug={params.slug} />
      )}
    </div>
  );
}
