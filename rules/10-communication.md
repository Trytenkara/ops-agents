# Communication

## COMM-01 — Keep replies short

A few sentences. No section headers, no tables, no bullet lists recapping
work, even after a long task. Say what changed and anything that needs a
decision. Drop the rest.

**Enforcement:** Judgement.

## COMM-02 — Write for a non-developer

Lead with the real-world effect ("suppliers' prices were showing up about 200x
too cheap"), not the mechanism. No file paths, function names, commit ids,
table or column names, or code in the reply unless asked. Full technical
detail belongs in the commit message and in this folder.

**Enforcement:** Judgement.

## COMM-03 — Claim only what a command proved

Never state that something was pushed, deployed, fixed or verified unless a
command run in the same session shows it. No inferring from "I ran the edit, so
it must be live". A code edit that was never executed is a hypothesis, not a
fix. Before claiming a bug is fixed, reproduce it first, then show the same
reproduction producing the good output.

After a commit, read the file list it prints and confirm it matches the
message. After a push, confirm against the remote. After a deploy, read what
production is actually serving.

The evidence is kept and can be produced on request; it is not pasted into the
reply by default (see COMM-04 and `CONFLICTS.md` A).

**Enforcement:** Judgement. This is the rule whose breach reads as "fake
pushing".

## COMM-04 — Report the outcome, keep the receipts

Resolution of the tension between COMM-01/02 (short, no ids) and COMM-03
(prove it): state the verified outcome in plain words, for example
"it is live on production, confirmed against the running deployment". Do not
paste command output, ids or paths unless asked. Keep the raw evidence in the
session and in the commit message so it can be produced immediately.

If verification did NOT happen, say so plainly. "Pushed but not yet confirmed
live" is an acceptable sentence; silence is not.

**Enforcement:** Judgement.

## COMM-05 — Never speak as the human

The connected Slack account can post as Sam. It never does. Anything an agent
sends goes out as the `tenkara_agents` bot, or is staged as a draft for a human
to send. This includes failure alerts and direct messages.

**Enforcement:** Check owed — `comm/one-slack-sender`: a single send helper
that accepts only the bot token, and no user token anywhere.

## COMM-06 — One channel, one post a day

Everything the fleet says goes to `#op-assistant-agents` (`C0B5M1QCE9E`), as
one consolidated post per day. No other channel, no direct message, no
per-event chatter. Callers do not choose a destination: `postSlackMessage`
resolves the channel itself and takes no channel argument.

Changed 2026-08-19 (was `#control-room-feedback`, plus a DM to Sam for
failures, plus five other configurable targets). Sam asked for one channel and
for the p1 exception to go with it.

**Enforcement:** Guard — `comm/one-slack-channel` in `scripts/check-rules.mjs`
rejects any channel argument, any hardcoded `C0…`/`D0…` id and any of the
retired channel env vars, everywhere except `src/lib/slack.ts`.

## COMM-07 — Everything an agent raises waits for the daily post

There is no live agent alert. p1 and p2 both queue in `slack_alert_log` and
leave in the 18:00 digest; p1 leads it, keeps its `@`-mentions and carries a
:rotating_light:. p3 stays ledger-only. The two exceptions are an operator
pressing a button in the Control Room (Report Issue, escalate-to-call — a human
is already waiting on that post) and the fail-open path in `alert-policy.ts`
when the ledger itself is unreachable.

The cost is real and accepted: a cross-client contamination alert can now wait
up to 24h to reach Slack. The audit that finds it runs daily anyway, and the
Control Room shows it immediately.

**Enforcement:** Guard — `dispatchAlert` queues every severity except p3;
nothing else in the repo posts an agent alert. Fail-open is deliberate.

## COMM-08 — Copy bans

Never use the term "RFQ" in email copy; say "sourcing inquiry". Never use an
em dash in supplier-facing or user-facing output.

**Enforcement:** Guard — `sanitizeDraft` inside `stageDraft`, plus
`copy/no-rfq-or-em-dash-in-templates`. The guard covers recognised copy
literals only; model prompts, database-sourced copy and concatenated strings
can still slip through. See `OUTSTANDING.md`.

## COMM-09 — Never announce as a bot in a crawler user agent

A crawler that identifies itself as an agent gets blocked or served different
content, which then reads as a site that cannot be scraped.

**Enforcement:** Check owed — `crawl/no-agent-identifying-user-agent`.
