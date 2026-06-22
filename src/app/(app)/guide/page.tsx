import { ListPageHeader } from "@/components/list-page-header";

export const dynamic = "force-dynamic";

// Operators Guide — a single in-app reference: how an operator works the app
// day-to-day, what every tab/feature does, and the background agent fleet.

const TABS: { name: string; question: string; does: string; agents: string }[] = [
  {
    name: "Overview",
    question: "What needs my attention?",
    does: "Six metric cards (new leads, drafts to send, quotes to approve, price changes, open cases, pending approvals). Each links to the tab where you act on it.",
    agents: "—",
  },
  {
    name: "Client Profile",
    question: "Who is this client?",
    does: "Contact (purchasing email, priority contact), supplier rep sheet, an AI-written summary, and a Documents box — upload any PDF/spreadsheet/CSV and it's parsed into the summary.",
    agents: "Agent 12 (Client Profile)",
  },
  {
    name: "Materials",
    question: "What do they buy, and where does each stand?",
    does: "Every material with a per-material sourcing status. Expand a row for its collected quotes (approve / dismiss inline), uploaded POs, and approvals. Upload POs and add sourcing notes here.",
    agents: "Agent 08 (Email Scanner) extracts quotes from supplier replies",
  },
  {
    name: "Suppliers",
    question: "Who can supply these materials?",
    does: "The client's Tenkara suppliers grouped by Approved / Pending / Denied — a read-only reference, sortable and filterable.",
    agents: "— (synced from Tenkara)",
  },
  {
    name: "Leads",
    question: "Who else could we source from?",
    does: "Newly discovered suppliers, tagged Marketplace vs Direct (filterable). Promote good ones to outreach or drop them. Bulk-upload a supplier CSV. The run ↗ link opens the agent log that created each lead.",
    agents: "Agent 03 (Lead Creator) + Agent 06 (Enrichment)",
  },
  {
    name: "Live Price Index",
    question: "Is their pricing still current?",
    does: "Marketplace re-checks — public price vs on-file, grouped into per-material tier ladders (cheapest per-unit first). Direct re-quotes — expiring quotes drafted for a fresh price, showing the expiry reason. Approve a refresh or open the re-quote.",
    agents: "Agent 05 (Marketplace Re-check) + Agent 02 (Revalidation)",
  },
  {
    name: "All Threads",
    question: "What's the conversation so far?",
    does: "Every outreach email and supplier reply, filterable by outbound / inbound. Open a draft to review and send. The full back-and-forth is logged here.",
    agents: "Agent 04 (Outreach) + Agent 08 (Email Scanner) + Agent 15 (Reply Manager)",
  },
  {
    name: "Savings",
    question: "What did we save them?",
    does: "A Worksheet view for ops and a branded, client-facing Savings report (PDF export, custom-prompt reshaper, optional freight/landed-cost toggle). Materials without a client price benchmark against the market average.",
    agents: "— (computed from the quote corpus)",
  },
  {
    name: "Cases",
    question: "What stalled and needs a human?",
    does: "Stale leads escalated after >14 days of no movement. Take the recommended action and resolve.",
    agents: "Agent 07 (Escalation)",
  },
];

