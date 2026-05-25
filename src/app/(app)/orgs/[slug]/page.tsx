import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OrgOverview({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const [draftsRes, casesRes, approvalsRes, opsRes] = await Promise.all([
    admin.from("draft_references").select("id, status", { count: "exact", head: false }).eq("org_id", org.id),
    admin.from("cases").select("id, status").eq("org_id", org.id).eq("status", "open"),
    admin.from("pending_approvals").select("id").eq("org_id", org.id).eq("status", "pending"),
    admin
      .from("org_default_operators")
      .select("primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(display_name, email, status), backup_user:users!org_default_operators_backup_user_id_fkey(display_name, email, status)")
      .eq("org_id", org.id)
      .maybeSingle(),
  ]);

  const drafts = draftsRes.data ?? [];
  const staged = drafts.filter((d: any) => d.status === "staged").length;
  const reviewed = drafts.filter((d: any) => d.status === "reviewed").length;
  const ops = opsRes.data as any;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader><CardTitle className="text-sm">Drafts in flight</CardTitle></CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{staged}</div>
          <p className="text-xs text-muted-foreground">{reviewed} reviewed, awaiting send</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">Open cases</CardTitle></CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{casesRes.data?.length ?? 0}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">Pending approvals</CardTitle></CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{approvalsRes.data?.length ?? 0}</div>
        </CardContent>
      </Card>
      <Card className="md:col-span-3">
        <CardHeader><CardTitle className="text-sm">Operator assignment</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          {ops ? (
            <>
              <div>
                <span className="text-muted-foreground">Primary:</span>{" "}
                <strong>{ops.primary_user?.display_name ?? ops.primary_user?.email ?? "—"}</strong>{" "}
                {ops.primary_user?.status === "out_of_office" && <Badge variant="warn">OOO</Badge>}
              </div>
              <div>
                <span className="text-muted-foreground">Backup:</span>{" "}
                <strong>{ops.backup_user?.display_name ?? ops.backup_user?.email ?? "—"}</strong>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">No default operator configured. Admins set this on the org row in Supabase or via the (not-yet-built) settings page.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
