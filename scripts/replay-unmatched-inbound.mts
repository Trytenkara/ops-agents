// Replays supplier replies that were dead-lettered by the ORG-11 fault: the
// inbound router counted an unlinked draft (supplier_id null) as a second,
// different supplier, called a one-counterparty thread ambiguous, and parked
// the reply. The prices in those replies never reached the client.
//
// The router is fixed, but a parked reply is never reconsidered: the reconcile
// sweep skips any message already in inbound_message_ledger. This clears the
// ledger row so the message reads as unseen, then runs the SAME reconcile pass
// the scheduled sweep runs, so the replay cannot drift from normal processing.
//
// Candidates come from unmatched_inbound_events, the durable record that a
// reply was parked — NOT from the ledger outcome, which changes as soon as a
// replay is attempted and would hide any message a failed attempt had touched.
//
// Only conversations that soleReplyTarget now resolves are touched. One that
// still names no supplier on any draft is left alone and reported: it needs the
// supplier link backfilled upstream (ORG-10), not a replay.
//
// Usage:
//   npx tsx scripts/replay-unmatched-inbound.mts                   # dry run, every candidate
//   npx tsx scripts/replay-unmatched-inbound.mts --conversation=<id> [--conversation=...]
//   npx tsx scripts/replay-unmatched-inbound.mts --apply --limit=4
import { createAdminClient } from "../src/lib/supabase/admin";
import { soleReplyTarget } from "../src/lib/org-isolation";
import { reconcileThread } from "../src/agents-runtime/agents/reply-manager/thread-reconcile";
import { retireUnmatchedTriage } from "../src/lib/tenkara-inbound";

const apply = process.argv.includes("--apply");
const only = process.argv
  .filter((a) => a.startsWith("--conversation="))
  .map((a) => a.slice("--conversation=".length));
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;

