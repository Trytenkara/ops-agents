"use client";

import { Button } from "@/components/ui/button";
import { toCsv, type CsvCell } from "@/lib/csv";

// Client-side CSV export from already-loaded rows. Mirrors what's on screen
// (post search/sort/filter) so the download matches what the operator sees.
// For exports that must apply server-side permissions/joins, use a dedicated
// /api/.../export-csv route instead.
export function ListCsvButton({
  filename,
  headers,
  rows,
  count,
  disabled,
}: {
  filename: string;
  headers: string[];
  rows: CsvCell[][];
  count?: number;
  disabled?: boolean;
}) {
  function download() {
    const body = toCsv(headers, rows);
    const blob = new Blob([body], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const n = count ?? rows.length;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || n === 0}
      onClick={download}
      title={n === 0 ? "Nothing to export" : undefined}
    >
      Export CSV{n > 0 ? ` (${n})` : ""}
    </Button>
  );
}
