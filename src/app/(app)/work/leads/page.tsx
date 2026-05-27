import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Cross-org list of `leads_in_flight` rows produced by Agent 03 (and any other
// lead-creating agent). Defaults to stage='raw' since that's the new-from-cron
// bucket; filter via ?stage=… to peek at enriched / ready_for_approval / terminal.
const STAGES = ["raw", "enriched", "ready_for_outreach", "ready_for_approval", "terminal"] as const;
type Stage = (typeof STAGES)[number];

export default async function LeadsPage({ searchParams }: { searchParams: { stage?: string } }) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const stage: Stage = (STAGES as readonly string[]).includes(searchParams.stage ?? "")
    ? (searchParams.stage as Stage)
    : "raw";

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("leads_in_flight")
    .select("id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, confidence_score, agent_run_id, created_at, orgs(slug, name)")
    .eq("stage", stage)
    .eq("status", "active")
    .order("confidence_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Leads in flight</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Candidate suppliers staged by Agent 03 (Lead Creator) and other lead agents. Top of the list = highest confidence.
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        {STAGES.map((s) => (
          <Link
            key={s}
            href={`/work/leads?stage=${s}`}
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
                  {r.material_name ?? "—"}
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
                    <Link href={`/agents/runs/${r.agent_run_id}`} className="text-primary hover:underline text-xs">
                      run →
                    </Link>
                  ) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
          {(!rows || rows.length === 0) && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
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