const AGENTS: { id: string; name: string; does: string; feeds: string }[] = [
  { id: "01", name: "Ping", does: "Infrastructure heartbeat — verifies the pipeline is alive.", feeds: "—" },
  { id: "02", name: "Quote Revalidation", does: "Drafts re-quote emails for expiring/expired quotes.", feeds: "Live Price Index" },
  { id: "03", name: "Lead Creator", does: "Finds candidate suppliers (existing graph + web Scout discovery).", feeds: "Leads" },
  { id: "05", name: "Marketplace Re-check", does: "Re-checks public marketplace prices vs what's on file.", feeds: "Live Price Index" },
  { id: "06", name: "Enrichment", does: "Fills in lead contact/website before outreach.", feeds: "Leads" },
  { id: "04", name: "Outreach", does: "Composes outreach RFQ emails (staged, never auto-sent).", feeds: "All Threads" },
  { id: "07", name: "Escalation", does: "Opens cases for leads stale >14 days.", feeds: "Cases" },
  { id: "08", name: "Email Scanner", does: "Detects supplier replies, extracts prices into staged quotes.", feeds: "Materials / All Threads" },
  { id: "10", name: "Draft QA", does: "Lints staged drafts for placeholders / broken templates.", feeds: "All Threads (quality)" },
  { id: "11", name: "Lead Scanner CSV Push", does: "Daily per-supplier CSV handoff of dropped leads.", feeds: "Exports (paused)" },
  { id: "12", name: "Client Profile", does: "Researches and maintains the client summary.", feeds: "Client Profile" },
  { id: "13", name: "Inbox Context", does: "Reads thread state so re-quotes use a follow-up tone.", feeds: "All Threads (context)" },
  { id: "14", name: "QA Watchdog", does: "Data-integrity sweep; flags anomalies to Slack.", feeds: "— (alerts)" },
  { id: "15", name: "Reply Manager", does: "Owns the supplier conversation after a reply is detected.", feeds: "All Threads" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-2xl tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

export default function OperatorsGuidePage() {
  return (
    <div className="space-y-10 max-w-4xl">
      <ListPageHeader
        title="Operators Guide"
        description="How to work the Control Room: a day in the life, every feature, and the agents working in the background."
      />

      {/* 1. Day in the life */}
      <Section title="A day in the life">
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          <span className="font-medium">The loop:</span> agents discover suppliers and pull pricing in the background →
          you vet leads, send outreach, capture quotes, and report savings to the client. Your job is{" "}
          <span className="font-medium">review → approve → act</span> — you never start from a blank page.
        </div>
        <p className="text-sm text-muted-foreground">
          Open a client from the sidebar and you land on <strong>Overview</strong> — a scoreboard of what needs attention.
          From there you work the tabs left-to-right, which are ordered to tell a story:
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { h: "Understand the client", t: "Profile → Materials → Suppliers", d: "Who they are, what they buy, who supplies it." },
            { h: "Do the sourcing work", t: "Leads → Price Index → Threads", d: "Find suppliers, keep pricing current, run the conversation." },
            { h: "Outcomes & cleanup", t: "Savings → Cases", d: "Report the wins; handle what stalled." },
          ].map((c) => (
            <div key={c.h} className="rounded-lg border border-border p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{c.h}</div>
              <div className="mt-1 font-medium text-sm">{c.t}</div>
              <div className="mt-1 text-xs text-muted-foreground">{c.d}</div>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Every collection-driven tab shows a <span className="font-medium text-foreground">⚙ Collected by …</span> line
          so you always know which agent fed it, and a <span className="font-medium text-foreground">run ↗</span> link
          opens that agent&apos;s full activity log for QA.
        </p>
      </Section>

      {/* 2. Features & capabilities */}
      <Section title="Features &amp; capabilities — by tab">
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2 font-semibold">Tab</th>
                <th className="px-4 py-2 font-semibold">What you do here</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {TABS.map((t) => (
                <tr key={t.name} className="align-top">
                  <td className="px-4 py-3 w-44">
                    <div className="font-medium">{t.name}</div>
                    <div className="mt-0.5 text-xs italic text-muted-foreground">{t.question}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
          <li>Every list has <span className="text-foreground">search, sort, and a CSV export</span> in a consistent bar.</li>
          <li>Quotes collected from supplier replies are <span className="text-foreground">staged for review</span> — nothing writes back to Tenkara automatically; you approve, then export the Tenkara-ready CSV.</li>
          <li>The Savings report can be <span className="text-foreground">reshaped with a free-text prompt</span> and printed to PDF for the client.</li>
        </ul>
      </Section>

      {/* 3. The agent fleet */}
      <Section title="The agent fleet">
        <p className="text-sm text-muted-foreground">
          Fourteen background agents do the collecting. They run on a schedule and <strong>never write back to Tenkara</strong> —
          everything funnels to review queues where an operator makes the call.
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2 font-semibold w-16">Agent</th>
                <th className="px-4 py-2 font-semibold">What it does</th>
                <th className="px-4 py-2 font-semibold w-40">Feeds</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {AGENTS.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="px-4 py-3 font-medium tabular-nums">{a.id}</td>
                  <td className="px-4 py-3"><span className="font-medium">{a.name}</span><div className="text-xs text-muted-foreground">{a.does}</div></td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{a.feeds}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Live status and per-run logs live under <span className="text-foreground">Agents → activity</span> (admin/monitor).
        </p>
      </Section>
    </div>
  );
}
