"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { setOrgSourcingStatus, type SourcingStatusInput } from "@/app/actions/client-settings";

const OPTIONS: { value: SourcingStatusInput; label: string; hint: string }[] = [
  { value: "active", label: "Active", hint: "Full pipeline — discovery, enrichment, outreach, replies" },
  { value: "sourcing_only", label: "Sourcing only", hint: "Build the supplier pool; outreach & replies held" },
  { value: "off", label: "Off", hint: "Paused — agents skip this org entirely" },
];

function badgeVariant(s: SourcingStatusInput): "default" | "warn" | "outline" {
  return s === "active" ? "default" : s === "sourcing_only" ? "warn" : "outline";
}

export function OrgSourcingToggle({
  orgId,
  orgName,
  initial,
  canEdit,
}: {
  orgId: string;
  orgName: string;
  initial: SourcingStatusInput;
  canEdit: boolean;
}) {
  const [saved, setSaved] = useState<SourcingStatusInput>(initial);
  const [choice, setChoice] = useState<SourcingStatusInput>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const current = OPTIONS.find((o) => o.value === saved)!;
  const dirty = choice !== saved;

  function save() {
    setMsg(null);
    start(async () => {
      const res = await setOrgSourcingStatus(orgId, choice);
      if (!res.ok) {
        setMsg(res.error ?? "failed");
        setChoice(saved);
      } else {
        setSaved(choice);
        router.refresh();
      }
    });
  }

  if (!canEdit) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Badge variant={badgeVariant(saved)}>{current.label}</Badge>
        <span className="text-muted-foreground">{current.hint}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-3">
        <Badge variant={badgeVariant(saved)}>{current.label}</Badge>
        <div className="min-w-[240px]">
          <Select
            value={choice}
            onValueChange={(v) => setChoice(v as SourcingStatusInput)}
            ariaLabel={`Sourcing status for ${orgName}`}
            options={OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </div>
        {dirty && (
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? "Saving..." : "Save"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{OPTIONS.find((o) => o.value === choice)!.hint}.</p>
      {msg && <p className="text-xs text-destructive">{msg}</p>}
    </div>
  );
}
