// Human-readable spec for each agent. Source: docs/AGENTS-OVERVIEW.md.
// Surfaced on /how-it-works. Keep in sync with the OA `agents` table.

export interface AgentSpec {
  number: number;
  slug: string;
  name: string;
  status: "shipped" | "deferred";
  cadence: string;
  purpose: string;
  automatic: string;
  humanInput: string;
}

export const AGENT_SPECS: AgentSpec[] = [
  {
    number: 1,
    slug: "agent-01-ping",
    name: "Ping",
    status: "shipped",
    cadence: "Every 5 min · America/New_York",
    purpose: "Infrastructure heartbeat. Confirms the agent runtime is reachable end-to-end.",
    automatic: "POSTs to the run-recording endpoint and writes a row to agent_runs. No business logic.",
    humanInput: "None. Surface only if it stops appearing in Activity feed.",
  },
  {
    number: 2,
    slug: "agent-02-revalidation",
    name: "Quote Revalidation",
    status: "shipped",
    cadence: "Daily — 07:00 America/New_York",
    purpose: "Sweep expiring/expired quotes across every Tenkara client and stage one outreach draft per (client × supplier).",
    automatic: "Reads Tenkara quotes/materials/suppliers, classifies clients as active vs ghost, drafts emails in Missive (QA-linted inline), uploads a CSV, posts a Slack summary. Debounces so a quote isn't re-drafted within 7 days.",
    humanInput: "Review each staged draft in Missive, edit if needed, click Send. Nothing leaves the building automatically.",
  },
  {
    number: 3,
    slug: "agent-03-lead-creator",
    name: "Lead Creator",
    status: "shipped",
    cadence: "Every 2 hours, 07:00–21:00 · America/New_York",
    purpose: "Drive the lead pipeline: discover suppliers for new materials, enrich them, and stage outreach — the single scheduled driver for Agents 06 and 04.",
    automatic: "Each run drains the existing backlog (enriches raw leads via Agent 06, then lets Agent 04 draft the enriched ones), then scouts suppliers for newly-added materials (graph + web), then emits a downloadable sourcing CSV. Budget-bounded; leftovers roll to the next run.",
    humanInput: "Review staged outreach drafts and send in Missive; download the sourcing CSV for the supplier index. Promote/Drop leads on /work/review/leads.",
  },
  {
    number: 4,
    slug: "agent-04-outreach",
    name: "Outreach",
    status: "shipped",
    cadence: "Called by Agents 02/03/08 — not independently scheduled",
    purpose: "Shared outreach drafter. Composes the email and stages it (QA-linted) for a lead, then promotes it to ready_for_outreach.",
    automatic: "Given an enriched lead, composes the Missive draft, runs the QA lint inline, records a draft_references row, advances to stage=ready_for_outreach. Never sends. Invoked by Agent 03's drive; also runnable manually for backfill.",
    humanInput: "Review each Missive draft, edit, click Send manually. The from-address is left empty so you can pick the right sender.",
  },
  {
    number: 5,
    slug: "agent-05-marketplace-validation",
    name: "Marketplace Validation",
    status: "shipped",
    cadence: "Daily · 07:00 America/New_York",
    purpose: "Re-verify catalog-match leads against Tenkara's current supplier catalogs.",
    automatic: "Reads leads with signal=catalog_match, checks supplier_catalog_materials, flags payload.catalog_drift='no_longer_listed' when a supplier has dropped the material.",
    humanInput: "Review flagged leads on /work/review/leads — drop ones whose drift signal makes them no longer worth pursuing.",
  },
  {
    number: 6,
    slug: "agent-06-enrichment",
    name: "Data Enrichment",
    status: "shipped",
    cadence: "Called by Agent 03 — not independently scheduled",
    purpose: "Shared enrichment step. Promotes raw leads to enriched, or marks them blocked with a reason.",
    automatic: "Reads top 25 stage=raw leads by confidence, merges Tenkara supplier metadata, sets supplier_phone / country / completeness_score. Promotes to stage=enriched or leaves at raw with payload.enrichment_blocked_reason.",
    humanInput: "On /work/review/leads, click Promote on an enriched lead to hand it to Agent 04, or click Drop with a reason if it shouldn't be pursued. Raw-with-blocked-reason leads can be promoted as an override when you want to contact anyway.",
  },
  {
    number: 7,
    slug: "agent-07-escalation",
    name: "Escalation",
    status: "shipped",
    cadence: "Daily — 14:00 America/New_York",
    purpose: "Chase un-actioned work and own stale leads. Opens cases for >14d-stale leads AND nudges ops about items waiting on them.",
    automatic: "Opens a cases row for >14d-stale leads (assigned to the org's primary/backup operator). Separately posts a Slack nudge per org about items pending >3d — staged drafts not sent, reply drafts not sent, leads stuck at enriched.",
    humanInput: "Resolve the case on the org page; act on the nudged items (send the drafts, promote the leads).",
  },
  {
    number: 8,
    slug: "agent-08-email-scanner",
    name: "Email Scanner",
    status: "shipped",
    cadence: "Every 30 min · America/New_York",
    purpose: "Detect supplier replies (by sender email, not thread ID) and draft a response for the operator to review.",
    automatic: "Scans the Missive team inbox, matches sender against supplier_contact_email, stamps reply_detected, then composes a contextual reply and stages it (QA-linted, deduped). Never sends.",
    humanInput: "Review the drafted reply and send it in Missive.",
  },
  {
    number: 9,
    slug: "agent-09-doc-refresh",
    name: "Doc Refresh",
    status: "deferred",
    cadence: "Not yet scheduled",
    purpose: "Compose Missive drafts asking suppliers to refresh out-of-date specs/COAs.",
    automatic: "Not built yet — deferred until the E2E pass for the rest of the fleet is done, so the test signal for Agent 08 stays clean.",
    humanInput: "n/a (will mirror Agent 02's draft-and-send-by-human pattern once shipped).",
  },
  {
    number: 10,
    slug: "agent-10-qa-outreach",
    name: "QA Outreach",
    status: "shipped",
    cadence: "Called inline when 02/03/08 stage a draft — not independently scheduled",
    purpose: "Lint drafts for placeholders, missing operators, empty bodies, and ghost-mode brand leaks.",
    automatic: "Runs at draft-creation time inside the shared staging pipeline, writing findings to draft_references.metadata.qa_findings. Does not change draft status.",
    humanInput: "Check qa_findings on /work/review/drafts before sending a draft — fix any errors first.",
  },
  {
    number: 11,
    slug: "agent-11-lead-scanner-csv-push",
    name: "Lead Scanner CSV Push",
    status: "deferred",
    cadence: "Paused",
    purpose: "Daily per-supplier CSV handoff to Andrew (Tenkara eng) so dropped leads land back in the supplier graph.",
    automatic: "Reads dropped/terminal leads, groups by supplier, uploads CSV to Supabase Storage, posts a Slack DM. 7-day dedup per supplier.",
    humanInput: "Andrew confirms uploads in Slack — the confirmation gets logged in lead_scanner_exports.",
  },
];
