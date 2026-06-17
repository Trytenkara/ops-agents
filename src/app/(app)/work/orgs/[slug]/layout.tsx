import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { OrgSubnav } from "@/components/org-subnav";

export const dynamic = "force-dynamic";

const sections = [
  { href: "", label: "Overview" },
  { href: "/profile", label: "Client Profile" },
  { href: "/revalidation", label: "Expiries" },
  { href: "/leads", label: "Leads" },
  { href: "/price-changes", label: "Price Changes" },
  { href: "/savings", label: "Savings" },
  { href: "/outreach", label: "Outreach" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/inbound", label: "Inbound" },
  { href: "/cases", label: "Cases" },
  { href: "/approvals", label: "Approvals" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/quotes", label: "Quotes" },
];

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug: string };
}) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, is_internal").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const base = `/work/orgs/${org.slug}`;

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between border-b border-border pb-4">
        <div>
          <h1 className="font-serif text-3xl tracking-tight">{org.name}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Org workspace
            {org.is_internal && <span className="ml-2 text-[9px] uppercase tracking-wider bg-secondary px-1.5 py-0.5 rounded">Internal</span>}
          </p>
        </div>
      </header>
      <OrgSubnav base={base} sections={sections} />
      <div>{children}</div>
    </div>
  );
}
