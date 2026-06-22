import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ClientSuppliers, ClientSupplier, SupplierApproval } from "@/lib/client-suppliers";

const GROUPS: { key: SupplierApproval; label: string; variant: "success" | "warn" | "secondary" }[] = [
  { key: "approved", label: "Approved", variant: "success" },
  { key: "pending_review", label: "Pending review", variant: "warn" },
  { key: "denied", label: "Denied", variant: "secondary" },
  { key: "draft", label: "Draft", variant: "secondary" },
];

function SupplierRow({ s }: { s: ClientSupplier }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm py-1">
      <span className="font-medium">{s.name ?? "—"}</span>
      {s.is_marketplace && <Badge variant="secondary">marketplace</Badge>}
      {s.poc_email && <span className="text-xs text-muted-foreground">{s.poc_email}</span>}
      {s.approval_notes && <span className="text-xs text-muted-foreground italic">“{s.approval_notes}”</span>}
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
      <CardContent className="space-y-4">
        {suppliers.total === 0 ? (
          <p className="text-sm text-muted-foreground">No suppliers linked to this client in Tenkara yet.</p>
        ) : (
          GROUPS.filter((g) => suppliers[g.key].length > 0).map((g) => (
            <div key={g.key}>
              <div className="mb-1 flex items-center gap-2">
                <Badge variant={g.variant}>{g.label}</Badge>
                <span className="text-xs text-muted-foreground">{suppliers[g.key].length}</span>
              </div>
              <div className="divide-y divide-border/60">
                {suppliers[g.key].map((s) => (
                  <SupplierRow key={s.id} s={s} />
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
