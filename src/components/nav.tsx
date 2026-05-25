import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { SessionContext } from "@/lib/auth";
import { canSeeAgentTab } from "@/lib/auth";
import { SignOutButton } from "@/components/sign-out-button";

export function Nav({ session, orgs }: { session: SessionContext; orgs: { slug: string; name: string }[] }) {
  const showAgentTab = canSeeAgentTab(session);
  return (
    <aside className="w-60 shrink-0 border-r bg-muted/30 min-h-screen p-4 flex flex-col gap-6">
      <div>
        <Link href="/" className="text-lg font-semibold tracking-tight block">Ops Assistants</Link>
        <p className="text-xs text-muted-foreground">Command Center</p>
      </div>

      <nav className="space-y-1 text-sm">
        <div className="text-xs uppercase tracking-wider text-muted-foreground px-2 mb-2">Ops</div>
        <Link href="/" className="block px-2 py-1.5 rounded hover:bg-accent">Today / Inbox</Link>
        <Link href="/cross-org" className="block px-2 py-1.5 rounded hover:bg-accent">Cross-org views</Link>

        <div className="text-xs uppercase tracking-wider text-muted-foreground px-2 mt-4 mb-2">Orgs</div>
        {orgs.length === 0 && <div className="text-xs text-muted-foreground px-2">No orgs yet</div>}
        {orgs.map((o) => (
          <Link key={o.slug} href={`/orgs/${o.slug}`} className="block px-2 py-1.5 rounded hover:bg-accent">
            {o.name}
          </Link>
        ))}

        {showAgentTab && (
          <>
            <div className="text-xs uppercase tracking-wider text-muted-foreground px-2 mt-4 mb-2">Agents</div>
            <Link href="/agents" className="block px-2 py-1.5 rounded hover:bg-accent">Activity feed</Link>
            <Link href="/agents/config" className="block px-2 py-1.5 rounded hover:bg-accent">Configuration</Link>
            <Link href="/agents/health" className="block px-2 py-1.5 rounded hover:bg-accent">System health</Link>
          </>
        )}

        <div className="text-xs uppercase tracking-wider text-muted-foreground px-2 mt-4 mb-2">Account</div>
        <Link href="/settings/profile" className="block px-2 py-1.5 rounded hover:bg-accent">Profile</Link>
      </nav>

      <div className="mt-auto border-t pt-4 space-y-2">
        <div className="text-xs text-muted-foreground truncate" title={session.email}>{session.displayName ?? session.email}</div>
        <div className="flex flex-wrap gap-1">
          {session.roles.map((r) => <Badge key={r} variant="secondary">{r}</Badge>)}
          {session.status === "out_of_office" && <Badge variant="warn">OOO</Badge>}
        </div>
        <SignOutButton />
      </div>
    </aside>
  );
}
