"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
import { assignSupplierOperator } from "@/app/actions/supplier-assignment";

// Per-supplier operator picker. Choosing an operator writes a manual assignment
// (agents route that client's outreach to them); choosing "Auto" clears it and
// falls back to the sticky-random default (shown in the Auto label).
export function SupplierOperatorAssign({
  orgId,
  supplierId,
  assignedId,
  autoName,
  options,
  claimsIgnored,
}: {
  orgId: string;
  supplierId: string;
  assignedId: string | null;
  autoName: string | null;
  options: { id: string; name: string }[];
  // Org is on "auto, reassign all": the claim is kept but dormant. Say so
  // instead of showing a picked name that agents are not actually routing to.
  claimsIgnored?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const opts = [
    { value: "", label: autoName ? `Auto · ${autoName}` : "Auto (unassigned)" },
    ...options.map((o) => ({ value: o.id, label: o.name })),
  ];

  function onChange(val: string) {
    setErr(null);
    start(async () => {
      const r = await assignSupplierOperator(orgId, supplierId, val || null);
      if (r.ok) router.refresh();
      else setErr(r.error ?? "failed");
    });
  }

  return (
    <div className="flex flex-col gap-0.5">
      <Select
        size="sm"
        className="min-w-[11rem]"
        ariaLabel="Assign operator"
        value={assignedId ?? ""}
        onValueChange={onChange}
        options={opts}
        disabled={pending}
      />
      {claimsIgnored && assignedId && (
        <span className="text-[11px] text-muted-foreground">Overridden by auto mode</span>
      )}
      {err && <span className="text-[11px] text-red-600 dark:text-red-400">{err}</span>}
    </div>
  );
}
