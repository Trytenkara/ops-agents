import { ListPageHeader } from "@/components/list-page-header";

export const dynamic = "force-dynamic";

// Operators Guide — a single in-app reference: how an operator works the app
// day-to-day, what every tab/feature does, and the background agent fleet.

const TABS: { name: string; question: string; does: string; agents: string }[] = [
  {
    name: "Overview",
    question: "What needs my attention?",
    does: "Six metric cards (new leads, drafts to send, quotes to approve, price changes, open cases, pending approvals), each linking to where you act on it. Open cases is also the only way into this client's Cases list. The Sourcing card holds the client's sourcing status (Active / Sourcing only / Off) and its Tenkara inbox.",
    agents: "Agent 07 (Escalation) opens the cases",
  },
  {
    name: "Client Profile",
    question: "Who is this client?",
    does: "Contact (purchasing email, priority contact), supplier rep sheet, an AI-written summary, and a Documents box: upload any PDF/spreadsheet/CSV and it's parsed into the summary. Saving settings or uploading a file re-runs the research; your own edits are kept until you regenerate.",
    agents: "Agent 12 (Client Profile)",
  },
  {
    name: "Platform Data",
    question: "What do they buy, and who supplies it today?",
    does: "The client's Tenkara data, in two sub-tabs. Materials: every material with a sourcing chip (Not started → Sourcing → Outreach sent → Quotes in → Sourced / Above client) and a Leads/Drafted/Sent/Quotes funnel; expand a row for collected quotes (approve or dismiss inline), uploaded POs and approvals. Suppliers: their existing suppliers grouped Approved / Pending / Denied, read-only.",
    agents: "Agent 08 (Email Scanner) extracts quotes from supplier replies; suppliers sync from Tenkara",
  },
  {
    name: "Agent Supplier Leads",
    question: "Who else could we source from?",
    does: "Newly discovered suppliers. The pipeline row across the top (Raw · Enriched · Ready to send · Held for review) shows where they are; sub-tabs cover Supplier Validation, All leads, Marketplace pricing, Outreach, Supplier Escalations and Dropped. Promote the good ones to outreach or drop them, bulk-upload a supplier CSV, and use the run ↗ link to open the agent log that created a lead.",
    agents: "Agent 03 (Lead Creator) + Agent 06 (Enrichment) + Agent 04 (Outreach)",
  },
  {
    name: "Agent Quotes",
    question: "Is the pricing real, and is it still current?",
    does: "Quotes Validation for the details behind each collected quote, Marketplace prices for public listings (On file / Current / Δ / Updated, grouped into per-material tier ladders), Direct prices for supplier-quoted numbers, and Quotes Escalations for what needs a human. Approve a refresh or open the re-quote.",
    agents: "Agent 05 (Marketplace Re-check) + Agent 02 (Revalidation)",
  },
  {
    name: "Email Thread Tracker",
    question: "What's the conversation so far?",
    does: "Every outreach email and supplier reply, filterable by outbound / inbound. One thread per supplier, with every contact for that supplier CC'd on it. Open a draft to review and send; the full back-and-forth is logged here.",
    agents: "Agent 04 (Outreach) + Agent 08 (Email Scanner) + Agent 15 (Reply Manager)",
  },
  {
    name: "Cost Savings and Reports",
    question: "What did we save them?",
    does: "A Worksheet view for ops and a branded, client-facing savings report (PDF export, custom-prompt reshaper, optional freight/landed-cost toggle). Materials without a client price benchmark against the market average.",
    agents: "— (computed from the quote corpus)",
  },
];

