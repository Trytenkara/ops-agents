import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const sections = [
  { href: "", label: "Overview" },
  { href: "/revalidation", label: "Revalidation" },
  { href: "/outreach", label: "Outreach" },
  { href: "/cases", label: "Cases" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/approvals", label: "Approvals" },
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
  const { data: org } = await admin.from("orgs").select("id, slug, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between border-b pb-3">
        <div>
          <h1 className="text-2xl font-semibold">{org.name}</h1>
          <p className="text-xs text-muted-foreground">Org workspace</p>
        </div>
      </header>
      <nav className="flex gap-1 text-sm border-b -mt-3 -mx-1 px-1">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={`/orgs/${org.slug}${s.href}`}
            className="px-3 py-2 hover:bg-accent rounded-t-md"
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  );
}
