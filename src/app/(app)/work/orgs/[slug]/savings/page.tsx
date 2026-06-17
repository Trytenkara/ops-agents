import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { getSession, hasAnyRole } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildSavingsReport } from "@/lib/savings-report";
import { buildSourcingScorecard, type SourcingStatus } from "@/lib/sourcing-scorecard";
import { SavingsExportCsvButton } from "@/components/savings-export-csv-button";

export const dynamic = "force-dynamic";

function money(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default async function OrgSavingsPage({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, tenkara_org_id")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  if (!org.tenkara_org_id) {
    return (
      <p className="text-sm text-muted-foreground">
        This org isn&apos;t linked to a Tenkara organization yet, so there are no quotes to compare. Set{" "}
        <code className="text-xs">tenkara_org_id</code> on the org to enable savings.
      </p>
    );
  }

  const report = await buildSavingsReport(org.tenkara_org_id);
  const withSavings = report.lines.filter((l) => l.savings_per_unit > 0);
  const scorecard = await buildSourcingScorecard(admin, org.id, org.tenkara_org_id);

  return (
    <div className="space-y-8">
      {scorecard.materials_sourcing > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="font-serif text-2xl tracking-tight">Live sourcing</h2>
            <p className="text-sm text-muted-foreground max-w-2xl mt-1">
              Best price sourced so far in the current outreach (quotes staged from supplier replies), scored against
              what {org.name} pays today. <span className="text-foreground font-medium">Beats client</span> = the best
              sourced per-unit price is below their current price.
            </p>
          </div>

          <div className="flex gap-6 text-sm">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {scorecard.materials_beating_client}
              </div>
              <div className="text-muted-foreground">materials beating client price</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{scorecard.materials_sourcing}</div>
              <div className="text-muted-foreground">materials being sourced</div>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Client price</TableHead>
                <TableHead className="text-right">Best sourced</TableHead>
                <TableHead className="text-right">vs client</TableHead>
                <TableHead>Best supplier</TableHead>
                <TableHead className="text-right">Sourced</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scorecard.lines.map((l) => (
                <TableRow key={`${l.material_id}-${l.unit ?? "?"}`}>
                  <TableCell className="font-medium">{l.material_name}</TableCell>
                  <TableCell className="text-muted-foreground">{l.unit ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.client_unit_price)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.best_sourced_unit_price != null
                      ? money(l.best_sourced_unit_price)
                      : l.best_sourced_raw_price != null
                      ? `${money(l.best_sourced_raw_price)} (raw)`
                      : "—"}
                  </TableCell>
                  <TableCell
                    className={
                      "text-right tabular-nums " +
                      (l.beats_client_pct == null
                        ? "text-muted-foreground"
                        : l.beats_client_pct > 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400")
                    }
                  >
                    {l.beats_client_pct == null
                      ? "—"
                      : `${l.beats_client_pct > 0 ? "−" : "+"}${Math.abs(l.beats_client_pct).toFixed(0)}%`}
                  </TableCell>
                  <TableCell className="text-sm">{l.best_sourced_supplier ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {l.n_sourced} / {l.n_sourced_suppliers} sup
                  </TableCell>
                  <TableCell><SourcingStatusBadge status={l.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Per-material savings for {org.name}: the price they accepted (approved quote) vs the cheapest current
          Tenkara quote for the same material. Prices are normalized per-unit. Sample quotes and unit-mislabeled
          outliers are excluded. Read-only — acting on a recommendation is a human decision.
        </p>
        <SavingsExportCsvButton slug={org.slug} disabled={withSavings.length === 0} count={withSavings.length} />
      </div>

      <div className="flex gap-6 text-sm">
        <div>
          <div className="text-2xl font-semibold tabular-nums">{report.materials_with_savings}</div>
          <div className="text-muted-foreground">materials with a cheaper supplier</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums">{report.total_materials}</div>
          <div className="text-muted-foreground">materials benchmarked</div>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Material</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead className="text-right">Their price</TableHead>
            <TableHead className="text-right">Best Tenkara</TableHead>
            <TableHead className="text-right">Savings/unit</TableHead>
            <TableHead className="text-right">%</TableHead>
            <TableHead>Recommended supplier</TableHead>
            <TableHead className="text-right">Quotes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.lines.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                No approved quotes to benchmark for this client yet.
              </TableCell>
            </TableRow>
          )}
          {report.lines.map((l) => {
            const hasSaving = l.savings_per_unit > 0;
            return (
              <TableRow key={`${l.material_id}-${l.unit}`}>
                <TableCell className="font-medium">{l.material_name}</TableCell>
                <TableCell className="text-muted-foreground">{l.unit}</TableCell>
                <TableCell className="text-right tabular-nums">{money(l.their_unit_price)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(l.best_unit_price)}</TableCell>
                <TableCell className={"text-right tabular-nums " + (hasSaving ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                  {hasSaving ? money(l.savings_per_unit) : "—"}
                </TableCell>
                <TableCell className={"text-right tabular-nums " + (hasSaving ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                  {hasSaving ? `${l.savings_pct.toFixed(0)}%` : "—"}
                </TableCell>
                <TableCell className="text-sm">{hasSaving ? (l.recommended_supplier_name ?? "—") : "already cheapest"}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{l.n_quotes} / {l.n_suppliers} sup</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </section>
    </div>
  );
}

function SourcingStatusBadge({ status }: { status: SourcingStatus }) {
  switch (status) {
    case "beating":
      return (
        <span className="inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
          beats client
        </span>
      );
    case "above":
      return (
        <span className="inline-flex items-center rounded-full bg-red-500/15 text-red-700 dark:text-red-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
          above client
        </span>
      );
    case "no_baseline":
      return (
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" title="No benchmarked client price for this material yet.">
          no baseline
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" title="Sourced quote has no unit/case size, so it can't be normalized per-unit.">
          not comparable
        </span>
      );
  }
}
