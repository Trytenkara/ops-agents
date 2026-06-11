"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/work/review", label: "By org", exact: true },
  { href: "/work/review/leads", label: "All leads" },
  { href: "/work/review/marketplace", label: "All price changes" },
  { href: "/work/review/staged-quotes", label: "Staged quotes" },
  { href: "/work/review/drafts", label: "All drafts" },
];

export function ReviewTabs() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="flex items-center gap-1 border-b border-border" aria-label="Review queue tabs">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
