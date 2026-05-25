"use client";
import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { setOwnStatus } from "@/app/actions/profile";
import { useRouter } from "next/navigation";

export function OooToggle({ initialStatus }: { initialStatus: "active" | "out_of_office" }) {
  const [status, setStatus] = useState(initialStatus);
  const [pending, start] = useTransition();
  const router = useRouter();
  const isOoo = status === "out_of_office";
  return (
    <div className="flex items-center gap-3">
      <Button
        variant={isOoo ? "outline" : "default"}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const next = isOoo ? "active" : "out_of_office";
            const res = await setOwnStatus(next);
            if (res.ok) {
              setStatus(next);
              router.refresh();
            }
          })
        }
      >
        {pending ? "..." : isOoo ? "I'm back — clear OOO" : "Mark me out of office"}
      </Button>
      <span className="text-sm text-muted-foreground">Current: <strong>{status}</strong></span>
    </div>
  );
}
