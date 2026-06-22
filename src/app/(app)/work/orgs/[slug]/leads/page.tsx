import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { ListPageHeader } from "@/components/list-page-header";
import { LeadsTabs } from "@/components/leads-tabs";
import { SuppliersCsvUpload } from "@/components/suppliers-csv-upload";
import { resolveMaterialGrades, resolveSupplierMarketplace } from "@/lib/tenkara-names";
import { leadMarketKind } from "@/components/lead-rich-row";
import { getOrgOperatorPool, pickSupplierOperator } from "@/lib/operator-assignment";
import { existingQuotesForOrg, type ExistingQuote } from "@/agents-runtime/agents/lead-creator/sql";

export const dynamic = "force-dynamic";

export default async function OrgLeadsPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: rows } = await admin
    .from("leads_in_flight")
    .select(
      "id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, orgs(slug, name)"
    )
    .eq("org_id", org.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(200);
  let leads = (rows ?? []) as any[];

  // Grade lives on the Tenkara material — resolve by material_id and attach.
  let leadGrades = new Map<string, string>();
  let leadMarketplace = new Map<string, boolean>();
  try {
    [leadGrades, leadMarketplace] = await Promise.all([
      resolveMaterialGrades(leads.map((r) => r.material_id).filter(Boolean)),
      resolveSupplierMarketplace(leads.map((r) => r.supplier_id).filter(Boolean)),
    ]);
  } catch {
    // Tenkara unreachable — fall back to payload grade / site_type in the row.
  }
  // market_kind: prefer the supplier's is_marketplace flag (covers platform-DB
  // leads), fall back to the scanner's site_type for scout leads.
  // Owning operator per lead, sticky by supplier within the org.
  const operatorPool = await getOrgOperatorPool(admin, org.id);
  leads = leads.map((r) => {
    const flag = r.supplier_id ? leadMarketplace.get(r.supplier_id) : undefined;
    const market_kind =
      flag === true ? "marketplace" : flag === false ? "direct" : leadMarketKind(r.payload?.site_type);
    const operator_name = pickSupplierOperator(operatorPool, r.supplier_id)?.name ?? null;
    return { ...r, grade: r.material_id ? leadGrades.get(r.material_id) ?? null : null, market_kind, operator_name };
  });

  // Promote/Drop gating: the operator can act if they see all orgs or this org
  // is in their assignment set, and they hold an acting role.
  const session = (await getSession())!;
  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  // Existing saved quotes we already have for this org's materials (Ben's recco)
  // — context, not new leads. Tenkara is read-only + occasionally slow, so fall
  // back to an empty list rather than failing the page.
  let quotes: ExistingQuote[] = [];
  if (org.tenkara_org_id) {
    quotes = await existingQuotesForOrg(org.tenkara_org_id).catch(() => []);
  }

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Leads"
        description={`Suppliers discovered for ${org.name}. Export the CSV for the manual supplier-sourcing index.`}
        collectedBy="Agent 03 (Lead Creator) + Agent 06 (Enrichment)"
        actions={canAct ? <SuppliersCsvUpload orgId={org.id} /> : undefined}
      />
      {leads.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No active leads for this org.</p>
      ) : (
        <LeadsTabs rows={leads} canAct={canAct} slug={org.slug} />
      )}

      <section className="space-y-2 pt-2">
        <h2 className="font-serif text-xl tracking-tight">
          Existing saved quotes <span className="text-muted-foreground text-base">· {quotes.length}</span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Quotes already in the database for {org.name}&apos;s materials — so you can see what&apos;s covered before sourcing more. Re-quoting these is Agent 02&apos;s job, not new outreach.
        </p>
        {quotes.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Lead time</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Quoted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotes.map((q) => (
                <TableRow key={q.quote_id}>
                  <TableCell className="font-medium">{q.material_name ?? "—"}</TableCell>
                  <TableCell>{q.supplier_name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.price != null ? `$${q.price}${q.uom ? `/${q.uom}` : ""}` : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{q.lead_time_days != null ? `${q.lead_time_days}d` : "—"}</TableCell>
                  <TableCell><Badge variant="secondary">{q.status ?? "—"}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{q.quote_date ? relativeTime(q.quote_date) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No saved quotes for this org&apos;s materials yet.</p>
        )}
      </section>
    </div>
  );
}
