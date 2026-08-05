"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DraftDetailView } from "@/components/draft-detail-view";
import { getDraftDetail } from "@/app/actions/drafts";
import { relativeTime } from "@/lib/utils";
import type { DraftDetail } from "@/lib/draft-detail";

// Right-hand slide-over for reviewing a staged draft without losing the thread
// list (and the operator's filters and scroll position).
export function DraftPanel({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getDraftDetail(draftId);
    if (res.ok) {
      setDetail(res.detail);
      setCanReview(res.canReview);
      setError(null);
    } else {
      setError(res.error);
    }
  }, [draftId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Draft detail">
      <div className="flex-1 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="flex h-full w-full max-w-xl flex-col border-l border-border bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-serif text-lg truncate">{detail?.subject ?? "Draft"}</h2>
              {detail && (
                <Badge variant={detail.status === "staged" ? "warn" : "success"}>{detail.status}</Badge>
              )}
            </div>
            {detail && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Staged {relativeTime(detail.createdAt)} by {detail.agentName ?? "agent"}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Link href={`/work/drafts/${draftId}`} className="text-xs text-primary hover:underline">
              Full page ↗
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close draft"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="text-sm text-destructive">Could not load this draft ({error}).</p>
          ) : detail ? (
            <DraftDetailView detail={detail} canReview={canReview} onChanged={load} />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
      </div>
    </div>
  );
}
