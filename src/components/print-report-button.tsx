"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

// Prints only the report region tagged with the matching class (.print-report
// or .print-custom). Sets data-printing on <body> so the print stylesheet can
// isolate that region; clears it after the print dialog closes.
export function PrintReportButton({
  target = "report",
  label = "Print / Save PDF",
  disabled,
}: {
  target?: "report" | "custom";
  label?: string;
  disabled?: boolean;
}) {
  useEffect(() => {
    const clear = () => document.body.removeAttribute("data-printing");
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  function print() {
    document.body.setAttribute("data-printing", target);
    window.print();
  }

  return (
    <Button size="sm" variant="outline" onClick={print} disabled={disabled}>
      {label}
    </Button>
  );
}
