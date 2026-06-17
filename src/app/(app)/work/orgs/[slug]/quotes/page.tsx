import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { STAGED_CONF_ORDER } from "@/components/staged-quote-row";
import { StagedQuotesList } from "@/components/staged-quotes-list";
import { resolveMaterialGrades } from "@/lib/tenkara-names";

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
      "id, source, source_attachment_name, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, unit_price, currency, confidence, extraction_notes, status, created_at"
    )
    .eq("org_id", org.id)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(500);
  let staged = (rows ?? []) as any[];
  staged = staged.sort((a, b) => (STAGED_CONF_ORDER[a.confidence] ?? 9) - (STAGED_CONF_ORDER[b.confidence] ?? 9));

  // Grade lives on the Tenkara material, not the staged quote — resolve by id.
  let grades = new Map<string, string>();
  try {
    grades = await resolveMaterialGrades(staged.map((r) => r.material_id).filter(Boolean));
  } catch {
    // Tenkara unreachable — fall back to no grade rather than failing the page.
  }
  staged = staged.map((r) => ({ ...r, grade: r.material_id ? grades.get(r.material_id) ?? null : null }));

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

      {staged.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          {error ? (
            <span className="text-destructive">Query failed: {error.message}</span>
          ) : status === "pending_review" ? (
            "No staged quotes yet. The Email Scanner populates this when it finds prices in this client's supplier replies."
          ) : (
            `No ${status.replace("_", " ")} staged quotes.`
          )}
        </p>
      ) : (
        <StagedQuotesList rows={staged} canAct={canAct} />
      )}
    </div>
  );
}
