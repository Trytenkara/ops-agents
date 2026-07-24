"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Org-page sub-nav. Highlights the active tab and shows an immediate spinner on
// the tab you click, so switching feels responsive even while the next tab's
// (sometimes slow, Tenkara-backed) data loads. The body also shows a skeleton
// via the route's loading.tsx.
export function OrgSubnav({
  base,
  sections,
}: {
  base: string;
  sections: { href: string; label: string; disabled?: boolean }[];
}) {
  const pathname = usePathname() ?? "";
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // Navigation finished (path changed) → clear the pending spinner.
  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  return (
    <nav className="flex gap-1 text-sm">
      {sections.map((s) => {
        const href = `${base}${s.href}`;
        const active = s.href === "" ? pathname === base : pathname === href || pathname.startsWith(href + "/");
        const pending = pendingHref === href && !active;
        // Greyed, non-interactive tab (e.g. a surface that isn't ready to open yet).
        if (s.disabled) {
          return (
            <span
              key={s.href}
              aria-disabled="true"
              title="Coming soon"
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground/40"
            >
              {s.label}
            </span>
          );
        }
        return (
          <Link
            key={s.href}
            href={href}
            onClick={() => !active && setPendingHref(href)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors",
              active
                ? "bg-primary/10 text-primary font-medium"
                : pending
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            {pending && (
              <span
                className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
                aria-hidden="true"
              />
            )}
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
