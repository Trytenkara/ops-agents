import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { OrgSubnav } from "@/components/org-subnav";
import { WorkflowStepper } from "@/components/workflow-stepper";

export const dynamic = "force-dynamic";

const sections = [
  { href: "", label: "Overview" },
  { href: "/work", label: "Sourcing" },
  { href: "/materials", label: "Materials" },
  { href: "/documents", label: "Documents" },
  { href: "/queue", label: "Needs You" },
  { href: "/settings", label: "Settings" },
];

export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug: string };
}) {
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, is_internal")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  const base = `/clients/${org.slug}`;

  return (
    <div className="space-y-6">
      <header className="border-b border-border pb-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">{org.name}</h1>
            <p className="text-xs text-muted-foreground mt-1">
              Active
              {org.is_internal && <span className="ml-2 text-[9px] uppercase tracking-wider bg-secondary px-1.5 py-0.5 rounded">Internal</span>}
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>Lead operator: <span className="text-foreground">—</span></div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">Materials sourcing · supplier responses · documents</p>
      </header>
      <WorkflowStepper base={base} currentStage="source" />
      <OrgSubnav base={base} sections={sections} />
      <div>{children}</div>
    </div>
  );
}
