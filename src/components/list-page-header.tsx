import React from "react";

// Shared header for list/index pages (leads, marketplace findings, cases,
// approvals, exports, suppliers). Standardizes the title + description row, the
// optional right-aligned actions (export buttons), the dashed explainer box,
// and a slot for filter rows. `level` switches between a top-level page (h1)
// and an org sub-tab section (h2) so org-scoped pages nest cleanly under the
// org name.
export function ListPageHeader({
  title,
  description,
  actions,
  explainer,
  filters,
  level = 1,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  explainer?: React.ReactNode;
  filters?: React.ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 2 ? "h2" : "h1";
  const headingClass = level === 2 ? "font-serif text-xl tracking-tight" : "font-serif text-3xl tracking-tight";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Heading className={headingClass}>{title}</Heading>
          {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>

      {explainer && (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          {explainer}
        </div>
      )}

      {filters}
    </div>
  );
}

// Reusable pill-link filter chip used in the header filter rows. Renders a
// next/link styled as an active/inactive pill — matches the existing stage /
// source chip styling so all list pages read consistently.
export function FilterChip({
  href,
  active,
  children,
  title,
  tone = "primary",
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  title?: string;
  tone?: "primary" | "amber";
}) {
  const activeClass =
    tone === "amber"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40"
      : "bg-primary text-primary-foreground border-primary";
  return (
    <a
      href={href}
      title={title}
      className={"rounded-full px-3 py-1 border " + (active ? activeClass : "border-border text-muted-foreground hover:text-foreground")}
    >
      {children}
    </a>
  );
}

// A labeled row of filter chips. Keeps the "Label:" + wrapped chips layout
// identical across pages.
export function FilterRow({ label, children, className = "" }: { label?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={"flex flex-wrap gap-2 text-sm " + className}>
      {label && <span className="text-xs text-muted-foreground self-center mr-1">{label}</span>}
      {children}
    </div>
  );
}
