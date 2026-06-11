"use client";
import { Button } from "@/components/ui/button";

export function SavingsExportCsvButton({ slug, disabled, count }: { slug: string; disabled?: boolean; count: number }) {
  function download() {
    window.location.assign(`/api/savings/export-csv?org=${encodeURIComponent(slug)}`);
  }
  return (
    <Button size="sm" variant="default" disabled={disabled} onClick={download} title={disabled ? "No savings to export" : undefined}>
      Export savings CSV{count > 0 ? ` (${count})` : ""}
    </Button>
  );
}