async function main() {
  const admin = createAdminClient();

  // ORG-12. An event recorded before the router learned to ask the thread has
  // no org_id, and the candidate read below deliberately skips those. Name them
  // first, by the same test the router now uses — exactly one owner across the
  // conversation's draft references — so the replay works on the same
  // population production would.
  const { data: orphans, error: orphanError } = await admin
    .from("unmatched_inbound_events")
    .select("id, conversation_id")
    .is("org_id", null);
  if (orphanError) throw new Error(`orphan read failed: ${orphanError.message}`);
  const orphanConvs = [...new Set((orphans ?? []).map((r: any) => r.conversation_id))];
  let named = 0;
  let stillOrphan = 0;
  for (const conv of orphanConvs) {
    const { data: refs, error } = await admin
      .from("draft_references")
      .select("org_id")
      .eq("thread_id", conv)
      .not("org_id", "is", null)
      .limit(200);
    if (error) throw new Error(`orphan refs read failed on ${conv}: ${error.message}`);
    const owners = new Set((refs ?? []).map((r: any) => r.org_id));
    if (owners.size !== 1) {
      stillOrphan++;
      continue;
    }
    named++;
    if (!apply) continue;
    const { error: upErr } = await admin
      .from("unmatched_inbound_events")
      .update({ org_id: [...owners][0] })
      .eq("conversation_id", conv)
      .is("org_id", null);
    if (upErr) throw new Error(`orphan write failed on ${conv}: ${upErr.message}`);
  }
  if (orphanConvs.length) {
    console.log(
      `conversations with no client: ${orphanConvs.length}; named by their own drafts: ${named}` +
        `; still unowned: ${stillOrphan} (their inbox is mapped to nobody and their thread names nobody)`
    );
  }

  const parked: any[] = [];
  for (let from = 0; ; from += 1000) {
    const q = admin
      .from("unmatched_inbound_events")
      .select("message_id, conversation_id, sender_email, created_at")
      // An event with no client was never routable in the first place: its
      // inbox is not mapped to anyone, which is a different fault.
      .not("org_id", "is", null)
      .order("created_at")
      .range(from, from + 999);
    const { data, error } = await (only.length ? q.in("conversation_id", only) : q);
    if (error) throw new Error(`event read failed: ${error.message}`);
    parked.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }

  const byConversation = new Map<string, any[]>();
  for (const row of parked) {
    const list = byConversation.get(row.conversation_id) ?? [];
    list.push(row);
    byConversation.set(row.conversation_id, list);
  }
  console.log(
    `parked replies: ${parked.length} across ${byConversation.size} conversation(s)` +
      (only.length ? ` (restricted to ${only.length} by --conversation)` : "")
  );

  const replayable: Array<{ conv: string; rows: any[] }> = [];
  const stillTriage: string[] = [];
  for (const [conv, rows] of byConversation) {
    const { data: refs, error } = await admin
      .from("draft_references")
      .select("org_id, supplier_id, material_id, status, created_at")
      .eq("thread_id", conv)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`refs read failed on ${conv}: ${error.message}`);
    if (soleReplyTarget(refs ?? [])) replayable.push({ conv, rows });
    else stillTriage.push(conv);
  }
  console.log(
    `resolvable now: ${replayable.length}; still unresolvable: ${stillTriage.length}` +
      (stillTriage.length ? ` (${stillTriage.join(", ")})` : "")
  );

  // A message that has since been answered must never be replayed: clearing its
  // ledger row would stage the same quotes a second time. The script is a repair
  // tool and gets re-run, so this is checked rather than assumed.
  const answered = new Set<string>();
  for (const { rows } of replayable) {
    const { data: ledger, error } = await admin
      .from("inbound_message_ledger")
      .select("message_id, outcome")
      .in("message_id", rows.map((r) => r.message_id));
    if (error) throw new Error(`ledger read failed: ${error.message}`);
    // "deduped" counts: since PERS-08 it can only mean a real reply exists.
    for (const l of (ledger ?? []) as any[]) {
      if (l.outcome === "drafted" || l.outcome === "deduped") answered.add(l.message_id);
    }
  }
  const pending = replayable
    .map(({ conv, rows }) => ({ conv, rows: rows.filter((r) => !answered.has(r.message_id)) }))
    .filter((c) => c.rows.length > 0);
  if (pending.length < replayable.length) {
    console.log(
      `already answered: ${replayable.length - pending.length} conversation(s) need no replay, only their triage artefacts retired`
    );
  }

  // Named, not silent: --limit is a deliberate pilot window, never a quiet cap.
  const batch = pending.slice(0, LIMIT);
  if (batch.length < pending.length) {
    console.log(`--limit=${LIMIT}: replaying ${batch.length} of ${pending.length}, the rest are untouched`);
  }

  let cleared = 0, drafted = 0, replayedMsgs = 0, failed = 0, unreadable = 0;
  for (const { conv, rows } of batch) {
    if (!apply) {
      console.log(`  would replay ${rows.length} message(s) on ${conv} (${rows.map((r) => r.sender_email).join(", ")})`);
      continue;
    }
    const { data: gone, error: delError } = await admin
      .from("inbound_message_ledger")
      .delete()
      .in("message_id", rows.map((r) => r.message_id))
      .select("message_id");
    if (delError) {
      console.warn(`  ${conv}: ledger clear failed (${delError.message}), skipped`);
      failed++;
      continue;
    }
    cleared += gone?.length ?? 0;

    const pass = await reconcileThread(
      admin,
      { agentId: "", runId: "", log: async () => {} },
      conv,
      { deadline: Date.now() + 240_000 }
    );
    replayedMsgs += pass.replayed;
    drafted += pass.drafted;
    failed += pass.failed;
    if (pass.unreadable) unreadable++;
    console.log(
      `  ${conv}: replayed ${pass.replayed}, drafted ${pass.drafted}, failed ${pass.failed}` +
        (pass.outcomes.length ? ` — ${pass.outcomes.join("; ")}` : "")
    );
  }

  // Sweep the artefacts of messages that are answered but were answered before
  // the router learned to retire them (PERS-08) — the four threads replayed on
  // 2026-08-20, and any message a supplier reply resolved by another route.
  // Idempotent, so it runs over every candidate, not just the batch.
  let casesClosed = 0, draftsRetired = 0;
  for (const { conv, rows } of replayable) {
    for (const row of rows.filter((r) => answered.has(r.message_id))) {
      if (!apply) {
        console.log(`  would retire triage artefacts for ${row.message_id} on ${conv}`);
        continue;
      }
      const r = await retireUnmatchedTriage(admin, { conversationId: conv, messageId: row.message_id });
      casesClosed += r.casesClosed;
      draftsRetired += r.draftsRetired;
    }
  }

  console.log(
    apply
      ? `\nledger rows cleared: ${cleared}, messages replayed: ${replayedMsgs}, drafts produced: ${drafted}, failed: ${failed}, unreadable threads: ${unreadable}` +
          `\ntriage cases closed: ${casesClosed}, clarification drafts retired: ${draftsRetired}`
      : "\ndry run, nothing written"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
