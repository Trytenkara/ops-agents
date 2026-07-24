"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Lightweight hover/focus tooltip using our design tokens — avoids the slow,
// OS-styled native `title` bubble. Wrap any trigger: <Tooltip content="…"><Button/></Tooltip>.
export function Tooltip({
  content,
  children,
  side = "bottom",
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}) {
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 w-max max-w-[15rem] -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-normal leading-snug text-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
          className
        )}
      >
        {content}
      </span>
    </span>
  );
}
