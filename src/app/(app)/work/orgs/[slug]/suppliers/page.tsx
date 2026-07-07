import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import { ListPageHeader } from "@/components/list-page-header";
import { ClientSuppliersSection } from "@/components/client-suppliers-section";
import { getClientSuppliers } from "@/lib/client-suppliers";
import { getOrgOperatorPool, operatorBySupplier, getSupplierAssignments } from "@/lib/operator-assignment";
import { getSession, hasAnyRole } from "@/lib/auth";
import { orgDisplayName } from "@/lib/org-display";

export const dynamic = "force-dynamic";

export default async function OrgSuppliersPage({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, display_name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const suppliers = await getClientSuppliers(org.tenkara_org_id ?? null);

  // Sticky-random default owner per supplier (shown as the "Auto" fallback).
  const pool = await getOrgOperatorPool(admin, org.id);
  const allIds = [...suppliers.approved, ...suppliers.pending_review, ...suppliers.denied, ...suppliers.draft].map((s) => s.id);
  const owners = operatorBySupplier(pool, allIds);
  const autoNames: Record<string, string> = {};
  for (const [sid, op] of Object.entries(owners)) autoNames[sid] = op.name;

  // Manual claims (override the default) and the names to display them with.
  const assignmentMap = await getSupplierAssignments(admin, org.id).catch(() => new Map<string, string>());
  const assignments: Record<string, string> = {};
  for (const [sid, opId] of assignmentMap) assignments[sid] = opId;
  const operatorNames: Record<string, string> = {};
  for (const op of pool) operatorNames[op.id] = op.name;

  const canAct = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);
  const operatorOptions = pool.map((op) => ({ id: op.id, name: op.name }));

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Suppliers"
        description={`Suppliers linked to ${orgDisplayName(org)}, by approval status. Assign a supplier's operator to route its outreach; "Auto" uses the default.`}
      />
      <ClientSuppliersSection
        suppliers={suppliers}
        orgId={org.id}
        autoNames={autoNames}
        assignments={assignments}
        operatorOptions={operatorOptions}
        operatorNames={operatorNames}
        canAct={canAct}
      />
    </div>
  );
}
