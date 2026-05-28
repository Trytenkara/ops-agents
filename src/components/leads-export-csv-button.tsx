"use client";
import { Button } from "@/components/ui/button";

export function LeadsExportCsvButton({
  disabled,
  count,
  filters,
}: {
  disabled?: boolean;
  count: number;
  filters: { stage?: string; material?: string; source?: string; status?: string; drift?: string };
}) {
  function download() {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) sp.set(k, v);
    }
    const qs = sp.toString();
    window.location.assign(`/api/leads-in-flight/export-csv${qs ? `?${qs}` : ""}`);
  }
  return (
    <Button size="sm" variant="default" disabled={disabled} onClick={download} title={disabled ? "No leads to export" : undefined}>
      Export CSV{count > 0 ? ` (${count})` : ""}
    </Button>
  );
}
