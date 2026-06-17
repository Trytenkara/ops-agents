import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { StagedQuoteRow, StagedQuoteHeaders, stagedQuoteColSpan, STAGED_CONF_ORDER } from "@/components/staged-quote-row";
import { StagedQuotesExportCsvButton } from "@/components/staged-quotes-export-csv-button";
import { ListPageHeader } from "@/components/list-page-header";

export const dynamic = "force-dynamic";

const STATUSES = ["pending_review", "approved", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

interface StagedRow {
  id: string;
  org_id: string | null;
  source: string;
  source_attachment_name: string | null;
  source_conversation_id: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  material_id: string | null;
  material_name: string | null;
  price: number | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  unit_price: number | null;
  currency: string | null;
  confidence: string;
  extraction_notes: string | null;
  status: Status;
  created_at: string;
  orgs: { slug: string; name: string } | null;
}

export default async function StagedQuotesPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const status: Status = (STATUSES as readonly string[]).includes(searchParams.status ?? "")
    ? (searchParams.status as Status)
    : "pending_review";

  const assigned = await getAssignedOrgIds(session);
  const admin = createAdminClient();
  let q = admin
    .from("staged_quotes")
    .select(
      "id, org_id, source, source_attachment_name, source_conversation_id, supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, unit_price, currency, confidence, extraction_notes, status, created_at, orgs(slug, name)"
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(500);
  if (assigned) q = q.in("org_id", assigned);

  const { data: rows, error } = await q;
  let staged = (rows ?? []) as unknown as StagedRow[];
  // Lowest-confidence first so ops triages the riskiest extractions up top.
  staged = staged.sort((a, b) => (STAGED_CONF_ORDER[a.confidence] ?? 9) - (STAGED_CONF_ORDER[b.confidence] ?? 9));

  const canAct = seesAllOrgs(session) || (assigned !== null && assigned.length > 0);

  let approvedCountQ = admin
    .from("staged_quotes")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved");
  if (assigned) approvedCountQ = approvedCountQ.in("org_id", assigned);
  const { count: approvedCount } = await approvedCountQ;

  return (
    <div className="space-y-4">
      <ListPageHeader
        title="Staged quotes"
        description="Supplier prices the Email Scanner extracted from reply bodies and attachments. Clean the values, approve to queue for the next CSV export; ops uploads that CSV to Tenkara manually."
        actions={<StagedQuotesExportCsvButton disabled={!approvedCount} count={approvedCount ?? 0} />}
        explainer={
          <>
            <span className="font-medium text-foreground">Agent 08 (Email Scanner)</span> stages a row per price line it found in an email or attachment.
            <span className="font-medium text-foreground"> Edit</span> to fix the extracted supplier/material/price.
            <span className="font-medium text-foreground"> Approve</span> queues it for the next CSV download.
            Staged quotes never write back to Tenkara automatically — your safety floor.
          </>
        }
        filters={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {STATUSES.map((s) => (
              <Link
                key={s}
                href={{ pathname: "/work/review/staged-quotes", query: { status: s } }}
                className={
                  "rounded-full px-3 py-1 border " +
                  (s === status
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:text-foreground")
                }
              >
                {s.replace("_", " ")}
              </Link>
            ))}
          </div>
        }
      />

      <Table>
        <TableHeader>
          <StagedQuoteHeaders />
        </TableHeader>
        <TableBody>
          {staged.length === 0 && (
            <TableRow>
              <TableCell colSpan={stagedQuoteColSpan()} className="text-center text-muted-foreground py-10">
                {error ? (
                  <span className="text-destructive">Query failed: {error.message}</span>
                ) : status === "pending_review" ? (
                  <>
                    <div className="font-medium text-foreground mb-1">No staged quotes yet.</div>
                    The Email Scanner populates this when it finds prices in supplier replies or attachments.
                  </>
                ) : (
                  <>No {status.replace("_", " ")} staged quotes.</>
                )}
              </TableCell>
            </TableRow>
          )}
          {staged.map((r) => (
            <StagedQuoteRow key={r.id} r={r} canAct={canAct} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
