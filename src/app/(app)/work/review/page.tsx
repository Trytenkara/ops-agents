import Link from "next/link";
import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { getOrgNudgeCounts, totalNudges } from "@/lib/org-nudges";

export const dynamic = "force-dynamic";

// Hybrid surfacing: this top-level view is a per-org NUDGE summary — "Org X has
// N things waiting" — that deep-links into the per-org tabs where the detail and
// actions live. The "All …" tabs above keep the cross-org detail views.
export default async function ReviewByOrgPage() {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session);

  let orgQuery = admin.from("orgs").select("id, slug, name, is_internal").order("is_internal").order("name");
  if (assigned) {
    if (assigned.length === 0) {
      return <p className="text-sm text-muted-foreground">No orgs assigned to you yet.</p>;
    }
    orgQuery = orgQuery.in("id", assigned);
  }
  const { data: orgs } = await orgQuery;

  const withCounts = await Promise.all(
    (orgs ?? []).map(async (o: any) => ({ org: o, counts: await getOrgNudgeCounts(admin, o.id) }))
  );
  // Orgs with pending work first, by volume.
  withCounts.sort((a, b) => totalNudges(b.counts) - totalNudges(a.counts));
  const anyWork = withCounts.some((r) => totalNudges(r.counts) > 0);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        What&apos;s waiting on a human, by org. Click through to act — the detail and actions live on each org&apos;s tabs.
      </p>
      {!anyWork && <p className="text-sm text-muted-foreground">Nothing pending across your orgs. 🎣</p>}
      <div className="space-y-2">
        {withCounts.map(({ org, counts }) => {
          const total = totalNudges(counts);
          return (
            <div
              key={org.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${total > 0 ? "border-border bg-background" : "border-border/60 bg-background/50"}`}
            >
              <Link href={`/work/orgs/${org.slug}`} className="font-medium hover:underline">
                {org.name}
                {org.is_internal && <span className="ml-2 text-[9px] uppercase tracking-wider bg-secondary text-muted-foreground px-1.5 py-0.5 rounded">Internal</span>}
              </Link>
              {total === 0 ? (
                <span className="text-xs text-muted-foreground">all clear</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <NudgeChip n={counts.newLeads} label="new leads" href={`/work/orgs/${org.slug}/leads`} />
                  <NudgeChip n={counts.draftsToSend} label="to send" href={`/work/orgs/${org.slug}/threads`} />
                  <NudgeChip n={counts.priceChanges} label="price changes" href={`/work/orgs/${org.slug}/price-changes`} />
                  <NudgeChip n={counts.openCases} label="cases" href={`/work/orgs/${org.slug}/cases`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NudgeChip({ n, label, href }: { n: number; label: string; href: string }) {
  if (!n) return null;
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground hover:opacity-90"
    >
      <span className="tabular-nums">{n}</span> {label}
    </Link>
  );
}
