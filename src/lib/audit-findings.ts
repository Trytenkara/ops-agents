// Where an audit finding lives between the run that found it and the person
// who fixes it (UI-06).
//
// Before this, Agent 26 computed five findings a day and posted them to Slack.
// Nothing persisted them, so nothing could scope them to the client they were
// about, nothing could say how long one had been open, and the flagged-work
// registry - the thing that gives a set a surface on the owning client's tab -
// had no row to read. A finding that exists only in a chat message is the same
// failure as a price withheld into a blank cell: it looks like nobody has got
// to it yet, forever.
//
// Writing goes through `recordAuditFindings` and only that, so the two halves
// that make the surface honest cannot come apart: a finding restated today
// updates the row it already opened rather than opening a second one, and a
// finding the audit no longer reports is closed in the same pass. An audit that
// only ever wrote would show yesterday's cleared faults as open work.

import type { SupabaseClient } from "@supabase/supabase-js";

/** The uuid a fleet-wide finding folds onto, matching the unique index. */
const NO_ORG = "00000000-0000-0000-0000-000000000000";

export interface AuditFinding {
  rule: string;
  /** The client the finding is about, or null when it is fleet-wide. */
  orgId: string | null;
  count: number;
  detail: string;
  sample: string[];
}

export interface OpenAuditFinding extends AuditFinding {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

const keyOf = (f: { rule: string; orgId: string | null }) => `${f.rule}:${f.orgId ?? NO_ORG}`;

/**
 * Write today's findings and close the ones that no longer hold.
 *
 * `scope` bounds what may be closed: a run that only audited some of the rules
 * must not read the rules it never looked at as clean. Pass the rules the run
 * actually evaluated, including the ones that came back with nothing.
 */
export async function recordAuditFindings(
  admin: SupabaseClient,
  findings: AuditFinding[],
  scope: string[],
): Promise<{ opened: number; updated: number; resolved: number }> {
  const now = new Date().toISOString();
  const { data: openRows, error } = await admin
    .from("audit_findings")
    .select("id, rule, org_id")
    .is("resolved_at", null)
    .in("rule", scope);
  if (error) throw new Error(`could not read open audit findings: ${error.message}`);

  const open = new Map<string, string>();
  for (const r of openRows ?? []) open.set(keyOf({ rule: r.rule, orgId: r.org_id }), r.id);

  let opened = 0;
  let updated = 0;
  for (const f of findings) {
    const existing = open.get(keyOf(f));
    if (existing) {
      const { error: e } = await admin
        .from("audit_findings")
        .update({ detail: f.detail, count: f.count, sample: f.sample, last_seen_at: now })
        .eq("id", existing);
      if (e) throw new Error(`could not update audit finding ${f.rule}: ${e.message}`);
      updated++;
    } else {
      const { error: e } = await admin.from("audit_findings").insert({
        rule: f.rule,
        org_id: f.orgId,
        detail: f.detail,
        count: f.count,
        sample: f.sample,
        first_seen_at: now,
        last_seen_at: now,
      });
      if (e) throw new Error(`could not open audit finding ${f.rule}: ${e.message}`);
      opened++;
    }
  }

  const stillOpen = new Set(findings.map(keyOf));
  const stale = [...open.entries()].filter(([k]) => !stillOpen.has(k)).map(([, id]) => id);
  if (stale.length) {
    const { error: e } = await admin.from("audit_findings").update({ resolved_at: now }).in("id", stale);
    if (e) throw new Error(`could not resolve cleared audit findings: ${e.message}`);
  }
  return { opened, updated, resolved: stale.length };
}

/** Open findings for one client, newest restatement first. */
export async function loadOpenAuditFindings(
  admin: SupabaseClient,
  orgId: string,
  limit: number,
): Promise<{ items: OpenAuditFinding[]; total: number }> {
  const { data, count, error } = await admin
    .from("audit_findings")
    .select("id, rule, org_id, detail, count, sample, first_seen_at, last_seen_at", { count: "exact" })
    .eq("org_id", orgId)
    .is("resolved_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const items = (data ?? []).map((r: any) => ({
    id: r.id,
    rule: r.rule,
    orgId: r.org_id,
    count: r.count,
    detail: r.detail,
    sample: Array.isArray(r.sample) ? r.sample : [],
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  }));
  return { items, total: count ?? items.length };
}
