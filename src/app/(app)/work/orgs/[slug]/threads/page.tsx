import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNamesWithFallback, resolveMaterialNames, resolveQuoteRefs } from "@/lib/tenkara-names";
import { ListPageHeader } from "@/components/list-page-header";
import { ThreadsList, type ThreadRow, type ThreadKind } from "@/components/threads-list";

export const dynamic = "force-dynamic";

function kindOf(d: any): ThreadKind {
  return d.metadata?.draft_kind === "inbound_reply" ? "inbound" : "outbound";
}

// Unified email-thread workspace: outbound RFQs + inbound supplier replies for
// the client, filterable by kind. Re-quote drafts for expiring quotes live on
// the Price Index tab, not here.
export default async function OrgThreadsPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const session = (await getSession())!;
  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  const { data: drafts } = await admin
    .from("draft_references")
    .select(
      "id, subject, supplier_id, material_id, quote_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), reviewer:users!draft_references_reviewer_fkey(display_name), agents(name, slug)"
    )
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = drafts ?? [];
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  let quoteRefs = new Map<string, string>();
  try {
    [supplierNames, materialNames, quoteRefs] = await Promise.all([
      resolveSupplierNamesWithFallback(rows.map((d: any) => d.supplier_id).filter(Boolean)),
      resolveMaterialNames(rows.map((d: any) => d.material_id).filter(Boolean)),
      resolveQuoteRefs(rows.map((d: any) => d.quote_id).filter(Boolean)),
    ]);
  } catch {
    // Tenkara unreachable — rows fall back to "name unavailable".
  }

  const threadRows: ThreadRow[] = rows
    .filter((d: any) => d.agents?.slug !== "agent-02-revalidation")
    .map((d: any) => ({
    id: d.id,
    kind: kindOf(d),
    subject: d.subject ?? null,
    supplierId: d.supplier_id ?? null,
    // Scout-discovered leads have no Tenkara supplier_id/material row, so fall
    // back to the name carried on the draft metadata.
    supplierName: (d.supplier_id ? supplierNames.get(d.supplier_id) : null) ?? (d.metadata as any)?.supplier_name ?? null,
    materialId: d.material_id ?? null,
    materialName: (d.material_id ? materialNames.get(d.material_id) : null) ?? (d.metadata as any)?.material_name ?? null,
    quoteRef: d.quote_id ? quoteRefs.get(d.quote_id) ?? null : null,
    status: d.status,
    createdAt: d.created_at ?? null,
    metadata: d.metadata,
    assignedName: d.users?.display_name ?? null,
    assignedEmail: d.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(d.users)),
    reviewerName: d.reviewer?.display_name ?? null,
  }));

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="All Threads"
        description="Every email conversation for this client — outbound RFQs and inbound supplier replies. Drafts only; nothing sends automatically. Re-quotes to maintain live pricing are on the Live Price Index tab."
        collectedBy="Agent 04 (Outreach) + Agent 08 (Email Scanner) + Agent 15 (Reply Manager)"
        explainer={
          <>
            Drafts are composed automatically and staged for review. Filter by <span className="font-medium text-foreground">kind</span> to
            see outbound RFQs or inbound replies. Open a draft to review and send it.
          </>
        }
      />
      {threadRows.length === 0 ? (
        <p className="text-center text-muted-foreground py-8 text-sm">No threads yet. Promote a lead to start outreach.</p>
      ) : (
        <ThreadsList rows={threadRows} slug={params.slug} canAct={canAct} />
      )}
    </div>
  );
}
