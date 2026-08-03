// Human-readable spec for each agent. Surfaced on /how-it-works, in the Operators
// Guide, and inside the Ops assistant's runbook knowledge.
// Cadences mirror `agents.schedule_cron` in the OA database: that table is
// authoritative; update both together.

export interface AgentSpec {
  // null for the unnumbered fleet-summary agent.
  number: number | null;
  slug: string;
  name: string;
  // paused = built and deployed, but not currently doing work (kill switch or
  // superseded by another path).
  status: "shipped" | "paused" | "deferred";
  cadence: string;
  purpose: string;
  automatic: string;
  humanInput: string;
}

export function agentLabel(a: AgentSpec): string {
  return a.number == null ? a.name : `Agent ${String(a.number).padStart(2, "0")} — ${a.name}`;
}

export const AGENT_SPECS: AgentSpec[] = [
  {
    number: 1,
    slug: "agent-01-ping",
    name: "Ping",
    status: "shipped",
    cadence: "Every minute · America/New_York",
    purpose: "Infrastructure heartbeat. Confirms the agent runtime is reachable end-to-end.",
    automatic: "Logs three heartbeats and records a run. No business logic. The only agent exempt from the training-wheels kill switch.",
    humanInput: "None. Surface only if it stops appearing in the Agent activity feed.",
  },
  {
    number: 2,
    slug: "agent-02-revalidation",
    name: "Quote Revalidation",
    status: "shipped",
    cadence: "Daily: 07:10 America/New_York",
    purpose: "Sweep expiring/expired quotes across every active client and stage one re-quote email per (client × supplier).",
    automatic: "Reads Tenkara quotes/materials/suppliers read-only, groups by supplier (max 15 materials per email), and drafts into the client's Tenkara inbox: replying inside the existing supplier thread when there is one, otherwise opening a new conversation. QA-linted inline, assigned to an operator (manual assignment first, then the org's primary/backup, skipping anyone out of office) and mirrored to Tenkara. Uploads a CSV and posts a Slack summary. Debounces so a quote isn't re-drafted within 7 days. Only runs for orgs whose sourcing status is Active.",
    humanInput: "Review each staged draft in the Tenkara inbox, edit if needed, click Send. Nothing leaves the building automatically.",
  },
  {
    number: 3,
    slug: "agent-03-lead-creator",
    name: "Lead Creator",
    status: "shipped",
    cadence: "Every minute · America/New_York",
    purpose: "Scout suppliers for the client's materials and stage them as raw leads. Enrichment (06) and outreach (04) run as their own scheduled agents.",
    automatic:
      "Four discovery sources: the existing Tenkara supplier graph (quote history + catalogs), an Anthropic web-search scout, and signed webhook pulls from ImportYeti and SourceReady (25 materials each per run; their results land out of band, minutes later). The scout runs a rotating 3-of-6 scoped passes (majors, distributors, Asia, West, marketplace, retail) so successive runs cover different ground, probes each URL and drops dead links, and skips hosts it already found. Keeps sourcing a material until it has ~100 leads, then backs off; a material that goes dry three cycles is re-checked weekly. Caps at 300 new leads per run within a time budget, dedupes on supplier, canonical company name and a 90-day mirror, and flags misspelled material names. Inserts at stage=raw and emits a sourcing CSV. Runs for orgs set to Active or Sourcing only; priority-tagged materials go first.",
    humanInput: "Download the sourcing CSV for the supplier index; Promote/Drop leads on the client's Agent Supplier Leads tab.",
  },
  {
    number: 4,
    slug: "agent-04-outreach",
    name: "Outreach",
    status: "shipped",
    cadence: "Every 5 min · America/New_York",
    purpose: "Compose the first outreach email for enriched leads, stage it (QA-linted), and advance the lead to ready_for_outreach.",
    automatic:
      "Sweeps enriched leads and sends ONE email per supplier covering that supplier's materials: the top 3 by confidence go in the first email and the rest are held back for the reply loop. Every contact found for that supplier rides the same thread (primary on To, the rest on CC), reserved atomically so no address is emailed twice. Drafts with Anthropic against a deterministic template fallback, gives each thread a unique reference, QA-lints inline, mirrors the operator assignment to Tenkara, and stages into the client's Tenkara inbox. Never sends. Cap 5 drafts per run, and real clients are served before internal test orgs. Holds a supplier back for a pending spelling flag, a sibling material still enriching, an existing Tenkara relationship, an excluded country or do-not-contact, or equipment rather than material; low-trust marketplace leads divert to ready_for_approval instead. Only runs for orgs whose sourcing status is Active.",
    humanInput: "Review each draft in the Tenkara inbox, edit, click Send manually.",
  },
  {
    number: 5,
    slug: "agent-05-marketplace-validation",
    name: "Marketplace Price Re-check",
    status: "shipped",
    cadence: "Hourly at :20 · America/New_York",
    purpose: "Keep public marketplace pricing current: both on Tenkara quotes coming up for reanalysis and on marketplace leads in the sourcing pipeline.",
    automatic:
      "Reads the real product page with Anthropic web_fetch and, when the link is dead, wrong or gated, repairs it with web_search and re-fetches. Two passes: expiring Tenkara marketplace quotes (findings written to marketplace_check_findings; an unchanged price is auto-dismissed) and marketplace leads (price, pack size, MOQ, lead time, tier ladder and checkout link written onto the lead, which is what feeds the Agent Quotes tab). Checkout presence is the marketplace test: a price with no checkout is recorded as not a marketplace. Never fabricates or back-calculates a price: unreadable, login-walled or unconvertible listings are flagged with the reason instead. Foreign currency is detected from the page and converted to USD, and anything that can't be converted is held for review rather than published. Implausible moves (10x either way) keep the price on file. Operator-edited price tiers are never overwritten. After 3 failed attempts it opens a manual-pull case. Runs for orgs set to Active or Sourcing only, real clients before internal test orgs.",
    humanInput: "Review pending findings and work the marketplace price-pull cases (login walls, broken links, repeated misses). The Agent Quotes tab and the material chips surface the deltas.",
  },
  {
    number: 6,
    slug: "agent-06-enrichment",
    name: "Data Enrichment",
    status: "shipped",
    cadence: "Every 5 min · America/New_York",
    purpose: "Find a usable contact for each raw lead and promote it to enriched, or leave it blocked with a reason. Also keeps the Supplier and Quote Validation tabs filled.",
    automatic:
      "Every run first auto-seeds the supplier and quote validation profiles from leads, staged quotes and marketplace pulls (real clients first), then screens ImportYeti/SourceReady leads for product relevance and terminally drops mismatches. For each raw lead it works a contact waterfall: multi-page website scrape (own-domain addresses only), then the Tenkara supplier record, then Hunter.io, LeadMagic, ZoomInfo and GetProspect as paid fallbacks, and harvests the extra contacts Agent 04 will CC. Promotes to enriched or leaves the lead at raw with a blocked reason. Marketplace leads of unverified ownership are confidence-downranked. Oldest-attempt-first, 25 leads per run inside a wall-clock deadline. Runs for orgs set to Active or Sourcing only.",
    humanInput: "On the client's Agent Supplier Leads tab, Promote an enriched lead to start outreach or Drop it with a reason. A raw lead with a blocked reason can still be promoted as an override.",
  },
  {
    number: 7,
    slug: "agent-07-escalation",
    name: "Escalation",
    status: "shipped",
    cadence: "Daily: 14:00 America/New_York",
    purpose: "Chase un-actioned work and clear out stale leads so nothing rots silently.",
    automatic: "Opens a case for each lead untouched for more than 14 days (assigned to the org's primary operator, or the backup if they're out of office) and drops the lead as escalated_to_case; a lead already covered by an open case is dropped as a duplicate. 25 leads per run, across every org regardless of sourcing status. Separately posts one Slack nudge listing, per org, the staged drafts older than 3 days, undrafted inbound replies, and leads stuck at enriched.",
    humanInput: "Resolve the case from the client's Overview → Open cases card; act on the nudged items (send the drafts, promote the leads).",
  },
  {
    number: 8,
    slug: "agent-08-email-scanner",
    name: "Email Scanner",
    status: "shipped",
    cadence: "Continuous: inbound Tenkara webhook (the scheduled 30-min sweep is a no-op unless Missive polling is switched back on)",
    purpose: "Catch supplier replies as they arrive and turn them into staged quotes, documents and a drafted response.",
    automatic:
      "Tenkara pushes each inbound message to a signed webhook, which matches it to a thread by draft, then conversation, then a known alternate address, then sender domain: anything unmatched raises a triage case. It detects bounces, auto-confirms marketplace signups, extracts prices from the reply body and attachments into staged quotes (converting currency to USD), files supplier documents with their parsed fields, updates the supplier profile, and stages a reply draft back into the Tenkara thread. The older poll-the-inbox path is retired and skips itself.",
    humanInput: "Review the extracted quotes on the client's Agent Quotes tab and the drafted reply in the Tenkara inbox, then send.",
  },
  {
    number: 9,
    slug: "agent-09-doc-refresh",
    name: "Doc Refresh",
    status: "deferred",
    cadence: "Not scheduled",
    purpose: "Compose drafts asking suppliers to refresh out-of-date specs/COAs.",
    automatic: "Not built. Document requests are currently handled inside Agent 15's qualification ask.",
    humanInput: "n/a",
  },
  {
    number: 10,
    slug: "agent-10-qa-outreach",
    name: "Draft QA",
    status: "shipped",
    cadence: "Inline, every time a draft is staged (02 / 04 / 15 / the inbound webhook). The catch-up sweep is manual-only.",
    purpose: "Lint every outgoing draft before an operator ever sees it.",
    automatic: "Checks for leftover placeholders in the body or subject, a missing operator, an empty body, misspelled material names, ghost-brand leaks, and fabricated contact details. Findings are written onto the draft. A fabricated-contact finding is a hard block: no draft is created at all, the record is marked blocked, and Slack is alerted.",
    humanInput: "Read the QA findings before sending a draft, and fix any errors first. A blocked draft needs the contact verified (or whitelisted) before it can go out.",
  },
  {
    number: 11,
    slug: "agent-11-lead-scanner-csv-push",
    name: "Lead Scanner CSV Push",
    status: "paused",
    cadence: "Built and scheduled for 09:00 America/New_York, but currently held by the training-wheels kill switch",
    purpose: "Per-supplier CSV handoff so dropped leads land back in the supplier graph.",
    automatic: "Groups dropped/terminal leads by supplier, skips thin low-confidence batches, uploads a CSV with a 7-day signed link, and posts it to the ops Slack channel. 7-day dedup per supplier. An export nobody acknowledges within 72 hours is marked failed and re-alerted.",
    humanInput: "Pick the CSV up from Slack and load it. There is no in-app acknowledgement step: an unworked export just re-alerts after 72 hours.",
  },
  {
    number: 12,
    slug: "agent-12-client-profile",
    name: "Client Profile",
    status: "shipped",
    cadence: "Hourly at :40 · America/New_York (stale-profile backstop) + on demand",
    purpose: "Research each client and summarize a profile: who they are, what they source, how to work with them, so clients are identifiable at a glance.",
    automatic: "Combs the open web and combines it with the client's Tenkara data, the settings ops entered, and uploaded documents, then writes the summary, highlights, sources, supplier rep sheet and client type. Runs on demand, whenever client settings are saved or a document is uploaded, and as an hourly backstop that refreshes up to 3 profiles older than a week. A profile an operator has edited is never auto-overwritten. Writes ops-side only; never emails.",
    humanInput: "Click Generate on the client's Client Profile tab, upload any extra info, and edit the summary if something's wrong (your edit is preserved until you regenerate).",
  },
  {
    number: 13,
    slug: "agent-13-inbox-context",
    name: "Inbox Context",
    status: "paused",
    cadence: "Daily: 06:45 America/New_York, but a no-op since the Tenkara cutover",
    purpose: "Build a per-supplier email-context row (thread state, last contact, open ask) so Agent 02 reaches out with the right tone.",
    automatic: "Skips itself immediately: it reads the old Missive inbox, which is no longer the email path. Supplier email context is therefore no longer being refreshed, and Agent 02's follow-up tone falls back to whatever was last written.",
    humanInput: "None. Rebuilding this on the Tenkara thread history is outstanding work.",
  },
  {
    number: 14,
    slug: "agent-14-qa-watchdog",
    name: "QA Watchdog",
    status: "shipped",
    cadence: "Daily: 16:00 America/New_York",
    purpose: "Data-integrity sweep over the other agents' outputs, catching things that silently fell through the cracks.",
    automatic: "Scans for replies detected but never drafted, staged quotes missing a price or material, low-confidence or stale review items, marketplace findings pending review for more than a week, and agent failures in the last 24 hours, then posts a Slack digest, but only when there is something to report. Read-only; never mutates data.",
    humanInput: "Act on the flagged issues from the Slack digest (draft the missed reply, fix the incomplete quote, review the stale item).",
  },
  {
    number: 15,
    slug: "agent-15-reply-manager",
    name: "Supplier Reply Manager",
    status: "shipped",
    cadence: "Every 5 min · America/New_York",
    purpose: "Own the supplier conversation after the first email: chase silence, and once a supplier replies, keep the thread going until a price is captured.",
    automatic:
      "For threads with no reply, it sends two nudges (roughly 4 and 8 days out), pulling in any supplier contacts not yet reached, then opens a calling-escalation case. For threads that did reply, it classifies the response and drafts the right next message: answering a question, reframing a no-record reply as a fresh pricing ask, or chasing the missing number, and always asks for EXW and tiered pricing plus whatever qualification documents that client requires. Bounces are recorded and, past two in a day, raise a Slack alert and a case; a supplier who sends a web form or asks for information we don't have is handed to a human. Replies from a different address than the one we wrote to update the contact. Everything is staged in the Tenkara thread; it never sends. Skipped entirely for orgs whose sourcing status isn't Active.",
    humanInput: "Review the staged reply in the Tenkara inbox and send it. Work the calling escalations, bounce alerts and supplier-form cases. Track each thread to a captured price on the Pricing pipeline board.",
  },
  {
    number: null,
    slug: "agent-fleet-summary",
    name: "Fleet Summary",
    status: "shipped",
    cadence: "Daily: 18:00 America/New_York",
    purpose: "One daily digest of how the whole fleet ran.",
    automatic: "Totals the last 24 hours of runs per agent and posts the digest to Slack with a link to System health.",
    humanInput: "Skim it; dig into /agents/health if an agent looks quiet or is failing.",
  },
];
