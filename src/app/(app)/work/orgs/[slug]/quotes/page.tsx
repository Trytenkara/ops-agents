import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import {
  StagedQuoteRow,
  StagedQuoteHeaders,
  stagedQuoteColSpan,
  STAGED_CONF_ORDER,
} from "@/components/staged-quote-row";

export const dynamic = "force-dynamic";

const STATUSES = ["pending_review", "approved", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

export default async function OrgQuotesPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { status?: string };
}) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const status: Status = (STATUSES as readonly string[]).includes(searchParams.status ?? "")
    ? (searchParams.status as Status)
    : "pending_review";

  const { data: rows, error } = await admin
    .from("staged_quotes")
    .select(
      "id, source, source_attachment_name, supplier_name, material_name, price, case_size, unit_of_measurement, unit_price, currency, confidence, extraction_notes, status, created_at"
    )
    .eq("org_id", org.id)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(500);
  let staged = (rows ?? []) as any[];
  staged = staged.sort((a, b) => (STAGED_CONF_ORDER[a.confidence] ?? 9) - (STAGED_CONF_ORDER[b.confidence] ?? 9));

  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Supplier prices the Email Scanner extracted from reply bodies and attachments for {org.name}. Edit to fix an
        extraction, approve to queue for the next CSV export — staged quotes never write back to Tenkara automatically.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {STATUSES.map((s) => (
          <a
            key={s}
            href={`/work/orgs/${org.slug}/quotes?status=${s}`}
            className={
              "rounded-full px-3 py-1 border " +
              (s === status
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {s.replace("_", " ")}
          </a>
        ))}
      </div>

      <Table>
        <TableHeader>
          <StagedQuoteHeaders showOrg={false} />
        </TableHeader>
        <TableBody>
          {staged.length === 0 && (
            <TableRow>
              <TableCell colSpan={stagedQuoteColSpan(false)} className="text-center text-muted-foreground py-10">
                {error ? (
                  <span className="text-destructive">Query failed: {error.message}</span>
                ) : status === "pending_review" ? (
                  <>
                    <div className="font-medium text-foreground mb-1">No staged quotes yet.</div>
                    The Email Scanner populates this when it finds prices in this client&apos;s supplier replies.
                  </>
                ) : (
                  <>No {status.replace("_", " ")} staged quotes.</>
                )}
              </TableCell>
            </TableRow>
          )}
          {staged.map((r) => (
            <StagedQuoteRow key={r.id} r={r} canAct={canAct} showOrg={false} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
