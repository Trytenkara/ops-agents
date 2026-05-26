# Session 03 — Agent 02 E2E + Agent naming convention

## Agents built this session
- **Agent 02 - Quote Revalidation** — **E2E verified in production**.
  - Run `a8831685-d0c1-4e8a-a531-57407a20435c` finished in 9s with 1 Missive draft (Nutripro × Food in Bulk, 2 materials), signed CSV URL, and Slack summary.
  - All hard constraints honored: no emails auto-sent, no Tenkara prod writes, only `mcp_readonly` reads.
  - Prompt / agent code: [`src/agents-runtime/agents/quote-revalidation/index.ts`](../src/agents-runtime/agents/quote-revalidation/index.ts)
- **Agent 01 - Ping** — renamed from `ping`, description rewritten as the liveness-check definition. Registry, DB, and UI all aligned.
  - Code: [`src/agents-runtime/agents/ping.ts`](../src/agents-runtime/agents/ping.ts)

## Infra / platform changes
- Recovered Vercel deploys after silent GitHub-App rejection: recreated project as `ops-agents-vu4o`. Fresh project surfaced two hidden Hobby-plan limits.
  - Cron schedule downgraded `*/5 * * * *` → `0 3 * * *` in `vercel.json`.
  - `maxDuration` capped at 300s on `/api/cron` and `/api/agents/run/[slug]`.
- Long-running agent bodies now run via `@vercel/functions` `waitUntil(runClaimed(...))`. Split `executeAgentRun` into `claimRun` (sync lock + open row) and `runClaimed` (the actual work), so the HTTP response returns instantly while the agent gets the full 300s budget.
- Added orphan-run reaper in `claimRun`: any `agent_runs` row stuck in `running` past the 6-minute function-timeout is force-finalized as `failure`.
- Tuned `tenkara-readonly.ts` for serverless: pool `max:1`, JS-side 25s query timeout, server-side `statement_timeout=20000`. Forced transaction pooler (port 6543) and validated the `mcp_readonly.` username prefix.
- Migration `0008_agent_naming_convention.sql` applied: renamed `ping` → `agent-01-ping` with the new liveness-check description; normalized Agent 02 em-dash → hyphen.
- UI: Activity feed agent cell now carries the description as a `title` tooltip; run-detail page renders the description under the agent name. Config page already showed description (untouched).

## Agents pending
| # | Agent | Status | Next action |
|---|-------|--------|-------------|
| 03 | Lead Creator | spec needed | Port from external prompt; needs Missive draft + CSV → Andrew flow |
| 04 | Outreach | spec needed | Define trigger + Missive integration |
| 05 | Marketplace Validation | spec needed | Define source dataset |
| 06 | Data Enrichment | spec needed | Define enrichment fields + write-target |
| 07 | Escalation | spec needed | Define escalation rules + Slack channel |
| 08 | Email Scanner | spec needed | Define scope; high-value, scheduled next |
| 09 | Doc Refresh | spec needed | Define which docs |
| 10 | QA Outreach | spec needed | Define QA criteria |
| 11 | Lead Scanner CSV Push | spec needed | Wire to existing `lead_scanner_exports` table |

All slots above will register in the same `Agent NN - Name` pattern; numbering = registration order.

## Blockers carried into next session
- None blocking. Hobby-plan limits are now respected; production deploys are green.
- Note: cron runs only once daily (`0 3 * * *`) because of the Hobby limit. If we need more frequent cadence we'll need to upgrade Vercel or move cron to an external scheduler.

## Suggested next session
**Session 04 — Agent 03 (Lead Creator)** is the right next target. Reasoning:
- Lead Creator is the highest-leverage agent that's still an external prompt — porting it to the embedded runtime closes the loop on the "agents live inside Tackle Box" goal.
- It exercises the same primitives Agent 02 used (Tenkara read, Missive draft, optional Slack post) so we already have the helpers proven in production.
- After Lead Creator, Email Scanner (Agent 08) is the next big-bang win — schedule it Session 05.