const AGENTS: { id: string; name: string; does: string; feeds: string }[] = [
  { id: "01", name: "Ping", does: "Infrastructure heartbeat: verifies the fleet is alive.", feeds: "—" },
  { id: "02", name: "Quote Revalidation", does: "Drafts re-quote emails for expiring and expired quotes, one per supplier.", feeds: "Agent Quotes · Direct prices" },
  { id: "03", name: "Lead Creator", does: "Finds candidate suppliers: the existing supplier graph, a rotating web scout, ImportYeti and SourceReady.", feeds: "Agent Supplier Leads · Raw" },
  { id: "06", name: "Enrichment", does: "Works the contact waterfall (site crawl → Tenkara → paid providers) and seeds the validation profiles. With a name but no address it builds the standard patterns on the supplier's own domain and labels them guessed.", feeds: "Agent Supplier Leads · Enriched" },
  { id: "04", name: "Outreach", does: "Composes the first sourcing email per supplier, CC'ing every contact on one thread. Staged, never auto-sent.", feeds: "Email Thread Tracker" },
  { id: "05", name: "Marketplace Re-check", does: "Reads the live product page for current pricing and tier ladders; flags anything it cannot read rather than guessing. Splits an aggregator index page into one lead per seller, and closes its own price-pull case once a price lands.", feeds: "Agent Quotes · Marketplace prices" },
  { id: "07", name: "Escalation", does: "Opens cases for leads stale >14 days and nudges Slack about work waiting on you.", feeds: "Overview · Open cases" },
  { id: "08", name: "Email Scanner", does: "Handles inbound supplier replies from the Tenkara webhook: extracts prices, files documents, stages a response.", feeds: "Platform Data · Materials / Email Thread Tracker" },
  { id: "09", name: "Document Retrieval", does: "Collects the SDS, CoA, TDS and certificates suppliers already publish on their own pages, and ticks off the client's document requirements it can evidence.", feeds: "Agent Supplier Leads · documents" },
  { id: "10", name: "Draft QA", does: "Lints every draft as it is staged. Two findings hard-block it: an unverified contact detail, and copy that invites a grade other than the one the client marked a dealbreaker.", feeds: "Email Thread Tracker (quality)" },
  { id: "11", name: "Lead Scanner CSV Push", does: "Per-supplier CSV handoff of dropped leads. Built, currently kill-switched.", feeds: "Exports (paused)" },
  { id: "12", name: "Client Profile", does: "Researches and maintains the client summary and rep sheet, mirrors the client's Tenkara settings (ship-to, exclusions, requirements), and re-judges existing leads when those requirements change.", feeds: "Client Profile" },
  { id: "13", name: "Inbox Context", does: "Reads our Tenkara threads and records where each supplier conversation stands.", feeds: "02" },
  { id: "14", name: "QA Watchdog", does: "Data-integrity sweep; flags what fell through the cracks to Slack.", feeds: "— (alerts)" },
  { id: "15", name: "Reply Manager", does: "Chases the threads that went quiet: two nudges then a calling escalation. Also re-reads tracked threads to recover any supplier reply the webhook never delivered. Replies themselves are handled by Agent 08.", feeds: "Email Thread Tracker" },
  { id: "16", name: "FX Refresh", does: "Restates published USD prices from the stored native price when exchange rates move, so a currency swing is never mistaken for a supplier price change.", feeds: "Agent Quotes · prices" },
  { id: "—", name: "Fleet Summary", does: "Daily digest of how every agent ran.", feeds: "— (Slack)" },
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
            { h: "Understand the client", t: "Client Profile → Platform Data", d: "Who they are, what they buy, who supplies it today." },
            { h: "Do the sourcing work", t: "Agent Supplier Leads → Agent Quotes → Email Thread Tracker", d: "Vet suppliers, keep pricing current, run the conversation." },
            { h: "Outcomes & cleanup", t: "Cost Savings and Reports → Cases", d: "Report the wins; handle what stalled." },
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
          These agents do the collecting. They run on a schedule and <strong>never write back to Tenkara</strong>: everything
          funnels to review queues where an operator makes the call. They also never invent data: an unreadable price comes
          back flagged with its reason instead of a plausible-looking number, and a draft that states a contact detail we
          could not verify is blocked before it is created. The one deliberate exception is labelled as such: where we have a
          person&apos;s name but no address, enrichment builds the standard email patterns on that supplier&apos;s own domain
          (never a marketplace domain) and marks them <span className="text-foreground">guessed</span>, so you can see what is
          confirmed and what is a best guess before you send. Which agents touch a client depends on that client&apos;s
          sourcing status, set on its Overview tab.
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
