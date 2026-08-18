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
    automatic: "Reads Tenkara quotes/materials/suppliers read-only, groups by supplier (max 15 materials per email), and drafts into the client's Tenkara inbox: replying inside the existing supplier thread when there is one, otherwise opening a new conversation. QA-linted inline, assigned to an operator (a manual assignment wins; otherwise the supplier's sticky owner from the org's email operators covering that supplier's lane, skipping anyone out of office) and mirrored to Tenkara. Uploads a CSV and posts a Slack summary. Debounces so a quote isn't re-drafted within 7 days. Only runs for orgs whose sourcing status is Active.",
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
      "Four discovery sources: the existing Tenkara supplier graph (quote history + catalogs), an Anthropic web-search scout, a direct ImportYeti US-customs pull, and a signed webhook pull from SourceReady (25 materials each per run). ImportYeti leads are staged during the run itself; SourceReady results land out of band, minutes later. The scout runs a rotating 3-of-6 scoped passes (majors, distributors, Asia, West, marketplace, retail) so successive runs cover different ground, probes each URL and drops dead links, and skips hosts it already found. ImportYeti and SourceReady advance one result page per fire off a stored cursor, so a material that was already half-ingested keeps going deeper instead of re-reading page 1 forever. Keeps sourcing a material until it has ~100 leads, then backs off; a material that goes dry three cycles is re-checked weekly. Caps at 300 new leads per run within a time budget, dedupes on supplier, canonical company name and a 90-day mirror, and flags misspelled material names. Every 6 hours it also checks each client's full material list for duplicate materials and posts the candidates to Slack. Inserts at stage=raw and emits a sourcing CSV. Runs for orgs set to Active or Sourcing only; priority-tagged materials go first.",
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
      "Reads the real product page with Anthropic web_fetch and, when the link is dead, wrong or gated, repairs it with web_search and re-fetches. Three cohorts share one run: expiring Tenkara marketplace quotes (findings written to marketplace_check_findings; an unchanged price is auto-dismissed), marketplace leads with no price yet, and priced leads due for a re-check (price, pack size, MOQ, lead time, tier ladder and checkout link written onto the lead, which is what feeds the Agent Quotes tab). Every priced lead is re-verified daily. Listings are sorted three ways, not two: checkout present is a marketplace, many suppliers and no checkout is an aggregator, one company and no checkout is a direct supplier that goes to outreach instead. An aggregator index or category page is never treated as the supplier: the sellers on it are enumerated and staged as their own leads, and the umbrella row is retired. Never fabricates or back-calculates a price: unreadable, login-walled or unconvertible listings are flagged with the reason instead. Foreign currency is detected from the page and converted to USD, and anything that can't be converted is held for review rather than published. Implausible moves (10x either way) keep the previous price on file. Operator-edited price tiers are never overwritten. It never gives up on a lead: a failed read is retried on a widening backoff (1, 3, 7, 14, 30 days) forever. A login wall or broken link opens a price-pull case on the first hit; a needs-review read opens one after 3 attempts; a temporary infrastructure error does neither. When a price finally lands, the open case closes itself with the price in the note. Runs for orgs set to Active or Sourcing only, real clients before internal test orgs.",
    humanInput: "Review pending findings and work the marketplace price-pull cases (login walls, broken links, repeated misses). You do not need to close a case once the price arrives: it closes itself. The Agent Quotes tab and the material chips surface the deltas.",
  },
  {
    number: 6,
    slug: "agent-06-enrichment",
    name: "Data Enrichment",
    status: "shipped",
    cadence: "Every 5 min · America/New_York",
    purpose: "Find a usable contact for each raw lead and promote it to enriched, or leave it blocked with a reason. Also keeps the Supplier and Quote Validation tabs filled.",
    automatic:
      "Runs as two parallel lanes every 5 minutes, 25 leads each, so 50 leads a tick. The first lane also auto-seeds and fills the supplier and quote validation profiles from leads, staged quotes, Tenkara and (for real clients) an open-web read; a field the supplier's site does not publish is recorded as not published rather than guessed, and a site that could not be reached at all is retried later instead of being written off. It then screens ImportYeti/SourceReady leads for product relevance and terminally drops mismatches. For each lead it works a contact waterfall: a per-domain memory of what that domain gave us last time, a multi-page website crawl (including impressum/kontakt/team pages), a model read of the pages when the crawl found nothing but the site did load, the Tenkara supplier record, then Hunter.io, LeadMagic, ZoomInfo and GetProspect as paid fallbacks (real clients only, and a provider that returns rate-limit or billing errors is stood down for the rest of the run). When it finds a person's name but no address, it generates the standard email patterns on that supplier's own domain, puts the likeliest one on To and the rest on CC, and labels them as guessed so you can see it before sending. It never guesses on a marketplace or platform domain. Harvests the extra contacts Agent 04 will CC. Promotes to enriched or leaves the lead at raw with a blocked reason, and leads that were promoted with no usable email are cycled back for another attempt rather than parked. It also records, without blocking anything, whether each lead meets the client's dealbreaker grade and certificate requirements. A blocked page (401/403/429) is recorded as blocked, not as no contact. Runs for orgs set to Active or Sourcing only.",
    humanInput: "On the client's Agent Supplier Leads tab, Promote an enriched lead to start outreach or Drop it with a reason. A raw lead with a blocked reason can still be promoted as an override.",
  },
  {
    number: 7,
    slug: "agent-07-escalation",
    name: "Escalation",
    status: "shipped",
    cadence: "Daily: 14:00 America/New_York",
    purpose: "Chase un-actioned work and clear out stale leads so nothing rots silently.",
    automatic: "Opens a case for each lead untouched for more than 14 days (assigned to the supplier's owning operator, skipping anyone out of office) and drops the lead as escalated_to_case; a lead already covered by an open case is dropped as a duplicate. 25 leads per run, across every org regardless of sourcing status. Separately posts one Slack nudge listing, per org, the staged drafts older than 3 days, undrafted inbound replies, and leads stuck at enriched.",
    humanInput: "Resolve the case from the client's Overview → Open cases card; act on the nudged items (send the drafts, promote the leads).",
  },
  {
    number: 8,
    slug: "agent-08-email-scanner",
    name: "Email Scanner",
    status: "shipped",
    cadence: "Continuous: inbound Tenkara webhook. There is no scheduled run; the old inbox-polling sweep has been removed.",
    purpose: "Catch supplier replies as they arrive and turn them into staged quotes, documents and a drafted response.",
    automatic:
      "Tenkara pushes each inbound message to a signed webhook, which matches it to a thread through six steps in order: the per-inquiry reply tag, the draft it answers, the conversation id, an alternate address an operator attached, the sender's domain, and finally the exact sender address. The last two only count when every candidate points at one supplier and one material. Anything unmatched raises a triage case and a review-only clarification draft; a message for an inbox that maps to no client is held as needing org assignment. It then detects bounces (every bounce alerts Slack and opens a case), auto-confirms marketplace signups, splits a marketplace seller who replies from their own address off into a direct lead, extracts prices from the reply body and attachments into staged quotes (converting currency to USD), files supplier documents with their parsed fields, updates the supplier profile, stages a referral when the supplier points us elsewhere, and drafts the reply back into the Tenkara thread with everyone who was on the original thread kept on CC. A supplier who cannot ship to the US is not a dead end: the reply asks for EXW at works plus the nearest port. Nothing about this agent is on a timer: the webhook is the whole agent, and its scheduled inbox sweep was deleted.",
    humanInput: "Review the extracted quotes on the client's Agent Quotes tab and the drafted reply in the Tenkara inbox, then send.",
  },
  {
    number: 9,
    slug: "agent-09-document-retrieval",
    name: "Document Retrieval",
    status: "shipped",
    cadence: "Hourly at :50",
    purpose: "Collect the qualification documents (SDS, CoA, TDS, certificates) suppliers already publish, so we ask them for fewer.",
    automatic:
      "Visits the supplier and product pages we already have on file (quote sources, active leads, marketplace findings), finds linked documents, and stores the actual file rather than just the link, because suppliers replace files at the same URL and captured links die quickly. Each document is recorded as supplier-issued or a third-party reference copy: an emailed attachment is always supplier-issued, and a web-retrieved file counts as issued when it sits on the supplier's own domain or storefront. It then ticks off the client's document requirements, but only where both the supplier and the material match the document, and only ever from missing to met: un-ticking stays manual. Pages that yield nothing are recorded with the reason so they are not re-crawled for 60 days. 40 pages per run, real clients first. Never emails. Runs for orgs set to Active or Sourcing only.",
    humanInput:
      "Review the documents on the Agent Supplier Leads tab and the quote card; correct any mis-parsed field (your correction is stored separately and survives a re-parse). Expect a low hit rate: most supplier pages publish nothing, and that is the shape of the work, not a fault.",
  },
  {
    number: 10,
    slug: "agent-10-qa-outreach",
    name: "Draft QA",
    status: "shipped",
    cadence: "Inline, every time a draft is staged (02 / 04 / 15 / the inbound webhook). The catch-up sweep is manual-only.",
    purpose: "Lint every outgoing draft before an operator ever sees it.",
    automatic:
      "Eight checks: leftover placeholders in the body, leftover placeholders in the subject, a missing operator, an empty body, misspelled material names, ghost-brand leaks, fabricated contact details, and copy that widens a grade the client marked as a dealbreaker. Findings are written onto the draft. Two of them are hard blocks: fabricated contact details, and a widened grade ask. On either, no draft is created at all, the record is marked blocked, and Slack is alerted. The other six annotate the draft without stopping it, so an error finding does not necessarily mean the draft was withheld.",
    humanInput:
      "Read the QA findings before sending a draft, and fix any errors first. A draft blocked for a contact needs that contact verified (or whitelisted); a draft blocked for a widened grade ask needs the copy to ask for the required grade only, without offering the supplier a nearby one.",
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
    purpose: "Keep each client's own details in sync, re-judge their leads when their requirements change, and summarize who they are so clients are identifiable at a glance.",
    automatic:
      "Three jobs each run. First it mirrors every client's Tenkara settings (ship-to and billing addresses, units, excluded countries, qualification requirements) into the ops database, which is how a supplier reply can state the correct ship-to. Second, when a client's requirements change, it re-judges that client's existing leads against the new requirements: a pure recompute from evidence already on file, so nothing is dropped, re-staged or re-contacted, and no credits are spent. Expect a large number of leads to change grading after a settings edit; that is intended. Third it researches the client on the open web, combines that with their Tenkara data, the settings ops entered and uploaded documents, and writes the summary, highlights, sources, supplier rep sheet and client type. The profile runs on demand, whenever client settings are saved or a document is uploaded, and as an hourly backstop that refreshes up to 3 profiles older than a week. A profile an operator has edited is never auto-overwritten. Writes ops-side only; never emails.",
    humanInput: "Click Generate on the client's Client Profile tab, upload any extra info, and edit the summary if something's wrong (your edit is preserved until you regenerate).",
  },
  {
    number: 13,
    slug: "agent-13-inbox-context",
    name: "Inbox Context",
    status: "shipped",
    cadence: "Daily: 06:45 America/New_York",
    purpose: "Build a per-supplier email-context row (thread state, last contact, open ask) so Agent 02 reaches out with the right tone and callers know where the thread stands before they dial.",
    automatic: "Takes the list of Tenkara threads we have drafted into over the last 90 days, reads each conversation, and works out where it stands: they replied and owe us nothing, we are waiting on them, or the thread has gone quiet for 3 weeks. For threads where the supplier replied it summarizes the open ask, otherwise it falls back to the last message. Writes one row per supplier email. Read-only on Tenkara; never drafts or sends.",
    humanInput: "None. The output shapes the tone of Agent 02's follow-ups and fills the \"From the inbox\" panel on every Call Tracker row, read live when the row is opened.",
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
    purpose: "Catch supplier replies the webhook never delivered, chase every unanswered email (both suppliers who never replied and those who replied then went quiet), and raise the calls in the cadence.",
    automatic:
      "Three jobs, in order. First it re-reads the Tenkara threads we are tracking, on a cadence based on how recently each was active, and replays any inbound message that never reached the webhook, so a reply cannot be lost because a single delivery failed. It takes the newest unseen message from each sender, and still files the attachments on older ones. Second, it chases silence. For threads with genuinely no reply it stages two nudges, on day 2 and day 4 counting from the day the sourcing inquiry went out. For threads where the supplier replied and then went quiet mid-conversation, it chases on the same day 2 and day 4 rhythm counting from OUR last message, then widens to a week, a fortnight and finally monthly, and it never stops: an unanswered email is only ever chased more slowly, never abandoned. That second sequence ends only on a real ending, meaning the supplier declined, the quote was captured or finalised, or our own last message closed the conversation out with nothing left for them to answer. Third, it raises the call tasks: an intro call on day 1 (whether or not they replied) and a second call on day 5 (only if they still have not), each landing on the client's Call Tracker tab with the number, the supplier's calling window in their timezone, a summary of what we emailed and what the inbox says back, and what to ask for. Every offset is measured from the send date, so a nudge sent late cannot drag the phone work with it. A nudge is held back when one of our own drafts is still sitting unsent in the outbox, when the supplier is the one waiting on us, when the first email was never actually sent, or when the client is not Active. Everything is staged in the Tenkara thread; it never sends. Handling of replies that DID arrive lives on the Tenkara inbound webhook (Agent 08), not here: a scheduled agent can't react to a message, and this one exists to act on the message that never came.",
    humanInput:
      "Review the staged nudge in the Tenkara inbox and send it. Work the Call Tracker: log each call's outcome, and close the task by sending the supplier back into the email loop (with what came out of the call) or dropping them with a reason when they never came back on either channel. Track each thread to a captured price on the Pricing pipeline board. If a nudge did not go out, check whether the previous one is still unsent: that suppresses the next one on purpose.",
  },
  {
    number: 16,
    slug: "agent-16-fx-refresh",
    name: "FX Refresh",
    status: "shipped",
    cadence: "Every 6 hours at :05 · America/New_York",
    purpose: "Keep published USD prices honest when the exchange rate moves, not just when the supplier changes their price.",
    automatic:
      "Every price we capture in a foreign currency is stored in that currency alongside its USD figure and the rate used. When rates move, this restates the USD figures on leads and staged quotes from the original native price. Arithmetic only: no scraping, no supplier contact, no re-reading a page. A price change caused by currency is recorded as currency-driven and does not count as the supplier changing their price, so the price-change date on a lead still means what it says.",
    humanInput: "None. On the price views, a move attributed to currency is not a supplier move; treat only supplier-driven changes as negotiating signal.",
  },
  {
    number: 20,
    slug: "agent-20-duplicate-guard",
    name: "Duplicate Guard",
    status: "shipped",
    cadence: "Every 20 minutes · America/New_York",
    purpose: "Stop the same supplier being created twice in Tenkara.",
    automatic:
      "Tenkara turns our enriched leads into supplier records every hour, and skips a lead whose name or website it already has. That website check switches itself off as soon as one domain carries two different names, which is exactly what a duplicate looks like: already holding \"Tronox\" lets \"Tronox France\" through. This agent reads the client's existing suppliers, finds the leads that would slip through, and parks them where Tenkara does not look, so the second record is never created. A marketplace listing and a direct relationship for one company are a deliberate pair and are left alone, and a shared directory address (Alibaba, LinkedIn) is not treated as a match because the companies listed there are unrelated.",
    humanInput:
      "Each parked lead raises an escalation on the client's Supplier Leads tab naming the supplier we already have. Drop the lead if it is the same company, or send it back to Enriched if it is genuinely different. A parked lead sends no outreach until you decide.",
  },
  {
    number: 22,
    slug: "agent-22-operator-email-outreach",
    name: "Operator Email Outreach",
    status: "shipped",
    cadence: "Hourly at :30 · Asia/Manila",
    purpose: "Make sure an email an operator hand-added actually gets used.",
    automatic:
      "When an operator finds a supplier contact and types it in, that address is a human judgement about who can quote the material. The main outreach agent was dropping a large share of them, because it is built to open exactly one cold thread per supplier and refuses a second. This agent picks those hand-added addresses up and acts on all three cases it was refusing. If we already have a thread open with that company, the new person is added to it rather than thrown away. If someone else happens to use the same free mailbox provider (the shared consumer inboxes common with Chinese suppliers), that is no longer read as \"we already emailed them\", which had been collapsing sixteen unrelated suppliers onto five addresses. And if the lead is parked over a question about a duplicate supplier record, the material inquiry still goes out while that record question stays exactly as parked as it was.",
    humanInput:
      "Everything it produces is a draft in the normal review queue, never an auto-send. Each draft records who added the address and when, so you can see whose call it was before you send.",
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
