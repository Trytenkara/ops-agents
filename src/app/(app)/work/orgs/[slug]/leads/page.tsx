import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { LeadsExportCsvButton } from "@/components/leads-export-csv-button";
import { LeadsList } from "@/components/leads-list";
import { SuppliersCsvUpload } from "@/components/suppliers-csv-upload";
import { resolveMaterialGrades } from "@/lib/tenkara-names";
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
    .order("confidence_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);
  let leads = (rows ?? []) as any[];

  // Grade lives on the Tenkara material — resolve by material_id and attach.
  let leadGrades = new Map<string, string>();
  try {
    leadGrades = await resolveMaterialGrades(leads.map((r) => r.material_id).filter(Boolean));
  } catch {
    // Tenkara unreachable — fall back to payload grade in the row component.
  }
  leads = leads.map((r) => ({ ...r, grade: r.material_id ? leadGrades.get(r.material_id) ?? null : null }));

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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Suppliers discovered for {org.name}. Download the CSV for the manual supplier-sourcing index.
        </p>
        <div className="flex items-start gap-2">
          {canAct && <SuppliersCsvUpload orgId={org.id} />}
          <LeadsExportCsvButton disabled={leads.length === 0} count={leads.length} filters={{ org: org.slug }} />
        </div>
      </div>
      {leads.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No active leads for this org.</p>
      ) : (
        <LeadsList rows={leads} canAct={canAct} />
      )}

      <section className="space-y-2 pt-2">
        <h2 className="text-sm uppercase tracking-wider text-muted-foreground font-medium">
          Existing saved quotes <span className="ml-1 text-foreground">· {quotes.length}</span>
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
