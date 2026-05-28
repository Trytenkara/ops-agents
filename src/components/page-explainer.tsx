// Short contextual callout shown under a page heading. Matches the dashed-border
// style of the "Agent-written" banner on /work/leads.
//
// Usage:
//   <PageExplainer>This page lists every CSV-bound approval across all orgs…</PageExplainer>
// or with a leading bold tag:
//   <PageExplainer tag="Agent-staged, human-sent.">Drafts are written by…</PageExplainer>
export function PageExplainer({
  tag,
  children,
}: {
  tag?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
      {tag && <span className="font-medium text-foreground">{tag}</span>}{tag && " "}
      {children}
    </div>
  );
}
