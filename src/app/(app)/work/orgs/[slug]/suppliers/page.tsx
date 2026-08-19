import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import { ListPageHeader } from "@/components/list-page-header";
import { ClientSuppliersSection } from "@/components/client-suppliers-section";
import { TdbOverviewSubnav } from "@/components/tdb-overview-subnav";
import { getClientSuppliers } from "@/lib/client-suppliers";
import { getOrgAssignmentContext, autoOperatorBySupplier, overridesAuto } from "@/lib/operator-assignment";
import { getSession, hasAnyRole } from "@/lib/auth";
import { orgDisplayName } from "@/lib/org-display";
import { findSupplierDupeSuspicions, findCrossLaneVersions, type SuspectSupplier } from "@/lib/supplier-dupe-suspicion";

export const dynamic = "force-dynamic";

export default async function OrgSuppliersPage({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, display_name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const suppliers = await getClientSuppliers(org.tenkara_org_id ?? null);

  // Sticky-random default owner per supplier (shown as the "Auto" fallback).
  // Empty for an org on manual mode, or for suppliers outside its auto scope.
  const ctx = await getOrgAssignmentContext(admin, org.id);
  const all = [...suppliers.approved, ...suppliers.pending_review, ...suppliers.denied, ...suppliers.draft];
  const owners = autoOperatorBySupplier(ctx, all.map((s) => ({ id: s.id, name: s.name })));
  const autoNames: Record<string, string> = {};
  for (const [sid, op] of Object.entries(owners)) autoNames[sid] = op.name;

  // Manual claims (override the default) and the names to display them with.
  const assignments: Record<string, string> = {};
  for (const [sid, opId] of ctx.manual) assignments[sid] = opId;
  const operatorNames: Record<string, string> = {};
  for (const op of ctx.pool) operatorNames[op.id] = op.name;

  // Two different things, both computed from the same list and neither of them
  // an automatic merge:
  //  - the same company held twice inside one lane, which is a mistake nobody
  //    can see today because the names differ (BASF, BASF SE, BASF SE.)
  //  - the same company held once per lane, which is correct and deliberate,
  //    but invisible from either side.
  const suspectRows: SuspectSupplier[] = all.map((s) => ({
    id: s.id,
    name: s.name ?? "",
    website: s.website ?? null,
    lane: s.is_marketplace ? "marketplace" : "direct",
    owner: assignments[s.id] ? operatorNames[assignments[s.id]] ?? null : autoNames[s.id] ?? null,
  }));
  const dupeSiblings: Record<string, { name: string; owner: string | null }[]> = {};
  for (const g of findSupplierDupeSuspicions(suspectRows)) {
    for (const m of g.members) {
      dupeSiblings[m.id] = g.members.filter((o) => o.id !== m.id).map((o) => ({ name: o.name, owner: o.owner }));
    }
  }
  const otherVersions: Record<string, { name: string; owner: string | null; lane: string }[]> = {};
  for (const [id, others] of findCrossLaneVersions(suspectRows)) {
    otherVersions[id] = others.map((o) => ({ name: o.name, owner: o.owner, lane: o.lane }));
  }

  const canAct = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);
  const operatorOptions = ctx.pool.map((op) => ({ id: op.id, name: op.name }));

  return (
    <div className="space-y-6">
      <TdbOverviewSubnav slug={org.slug} />
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
        claimsIgnored={ctx.config.mode === "auto_all"}
        dupeSiblings={dupeSiblings}
        otherVersions={otherVersions}
        claimWinsIds={[...ctx.manual.keys()].filter((sid) => overridesAuto(ctx, ctx.manualAt.get(sid)))}
      />
    </div>
  );
}
