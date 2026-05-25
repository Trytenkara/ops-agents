import Link from "next/link";
import { headers } from "next/headers";
import { cn } from "@/lib/utils";
import { roleLabel, ROLE_CHIP } from "@/lib/roles";
import type { SessionContext } from "@/lib/auth";
import { canSeeAgentTab, hasAnyRole } from "@/lib/auth";
import { SignOutButton } from "@/components/sign-out-button";

type Tab = "work" | "agents";

export interface OrgItem {
  slug: string;
  name: string;
  isInternal?: boolean;
}

export function Shell({
  session,
  orgs,
  children,
}: {
  session: SessionContext;
  orgs: OrgItem[];
  children: React.ReactNode;
}) {
  const path = headers().get("x-tackle-path") ?? "/work";
  const tab: Tab = path.startsWith("/agents") ? "agents" : "work";
  const showAgents = canSeeAgentTab(session);

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 border-r border-border bg-background flex flex-col">
        <div className="px-5 pt-6 pb-4">
          <Link href="/" className="block">
            <div className="font-serif text-2xl tracking-tight">Tackle Box</div>
            <div className="text-xs text-muted-foreground mt-0.5">A Tenkara operations hub</div>
          </Link>
        </div>

        {showAgents && (
          <div className="px-5 pb-4">
            <TabToggle tab={tab} />
          </div>
        )}

        <nav className="flex-1 px-3 text-sm space-y-0.5">
          {tab === "work" ? (
            <WorkNav orgs={orgs} path={path} session={session} />
          ) : (
            <AgentsNav path={path} />
          )}
        </nav>

        <div className="mt-auto border-t border-border px-5 py-4 space-y-2">
          <Link href="/settings/profile" className="block text-sm hover:underline">
            <div className="font-medium">{session.displayName ?? session.email}</div>
            <div className="text-xs text-muted-foreground truncate">{session.email}</div>
          </Link>
          <div className="flex flex-wrap gap-1">
            {session.roles.map((r) => (
              <span key={r} className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider", ROLE_CHIP[r])}>
                {roleLabel(r)}
              </span>
            ))}
            {session.status === "out_of_office" && (
              <span className="inline-flex items-center rounded-full bg-highlight px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">OOO</span>
            )}
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="flex-1 min-h-screen">
        <div className="px-10 py-8 max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

function TabToggle({ tab }: { tab: Tab }) {
  return (
    <div className="inline-flex rounded-full bg-secondary p-0.5 w-full">
      <Link
        href="/work"
        className={cn(
          "flex-1 text-center text-xs font-medium py-1.5 rounded-full transition-colors",
          tab === "work" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
        )}
      >
        Your Work
      </Link>
      <Link
        href="/agents"
        className={cn(
          "flex-1 text-center text-xs font-medium py-1.5 rounded-full transition-colors",
          tab === "agents" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
        )}
      >
        Agents
      </Link>
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors",
        active ? "bg-secondary text-foreground font-medium" : "text-foreground/80 hover:bg-secondary/60"
      )}
    >
      {active && <span className="block w-1.5 h-1.5 rounded-full bg-primary" />}
      <span className={active ? "" : "ml-3.5"}>{children}</span>
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-4 pb-1.5 font-semibold">{children}</div>;
}

function WorkNav({ orgs, path, session }: { orgs: OrgItem[]; path: string; session: SessionContext }) {
  const isAccountManagerOnly = hasAnyRole(session, ["account_manager"]) && !hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);
  const canManageOperators = hasAnyRole(session, ["admin", "ops_lead"]);
  return (
    <>
      <NavLink href="/work" active={path === "/work"}>Today</NavLink>
      {!isAccountManagerOnly && (
        <>
          <NavLink href="/work/cross-org" active={path === "/work/cross-org"}>Cross-org views</NavLink>
          <NavLink href="/work/exports" active={path.startsWith("/work/exports")}>Exports (30d)</NavLink>
        </>
      )}
      <SectionLabel>Orgs</SectionLabel>
      {orgs.length === 0 && <div className="text-xs text-muted-foreground px-3">No orgs synced yet</div>}
      {orgs.map((o) => (
        <NavLink key={o.slug} href={`/work/orgs/${o.slug}`} active={path.startsWith(`/work/orgs/${o.slug}`)}>
          <span className={o.isInternal ? "text-muted-foreground" : ""}>
            {o.name}
            {o.isInternal && <span className="ml-2 text-[9px] uppercase tracking-wider bg-secondary text-muted-foreground px-1.5 py-0.5 rounded">Internal</span>}
          </span>
        </NavLink>
      ))}
      {canManageOperators && (
        <>
          <SectionLabel>Team</SectionLabel>
          <NavLink href="/operators" active={path.startsWith("/operators")}>Operators</NavLink>
        </>
      )}
    </>
  );
}

function AgentsNav({ path }: { path: string }) {
  const items = [
    { href: "/agents", label: "Activity feed" },
    { href: "/agents/config", label: "Configuration" },
    { href: "/agents/audit", label: "Audit log" },
    { href: "/agents/health", label: "System health" },
  ];
  return (
    <>
      {items.map((i) => (
        <NavLink key={i.href} href={i.href} active={path === i.href}>{i.label}</NavLink>
      ))}
    </>
  );
}
