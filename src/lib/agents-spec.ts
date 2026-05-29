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
    cadence: "Weekly — Mondays 07:00 America/New_York",
    purpose: "Sweep expiring/expired quotes across every Tenkara client and stage one outreach draft per (client × supplier).",
    automatic: "Reads Tenkara quotes/materials/suppliers, classifies clients as active vs ghost, drafts emails in Missive, uploads a CSV to Supabase Storage, posts a Slack summary.",
    humanInput: "Review each staged draft in Missive, edit if needed, click Send. Nothing leaves the building automatically.",
  },
  {
    number: 3,
    slug: "agent-03-lead-creator",
    name: "Lead Creator",
    status: "shipped",
    cadence: "Every 4 hours · America/New_York",
    purpose: "For each newly-added Tenkara material, surface candidate suppliers from the existing supplier graph.",
    automatic: "Scans Tenkara materials added since the last cursor, finds candidate suppliers via quote history + catalogs, inserts rows into leads_in_flight at stage=raw (cap 50/run).",
    humanInput: "None at this stage — Agent 06 picks them up next. Use /work/review/leads if you want to peek or drop a bad row.",
  },
  {
    number: 4,
    slug: "agent-04-outreach",
    name: "Outreach",
    status: "shipped",
    cadence: "Hourly · America/New_York",
    purpose: "Compose outreach emails for enriched leads and stage them in Missive.",
    automatic: "Reads stage=enriched leads, drafts Missive emails (cap 5/run), records a draft_references row, advances lead to stage=ready_for_outreach. Never sends.",
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
    cadence: "Every 2 hours · America/New_York",
    purpose: "Promote raw leads to enriched, or mark them blocked with a reason.",
    automatic: "Reads top 25 stage=raw leads by confidence, merges Tenkara supplier metadata, sets supplier_phone / country / completeness_score. Promotes to stage=enriched or leaves at raw with payload.enrichment_blocked_reason.",
    humanInput: "On /work/review/leads, click Promote on an enriched lead to hand it to Agent 04, or click Drop with a reason if it shouldn't be pursued. Raw-with-blocked-reason leads can be promoted as an override when you want to contact anyway.",
  },
  {
    number: 7,
    slug: "agent-07-escalation",
    name: "Escalation",
    status: "shipped",
    cadence: "Every 6 hours · America/New_York",
    purpose: "Pull stale leads (active for >14d) into the cases queue so someone owns them.",
    automatic: "Opens a cases row assigned to the org's primary operator (or backup if OOO), drops the lead with drop_reason='escalated_to_case'.",
    humanInput: "Pick up the case on the org overview page, decide call/archive/feedback, mark it resolved when handled.",
  },
  {
    number: 8,
    slug: "agent-08-email-scanner",
    name: "Email Scanner",
    status: "shipped",
    cadence: "Every 30 min · America/New_York",
    purpose: "Detect supplier replies to our outreach — by sender email, not thread ID, so fresh chains still get caught.",
    automatic: "Scans Missive team inbox, matches sender against supplier_contact_email, stamps reply_detected on draft_references and supplier_reply on the lead. Never sends.",
    humanInput: "Watch for reply_detected stamps on the Cross-org view; follow up in Missive.",
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
    cadence: "Hourly at :15 · America/New_York",
    purpose: "Lint staged drafts for placeholders, missing operators, empty bodies, and ghost-mode brand leaks.",
    automatic: "Reads draft_references staged between 7d and 1h ago, writes findings to draft_references.metadata.qa_findings. Does not change draft status.",
    humanInput: "Check qa_findings on /work/review/drafts before sending a draft — fix any errors first.",
  },
  {
    number: 11,
    slug: "agent-11-lead-scanner-csv-push",
    name: "Lead Scanner CSV Push",
    status: "shipped",
    cadence: "Daily · 09:00 America/New_York (06:00 PT for Andrew)",
    purpose: "Daily per-supplier CSV handoff to Andrew (Tenkara eng) so dropped leads land back in the supplier graph.",
    automatic: "Reads dropped/terminal leads, groups by supplier, uploads CSV to Supabase Storage, posts a Slack DM. 7-day dedup per supplier.",
    humanInput: "Andrew confirms uploads in Slack — the confirmation gets logged in lead_scanner_exports.",
  },
];
