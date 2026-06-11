import Link from "next/link";
import { roleLabel, ROLE_CHIP } from "@/lib/roles";
import type { SessionContext } from "@/lib/auth";
import { canSeeAgentTab, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs } from "@/lib/org-access";
import { SignOutButton } from "@/components/sign-out-button";
import { NavLink } from "@/components/nav-link";
import { TabToggleClient } from "@/components/tab-toggle";
import { NavSwitcher } from "@/components/nav-switcher";
import { RunbookAssistant } from "@/components/runbook-assistant";
import { cn } from "@/lib/utils";

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
  const showAgents = canSeeAgentTab(session);

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 border-r border-border bg-background flex flex-col">
        <div className="px-5 pt-6 pb-4">
          <Link href="/" className="flex items-center gap-2.5">
            <RobotLogo className="h-8 w-8 shrink-0" />
            <div>
              <div className="font-serif text-2xl tracking-tight leading-none">Tackle Box</div>
              <div className="text-xs text-muted-foreground mt-1">A Tenkara operations hub</div>
            </div>
          </Link>
        </div>

        {showAgents && (
          <div className="px-5 pb-4">
            <TabToggle />
          </div>
        )}

        <nav className="flex-1 px-3 text-sm space-y-0.5">
          <NavSwitcher work={<WorkNav orgs={orgs} session={session} />} agents={<AgentsNav />} />
        </nav>

        <div className="mt-auto border-t border-border px-5 py-4 space-y-2">
          <RunbookAssistant />
          <Link href="/how-it-works" className="block text-xs text-muted-foreground hover:text-foreground hover:underline">
            How Tackle Box works →
          </Link>
          <Link href="/settings/profile" className="block text-sm hover:underline">
            <div className="font-medium">{session.displayName ?? session.email}</div>
            <div className="text-xs text-muted-foreground truncate">{session.email}</div>
          </Link>
          <div className="flex flex-wrap gap-1">
            {session.roles.map((r) => (
              <span key={r} className={cn("inline-flex items-center justify-center text-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide leading-tight", ROLE_CHIP[r])}>
                {roleLabel(r)}
              </span>
            ))}
            {session.status === "out_of_office" && (
              <span className="inline-flex items-center justify-center text-center rounded-full bg-highlight px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide leading-tight">OOO</span>
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

function TabToggle() {
  return <TabToggleClient />;
}

function RobotLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#0011FF" />
      <line x1="32" y1="9" x2="32" y2="17" stroke="#F7F6F5" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="8" r="3.5" fill="#F7F6F5" />
      <rect x="14" y="18" width="36" height="30" rx="8" fill="#F7F6F5" />
      <circle cx="25" cy="32" r="4" fill="#0011FF" />
      <circle cx="39" cy="32" r="4" fill="#0011FF" />
      <rect x="24" y="40" width="16" height="3.5" rx="1.75" fill="#0011FF" />
      <rect x="9" y="28" width="4" height="10" rx="2" fill="#F7F6F5" />
      <rect x="51" y="28" width="4" height="10" rx="2" fill="#F7F6F5" />
    </svg>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-4 pb-1.5 font-semibold">{children}</div>;
}

function WorkNav({ orgs, session }: { orgs: OrgItem[]; session: SessionContext }) {
  const isAccountManagerOnly = hasAnyRole(session, ["account_manager"]) && !hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);
  const canManageOperators = hasAnyRole(session, ["admin", "ops_lead"]);
  const allOrgs = seesAllOrgs(session);
  return (
    <>
      <SectionLabel>Your work</SectionLabel>
      <NavLink href="/work">Today</NavLink>
      {!isAccountManagerOnly && (
        <>
          <SectionLabel>Queues</SectionLabel>
          <NavLink href="/work/review" match="prefix">Review queue</NavLink>
          <NavLink href="/work/price-pulse" match="prefix">Price Pulse</NavLink>
          <NavLink href="/work/exports" match="prefix">Exports (30d)</NavLink>
        </>
      )}
      <div className="flex items-center justify-between px-3 pt-4 pb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Orgs</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {allOrgs ? "All orgs" : `${orgs.length} assigned`}
        </span>
      </div>
      {orgs.length === 0 && <div className="text-xs text-muted-foreground px-3">No orgs synced yet</div>}
      {orgs.map((o) => (
        <NavLink key={o.slug} href={`/work/orgs/${o.slug}`} match="prefix">
          <span className={o.isInternal ? "text-muted-foreground" : ""}>
            {o.name}
            {o.isInternal && <span className="ml-2 text-[9px] uppercase tracking-wider bg-secondary text-muted-foreground px-1.5 py-0.5 rounded">Internal</span>}
          </span>
        </NavLink>
      ))}
      {canManageOperators && (
        <>
          <SectionLabel>Team</SectionLabel>
          <NavLink href="/operators" match="prefix">Operators</NavLink>
        </>
      )}
    </>
  );
}

function AgentsNav() {
  const items = [
    { href: "/agents", label: "Activity feed" },
    { href: "/agents/config", label: "Configuration" },
    { href: "/agents/audit", label: "Audit log" },
    { href: "/agents/health", label: "System health" },
  ];
  return (
    <>
      {items.map((i) => (
        <NavLink key={i.href} href={i.href}>{i.label}</NavLink>
      ))}
    </>
  );
}
