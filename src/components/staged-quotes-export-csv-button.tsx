"use client";
import { Button } from "@/components/ui/button";

export function StagedQuotesExportCsvButton({ disabled, count }: { disabled?: boolean; count: number }) {
  function download() {
    window.location.assign("/api/staged-quotes/export-csv");
  }
  return (
    <Button size="sm" variant="default" disabled={disabled} onClick={download} title={disabled ? "No approved staged quotes to export" : undefined}>
      Export approved as CSV{count > 0 ? ` (${count})` : ""}
    </Button>
  );
}
