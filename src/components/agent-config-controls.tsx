"use client";
import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { setAgentStamp, rotateAgentKey } from "@/app/actions/agents";
import { useRouter } from "next/navigation";

export function StampToggle({ agentId, initial }: { agentId: string; initial: boolean }) {
  const [stamped, setStamped] = useState(initial);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      variant={stamped ? "default" : "outline"}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const next = !stamped;
          const res = await setAgentStamp(agentId, next);
          if (res.ok) {
            setStamped(next);
            router.refresh();
          }
        })
      }
    >
      {pending ? "..." : stamped ? "✓ Approved — click to revoke" : "Stamp approval"}
    </Button>
  );
}

export function RotateKeyButton({ agentId }: { agentId: string }) {
  const [pending, start] = useTransition();
  const [token, setToken] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await rotateAgentKey(agentId);
            if (res.ok && res.token) setToken(res.token);
          })
        }
      >
        {pending ? "..." : "Rotate API key"}
      </Button>
      {token && (
        <div className="rounded border bg-amber-50 text-amber-900 p-3 text-xs">
          <div className="font-semibold mb-1">Copy this now — it will not be shown again:</div>
          <code className="break-all">{token}</code>
        </div>
      )}
    </div>
  );
}
