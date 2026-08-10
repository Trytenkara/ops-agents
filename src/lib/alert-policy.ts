// Alert policy: decides whether an agent alert reaches Slack now, waits for the
// daily fleet digest, or is only recorded.
//
// Severity:
//   p1  Someone has to act now (send path, money, data loss, an agent down).
//       Posts live to the channel, may @-mention.
//   p2  A human is needed eventually (drafts held, stale escalations, expiring
//       quotes). Never posts live; queued and rolled into the 18:00 fleet digest
//       as one line per group.
//   p3  For the record (duplicate material names, flagged spellings). Recorded
//       here and nowhere else in Slack. Every p3 caller already writes a case or
//       flag row, so nothing is lost.
//
// Dedupe: alert_key identifies the CONDITION, not the occurrence. Use
// "blocked_draft:<supplier_id>", not a draft id, or every retry looks new. Same
// key with the same rendered text inside the TTL bumps suppressed_count instead
// of posting. A changed content hash means the situation moved and is said again.
//
// Fails open. If the ledger is unreachable the alert is posted live regardless
// of severity: noise is recoverable, a dropped alert is not.

import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage } from "@/lib/slack";

export type AlertSeverity = "p1" | "p2" | "p3";

export interface AlertPolicyOptions {
  key: string;
  severity: AlertSeverity;
  // Say the same thing again only after this long. Defaults below.
  ttlMinutes?: number;
  channel?: string;
  mentionUserIds?: string[];
  // Digest heading this alert groups under, e.g. "Drafts held for review".
  // Defaults to the portion of the key before the first colon.
  digestGroup?: string;
  // One-line form for the digest. Defaults to the first line of the text.
  title?: string;
  // Slack blocks for p1 only. Ignored for p2/p3, which render as digest lines.
  blocks?: any[];
}

export type AlertOutcome = "posted" | "queued" | "recorded" | "suppressed";

const DEFAULT_TTL_MINUTES: Record<AlertSeverity, number> = {
  // Long enough that a failing agent does not re-announce every 20-minute run,
  // short enough that a still-broken thing resurfaces the same day.
  p1: 240,
  // The digest runs daily, so a persistent condition is re-listed once a day.
  p2: 1440,
  p3: 10080,
};

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

interface LedgerRow {
  severity: string;
  content_hash: string;
  last_notified_at: string | null;
  suppressed_count: number;
  queued: boolean;
}

// Central entry point. Returns what happened so callers can log it.
export async function dispatchAlert(text: string, opts: AlertPolicyOptions): Promise<AlertOutcome> {
  const hash = hashText(text);
  const ttlMs = (opts.ttlMinutes ?? DEFAULT_TTL_MINUTES[opts.severity]) * 60_000;
  const now = new Date();
  const digestGroup = opts.digestGroup ?? opts.key.split(":")[0];
  const title = opts.title ?? text.split("\n")[0];

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    await postLive(text, opts);
    return "posted";
  }

  const { data: existing, error: readErr } = await admin
    .from("slack_alert_log")
    .select("severity, content_hash, last_notified_at, suppressed_count, queued")
    .eq("alert_key", opts.key)
    .maybeSingle<LedgerRow>();

  if (readErr) {
    console.error(`[alert-policy] ledger unavailable for ${opts.key}, posting live: ${readErr.message}`);
    await postLive(text, opts);
    return "posted";
  }

  if (existing) {
    const notifiedAt = existing.last_notified_at ? new Date(existing.last_notified_at).getTime() : 0;
    const withinTtl = notifiedAt > 0 && now.getTime() - notifiedAt < ttlMs;
    // Already waiting for the digest, or said recently and nothing changed. Still
    // refresh the rendered text when it moved, or the digest names a stale
    // situation (e.g. a bounce count that has since grown).
    if (existing.queued || (existing.content_hash === hash && withinTtl)) {
      const patch: Record<string, any> = { last_seen_at: now.toISOString(), suppressed_count: existing.suppressed_count + 1 };
      if (existing.content_hash !== hash) {
        patch.content_hash = hash;
        patch.title = title.slice(0, 400);
        patch.body = text.slice(0, 4000);
      }
      await admin.from("slack_alert_log").update(patch).eq("alert_key", opts.key);
      return "suppressed";
    }
  }

  const row: Record<string, any> = {
    alert_key: opts.key,
    severity: opts.severity,
    content_hash: hash,
    title: title.slice(0, 400),
    body: text.slice(0, 4000),
    channel: opts.channel ?? null,
    digest_group: digestGroup,
    last_seen_at: now.toISOString(),
    suppressed_count: 0,
    queued: opts.severity === "p2",
    // p2 is stamped by the digest drain, not here.
    last_notified_at: opts.severity === "p2" ? null : now.toISOString(),
  };

  const { error: writeErr } = await admin.from("slack_alert_log").upsert(row, { onConflict: "alert_key" });
  if (writeErr) {
    console.error(`[alert-policy] ledger write failed for ${opts.key}, posting live: ${writeErr.message}`);
    await postLive(text, opts);
    return "posted";
  }

  if (opts.severity === "p1") {
    const ts = await postLive(text, opts);
    if (ts) await admin.from("slack_alert_log").update({ slack_ts: ts }).eq("alert_key", opts.key);
    return "posted";
  }
  return opts.severity === "p2" ? "queued" : "recorded";
}

