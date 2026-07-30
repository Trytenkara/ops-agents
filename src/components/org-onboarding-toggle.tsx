"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { setOrgOnboardingStage, type OnboardingStageInput } from "@/app/actions/client-settings";

const OPTIONS: { value: OnboardingStageInput; label: string; hint: string }[] = [
  { value: "motherlode", label: "Motherlode", hint: "Early wide-net sourcing — surface every candidate" },
  {
    value: "onboarded",
    label: "Onboarded",
    hint: "Graduated client — tighter bar; leads below it get flagged (not deleted) in the Leads list",
  },
];

function badgeVariant(s: OnboardingStageInput): "default" | "outline" {
  return s === "onboarded" ? "default" : "outline";
}

export function OrgOnboardingToggle({
  orgId,
  orgName,
  initial,
  canEdit,
}: {
  orgId: string;
  orgName: string;
  initial: OnboardingStageInput;
  canEdit: boolean;
}) {
  const [saved, setSaved] = useState<OnboardingStageInput>(initial);
  const [choice, setChoice] = useState<OnboardingStageInput>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const current = OPTIONS.find((o) => o.value === saved)!;
  const dirty = choice !== saved;

  function save() {
    setMsg(null);
    start(async () => {
      const res = await setOrgOnboardingStage(orgId, choice);
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
            onValueChange={(v) => setChoice(v as OnboardingStageInput)}
            ariaLabel={`Onboarding stage for ${orgName}`}
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
