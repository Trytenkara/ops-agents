"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Client-side NavLink. Reads the current URL via usePathname() so the active
// pill stays in sync with the route even on statically-rendered segments.
// `match="exact"` requires pathname === href; `match="prefix"` matches any
// pathname that starts with href (used for nested routes like /work/orgs/foo).
export function NavLink({
  href,
  match = "exact",
  children,
}: {
  href: string;
  match?: "exact" | "prefix";
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const active = match === "exact" ? pathname === href : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors",
        active ? "bg-primary/10 text-primary font-medium" : "text-foreground/80 hover:bg-secondary/60"
      )}
    >
      {active && <span className="block w-1.5 h-1.5 rounded-full bg-primary" />}
      <span className={active ? "" : "ml-3.5"}>{children}</span>
    </Link>
  );
}
