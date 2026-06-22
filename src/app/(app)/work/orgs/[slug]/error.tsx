"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

// Recoverable error boundary for a client tab — a crash shows a retry instead
// of the bare "client-side exception" page, and logs the error for debugging.
export default function OrgTabError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[org-tab error]", error);
  }, [error]);

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
      <p className="text-sm font-medium">Something went wrong loading this tab.</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
        {error?.message || "An unexpected error occurred."}
        {error?.digest ? ` (ref ${error.digest})` : ""}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Button size="sm" onClick={() => reset()}>Try again</Button>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Reload page</Button>
      </div>
    </div>
  );
}
