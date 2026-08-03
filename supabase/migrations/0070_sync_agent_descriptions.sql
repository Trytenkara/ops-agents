-- Sync agents.description with src/lib/agents-spec.ts (the same copy shown on
-- /how-it-works and fed to the Ops assistant). The column had drifted badly:
-- it still described Missive drafts, a weekly Agent 02, and an LLM-free
-- Agent 04. agents.name is deliberately left alone, the activity tables rely on
-- its "Agent NN - " prefix. There is no agent-09 row; that spec entry is a
-- placeholder for the numbering only.

update public.agents set description = 'Infrastructure heartbeat. Confirms the agent runtime is reachable end-to-end.' where slug = 'agent-01-ping';
update public.agents set description = 'Sweep expiring/expired quotes across every active client and stage one re-quote email per (client × supplier).' where slug = 'agent-02-revalidation';
update public.agents set description = 'Scout suppliers for the client''s materials and stage them as raw leads. Enrichment (06) and outreach (04) run as their own scheduled agents.' where slug = 'agent-03-lead-creator';
update public.agents set description = 'Compose the first outreach email for enriched leads, stage it (QA-linted), and advance the lead to ready_for_outreach.' where slug = 'agent-04-outreach';
update public.agents set description = 'Keep public marketplace pricing current: both on Tenkara quotes coming up for reanalysis and on marketplace leads in the sourcing pipeline.' where slug = 'agent-05-marketplace-validation';
update public.agents set description = 'Find a usable contact for each raw lead and promote it to enriched, or leave it blocked with a reason. Also keeps the Supplier and Quote Validation tabs filled.' where slug = 'agent-06-enrichment';
update public.agents set description = 'Chase un-actioned work and clear out stale leads so nothing rots silently.' where slug = 'agent-07-escalation';
update public.agents set description = 'Catch supplier replies as they arrive and turn them into staged quotes, documents and a drafted response.' where slug = 'agent-08-email-scanner';
update public.agents set description = 'Lint every outgoing draft before an operator ever sees it.' where slug = 'agent-10-qa-outreach';
update public.agents set description = 'Per-supplier CSV handoff so dropped leads land back in the supplier graph.' where slug = 'agent-11-lead-scanner-csv-push';
update public.agents set description = 'Research each client and summarize a profile: who they are, what they source, how to work with them, so clients are identifiable at a glance.' where slug = 'agent-12-client-profile';
update public.agents set description = 'Build a per-supplier email-context row (thread state, last contact, open ask) so Agent 02 reaches out with the right tone.' where slug = 'agent-13-inbox-context';
update public.agents set description = 'Data-integrity sweep over the other agents'' outputs, catching things that silently fell through the cracks.' where slug = 'agent-14-qa-watchdog';
update public.agents set description = 'Own the supplier conversation after the first email: chase silence, and once a supplier replies, keep the thread going until a price is captured.' where slug = 'agent-15-reply-manager';
update public.agents set description = 'One daily digest of how the whole fleet ran.' where slug = 'agent-fleet-summary';
