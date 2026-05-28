import { ListPageHeader } from "@/components/list-page-header";

export default function SuppliersPage() {
  return (
    <div className="space-y-4">
      <ListPageHeader
        level={2}
        title="Suppliers"
        description="Read-only supplier view pulled from Tenkara. Per-supplier rules and doc-expiry tracking will live here."
      />
      <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
        Not wired up yet — coming in a later phase.
      </div>
    </div>
  );
}
