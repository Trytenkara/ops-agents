# Wiring a SuperAgent workflow into Tackle Box

This is the contract every Tenkara automation should follow once it's expected to surface its work in Tackle Box. The current home for Tackle Box is `https://ops-agents-vfsa.vercel.app`.

The agent keeps doing whatever it already does (drafting in Missive, posting to Slack, writing CSVs to Drive). It additionally posts a thin layer of metadata to Tackle Box so ops can see what happened in one place.

## Auth

Every call uses a per-agent bearer token. Rotate one per agent on `/agents/config` → click **Rotate API key**. Keep that token in your SuperAgent secret store (env var name `TACKLE_BOX_API_TOKEN`).

```text
Authorization: Bearer <TACKLE_BOX_API_TOKEN>
Content-Type: application/json
```

If you call without a valid bearer, you get a `401 {"error":"unauthorized"}`. Treat that as fatal — don't try to recover.

## The lifecycle

```text
              ┌──────────────────────────────────┐
   start ───▶ │ POST /api/agent/runs             │ ─▶ { run_id }
              └──────────────────────────────────┘

              ┌──────────────────────────────────┐
              │ GET /api/agent/rules?...          │  optional: resolve
              │ GET /api/agent/drafts?quote_id=...│  optional: dedupe check
              └──────────────────────────────────┘

   each draft ─▶ POST /api/agent/drafts           ─▶ { draft_id, assigned_operator }
   each case  ─▶ POST /api/agent/cases            ─▶ { case_id }
   each lead  ─▶ POST /api/agent/leads            ─▶ { inserted: N }
   urgent    ─▶  POST /api/agent/escalations      ─▶ { escalation_id, slack_message_ts }

              ┌──────────────────────────────────┐
   end ─────▶ │ PATCH /api/agent/runs            │ ─▶ closes the run
              │   { run_id, finished: true,      │
              │     status: 'success'|'partial', │
              │     items_processed: N,          │
              │     summary: "...",              │
              │     errors: [...],               │
              │     token_cost: 0.42 }           │
              └──────────────────────────────────┘
```

## POST `/api/agent/runs` — open a run

```json
{
  "org_slug": "nutripro",         // optional; omit for platform-wide workflows
  "status": "running",
  "summary": "Quote revalidation weekly sweep started",
  "trigger_source": "cron"        // or "manual"|"webhook"|"human_resolution"
}
```

Returns `{ "run_id": "<uuid>", "run_started_at": "..." }`. Stash the `run_id` and pass it as `agent_run_id` to subsequent calls so everything ties together.

## POST `/api/agent/drafts` — register a Missive draft

```json
{
  "thread_id": "missive-thread-id",
  "draft_id":  "missive-draft-id",
  "agent_run_id": "<run_id from above>",
  "tenkara_org_id": "uuid-from-tenkara-prod",   // preferred for agents that read Tenkara DB
  "org_slug": "nutripro",                       // alternative if you don't have the UUID
  "supplier_id": "<tenkara supplier id>",
  "material_id": "<tenkara material id>",
  "quote_id":  "<tenkara quote id>",            // for single-quote drafts
  "quote_ids": ["<id1>", "<id2>"],              // for drafts that cover multiple quotes
  "subject":   "Quote refresh — Hyaluronic Acid",
  "body_preview": "Hi Maria, hoping you can refresh ...",
  "metadata": {
    "outreach_mode": "active",                  // active|ghost|skip per your classification
    "suggested_signoff": "Nutripro Purchasing Team",
    "ghost_brand": null
  }
}
```

Returns `{ "draft_id": "<uuid>", "assigned_operator": "<uuid|null>" }`. If a draft for the same primary `quote_id` is already staged by this agent, returns `{ "draft_id": "<existing uuid>", "deduped": true }` — that's not an error.

Two notes:
- **`assigned_operator`** is filled in by Tackle Box using the org's primary/backup config + OOO routing. Use it if you want to show the assignee in your own logs.
- **`covered_quote_ids`** — when you pass an array of `quote_ids`, Tackle Box stores them in `metadata.covered_quote_ids` so ops can see what's covered without dereferencing the draft.

## GET `/api/agent/rules` — resolve the rules cascade

Before drafting, optionally pull resolved rules:

```text
GET /api/agent/rules?org_slug=nutripro&supplier_id=<id>&material_id=<id>
```

Returns one resolved value per `rule_type`:

```json
{
  "agent_slug": "agent-02-revalidation",
  "resolved": {
    "tone":           { "value": {"choice":"warm"},                "scope": "supplier", "scope_id": "..." },
    "do_not_contact": { "value": {"on": true, "reason": "no COA"}, "scope": "supplier", "scope_id": "..." }
  }
}
```

`do_not_contact: { on: true }` → don't draft for that supplier. Surface it in your summary.

## PATCH `/api/agent/runs` — close the run

