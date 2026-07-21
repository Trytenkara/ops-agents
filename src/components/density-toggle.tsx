"use client";

import { useEffect, useState } from "react";

// Row-density preference for the long data tables. Toggles a `density-compact`
// class on <html>; the shared Table primitive reads it to tighten cell padding
// so ops can fit more rows on screen. Persisted in localStorage, applied on
// mount (a brief non-compact flash on first paint is fine for an ops tool).
const KEY = "ui-density";

function apply(compact: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("density-compact", compact);
}

export function DensityToggle() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    let stored = false;
    try {
      stored = window.localStorage.getItem(KEY) === "compact";
    } catch {
      /* ignore */
    }
    setCompact(stored);
    apply(stored);
  }, []);

  function toggle() {
    const next = !compact;
    setCompact(next);
    apply(next);
    try {
      window.localStorage.setItem(KEY, next ? "compact" : "comfortable");
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title="Toggle row density for the tables on this page"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden>{compact ? "≡" : "☰"}</span>
      {compact ? "Compact" : "Comfortable"}
    </button>
  );
}
