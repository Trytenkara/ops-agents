"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { OperatorChip } from "@/components/operator-chip";
import { Badge } from "@/components/ui/badge";
import type { AppRole } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { setOrgDefaultOperators } from "@/app/actions/org-operators";

interface UserOption {
  id: string;
  display_name: string | null;
  email: string;
  role: AppRole | null;
  status: "active" | "out_of_office";
}

interface Props {
  orgId: string;
  orgName: string;
  initialPrimary: UserOption | null;
  initialBackup: UserOption | null;
  candidates: UserOption[];
  canEdit: boolean;
}

export function OrgOperatorsEditor({ orgId, orgName, initialPrimary, initialBackup, candidates, canEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const [primary, setPrimary] = useState<string | null>(initialPrimary?.id ?? null);
  const [backup, setBackup] = useState<string | null>(initialBackup?.id ?? null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const primaryUser = candidates.find((c) => c.id === primary) ?? null;
  const backupUser = candidates.find((c) => c.id === backup) ?? null;

  function save() {
    setMsg(null);
    start(async () => {
      const res = await setOrgDefaultOperators({ orgId, primaryUserId: primary, backupUserId: backup });
      if (!res.ok) setMsg(res.error ?? "failed");
      else {
        setEditing(false);
        router.refresh();
      }
    });
  }

  function cancel() {
    setPrimary(initialPrimary?.id ?? null);
    setBackup(initialBackup?.id ?? null);
    setEditing(false);
    setMsg(null);
  }

  if (!editing) {
    return (
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-20">Primary</span>
          {initialPrimary ? (
            <>
              <OperatorChip name={initialPrimary.display_name} email={initialPrimary.email} role={initialPrimary.role ?? undefined} />
              {initialPrimary.status === "out_of_office" && <Badge variant="warn">OOO</Badge>}
            </>
          ) : (
            <span className="text-muted-foreground italic">unset</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-20">Backup</span>
          {initialBackup ? (
            <OperatorChip name={initialBackup.display_name} email={initialBackup.email} role={initialBackup.role ?? undefined} />
          ) : (
            <span className="text-muted-foreground italic">unset</span>
          )}
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="mt-2">
            Edit
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-[80px_1fr] items-center gap-3">
        <label className="text-muted-foreground">Primary</label>
        <UserSelect
          value={primary}
          excludeId={backup}
          candidates={candidates}
          onChange={setPrimary}
          placeholder="— unassigned —"
        />
      </div>
      <div className="grid grid-cols-[80px_1fr] items-center gap-3">
        <label className="text-muted-foreground">Backup</label>
        <UserSelect
          value={backup}
          excludeId={primary}
          candidates={candidates}
          onChange={setBackup}
          placeholder="— none —"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Primary is auto-assigned to new agent items for {orgName}. If primary is OOO, items route to backup instead.
      </p>
      {msg && <p className="text-xs text-destructive">{msg}</p>}
      <div className="flex gap-2 pt-2">
        <Button size="sm" disabled={pending} onClick={save}>{pending ? "Saving..." : "Save"}</Button>
        <Button size="sm" variant="outline" onClick={cancel} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

function UserSelect({
  value,
  excludeId,
  candidates,
  onChange,
  placeholder,
}: {
  value: string | null;
  excludeId: string | null;
  candidates: UserOption[];
  onChange: (v: string | null) => void;
  placeholder: string;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
    >
      <option value="">{placeholder}</option>
      {candidates
        .filter((c) => c.id !== excludeId)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {(c.display_name ?? c.email) + (c.role ? ` · ${roleLabel(c.role)}` : "")}
            {c.status === "out_of_office" ? " (OOO)" : ""}
          </option>
        ))}
    </select>
  );
}
