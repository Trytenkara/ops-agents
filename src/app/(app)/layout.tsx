import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const admin = createAdminClient();
  const { data: orgs } = await admin.from("orgs").select("slug, name").order("name");

  return (
    <div className="flex">
      <Nav session={session} orgs={orgs ?? []} />
      <main className="flex-1 min-h-screen p-6">{children}</main>
    </div>
  );
}
