import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ClientSuppliers, ClientSupplier, SupplierApproval } from "@/lib/client-suppliers";

const GROUPS: { key: SupplierApproval; label: string; variant: "success" | "warn" | "secondary"; collapsed?: boolean }[] = [
  { key: "approved", label: "Approved", variant: "success" },
  { key: "pending_review", label: "Pending review", variant: "warn" },
  { key: "denied", label: "Denied", variant: "secondary" },
  { key: "draft", label: "Draft", variant: "secondary", collapsed: true },
];

function SupplierRows({ rows }: { rows: ClientSupplier[] }) {
  return (
    <div className="divide-y divide-border/50">
      {rows.map((s) => (
        <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-x-4 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{s.name ?? "—"}</span>
            {s.is_marketplace && <Badge variant="secondary" className="shrink-0">marketplace</Badge>}
          </div>
          <div className="min-w-0 text-sm text-muted-foreground">
            <span className="truncate block">{s.poc_email ?? s.poc_name ?? "—"}</span>
            {s.approval_notes && <span className="mt-0.5 block truncate text-xs italic">{s.approval_notes}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ClientSuppliersSection({ suppliers }: { suppliers: ClientSuppliers }) {
  return (
    <Card className="tb-surface shadow-none">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Suppliers</CardTitle>
        <span className="text-xs text-muted-foreground">
          {suppliers.total} total · {suppliers.approved.length} approved · {suppliers.pending_review.length} pending ·{" "}
          {suppliers.denied.length} denied
        </span>
      </CardHeader>
      <CardContent>
        {suppliers.total === 0 ? (
          <p className="text-sm text-muted-foreground">No suppliers linked to this client in Tenkara yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {GROUPS.filter((g) => suppliers[g.key].length > 0).map((g) => {
              const rows = suppliers[g.key];
              const header = (
                <div className="flex items-center gap-2">
                  <Badge variant={g.variant}>{g.label}</Badge>
                  <span className="text-xs text-muted-foreground">{rows.length}</span>
                </div>
              );
              return (
                <div key={g.key} className="py-3 first:pt-0 last:pb-0">
                  {g.collapsed ? (
                    <details>
                      <summary className="flex cursor-pointer list-none items-center gap-2 select-none">
                        {header}
                        <span className="text-xs text-muted-foreground">— show</span>
                      </summary>
                      <div className="mt-2">
                        <SupplierRows rows={rows} />
                      </div>
                    </details>
                  ) : (
                    <>
                      {header}
                      <div className="mt-2">
                        <SupplierRows rows={rows} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
