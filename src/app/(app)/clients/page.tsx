import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs } from "@/lib/org-access";
import { PageExplainer } from "@/components/page-explainer";
import { ClientsGrid } from "@/components/clients-grid";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const session = (await getSession())!;
  const admin = createAdminClient();

  let orgRows: Array<{ slug: string; name: string; is_internal: boolean }> = [];
  if (seesAllOrgs(session)) {
    const { data } = await admin
      .from("orgs")
      .select("slug, name, is_internal")
      .order("is_internal", { ascending: true })
      .order("name");
    orgRows = (data ?? []) as any;
  } else {
    const { data } = await admin
      .from("user_org_assignments")
      .select("orgs(slug, name, is_internal)")
      .eq("user_id", session.userId);
    orgRows = ((data ?? []) as any)
      .map((r: any) => r.orgs)
      .filter(Boolean)
      .sort((a: any, b: any) => Number(a.is_internal) - Number(b.is_internal) || a.name.localeCompare(b.name));
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">Clients</h1>
        <p className="text-sm text-muted-foreground mt-2">Your assigned client workspaces.</p>
      </header>

      <PageExplainer tag="Per client.">
        Each client has its own workspace — materials being sourced, suppliers, queue, and documents. Everything inside is
        strictly siloed to that client.
      </PageExplainer>

      {orgRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No clients assigned yet.</p>
      ) : (
        <ClientsGrid orgs={orgRows} />
      )}
    </div>
  );
}
