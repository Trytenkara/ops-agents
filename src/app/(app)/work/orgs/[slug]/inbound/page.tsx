import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { InboundList, type InboundRow } from "@/components/inbound-list";

export const dynamic = "force-dynamic";

// Reply drafts Agent 08 composed for inbound supplier emails — the operator
// reviews and sends each in Missive.
export default async function OrgInboundPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: rows } = await admin
    .from("draft_references")
    .select("id, subject, status, metadata, created_at")
    .eq("org_id", org.id)
    .eq("metadata->>draft_kind", "inbound_reply")
    .order("created_at", { ascending: false })
    .limit(100);
  const drafts = rows ?? [];

  const inboundRows: InboundRow[] = drafts.map((d: any) => {
    const findings = (d.metadata?.qa_findings ?? []) as any[];
    return {
      id: d.id,
      subject: d.subject ?? null,
      status: d.status,
      createdAt: d.created_at ?? null,
      qaErrors: findings.filter((f) => f.severity === "error").length,
      qaTotal: findings.length,
      missiveLink: (d.metadata?.missive_draft_link as string | undefined) ?? null,
    };
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Supplier replies for {org.name} — Agent 08 drafted a response for each. Review and send in Missive; nothing goes out automatically.
      </p>
      {inboundRows.length === 0 ? (
        <p className="text-center text-muted-foreground py-8 text-sm">No inbound reply drafts.</p>
      ) : (
        <InboundList rows={inboundRows} slug={org.slug} />
      )}
    </div>
  );
}
