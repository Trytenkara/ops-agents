import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { getMaterialProfile } from "@/lib/material-profile";
import { getMaterialSourcingStatus } from "@/lib/material-sourcing-status";
import { MaterialsPanel } from "@/components/materials-panel";
import { TdbOverviewSubnav } from "@/components/tdb-overview-subnav";
import { ListPageHeader } from "@/components/list-page-header";
import { DensityToggle } from "@/components/density-toggle";
import { existingQuotesForOrg, type ExistingQuote } from "@/agents-runtime/agents/lead-creator/sql";
import { resolveMaterialGradeSpecs, type MaterialGradeSpec } from "@/lib/tenkara-names";
import Link from "next/link";

export const dynamic = "force-dynamic";

function gradeTokens(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

// Rank a quote against the material's grade spec: 0 = states a grade that meets
// the spec, 1 = states no grade, 2 = states a different grade. A quote with no
// grade is unknown rather than a miss, so it never sorts below a known mismatch.
// A dealbreaker grade is the bar when the client set one, otherwise the full
// grade list stands in as a soft target.
function gradeRank(quoteGrade: string | null, spec: MaterialGradeSpec | undefined): number {
  const target = spec?.required ?? spec?.all ?? null;
  if (!target) return 1;
  const stated = new Set(gradeTokens(quoteGrade));
  if (stated.size === 0) return 1;
  const named = target.split(",").map(gradeTokens).filter((t) => t.length > 0);
  return named.some((t) => t.every((tok) => stated.has(tok))) ? 0 : 2;
}

export default async function OrgMaterialsPage({ params }: { params: { slug: string } }) {
  const session = await getSession();
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const profile = await getMaterialProfile(org.id);
  const statuses = await getMaterialSourcingStatus(admin, org.id, org.tenkara_org_id ?? null, profile);
  const canEdit = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  const { data: settingsRow } = await admin
    .from("client_settings")
    .select("sourcing_notes")
    .eq("org_id", org.id)
    .maybeSingle();

  // Collected quotes per material (Quotes tab folded in here): each carries its
  // own approval status (pending_review / approved / dismissed).
  const { data: quoteRows } = await admin
    .from("staged_quotes")
    .select("id, material_id, supplier_name, price, case_size, unit_of_measurement, unit_price, grade, status, confidence, created_at")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(1000);
  const quotesByMaterial: Record<string, any[]> = {};
  for (const q of quoteRows ?? []) {
    if (!q.material_id) continue;
    (quotesByMaterial[q.material_id] ??= []).push(q);
  }

  // Float the quotes that already show the material's grade spec to the top of
  // each drill-down, newest-first within each rank (sort is stable and the rows
  // arrive in created_at order). Best-effort: a Tenkara resolve failure leaves
  // the plain date order.
  const quotedMaterialIds = Object.keys(quotesByMaterial);
  if (quotedMaterialIds.length > 0) {
    const gradeSpecs = await resolveMaterialGradeSpecs(quotedMaterialIds).catch(
      () => new Map<string, MaterialGradeSpec>()
    );
    for (const [materialId, list] of Object.entries(quotesByMaterial)) {
      const spec = gradeSpecs.get(materialId);
      list.sort((a, b) => gradeRank(a.grade, spec) - gradeRank(b.grade, spec));
    }
  }

  // Existing saved quotes from the Tenkara DB (production quotes already in the system).
  let existingByMaterial: Record<string, ExistingQuote[]> = {};
  if (org.tenkara_org_id) {
    const existing = await existingQuotesForOrg(org.tenkara_org_id, 500).catch(() => []);
    for (const q of existing) {
      if (!q.material_id) continue;
      (existingByMaterial[q.material_id] ??= []).push(q);
    }
  }

  const [{ data: tagRows }, { data: orgClientRows }] = await Promise.all([
    admin.from("material_client_tags").select("tenkara_material_id, org_client_id, is_priority").eq("org_id", org.id),
    admin.from("org_clients").select("id, name").eq("org_id", org.id).order("name"),
  ]);
  const clientTags: Record<string, { orgClientId: string | null; isPriority: boolean }> = {};
  for (const t of tagRows ?? []) {
    clientTags[t.tenkara_material_id] = { orgClientId: t.org_client_id ?? null, isPriority: t.is_priority };
  }
  const orgClients = (orgClientRows ?? []).map((r: any) => ({ id: r.id as string, name: r.name as string }));

  return (
    <div className="space-y-6">
      <TdbOverviewSubnav slug={org.slug} />
      <ListPageHeader
        level={2}
        title="Materials"
        description="What this client buys and where each one stands. Expand a row for its quotes, uploads, and approvals."
        collectedBy="Agent 08 (Email Scanner) extracts quotes from supplier replies"
      />

      <div className="flex justify-end -mt-2">
        <DensityToggle />
      </div>

      <Link
        href={`/work/orgs/${org.slug}/suppliers`}
        className="group flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 hover:bg-secondary/60 transition-colors"
      >
        <div>
          <div className="font-medium">Next: Suppliers</div>
          <div className="text-sm text-muted-foreground">Who can supply these materials — added, approved, and denied.</div>
        </div>
        <span className="text-muted-foreground group-hover:text-foreground" aria-hidden>→</span>
      </Link>

      <MaterialsPanel
        orgId={org.id}
        slug={org.slug}
        profile={profile}
        canEdit={canEdit}
        statuses={statuses}
        quotesByMaterial={quotesByMaterial}
        existingQuotesByMaterial={existingByMaterial}
        sourcingNotes={settingsRow?.sourcing_notes ?? null}
        clientTags={clientTags}
        orgClients={orgClients}
      />
    </div>
  );
}
