"use client";

import { Button } from "@/components/ui/button";

export function PrintReportButton() {
  return (
    <Button size="sm" variant="outline" onClick={() => window.print()}>
      Print / Save PDF
    </Button>
  );
}
