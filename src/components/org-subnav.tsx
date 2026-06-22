"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Org-page sub-nav. Client component so the active pill stays in sync with
// the route on statically-rendered segments (the previous server version
// relied on the x-tackle-path header which doesn't propagate reliably).
export function OrgSubnav({ base, sections }: { base: string; sections: { href: string; label: string }[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav className="flex gap-1 text-sm">
      {sections.map((s) => {
        const href = `${base}${s.href}`;
        const active = s.href === "" ? pathname === base : pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={s.href}
            href={href}
            className={cn(
              "px-3 py-1.5 rounded-md transition-colors",
              active ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
