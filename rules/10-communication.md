# Communication

## COMM-01 — Keep replies short

A few sentences. No section headers, no tables, no bullet lists recapping
work, even after a long task. Say what changed and anything that needs a
decision. Drop the rest.

**Enforcement:** Honour.

## COMM-02 — Write for a non-developer

Lead with the real-world effect ("suppliers' prices were showing up about 200x
too cheap"), not the mechanism. No file paths, function names, commit ids,
table or column names, or code in the reply unless asked. Full technical
detail belongs in the commit message and in this folder.

**Enforcement:** Honour.

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

**Enforcement:** Honour. This is the rule whose breach reads as "fake pushing".

## COMM-04 — Report the outcome, keep the receipts

Resolution of the tension between COMM-01/02 (short, no ids) and COMM-03
(prove it): state the verified outcome in plain words, for example
"it is live on production, confirmed against the running deployment". Do not
paste command output, ids or paths unless asked. Keep the raw evidence in the
session and in the commit message so it can be produced immediately.

If verification did NOT happen, say so plainly. "Pushed but not yet confirmed
live" is an acceptable sentence; silence is not.

**Enforcement:** Honour.

## COMM-05 — Never speak as the human

The connected Slack account can post as Sam. It never does. Anything an agent
sends goes out as the `tenkara_agents` bot, or is staged as a draft for a human
to send. This includes failure alerts and direct messages.

**Enforcement:** Honour. Owed guard: a single Slack send helper that only
accepts the bot token. See `OUTSTANDING.md`.

## COMM-06 — One channel, one post a day

Routine agent output goes to `#control-room-feedback` (`C0BATUWBHC7`) only, as
one consolidated post per day. No other channel, no per-event chatter.

## COMM-07 — Failures are the exception to COMM-06

A genuine failure (agents down, a run producing nothing, a client-visible
break) is sent directly to Sam rather than waiting for the daily post. It is
sent BY THE BOT, never as Sam (COMM-05). This is the only sanctioned
destination outside `#control-room-feedback`.

**Enforcement:** Honour. Owed guard: the channel allowlist currently ends the
session on any channel that is not `C0BATUWBHC7`, which also blocks the
sanctioned failure DM. See `OUTSTANDING.md`.

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

**Enforcement:** Honour.
