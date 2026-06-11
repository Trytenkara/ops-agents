import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { getPricePulse } from "@/lib/price-pulse";

export const dynamic = "force-dynamic";

function money(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default async function PricePulsePage({
  searchParams,
}: {
  searchParams: { q?: string; min?: string };
}) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const minQuotes = Math.max(2, Number(searchParams.min ?? "3") || 3);
  const search = (searchParams.q ?? "").trim().toLowerCase();

  let pulse = await getPricePulse({ minQuotes, limit: 500 });
  if (search) pulse = pulse.filter((p) => p.material_name.toLowerCase().includes(search));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Price Pulse</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Live market spread per material across all suppliers in the Tenkara corpus — min / average / max per-unit
          price. Quotes fill from the marketplace and from scanned supplier replies. Sample quotes and unit-mislabeled
          outliers are excluded; materials with at least {minQuotes} quotes are shown. Read-only.
        </p>
      </div>

      <form className="flex gap-2 text-sm" action="/work/price-pulse" method="get">
        <input
          name="q"
          defaultValue={searchParams.q ?? ""}
          placeholder="Filter materials…"
          className="rounded border border-border bg-background px-2 py-1 text-sm w-56"
        />
        <input
          name="min"
          defaultValue={String(minQuotes)}
          inputMode="numeric"
          className="rounded border border-border bg-background px-2 py-1 text-sm w-20"
          title="Minimum quotes per material"
        />
        <button type="submit" className="rounded border border-border px-3 py-1 hover:bg-secondary">Apply</button>
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Material</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead className="text-right">Min</TableHead>
            <TableHead className="text-right">Avg</TableHead>
            <TableHead className="text-right">Max</TableHead>
            <TableHead className="text-right">Quotes</TableHead>
            <TableHead className="text-right">Suppliers</TableHead>
            <TableHead>Cheapest supplier</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pulse.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                No materials meet the threshold.
              </TableCell>
            </TableRow>
          )}
          {pulse.map((p) => (
            <TableRow key={`${p.material_id}-${p.unit}`}>
              <TableCell className="font-medium">{p.material_name}</TableCell>
              <TableCell className="text-muted-foreground">{p.unit}</TableCell>
              <TableCell className="text-right tabular-nums">{money(p.min_unit_price)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(p.avg_unit_price)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(p.max_unit_price)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{p.n_quotes}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{p.n_suppliers}</TableCell>
              <TableCell className="text-sm">{p.cheapest_supplier_name ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
