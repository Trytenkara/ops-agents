import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNamesWithFallback, resolveMaterialNames, resolveQuoteRefs } from "@/lib/tenkara-names";
import { RevalidationList, type RevalidationRow } from "@/components/revalidation-list";

export const dynamic = "force-dynamic";

export default async function RevalidationPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, quote_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), agents(name)")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(100);

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
    // Fall back to UUID prefixes if Tenkara is unreachable.
  }

  const revalRows: RevalidationRow[] = rows.map((d: any) => ({
    id: d.id,
    subject: d.subject ?? null,
    supplierId: d.supplier_id ?? null,
    supplierName: d.supplier_id ? supplierNames.get(d.supplier_id) ?? null : null,
    materialId: d.material_id ?? null,
    materialName: d.material_id ? materialNames.get(d.material_id) ?? null : null,
    quoteId: d.quote_id ?? null,
    quoteRef: d.quote_id ? quoteRefs.get(d.quote_id) ?? null : null,
    agentName: d.agents?.name ?? null,
    status: d.status,
    createdAt: d.created_at ?? null,
    metadata: d.metadata,
    assignedName: d.users?.display_name ?? null,
    assignedEmail: d.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(d.users)),
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="font-serif text-2xl">Revalidation</h2>
          <p className="text-sm text-muted-foreground">Quotes expiring or recently expired. Agent 02 surfaces drafts here.</p>
        </div>
      </div>
      {revalRows.length === 0 ? (
        <p className="text-center text-muted-foreground py-8 text-sm">No revalidation drafts yet. Agent 02 will populate this.</p>
      ) : (
        <RevalidationList rows={revalRows} slug={params.slug} />
      )}
    </div>
  );
}
