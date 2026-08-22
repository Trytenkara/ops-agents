# Communication

## COMM-01 — Keep replies short

A few sentences. No section headers, no tables, no bullet lists recapping
work, even after a long task. Say what changed and anything that needs a
decision. Drop the rest.

The pull is strongest exactly where it does most damage: after a long or
careful piece of work, the reply wants to show the work. On 2026-08-20 a reply
reporting one push ran to four hundred words with three headers, a four-row
table, two commit ids, a deployment id and a line of pasted command output.
Everything in it was true and verified. Sam's answer was "this is very
confusing", and he asked for a new rule, not knowing there were already three.

So the length of the work is not a licence for the length of the reply. A
bigger job earns a shorter summary, because there is more to leave out. If a
reply has a header or a table in it, it is already wrong.

This is judgement of the weakest kind, because nothing mechanical reads a
reply: it held for the fleet's Slack posts, which are code, and failed for
months in chat, which is not. Treat a long reply as a break of the same
standing as a bad push.

**Enforcement:** Judgement.

## COMM-02 — Write for a non-developer

Lead with the real-world effect ("suppliers' prices were showing up about 200x
too cheap"), not the mechanism. No file paths, function names, commit ids,
table or column names, or code in the reply unless asked. Full technical
detail belongs in the commit message and in this folder.

Rule ids are mechanism too. "DISC-01 moved from Check owed to Guard" says
nothing to the person reading it; "a new discovery source can no longer forget
to search the trade's name for a material" says the same thing and can be
understood. Use the id only when the reply is about the rulebook itself, and
even then say what the rule does the first time it appears.

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

It admits no exception, including an explicit instruction. Sam ruled on
2026-08-20 that even "post this as me" is answered with a draft he sends
himself: the click costs him nothing and a message in his name he did not write
cannot be withdrawn. See `CONFLICTS.md` M.

**Enforcement:** Guard — `comm/one-slack-sender`: `postSlackMessage` in
`src/lib/slack.ts` is the only place that posts, and no user token may appear
anywhere. `postAgentAlert` used to hold a second copy of the same fetch and now
delegates to it.

Four skill scripts post directly and are named as exceptions in the check: they
run outside the deploy and cannot import from `src`. The user-token half still
covers them, which is the half that matters — a second sender is a nuisance, a
user token is Sam's name on something he did not write.

## COMM-06 — One channel, one post a day

Everything the fleet says goes to `#op-assistant-agents` (`C0B5M1QCE9E`), as
one consolidated post per day. No other channel, no direct message, no
per-event chatter. Callers do not choose a destination: `postSlackMessage`
resolves the channel itself and takes no channel argument.

Changed 2026-08-19 (was `#control-room-feedback`, plus a DM to Sam for
failures, plus five other configurable targets). Sam asked for one channel and
for the p1 exception to go with it.

**Enforcement:** Guard — `comm/one-slack-channel` in
`scripts/lib/rule-checks.mjs` rejects any channel argument, any of the retired
channel env vars, and any Slack id that is not `C0B5M1QCE9E`, everywhere except
`src/lib/slack.ts`. It runs over this repository in `npm run build` and over
`/workspace/.claude/skills` in that repo's pre-commit hook, because the skills
post to Slack too and four of them were found breaking this rule on 2026-08-20
while the ledger reported it enforced.

## COMM-07 — Everything an agent raises waits for the daily post

There is no live agent alert. p1 and p2 both queue in `slack_alert_log` and
leave in the 18:00 digest; p1 leads it, keeps its `@`-mentions and carries a
:rotating_light:. p3 stays ledger-only. The exceptions are an operator pressing a
button in the Control Room (Report Issue, escalate-to-call — a human is already
waiting on that post), a violated read-only guarantee against Tenkara prod
(`alertTenkaraWriteAttempt`, which should never fire at all), and the fail-open
path in `alert-policy.ts` when the ledger itself is unreachable.

A failed or partial agent run is NOT an exception. It queues as p1 and leads
the digest. 73 runs broke in 24h on 2026-08-19, 65 of them one agent; live-
posting that is the noise this rule exists to stop.

The cost is real and accepted: a cross-client contamination alert can now wait
up to 24h to reach Slack. The audit that finds it runs daily anyway, and the
Control Room shows it immediately.

**Enforcement:** Guard — `dispatchAlert` queues every severity except p3;
nothing else in the repo posts an agent alert. Fail-open is deliberate.

## COMM-08 — Copy bans

Never use the term "RFQ" in email copy; say "sourcing inquiry". Never use an
em dash in supplier-facing or client-facing output.

The ban binds the copy and the prompts that write it. A prompt is the more
important half: `sanitizeDraft` can strip an em dash out of a body on the way
past, but nothing strips it out of a system prompt, and sixteen of them sat in
the instructions that draft every supplier reply, which is the most reliable
way to make a model produce them. It also cannot help a client deliverable that
is rendered rather than staged. The expedited report told clients about "Weeks
of manual RFQ work" for months in exactly that gap, because it never passes
through staging at all. See `CONFLICTS.md` K for what the ban does not bind.

Enforcing it inside `stageDraft` left a way around it. The operator redraft
action and the quote-revalidation reply both called the Tenkara transport
directly, so no ban ever ran on their copy. The sanitiser moved down a level on
2026-08-22: it now runs inside `createTenkaraDraft` and
`createTenkaraConversation`, which is the last thing every path goes through,
and the HTML is rebuilt from the cleaned plain text rather than cleaned in place
so the concession strips cannot cut across a tag.

**Enforcement:** Guard — `sanitizeDraft` inside the Tenkara transport at
runtime, so no path can create a draft that skipped it, and
`copy/no-rfq-or-em-dash-in-templates` at build time over a named scope of
outbound-copy files, held closed by two companion checks: the scope paths are
anchors, so renaming one fails the build rather than silently dropping it, and
`copy/scope-must-cover-every-draft-site` makes any `stageDraft` caller missing
from that scope a violation. `copy/no-direct-draft-create` holds the sanitiser
in the transport and both entry points to it.

## COMM-09 — Never announce as a bot in a crawler user agent

A crawler that identifies itself as an agent gets blocked or served different
content, which then reads as a site that cannot be scraped.

Agent 06's enrichment crawl sent `TackleBox-Enrich/1.0`, which EC21 and most
B2B directories answer with a 403. The fetch is a plain public-page read either
way, so the announcement bought nothing and cost the page. Fixed 2026-08-05 in
`4dd2151`, and the rule applies to every fetcher in the fleet, not just the one
that broke.

**Enforcement:** Guard — `crawl/no-agent-identifying-user-agent`: a user agent
naming the company or a crawler token fails the build. It is a check on the
literal rather than on a shared constant, because there are six user agents in
the fleet and consolidating them is a separate change; what matters is that none
of them says who we are. The skills folder is only scanned when `check-rules` is
run with `--also`, so a skill's fetcher is covered by the daily skills pass, not
by the deploy build.
