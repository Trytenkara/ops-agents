"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { approveMarketplaceOutreach, rejectMarketplaceOutreach } from "@/app/actions/marketplace-outreach-review";

export function MarketplaceOutreachRow({ row, canAct }: { row: any; canAct: boolean }) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const existingVerified = row.payload?.enrichment?.email_check?.domain_matches_website === true && row.payload?.enrichment?.email_check?.is_aggregator_domain !== true;
  const signals = row.payload?.enrichment?.marketplace_trust?.signals ?? [];

  function approve() {
    setError(null);
    startTransition(async () => {
      const res = await approveMarketplaceOutreach(row.id, email);
      if (!res.ok) setError(res.error ?? "failed");
      else window.location.reload();
    });
  }
  function reject() {
    setError(null);
    startTransition(async () => {
      const res = await rejectMarketplaceOutreach(row.id, reason);
      if (!res.ok) setError(res.error ?? "failed");
      else window.location.reload();
    });
  }

  return (
    <tr className="border-b align-top">
      <td className="px-3 py-3"><div className="font-medium">{row.supplier_name ?? "Unknown supplier"}</div><div className="text-xs text-muted-foreground">{row.orgs?.name ?? "Unknown org"}</div></td>
      <td className="px-3 py-3">{row.material_name ?? "—"}</td>
      <td className="px-3 py-3"><div>{row.payload?.supplier_contact_email ?? "—"}</div><div className={existingVerified ? "text-xs text-emerald-700" : "text-xs text-amber-700"}>{existingVerified ? "Supplier-owned domain verified" : "Ownership not verified"}</div></td>
      <td className="px-3 py-3 text-xs text-muted-foreground">{signals.length ? signals.join("; ") : "No trust signals recorded"}</td>
      <td className="px-3 py-3">{row.payload?.source_url ? <a href={row.payload.source_url} target="_blank" rel="noreferrer" className="text-primary hover:underline text-sm">Listing ↗</a> : "—"}</td>
      <td className="px-3 py-3 min-w-[18rem]">
        {canAct ? (
          <div className="space-y-2">
            {!existingVerified && <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="verified supplier email" className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />}
            <div className="flex gap-1"><Button size="sm" variant="outline" onClick={approve} disabled={pending}>{pending ? "…" : "Approve"}</Button></div>
            <div className="flex gap-1"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="rejection reason" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs" /><Button size="sm" variant="destructive" onClick={reject} disabled={pending || !reason.trim()}>Reject</Button></div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : <span className="text-xs text-muted-foreground">Read only</span>}
      </td>
    </tr>
  );
}
