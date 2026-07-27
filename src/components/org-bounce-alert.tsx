"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";
import { clearBounceAlert } from "@/app/actions/client-settings";

export function OrgBounceAlert({
  orgId,
  orgName,
  status,
  canEdit,
}: {
  orgId: string;
  orgName: string;
  status: "none" | "triggered" | "paused_by_ops";
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  if (status === "none") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="outline">No alerts</Badge>
        <span>All good — outreach flowing normally</span>
      </div>
    );
  }

  function handleClear() {
    setMsg(null);
    start(async () => {
      const res = await clearBounceAlert(orgId);
      if (!res.ok) {
        setMsg(res.error ?? "failed");
      } else {
        router.refresh();
      }
    });
  }

  const isTriggered = status === "triggered";

  return (
    <div className="space-y-3 text-sm border-l-2 border-destructive bg-destructive/5 p-3 rounded">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="danger">{isTriggered ? "Bounce alert active" : "Paused by ops"}</Badge>
          </div>
          <p className="text-xs text-foreground mb-2">
            {isTriggered
              ? "2+ bounces detected in the last 24h. Outreach is paused for this client to prevent domain blacklisting."
              : "A bounce alert was previously triggered. Outreach is paused until cleared."}
          </p>
          {canEdit && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={handleClear}
              >
                {pending ? "Clearing..." : "Clear alert & resume outreach"}
              </Button>
            </div>
          )}
          {msg && <p className="text-xs text-destructive mt-2">{msg}</p>}
        </div>
      </div>
    </div>
  );
}
