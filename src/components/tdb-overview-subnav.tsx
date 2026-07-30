"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Secondary tab bar inside the "TDB Overview" section, switching between the
// Materials and Suppliers surfaces. Active tab is derived from the route.
export function TdbOverviewSubnav({ slug }: { slug: string }) {
  const pathname = usePathname() ?? "";
  const base = `/work/orgs/${slug}`;
  const tabs = [
    { href: `${base}/materials`, label: "Materials" },
    { href: `${base}/suppliers`, label: "Suppliers" },
  ];
  return (
    <nav className="flex gap-1 border-b border-border text-sm">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 transition-colors",
              active
                ? "border-primary font-medium text-primary"
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
