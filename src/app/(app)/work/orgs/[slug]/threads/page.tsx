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
import { loadOrgCases } from "@/lib/org-cases";
import { getOrgAssignmentContext, orgAutoKey, spreadOwnerId, type AssignmentContext } from "@/lib/operator-assignment";
import { getOutreachTracker } from "@/lib/outreach-tracker";
import { selectAllPaged } from "@/lib/supabase-paging";
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
  const draftKind = d.metadata?.draft_kind;
  // A form inquiry is outbound but is not an email: it was pasted into an
  // aggregator's own web form and its thread_id is a synthetic "form-inquiry:<tag>",
  // so labelling it like emailed outreach misrepresents both the channel and the id.
  if (draftKind === "aggregator_form_inquiry") return "inquiry";
  return INBOUND_REPLY_KINDS.has(draftKind) ? "inbound" : "outbound";
}

// A draft stamps `assigned_operator` when the agent composes it and nothing ever
// revisits that stamp, so this tab was the last surface still naming whoever
// owned the supplier on the day the draft was written. Leads, Suppliers, Quotes
// and (since 58ce1ae) Escalations all derive at read time, which is why the
// Thread Tracker disagreed with them and read as "the agents reassigned my leads".
//
// Only work still in front of an operator is re-derived. A sent email keeps its
// stamp: that is the record of who actually sent it, and a supplier replying to
// Shellezie's email must still reach Shellezie.
const DERIVABLE_DRAFT_STATUSES = new Set(["staged", "blocked", "reviewed"]);

function deriveThreadOwners(ctx: AssignmentContext, rows: any[]): void {
  const byId = new Map(ctx.pool.map((op) => [op.id, op]));
  for (const d of rows) {
    if (!DERIVABLE_DRAFT_STATUSES.has(d.status)) continue;
    const supplierName = (d.metadata as any)?.supplier_name ?? null;
    const ownerId = spreadOwnerId(
      ctx,
      orgAutoKey(ctx, {
        supplierId: d.supplier_id,
        supplierName,
        email: (d.metadata as any)?.supplier_contact_email ?? null,
        leadId: (d.metadata as any)?.lead_id ?? d.id,
      }),
      { nameHint: supplierName, workType: "email" }
    );
    const owner = ownerId ? byId.get(ownerId) : null;
    // Derivation declining to own the draft (manual mode with no claim, empty
    // pool) is an answer, not a gap: clear the stale stamp rather than keep
    // showing an operator this client never assigned.
    if (!owner) {
      d.assigned_operator = null;
      d.users = null;
      continue;
    }
    d.assigned_operator = owner.id;
    d.users = { display_name: owner.name, email: owner.email, user_roles: owner.roles.map((role: string) => ({ role })) };
  }
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

  // PostgREST caps a response at 1000 rows and a plain .limit() truncated this
  // to the newest 200, so older conversations were unreachable. Page through
  // with a stable order (created_at + id) so every thread for the org loads.
  const drafts = await selectAllPaged<any>((from, to) =>
    admin
      .from("draft_references")
      .select(
        "id, subject, supplier_id, material_id, quote_id, status, email_client, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), reviewer:users!draft_references_reviewer_fkey(display_name), agents(name, slug)"
      )
      .eq("org_id", org.id)
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to)
  );

  const assignment = await getOrgAssignmentContext(admin, org.id);

  const { openRows: emailCasesOpen, resolvedRows: emailCasesResolved, resolvedTotal: emailCasesResolvedTotal } = await loadOrgCases(
    admin,
    org.id,
    assignment,
    ["email"]
  );

  const rows = drafts ?? [];
  deriveThreadOwners(assignment, rows);
  const { data: aliasRows } = await admin
    .from("supplier_email_aliases")
    .select("id, email, draft_ref_id")
    .eq("org_id", org.id);
  const aliasesByDraft = new Map<string, { id: string; email: string }[]>();
  for (const alias of aliasRows ?? []) {
    if (!alias.draft_ref_id) continue;
    const list = aliasesByDraft.get(alias.draft_ref_id) ?? [];
    list.push({ id: alias.id, email: alias.email });
    aliasesByDraft.set(alias.draft_ref_id, list);
  }
  const dates = rows.map((d: any) => d.created_at).filter(Boolean).sort();
  const fmt = (s: string) => new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const rangeNote =
    dates.length > 0
      ? `Showing all ${rows.length} thread${rows.length === 1 ? "" : "s"}, ${fmt(dates[0])} to ${fmt(dates[dates.length - 1])}`
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
    emailClient: d.email_client,
    createdAt: d.created_at ?? null,
    metadata: d.metadata,
    assignedName: d.users?.display_name ?? null,
    assignedEmail: d.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(d.users)),
    reviewerName: d.reviewer?.display_name ?? null,
    hiddenLocally: d.metadata?.hidden_locally === true,
    aliases: aliasesByDraft.get(d.id) ?? [],
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
                  <ThreadsList rows={threadRows} slug={params.slug} orgId={org.id} canAct={canAct} />
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
                resolvedTotal={emailCasesResolvedTotal}
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
