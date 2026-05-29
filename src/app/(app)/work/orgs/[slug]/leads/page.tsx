import { notFound } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { LeadsExportCsvButton } from "@/components/leads-export-csv-button";
import { existingQuotesForOrg, type ExistingQuote } from "@/agents-runtime/agents/lead-creator/sql";

export const dynamic = "force-dynamic";

const STAGE_LABEL: Record<string, string> = {
  raw: "New",
  enriched: "Ready to review",
  ready_for_outreach: "Drafted",
  ready_for_approval: "Awaiting approval",
  terminal: "Closed",
};

export default async function OrgLeadsPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: rows } = await admin
    .from("leads_in_flight")
    .select("id, supplier_name, material_name, stage, status, source, confidence_score, payload, created_at")
    .eq("org_id", org.id)
    .eq("status", "active")
    .order("confidence_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);
  const leads = rows ?? [];

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
        <LeadsExportCsvButton disabled={leads.length === 0} count={leads.length} filters={{ org: org.slug }} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Found</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leads.map((r: any) => {
            const p = r.payload ?? {};
            const conf = r.confidence_score != null ? `${Math.round(Number(r.confidence_score) * 100)}%` : "—";
            const contact = p.supplier_contact_email || p.supplier_phone || p.contact_url || "—";
            return (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.supplier_name ?? "—"}</TableCell>
                <TableCell>{r.material_name ?? "—"}</TableCell>
                <TableCell><Badge variant="secondary">{STAGE_LABEL[r.stage] ?? r.stage}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground truncate max-w-[26ch]" title={contact}>{contact}</TableCell>
                <TableCell className="text-muted-foreground">{conf}</TableCell>
                <TableCell className="text-muted-foreground">{relativeTime(r.created_at)}</TableCell>
              </TableRow>
            );
          })}
          {leads.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No active leads for this org.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <Link href={`/work/review/leads?org=${org.slug}`} className="inline-block text-sm text-primary hover:underline">
        Open in the full Review queue (filters, Promote/Drop) →
      </Link>

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