async function postLive(text: string, opts: AlertPolicyOptions): Promise<string | null> {
  const ids = [...new Set((opts.mentionUserIds ?? []).filter(Boolean))];
  const body = ids.length ? `${ids.map((id) => `<@${id}>`).join(" ")} ${text}` : text;
  const res = await postSlackMessage({ channel: opts.channel, text: body, blocks: opts.blocks });
  return res.ts ?? null;
}

// For the once-a-day watchdog digests (QA, sourcing health, quote revalidation,
// materials expiry, the escalation nudge). They are low volume and worth reading,
// so they keep posting live and keep their own error handling; what they should
// not do is repeat yesterday's numbers verbatim. Returns false when the
// fingerprint is unchanged inside the TTL, in which case the caller stays quiet.
//
// fingerprint must cover everything a reader would notice changing, not just a
// total: two different materials expiring on the same day is not the same digest.
export async function shouldPostDigest(key: string, fingerprint: string, ttlMinutes = 4320): Promise<boolean> {
  const hash = hashText(fingerprint);
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return true;
  }

  const { data: existing, error } = await admin
    .from("slack_alert_log")
    .select("severity, content_hash, last_notified_at, suppressed_count, queued")
    .eq("alert_key", key)
    .maybeSingle<LedgerRow>();
  if (error) {
    console.error(`[alert-policy] digest claim failed for ${key}, posting: ${error.message}`);
    return true;
  }

  if (existing?.content_hash === hash && existing.last_notified_at) {
    const age = Date.now() - new Date(existing.last_notified_at).getTime();
    if (age < ttlMinutes * 60_000) {
      await admin
        .from("slack_alert_log")
        .update({ last_seen_at: new Date().toISOString(), suppressed_count: existing.suppressed_count + 1 })
        .eq("alert_key", key);
      return false;
    }
  }

  return true;
}

// Stamped by the caller AFTER a successful post. Deliberately separate from
// shouldPostDigest: stamping at decision time meant a Slack failure was recorded
// as delivered and the digest went missing for the whole TTL.
export async function recordDigestPosted(key: string, fingerprint: string): Promise<void> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return;
  }
  const now = new Date().toISOString();
  const { error } = await admin.from("slack_alert_log").upsert(
    {
      alert_key: key,
      severity: "p1",
      content_hash: hashText(fingerprint),
      title: key,
      digest_group: "Daily reports",
      last_seen_at: now,
      last_notified_at: now,
      suppressed_count: 0,
      queued: false,
    },
    { onConflict: "alert_key" },
  );
  if (error) console.error(`[alert-policy] failed to stamp digest ${key}: ${error.message}`);
}

export interface DigestSection {
  group: string;
  lines: string[];
}

export interface QueuedAlertDigest {
  // null means the caller's default ops channel.
  channel: string | null;
  sections: DigestSection[];
  // Only the alerts actually named in this digest. Anything past the per-group
  // cap stays queued and leads tomorrow's digest (rows are read oldest-first),
  // because some p2 conditions fire exactly once and would otherwise be lost.
  keys: string[];
  named: number;
  deferred: number;
}

// How many alerts one group names individually per digest. The remainder is
// always counted out loud and carried to the next digest, never dropped.
const DIGEST_GROUP_LIMIT = 15;

// Read the queued p2 alerts, grouped by destination channel and then by digest
// group. Does NOT mark anything; the caller posts first and then calls
// markAlertsNotified with the keys it actually rendered, so a failed Slack post
// leaves them queued rather than losing them.
export async function readQueuedAlerts(): Promise<QueuedAlertDigest[]> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return [];
  }

  const { data, error } = await admin
    .from("slack_alert_log")
    .select("alert_key, digest_group, title, suppressed_count, first_seen_at, channel")
    .eq("queued", true)
    .order("first_seen_at", { ascending: true });

  if (error || !data?.length) {
    if (error) console.error(`[alert-policy] digest read failed: ${error.message}`);
    return [];
  }

  const byChannel = new Map<string | null, any[]>();
  for (const r of data as any[]) {
    const ch = (r.channel as string | null) ?? null;
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(r);
  }

  const digests: QueuedAlertDigest[] = [];
  for (const [channel, rows] of byChannel) {
    const byGroup = new Map<string, any[]>();
    for (const r of rows) {
      const group = (r.digest_group as string | null) ?? "Other";
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group)!.push(r);
    }
    const sections: DigestSection[] = [];
    const keys: string[] = [];
    let deferred = 0;
    for (const [group, all] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const shown = all.slice(0, DIGEST_GROUP_LIMIT);
      const over = all.length - shown.length;
      deferred += over;
      keys.push(...shown.map((r) => r.alert_key as string));
      const lines = shown.map((r) => {
        const repeats = r.suppressed_count > 0 ? ` _(seen ${r.suppressed_count + 1}x)_` : "";
        return `${r.title ?? r.alert_key}${repeats}`;
      });
      if (over) lines.push(`…and ${over} more, carried to the next digest`);
      sections.push({ group: `${group} (${all.length})`, lines });
    }
    digests.push({ channel, sections, keys, named: keys.length, deferred });
  }
  return digests;
}

export async function markAlertsNotified(keys: string[]): Promise<void> {
  if (!keys.length) return;
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return;
  }
  const { error } = await admin
    .from("slack_alert_log")
    .update({ queued: false, last_notified_at: new Date().toISOString() })
    .in("alert_key", keys);
  if (error) console.error(`[alert-policy] failed to clear ${keys.length} queued alerts: ${error.message}`);
}