```json
{
  "run_id": "<uuid>",
  "finished": true,
  "status": "success",            // or "partial" if some rows failed
  "summary": "112 expired quotes; staged 87 drafts across 31 suppliers; 25 skipped (Operator Invalid).",
  "items_processed": 87,
  "errors": null,                 // or { failed: [{quote_id, reason}, ...] }
  "token_cost": 0.42              // USD spent on LLM calls if you have it
}
```

This sets `run_finished_at` and flips the agent's `status` back to `idle` on the agents table.

## Storing a Drive CSV link on the run

If your run produces a CSV that lives in Drive (not the Andrew-handoff Lead Scanner CSV), put the link in the run's metadata at start or include it in the summary at end:

```json
PATCH /api/agent/runs
{
  "run_id": "<uuid>",
  "finished": true,
  "status": "success",
  "summary": "112 expired quotes; 87 drafts; CSV: https://drive.google.com/...",
  "items_processed": 87
}
```

The activity feed renders the summary so the link is one click away.

## When NOT to call Tackle Box

- **Slack posts** that don't need to be reflected in Tackle Box — keep posting directly. Tackle Box's `/api/agent/slack-notify` is for cases where you want OA to be the source-of-truth audit log; for your existing operator-facing Slack messages, post directly.
- **Drive uploads** — Tackle Box doesn't own Drive. Just post the link in the run summary.
- **Missive draft creation** — done by you. Tackle Box only stores the pointer.

## Failure modes worth handling

| When you see | What it means | What to do |
|---|---|---|
| `401 unauthorized` | Token revoked or wrong | Stop. Don't retry. Ping Sam. |
| `400` with `error.flatten()` payload | Schema mismatch on input | Log and skip the row. Surface in your summary. |
| `404 org_not_found` (cases/approvals) | The org slug isn't in OA's `orgs` table yet | The Tenkara→OA org sync didn't include this org. Ping Sam to re-run `npm run sync:orgs`. |
| `500` with error message | Server-side problem | Retry once with exponential backoff. If still failing, log and continue (don't block the whole run). |

## Connecting your existing Quote Revalidation workflow

Drop-in additions to `automations/workflows/quote_revalidation.py`:

```python
import os, httpx

TACKLE_BOX_URL = os.environ.get("TACKLE_BOX_API_URL", "https://ops-agents-vfsa.vercel.app")
TACKLE_BOX_TOKEN = os.environ["TACKLE_BOX_API_TOKEN"]

async def _tb(method: str, path: str, json: dict | None = None) -> dict:
    """Thin Tackle Box client — fails soft so a TB outage never breaks the agent."""
    headers = {"Authorization": f"Bearer {TACKLE_BOX_TOKEN}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            r = await c.request(method, f"{TACKLE_BOX_URL}{path}", headers=headers, json=json)
            if r.status_code >= 400:
                print(f"[tackle-box] {method} {path} → {r.status_code} {r.text[:200]}")
                return {}
            return r.json()
        except Exception as e:
            print(f"[tackle-box] {method} {path} → exception {e}")
            return {}

# 1. At the start of run_workflow():
run = await _tb("POST", "/api/agent/runs", {
    "status": "running",
    "trigger_source": "cron",
    "summary": "Weekly quote revalidation sweep",
})
run_id = run.get("run_id")

# 2. After staging each Missive draft (skip if Operator Invalid / Failed):
for draft in staged_drafts:
    await _tb("POST", "/api/agent/drafts", {
        "thread_id": draft["thread_id"],
        "draft_id":  draft["draft_id"],
        "agent_run_id": run_id,
        "tenkara_org_id": draft["client_org_id"],
        "supplier_id": draft["supplier_id"],
        "quote_id":  draft["primary_quote_id"],
        "quote_ids": draft["covered_quote_ids"],   # if multi-material
        "subject":   draft["subject"],
        "body_preview": draft["body"][:1500],
        "metadata": {
            "outreach_mode": draft["mode"],         # 'active'|'ghost'
            "suggested_from_email": draft["from_email"],
            "suggested_signoff": draft["signoff"],
            "ghost_brand": draft.get("ghost_brand"),
            "draft_status": "Staged",
        },
    })

# 3. At the end of run_workflow():
await _tb("PATCH", "/api/agent/runs", {
    "run_id": run_id,
    "finished": True,
    "status": "success" if no_failures else "partial",
    "items_processed": len(staged_drafts),
    "summary": (
        f"{n_expired} expired quotes · {len(staged_drafts)} drafts staged across {n_suppliers} suppliers · "
        f"Drive: {drive_link} · "
        f"Active: {n_active_drafts}, Ghost: {n_ghost_drafts}, Skipped: {n_skipped}"
    ),
    "errors": failure_list or None,
})
```

Two SuperAgent secrets you'll need:
- `TACKLE_BOX_API_URL` = `https://ops-agents-vfsa.vercel.app`
- `TACKLE_BOX_API_TOKEN` = the `oa_...` token from `/agents/config` → Rotate API key (your current one is `oa_cf350839b06ed6611390b2bd64d14d343e88bff642d172aa`, regenerate any time)

That's it. The agent's existing Slack post + Drive upload behavior is untouched; you've just added a side-channel write so ops can see the same activity in `/work`.
