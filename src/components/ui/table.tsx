import * as React from "react";
import { cn } from "@/lib/utils";

// Every table gets the same framed-card treatment (ivory surface, crisp border,
// consistent radius) so all tables across the platform read as one system.
// `viewport*` props address the scrolling box itself, so a long list can cap its
// height (and stick its header) without every table growing the page.
const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & {
    viewportClassName?: string;
    viewportRef?: React.Ref<HTMLDivElement>;
    onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
  }
>(({ className, viewportClassName, viewportRef, onViewportScroll, ...props }, ref) => (
  <div className="overflow-hidden rounded-lg border border-border bg-card">
    <div ref={viewportRef} onScroll={onViewportScroll} className={cn("relative w-full overflow-x-auto", viewportClassName)}>
      <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn("bg-muted/60 [&_tr]:border-b [&_tr]:border-border", className)} {...props} />
  )
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    // Zebra striping so rows/columns are easy to track across a wide table.
    <tbody ref={ref} className={cn("[&_tr:last-child]:border-0 [&>tr:nth-child(even)]:bg-muted/30", className)} {...props} />
  )
);
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn("border-b border-border transition-colors hover:bg-primary/5 data-[state=selected]:bg-muted", className)} {...props} />
  )
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    // Headers never wrap. A two-word label breaking mid-phrase ("ON / FILE",
    // "SUPPLIER / Δ") reads as two columns and doubles the header height across
    // the whole row. The viewport already scrolls horizontally, so the cost of a
    // wider header is a scrollbar, not a broken layout.
    <th ref={ref} className={cn("h-10 whitespace-nowrap px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground [html.density-compact_&]:h-8", className)} {...props} />
  )
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("p-3 align-middle [html.density-compact_&]:px-2 [html.density-compact_&]:py-1", className)} {...props} />
  )
);
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
