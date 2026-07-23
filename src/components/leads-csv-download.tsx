"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Per-client Leads-tab download: pull the CSV for everything, or narrow to a
// single material and/or the marketplace vs non-marketplace split. Hits the
// shared /api/leads-in-flight/export-csv route (org-scoped, all stages).
export function LeadsCsvDownload({ slug, materials }: { slug: string; materials: string[] }) {
  const [material, setMaterial] = useState("");
  const [market, setMarket] = useState("");

  function download() {
    const sp = new URLSearchParams({ org: slug, stage: "all", status: "active" });
    if (material) sp.set("material", material);
    if (market) sp.set("market", market);
    window.location.assign(`/api/leads-in-flight/export-csv?${sp.toString()}`);
  }

  const selectCls =
    "h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Download CSV:</span>
      <select className={selectCls} value={material} onChange={(e) => setMaterial(e.target.value)} title="Material">
        <option value="">All materials</option>
        {materials.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select className={selectCls} value={market} onChange={(e) => setMarket(e.target.value)} title="Channel">
        <option value="">Marketplace + non-marketplace</option>
        <option value="marketplace">Marketplace only</option>
        <option value="direct">Non-marketplace only</option>
      </select>
      <Button size="sm" variant="default" onClick={download}>
        Download
      </Button>
    </div>
  );
}
