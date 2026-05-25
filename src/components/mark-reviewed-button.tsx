"use client";
import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { markDraftReviewed } from "@/app/actions/drafts";

export function MarkReviewedButton({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="inline-flex items-center gap-2">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await markDraftReviewed(draftId);
            if (!res.ok) setErr(res.error ?? "failed");
            else router.refresh();
          })
        }
      >
        {pending ? "Marking…" : "Mark reviewed"}
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
