# Tackle Box — Setup

A Tenkara internal hub: where ops works and where agents are monitored. Built on Next.js (App Router) + Supabase + a per-agent bearer-key API.

## What's in the box

- **Your Work tab** — Today (with daily greeting), Cross-org rollup, per-org workspaces for all real Tenkara client orgs (Overview, Revalidation, Outreach, Cases, Suppliers, Approvals, Quotes). Account managers see a filtered view.
- **Agents tab** (Lead Operator + Admin + Monitor only) — Activity feed, Configuration (incl. stamp-of-approval gate + API-key rotation), System health
- **Top-level tab toggle** sits in the sidebar — sidebar contents change wholesale based on the active tab so ops can't get lost in agent monitoring.
- **Auth** — Supabase Auth with 5 roles displayed as **Admin** / **Lead Operator** / **Operator** / **Account Manager** / **Monitor**. DB enum stays as-is for back-compat.
- **Brand** — colors and fonts derived from tenkara.ai: cream background `#F7F6F5`, near-black text `#121212`, electric blue accent `#0011FF`, Source Serif 4 for editorial headers, Inter for body.
- **Org list** — synced from Tenkara prod read-only DB on demand via `npm run sync:orgs`. Aurora (Testing) and Tenkara (Internal Sourcing) flagged with an "Internal" tag and dimmed.
- **Operator chips** — `<Name> · <Role>` chip used in every operator reference (drafts, cases, org overview, audit log).
- **RBAC** — RLS policies enforce the Your Work / Agents split
- **Agent API** under `/api/agent/*` authenticated by per-agent bearer keys:
  - `POST /api/agent/runs`, `PATCH /api/agent/runs` (register/update runs)
  - `POST /api/agent/drafts`, `GET /api/agent/drafts` (stage drafts; check for existing)
  - `POST /api/agent/cases`, `GET /api/agent/cases`
  - `POST /api/agent/approvals`, `GET /api/agent/approvals`
  - `POST /api/agent/escalations` (fires Slack on urgent)
  - `POST /api/agent/slack-notify`
  - `POST /api/agent/leads` (push to `leads_in_flight`)
  - `POST /api/agent/lead-exports` (queue Andrew CSV handoff)
  - `GET /api/agent/rules` (resolve the per-supplier → per-org → agent-global cascade)
  - `GET /api/agent/resolutions` (polling fallback for SuperAgent webhooks)
- **Operator assignment** — primary + backup per org; OOO toggle on profile reroutes auto-assignment to backup
- **"Mark draft reviewed"** server action with audit-log entry and best-effort SuperAgent webhook notification

## Local setup

```bash
git clone https://github.com/sammypingali/ops-intelligence-agent.git
cd ops-intelligence-agent
cp .env.example .env.local   # then fill in the secrets below
npm install --include=dev    # the --include=dev flag is required when NODE_ENV=production in the shell
npm run db:push              # applies supabase/migrations/*.sql against OA_DATABASE_URL
npm run dev
```

Then sign up via `/login` (use a magic link — set `Site URL` in Supabase Auth settings to your local URL first, or use password auth via the Supabase dashboard to create the first user). Once you have an `auth.users` row:

```bash
ADMIN_EMAIL=you@trytenkara.com node scripts/bootstrap-admin.mjs
```

This grants `admin`, `ops_lead`, and `monitor` roles to your user so you can see everything.

## Required secrets (`.env.local`)

| Key | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page → publishable key (`sb_publishable_*`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → secret key (`sb_secret_*`). **Server-side only, never expose** |
| `OA_DATABASE_URL` | Supabase → Connect → Session pooler (the direct host is IPv6-only — use the pooler). This project is on `aws-1-us-west-2.pooler.supabase.com:5432`, user `postgres.<project_ref>`. URL-encode special chars in the password (e.g. `@` → `%40`). |
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`). The token currently in `.env.local` is **blank** — Slack posts will return `{ok:false, error:"slack_not_configured"}` until you add a real token. |
| `SLACK_OPS_CHANNEL_ID` | The one channel everything posts to, currently `C0B5M1QCE9E` (#op-assistant-agents). Optional — the code defaults to it. The bot must be in the channel. |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` for dev. In Vercel, your prod URL — Slack deep links use this. |

### Slack note

The token you provided in the original onboarding was a channel URL, not a bot token. You need a real bot token (starts with `xoxb-`) from the Slack app's OAuth & Permissions page. Until that's in place, the Slack-notify endpoint returns a soft failure and the agent code path continues normally.

## Connecting an agent (SuperAgent side)

1. On `/agents/config`, click **Rotate API key** for the agent you want to connect. Copy the token (shown once).
2. In SuperAgent, store the token as a secret and configure the agent to send `Authorization: Bearer <token>` on every call to `/api/agent/*`.
3. Typical run lifecycle the agent should follow:

```text
POST /api/agent/runs                       → { run_id }
GET  /api/agent/rules?org_slug=…&supplier_id=…       (resolve rules cascade)
GET  /api/agent/drafts?quote_id=…&status=staged      (check for duplicates)
POST /api/agent/drafts                     (stage the draft once safe)
PATCH /api/agent/runs { run_id, finished:true, status:'success', items_processed }
```

4. For human-in-the-loop resolution, register the agent's resume webhook URL in the `agents.webhook_url` column (no UI for this yet — set it via the Supabase SQL editor). When a human marks a draft reviewed, OA will POST to that URL. If the webhook fails or isn't set, the agent's next scheduled run can call `GET /api/agent/resolutions?since=<iso>` to catch up.

## Deploying to Vercel

1. `vercel link` against the GitHub repo
2. Set the same env vars in Vercel → Project Settings → Environment Variables (Production + Preview)
3. Add `https://<your-vercel-domain>/auth/callback` to **Supabase Auth → URL Configuration → Redirect URLs**
4. Set `NEXT_PUBLIC_APP_URL` to your Vercel domain so Slack deep links resolve correctly

## What's NOT done in Phase 1 (deferred to later phases per the outline)

- Cases UI (Phase 2; the API endpoint exists already)
- Suppliers / Quotes views (Phase 2 — needs Tenkara read-only client)
- Approvals UI with bulk CSV download (Phase 3)
- Rules engine form-driven UI (Phase 2 — schema + read API exist, just no UI yet)
- Lead Scanner mirror view (Phase 3)
- Lead Scanner export Slack DM to Andrew (Phase 3 — API endpoint exists)
- Org settings UI (Phase 2 — to assign primary/backup operators from the app rather than direct SQL)
- Realtime feed (Phase 4 per the decision in §11.3)

## Useful one-off SQL

Assign primary + backup operator for Meridian (replace UUIDs):

```sql
update public.org_default_operators
  set primary_user_id = '...uuid...', backup_user_id = '...uuid...'
  where org_id = (select id from public.orgs where slug = 'meridian-foods');
-- if no row yet:
insert into public.org_default_operators (org_id, primary_user_id, backup_user_id)
  values ((select id from public.orgs where slug = 'meridian-foods'), '...', '...')
  on conflict (org_id) do update set primary_user_id = excluded.primary_user_id, backup_user_id = excluded.backup_user_id;
```

Register an agent's resume webhook:

```sql
update public.agents set webhook_url = 'https://superagent.example/webhook/agent-02' where slug = 'agent-02-revalidation';
```
