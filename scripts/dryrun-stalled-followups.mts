// Dry run of the stalled-conversation sweep against prod. READ-ONLY: it calls the
// real gate logic (loadStalledThreadState) and the real cadence, then prints what
// WOULD be drafted instead of staging anything.
//
//   npx tsx --env-file=.env scripts/dryrun-stalled-followups.mts
import { createAdminClient } from "../src/lib/supabase/admin";
import { loadStalledThreadState, loadRecentThreadIds } from "../src/agents-runtime/agents/reply-manager/stalled-followup";
import { stalledFollowupGapMs } from "../src/lib/agent-timing";
import { loadOrgStatuses, outreachAllowed } from "../src/lib/org-status";

const admin = createAdminClient();
const threadIds = await loadRecentThreadIds(admin);
const state = await loadStalledThreadState(admin, threadIds);
const orgStatuses = await loadOrgStatuses(admin);
const now = Date.now();

const reasons: Record<string, number> = {};
const would: string[] = [];
for (const [, t] of state) {
  const bump = (k: string) => { reasons[k] = (reasons[k] ?? 0) + 1; };
  if (!t.lastInboundAt) { bump("never replied (no-reply sweep owns it)"); continue; }
  if (t.terminal) { bump("conversation ended (declined/finalized/priced)"); continue; }
  if (t.conversationComplete) { bump("our last message closed it out"); continue; }
  if (t.awaitingOperator) { bump("a draft is already waiting on ops"); continue; }
  if (!t.anchor || !t.lastOutboundAt) { bump("no sent message to reply from"); continue; }
  if (t.lastInboundAt > t.lastOutboundAt) { bump("they are waiting on US"); continue; }
  const r = t.anchor;
  const meta = (r.metadata ?? {}) as any;
  if (!outreachAllowed(orgStatuses.byOaId.get(r.org_id) ?? "off")) { bump("org paused"); continue; }
  if (now < t.lastOutboundAt + stalledFollowupGapMs(r.org_id, t.priorNudges)) { bump("not due yet"); continue; }
  if (!(meta.supplier_contact_email ?? t.contactEmail)) { bump("no contact email"); continue; }
  would.push(
    `#${t.priorNudges + 1}  ${String(meta.supplier_name ?? meta.supplier_contact_email ?? t.contactEmail).slice(0, 34).padEnd(34)}` +
      `  ${String(meta.material_name ?? "-").slice(0, 26).padEnd(26)}  silent ${Math.floor((now - t.lastOutboundAt) / 86400000)}d`
  );
}

console.log(`threads examined: ${state.size}\n`);
console.log("skipped:");
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`\nWOULD DRAFT: ${would.length}`);
for (const w of would.slice(0, 50)) console.log(`  ${w}`);
