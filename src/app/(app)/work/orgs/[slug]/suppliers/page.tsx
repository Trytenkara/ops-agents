import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import { ListPageHeader } from "@/components/list-page-header";
import { ClientSuppliersSection } from "@/components/client-suppliers-section";
import { SupplierProfilesList } from "@/components/supplier-profiles-list";
import { getClientSuppliers } from "@/lib/client-suppliers";
import { getSupplierProfiles, type SupplierProfile } from "@/lib/supplier-profiles";
import { getOrgOperatorPool, operatorBySupplier, getSupplierAssignments } from "@/lib/operator-assignment";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { orgDisplayName } from "@/lib/org-display";

export const dynamic = "force-dynamic";

export default async function OrgSuppliersPage({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, display_name, tenkara_org_id")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  // Tenkara suppliers (platform data)
  const tenkaraSuppliers = await getClientSuppliers(org.tenkara_org_id ?? null);
  const tenkaraById = new Map<string, { approval: string; qualified: boolean }>();
  for (const s of [
    ...tenkaraSuppliers.approved,
    ...tenkaraSuppliers.pending_review,
    ...tenkaraSuppliers.denied,
    ...tenkaraSuppliers.draft,
  ]) {
    tenkaraById.set(s.id, { approval: s.approval, qualified: s.qualified });
  }

  // Our supplier profiles (approval-tracking data)
  const profiles = await getSupplierProfiles(admin, org.id);

  // Count leads per supplier
  const { data: leadCounts } = await admin
    .from("leads_in_flight")
    .select("supplier_id")
    .eq("org_id", org.id)
    .eq("status", "active")
    .not("supplier_id", "is", null);
  const countBySupplier = new Map<string, number>();
  for (const row of leadCounts ?? []) {
    const sid = (row as any).supplier_id as string;
    countBySupplier.set(sid, (countBySupplier.get(sid) ?? 0) + 1);
  }

  const supplierRows = profiles.map((p) => ({
    profile: p,
    leadCount: p.supplier_id ? (countBySupplier.get(p.supplier_id) ?? 0) : 0,
    tenkara: p.supplier_id ? (tenkaraById.get(p.supplier_id) ?? null) : null,
  }));

  // Operator assignment (for legacy Tenkara supplier section)
  const pool = await getOrgOperatorPool(admin, org.id);
  const allIds = [
    ...tenkaraSuppliers.approved,
    ...tenkaraSuppliers.pending_review,
    ...tenkaraSuppliers.denied,
    ...tenkaraSuppliers.draft,
  ].map((s) => s.id);
  const owners = operatorBySupplier(pool, allIds);
  const autoNames: Record<string, string> = {};
  for (const [sid, op] of Object.entries(owners)) autoNames[sid] = op.name;
  const assignmentMap = await getSupplierAssignments(admin, org.id).catch(() => new Map<string, string>());
  const assignments: Record<string, string> = {};
  for (const [sid, opId] of assignmentMap) assignments[sid] = opId;
  const operatorNames: Record<string, string> = {};
  for (const op of pool) operatorNames[op.id] = op.name;

  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));
  const operatorOptions = pool.map((op) => ({ id: op.id, name: op.name }));

  return (
    <div className="space-y-8">
      <ListPageHeader
        level={2}
        title="Suppliers"
        description={`Manage supplier approvals for ${orgDisplayName(org)}. Click a supplier to view and edit approval fields.`}
      />

      {/* Supplier Approval Profiles */}
      {supplierRows.length > 0 ? (
        <SupplierProfilesList
          suppliers={supplierRows}
          orgId={org.id}
          canAct={canAct}
        />
      ) : (
        <div className="rounded-lg border border-dashed p-6 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            No supplier profiles yet. Click &quot;Seed from leads&quot; to create profiles from your existing leads, or they will be created automatically as new leads are enriched.
          </p>
          {canAct && (
            <form action={async () => {
              "use server";
              const { seedProfilesFromLeads } = await import("@/lib/supplier-profiles");
              const { createAdminClient } = await import("@/lib/supabase/admin");
              await seedProfilesFromLeads(createAdminClient(), org.id);
              const { revalidatePath } = await import("next/cache");
              revalidatePath(`/work/orgs/${org.slug}/suppliers`);
            }}>
              <button type="submit" className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                Seed from leads
              </button>
            </form>
          )}
        </div>
      )}

      {/* Platform Suppliers (Tenkara data, read-only reference) */}
      <div className="border-t pt-6">
        <ClientSuppliersSection
          suppliers={tenkaraSuppliers}
          orgId={org.id}
          autoNames={autoNames}
          assignments={assignments}
          operatorOptions={operatorOptions}
          operatorNames={operatorNames}
          canAct={canAct}
        />
      </div>
    </div>
  );
}
