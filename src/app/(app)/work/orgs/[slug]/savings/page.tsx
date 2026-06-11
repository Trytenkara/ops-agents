import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { getSession, hasAnyRole } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildSavingsReport } from "@/lib/savings-report";
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

  return (
    <div className="space-y-4">
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
    </div>
  );
}
