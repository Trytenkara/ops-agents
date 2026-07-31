import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNamesWithFallback, resolveMaterialNames, resolveQuoteRefs } from "@/lib/tenkara-names";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { ListPageHeader } from "@/components/list-page-header";
import { ThreadsList, type ThreadRow, type ThreadKind } from "@/components/threads-list";
import { PanelTabs } from "@/components/panel-tabs";
import { CasesSection } from "@/components/cases-section";
import { loadOrgCases, caseCategory } from "@/lib/org-cases";
import { getOutreachTracker } from "@/lib/outreach-tracker";
import { OutreachSummaryView } from "@/components/outreach-summary-view";

export const dynamic = "force-dynamic";

// Every draft an agent composes in response to a supplier's incoming email,
// regardless of which producer staged it. Agent 08 / the Tenkara webhook use
// "inbound_reply" (+ "..._with_followup" when it introduces held materials);
// Agent 15 uses "reply_manager_response". All are inbound replies to the operator.
const INBOUND_REPLY_KINDS = new Set([
  "inbound_reply",
  "inbound_reply_with_followup",
  "reply_manager_response",
]);

function kindOf(d: any): ThreadKind {
  return INBOUND_REPLY_KINDS.has(d.metadata?.draft_kind) ? "inbound" : "outbound";
}

// Unified email-thread workspace: outbound RFQs + inbound supplier replies for
// the client, filterable by kind. Re-quote drafts for expiring quotes live on
// the Price Index tab, not here.
export default async function OrgThreadsPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const session = (await getSession())!;
  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  const { data: drafts } = await admin
    .from("draft_references")
    .select(
      "id, subject, supplier_id, material_id, quote_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), reviewer:users!draft_references_reviewer_fkey(display_name), agents(name, slug)"
    )
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const { openRows: caseOpen, resolvedRows: caseResolved } = await loadOrgCases(admin, org.id);
  const emailCasesOpen = caseOpen.filter((c) => caseCategory(c.type) === "email");
  const emailCasesResolved = caseResolved.filter((c) => caseCategory(c.type) === "email");

  const rows = drafts ?? [];
  // The fetch is capped, so tell operators exactly which window they're seeing
  // (newest N threads and their date span). Older threads beyond the cap aren't
  // shown; the range makes that explicit instead of silently truncating.
  const THREADS_CAP = 200;
  const capHit = rows.length >= THREADS_CAP;
  const dates = rows.map((d: any) => d.created_at).filter(Boolean).sort();
  const fmt = (s: string) => new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const rangeNote =
    dates.length > 0
      ? `Showing ${rows.length} thread${rows.length === 1 ? "" : "s"} — ${fmt(dates[0])} to ${fmt(dates[dates.length - 1])}${capHit ? ` (newest ${THREADS_CAP}; older threads not shown)` : ""}`
      : null;
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  let quoteRefs = new Map<string, string>();
  try {
    [supplierNames, materialNames, quoteRefs] = await Promise.all([
      resolveSupplierNamesWithFallback(rows.map((d: any) => d.supplier_id).filter(Boolean)),
      resolveMaterialNames(rows.map((d: any) => d.material_id).filter(Boolean)),
      resolveQuoteRefs(rows.map((d: any) => d.quote_id).filter(Boolean)),
    ]);
  } catch {
    // Tenkara unreachable — rows fall back to "name unavailable".
  }

  const tracker = await getOutreachTracker(admin, org.id).catch(() => ({
    materials: [],
    totals: { emails: 0, qaFlagged: 0, manual: 0, skipped: 0, suppliers: 0 },
    marketplace: { total: 0, emailed: 0, manual: 0, needsPull: 0, pending: 0 },
  }));

  const threadRows: ThreadRow[] = rows
    .filter((d: any) => d.agents?.slug !== "agent-02-revalidation")
    .map((d: any) => ({
    id: d.id,
    kind: kindOf(d),
    subject: d.subject ?? null,
    supplierId: d.supplier_id ?? null,
    // Scout-discovered leads have no Tenkara supplier_id/material row, so fall
    // back to the name carried on the draft metadata.
    supplierName: (d.supplier_id ? supplierNames.get(d.supplier_id) : null) ?? (d.metadata as any)?.supplier_name ?? null,
    materialId: d.material_id ?? null,
    materialName: correctMaterialSpelling((d.material_id ? materialNames.get(d.material_id) : null) ?? (d.metadata as any)?.material_name ?? null),
    quoteRef: d.quote_id ? quoteRefs.get(d.quote_id) ?? null : null,
    status: d.status,
    createdAt: d.created_at ?? null,
    metadata: d.metadata,
    assignedName: d.users?.display_name ?? null,
    assignedEmail: d.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(d.users)),
    reviewerName: d.reviewer?.display_name ?? null,
    hiddenLocally: d.metadata?.hidden_locally === true,
  }));

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Email Thread Tracker"
        description="Every email conversation for this client — outbound RFQs and inbound supplier replies. Drafts only; nothing sends automatically. Re-quotes to maintain live pricing are on the Live Price Index tab."
        collectedBy="Agent 04 (Outreach) + Agent 08 (Email Scanner) + Agent 15 (Reply Manager)"
        explainer={
          <>
            Drafts are composed automatically and staged for review. Filter by <span className="font-medium text-foreground">kind</span> to
            see outbound RFQs or inbound replies. Open a draft to review and send it.
          </>
        }
      />
      <PanelTabs
        tabs={[
          {
            key: "outreach",
            label: "Outreach Summary",
            badge: tracker.totals.emails,
            content: (
              <OutreachSummaryView tracker={tracker} threads={threadRows} slug={params.slug} />
            ),
          },
          {
            key: "threads",
            label: "Threads",
            badge: threadRows.length,
            content: (
              <div className="space-y-4">
                {rangeNote && <p className="text-xs text-muted-foreground">{rangeNote}</p>}
                {threadRows.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8 text-sm">No threads yet. Promote a lead to start outreach.</p>
                ) : (
                  <ThreadsList rows={threadRows} slug={params.slug} canAct={canAct} />
                )}
              </div>
            ),
          },
          {
            key: "escalations",
            label: "Escalations",
            badge: emailCasesOpen.length,
            content: (
              <CasesSection
                openRows={emailCasesOpen}
                resolvedRows={emailCasesResolved}
                slug={params.slug}
                emptyLabel="No email escalations right now. Supplier forms to sign and no-reply calling escalations show up here."
              />
            ),
          },
        ]}
      />
    </div>
  );
}
