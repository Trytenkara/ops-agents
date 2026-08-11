"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { setOrgPipelineTier } from "@/app/actions/client-settings";
import type { PipelineTier } from "@/lib/org-tier";

const OPTIONS: { value: PipelineTier; label: string; hint: string }[] = [
  {
    value: "testing",
    label: "Testing",
    hint: "Internal test orgs only — 1-min discovery, 5-min outreach; burns API budget fast",
  },
  {
    value: "high_frequency",
    label: "High frequency",
    hint: "Real clients being actively sourced — 15-min discovery, enrichment and outreach",
  },
  { value: "normal", label: "Normal", hint: "Standard cadence — 2h discovery, hourly enrichment and outreach" },
];

function badgeVariant(t: PipelineTier): "default" | "outline" {
  return t === "normal" ? "outline" : "default";
}

export function OrgPipelineTierToggle({
  orgId,
  orgName,
  initial,
  canEdit,
}: {
  orgId: string;
  orgName: string;
  initial: PipelineTier;
  canEdit: boolean;
}) {
  const [saved, setSaved] = useState<PipelineTier>(initial);
  const [choice, setChoice] = useState<PipelineTier>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const current = OPTIONS.find((o) => o.value === saved)!;
  const dirty = choice !== saved;

  function save() {
    setMsg(null);
    start(async () => {
      const res = await setOrgPipelineTier(orgId, choice);
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
            onValueChange={(v) => setChoice(v as PipelineTier)}
            ariaLabel={`Pipeline cadence for ${orgName}`}
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
