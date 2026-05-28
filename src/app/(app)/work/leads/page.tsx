import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { LeadRowActions } from "@/components/lead-row-actions";

export const dynamic = "force-dynamic";

// Cross-org list of `leads_in_flight` rows produced by Agent 03 (and any other
// lead-creating agent). Defaults to stage='raw' since that's the new-from-cron
// bucket; filter via ?stage=… to peek at enriched / ready_for_approval / terminal.
const STAGES = ["raw", "enriched", "ready_for_outreach", "ready_for_approval", "terminal"] as const;
type Stage = (typeof STAGES)[number];

export default async function LeadsPage({ searchParams }: { searchParams: { stage?: string; drift?: string } }) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const stage: Stage = (STAGES as readonly string[]).includes(searchParams.stage ?? "")
    ? (searchParams.stage as Stage)
    : "raw";
  const driftOnly = searchParams.drift === "1";

  const assigned = await getAssignedOrgIds(session);
  const admin = createAdminClient();
  let q = admin
    .from("leads_in_flight")
    .select("id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, orgs(slug, name)")
    .eq("stage", stage)
    .order("confidence_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);
  // The terminal stage also wants dropped rows for full audit trail.
  if (stage === "terminal") {
    q = q.in("status", ["active", "dropped", "terminal"]);
  } else {
    q = q.eq("status", "active");
  }
  if (assigned) q = q.in("org_id", assigned);
  if (driftOnly) q = q.eq("payload->>catalog_drift", "no_longer_listed");
  const { data: rows } = await q;
  const canAct = seesAllOrgs(session) || (assigned !== null && assigned.length > 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Leads in flight</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Candidate suppliers staged by Agent 03 (Lead Creator) and other lead agents. Top of the list = highest confidence.
        </p>
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Agent-written rows, human-gated flow.</span>{" "}
        Rows are created by Agent 03 (Lead Creator) and processed by Agent 06 (Enrichment).
        Use <span className="font-medium text-foreground">Promote</span> to hand a lead to Agent 04 (Outreach) — moves it to <code>ready_for_outreach</code>.
        Use <span className="font-medium text-foreground">Drop</span> when a lead shouldn't be pursued — moves it to <code>terminal</code> with the reason recorded.
        Promotable from <code>enriched</code>, or from <code>raw</code> when enrichment was blocked but you want to contact anyway.
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {STAGES.map((s) => (
          <Link
            key={s}
            href={`/work/leads?stage=${s}${driftOnly ? "&drift=1" : ""}`}
            className={
              "rounded-full px-3 py-1 border " +
              (s === stage
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {s}
          </Link>
        ))}
        <Link
          href={driftOnly ? `/work/leads?stage=${stage}` : `/work/leads?stage=${stage}&drift=1`}
          className={
            "rounded-full px-3 py-1 border ml-auto " +
            (driftOnly
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40"
              : "border-border text-muted-foreground hover:text-foreground")
          }
          title="Show only leads where Agent 05 flagged the catalog drift (supplier dropped material)."
        >
          {driftOnly ? "✓ catalog drift" : "+ catalog drift"}
        </Link>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Signal</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Org</TableHead>
            <TableHead>Staged</TableHead>
            <TableHead>Run</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(rows ?? []).map((r: any) => {
            const signal = r.payload?.signal as string | undefined;
            const signalCount = r.payload?.signal_count as number | undefined;
            const conf = r.confidence_score != null ? Number(r.confidence_score) : null;
            return (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.supplier_name ?? "—"}
                  {r.payload?.supplier_country && (
                    <span className="ml-2 text-xs text-muted-foreground">{r.payload.supplier_country}</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{r.material_name ?? "—"}</span>
                    {r.payload?.catalog_drift === "no_longer_listed" && (
                      <span
                        className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        title="Agent 05 detected the supplier dropped this material from their catalog."
                      >
                        drift
                      </span>
                    )}
                  </div>
                  {r.payload?.inci_name && (
                    <div className="text-xs text-muted-foreground truncate max-w-[28ch]">{r.payload.inci_name}</div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {signal ? (
                    <>
                      <code>{signal}</code>
                      {signalCount != null && <span className="ml-1">×{signalCount}</span>}
                    </>
                  ) : "—"}
                </TableCell>
                <TableCell><ConfidenceBadge value={conf} /></TableCell>
                <TableCell className="text-muted-foreground">{r.source ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {r.orgs?.name ?? <span className="italic text-xs">cross-org</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{relativeTime(r.created_at)}</TableCell>
                <TableCell>
                  {r.agent_run_id ? (
                    <a
                      href={`/agents/runs/${r.agent_run_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-muted"
                      title="Open the agent run that created this lead (new tab)"
                    >
                      run ↗
                    </a>
                  ) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {r.status === "active" ? (
                    <LeadRowActions
                      leadId={r.id}
                      stage={r.stage}
                      status={r.status}
                      hasBlockedReason={!!r.payload?.enrichment_blocked_reason}
                      disabled={!canAct}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground" title={r.drop_reason ?? undefined}>
                      {r.status}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {(!rows || rows.length === 0) && (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                No leads at stage <code>{stage}</code>.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const pct = `${(value * 100).toFixed(0)}%`;
  if (value >= 0.85) return <Badge variant="success">{pct}</Badge>;
  if (value >= 0.65) return <Badge variant="default">{pct}</Badge>;
  return <Badge variant="secondary">{pct}</Badge>;
}
