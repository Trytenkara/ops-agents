import * as React from "react";
import { cn } from "@/lib/utils";

// Every table gets the same framed-card treatment (ivory surface, crisp border,
// consistent radius) so all tables across the platform read as one system.
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-x-auto">
        <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
      </div>
    </div>
  )
);
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
    <th ref={ref} className={cn("h-10 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)} {...props} />
  )
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("p-3 align-middle", className)} {...props} />
  )
);
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
