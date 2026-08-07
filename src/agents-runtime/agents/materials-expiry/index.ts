import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { postSlackMessage } from "@/lib/slack";

// Agent 18 — Materials expiry sweep.
//
// Ported from the container-side `materials-expiry-slack` skill. Finds approved,
// live quotes whose `reanalyze` date falls in the next N days and posts one
// digest naming the operator who entered each quote.
//
// `reanalyze` is the platform's re-quote trigger date, deliberately ahead of the
// hard expiry so ops has lead time. `product_expiry` (physical shelf life) is
// barely populated and is not used.
//
// Read-only against Tenkara.

const CHANNEL = process.env.EXPIRY_CHANNEL_ID ?? "C0BCZ5CPAKU"; // #ops-sam
const DAYS = Number(process.env.EXPIRY_DAYS_AHEAD ?? 7);

const DEFAULT_EXCLUDED_ORGS = [
  "Aurora (Testing Org)",
  "Tenkara (Internal Sourcing)",
  "MyFBAPrep",
  "tenkara's Organization",
];

function excludedOrgs(): string[] {
  const raw = process.env.EXPIRY_EXCLUDE_ORGS;
  if (raw === undefined) return DEFAULT_EXCLUDED_ORGS;
  return raw.split(";").map((s) => s.trim()).filter(Boolean);
}

interface ExpiringRow {
  material: string | null;
  expiry: Date;
  price: string | number | null;
  quote_id: string;
  supplier: string | null;
  org: string | null;
  operator_email: string | null;
  operator_first: string | null;
  operator_last: string | null;
  expiring_quote_count: string | number;
}

interface LookaheadRow {
  org: string;
  material: string;
  expiry: Date;
  days_out: string | number;
}

// One row per material: the soonest-expiring quote inside the window, plus how
// many of that material's quotes are expiring in the same window.
const EXPIRING_SQL = `
  SELECT DISTINCT ON (m.id)
         m.name AS material, mq.reanalyze::date AS expiry, mq.price,
         mq.id AS quote_id, s.name AS supplier, o.name AS org,
         op.email AS operator_email, op.firstname AS operator_first,
         op.lastname AS operator_last,
         count(*) OVER (PARTITION BY m.id) AS expiring_quote_count
  FROM material_quotes mq
  JOIN materials m ON m.id = mq.material_id
  LEFT JOIN suppliers s ON s.id = mq.supplier_id
  LEFT JOIN organizations o ON o.id = (
      SELECT organization_id FROM users WHERE id = m.user_id)
  -- The operator who entered the quote (is_operator), not the client owner.
  LEFT JOIN users op ON op.id = COALESCE(mq.user_id, mq.updated_by)
  WHERE mq.reanalyze IS NOT NULL
    AND mq.reanalyze::date BETWEEN CURRENT_DATE
        AND (CURRENT_DATE + ($1 || ' days')::interval)::date
    AND (o.name IS NULL OR o.name <> ALL($2::text[]))
    -- Approved only: signed off and client-ready.
    AND mq.approval::text = 'approved'
    -- Drop non-live quotes: superseded, out of stock, or replaced by a newer one.
    -- These carry stale prices and used to ping operators with wrong data.
    AND COALESCE(mq.status::text, '') NOT IN ('updated', 'out_of_stock')
    AND NOT EXISTS (
        SELECT 1 FROM material_quotes x WHERE x.replaced_quote_id = mq.id)
  ORDER BY m.id, mq.reanalyze ASC, mq.price ASC NULLS LAST`;

const LOOKAHEAD_SQL = `
  SELECT DISTINCT ON (o.name)
         o.name AS org, m.name AS material, mq.reanalyze::date AS expiry,
         (mq.reanalyze::date - CURRENT_DATE) AS days_out
  FROM material_quotes mq
  JOIN materials m ON m.id = mq.material_id
  JOIN organizations o ON o.id = (
      SELECT organization_id FROM users WHERE id = m.user_id)
  WHERE mq.reanalyze::date >= CURRENT_DATE
    AND o.name <> ALL($1::text[])
    AND mq.approval::text = 'approved'
    AND COALESCE(mq.status::text, '') NOT IN ('updated', 'out_of_stock')
    AND NOT EXISTS (
        SELECT 1 FROM material_quotes x WHERE x.replaced_quote_id = mq.id)
  ORDER BY o.name, mq.reanalyze ASC`;

const LEGEND =
  "*Legend:*  :large_orange_diamond: expiring soon (within window)  ·  " +
  ":red_circle: already expired\n" +
  "_Approved quotes only. Superseded, out-of-stock, and replaced quotes are excluded._";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// pg returns a `date` as a Date at local midnight, so reading UTC parts here
// would shift the day backwards for any server west of Greenwich.
function fmtDate(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function daysUntil(d: Date): number {
  const today = new Date();
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / 86_400_000);
}

// Best-effort refresh of the email -> member id map. Needs users:read and
// users:read.email, which the tenkara_agents bot does not have yet; without them
// this is a no-op and the table keeps whatever it was last seeded with. The
// mention degrades to a plain name, never to a wrong person.
async function refreshDirectory(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ refreshed: number } | { skipped: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { skipped: "no_token" };

  const rows: { email: string; slack_user_id: string; display_name: string | null; deleted: boolean }[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const url = new URL("https://slack.com/api/users.list");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await res.json().catch(() => ({}));
    if (!data.ok) return { skipped: data.error ?? `http_${res.status}` };
    for (const m of data.members ?? []) {
      const email: string | undefined = m.profile?.email;
      if (!email || m.is_bot) continue;
      rows.push({
        email: email.toLowerCase(),
        slack_user_id: m.id,
        display_name: m.real_name ?? m.profile?.real_name ?? null,
        deleted: Boolean(m.deleted),
      });
    }
    cursor = data.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  if (!rows.length) return { skipped: "empty" };

  const { error } = await admin
    .from("slack_directory")
    .upsert(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: "email" });
  if (error) return { skipped: `upsert:${error.message}` };
  return { refreshed: rows.length };
}

async function loadDirectory(
  admin: ReturnType<typeof createAdminClient>
): Promise<Map<string, string>> {
  const { data } = await admin
    .from("slack_directory")
    .select("email, slack_user_id")
    .eq("deleted", false);
  return new Map((data ?? []).map((r: any) => [String(r.email).toLowerCase(), r.slack_user_id]));
}

function operatorLabel(row: ExpiringRow, dir: Map<string, string>): string {
  const name = [row.operator_first, row.operator_last].filter(Boolean).join(" ").trim();
  const uid = row.operator_email ? dir.get(row.operator_email.toLowerCase()) : undefined;
  if (uid) return `<@${uid}>`;
  return name || row.operator_email || "unassigned";
}

registerAgent({
  slug: "agent-18-materials-expiry",
  displayName: "Agent 18 - Materials Expiry Sweep",
  description:
    "Daily sweep of approved Tenkara quotes whose reanalyze date falls in the next 7 days. Posts one Slack digest per day naming the material, price, supplier, org, and the operator who entered the quote, plus a look-ahead for client orgs with nothing in the window.",
  async run(ctx) {
    const admin = createAdminClient();
    const excluded = excludedOrgs();

    const refresh = await refreshDirectory(admin);
    if ("skipped" in refresh) {
      await ctx.log(`Slack directory not refreshed (${refresh.skipped}) — using stored map`, {
        level: "info",
        step: "directory",
      });
    } else {
      await ctx.log(`Refreshed ${refresh.refreshed} Slack directory entries`, { step: "directory" });
    }
    const dir = await loadDirectory(admin);

    const rows = await tenkaraQuery<ExpiringRow>(EXPIRING_SQL, [String(DAYS), excluded]);
    const lookahead = await tenkaraQuery<LookaheadRow>(LOOKAHEAD_SQL, [excluded]);
    const allClientOrgs = await tenkaraQuery<{ name: string }>(
      "SELECT name FROM organizations WHERE name <> ALL($1::text[]) ORDER BY name",
      [excluded]
    );

    // Expired first, then soonest, then org, then material — the order someone
    // scanning the digest for "what do I have to do today" wants.
    rows.sort(
      (a, b) =>
        daysUntil(a.expiry) - daysUntil(b.expiry) ||
        (a.org ?? "~").localeCompare(b.org ?? "~") ||
        (a.material ?? "").localeCompare(b.material ?? "")
    );

    const blocks: any[] = [];
    if (rows.length) {
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:alarm_clock: *Materials expiring within ${DAYS} days* — ${rows.length} material(s) need attention`,
          },
        },
        { type: "context", elements: [{ type: "mrkdwn", text: LEGEND }] },
        { type: "divider" }
      );
    } else {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *No approved quotes to review in the next ${DAYS} days.*`,
        },
      });
    }

    let unresolved = 0;
    for (const r of rows) {
      const priceNum = r.price === null ? null : Number(r.price);
      const price =
        priceNum === null || Number.isNaN(priceNum)
          ? "—"
          : `$${priceNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      // The badge comes from the date, not the raw `status` enum: status is null
      // on most quotes, which read as "unknown" and confused operators.
      const badge =
        daysUntil(r.expiry) < 0 ? ":red_circle: *EXPIRED*" : ":large_orange_diamond: *EXPIRING SOON*";
      const extra = Number(r.expiring_quote_count) || 1;
      const more = extra > 1 ? `  _(+${extra - 1} more quote(s) expiring)_` : "";
      const label = operatorLabel(r, dir);
      if (!label.startsWith("<@")) unresolved += 1;
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `${badge}  —  *${r.material}*  ·  expires *${fmtDate(r.expiry)}*${more}\n` +
            `   Soonest quote: ${price} (\`${String(r.quote_id).slice(0, 8)}\`)  ·  ` +
            `Supplier: ${r.supplier ?? "—"}  ·  Org: ${r.org ?? "—"}\n` +
            `   Operator: ${label}`,
        },
      });
    }

    // Orgs with nothing in the window still get a line, so silence for a client
    // is visibly "nothing due" rather than "the sweep forgot about you".
    const orgsWithItems = new Set(rows.map((r) => r.org));
    const otherOrgs = allClientOrgs.map((o) => o.name).filter((o) => !orgsWithItems.has(o));
    if (otherOrgs.length) {
      const nextUp = new Map(lookahead.map((l) => [l.org, l]));
      const upcoming = otherOrgs
        .filter((o) => nextUp.has(o))
        .map((o) => nextUp.get(o)!)
        .sort((a, b) => a.expiry.getTime() - b.expiry.getTime());
      const noneScheduled = otherOrgs.filter((o) => !nextUp.has(o));
      const lines = [
        `:telescope: *Coming up — nothing to review in the next ${DAYS} days for these orgs:*`,
      ];
      for (const n of upcoming) {
        lines.push(
          `   • *${n.org}* — next: *${n.material}* ~ ${fmtDate(n.expiry)} (est., ${n.days_out}d out)`
        );
      }
      if (noneScheduled.length) {
        lines.push(`   • _No approved quotes scheduled:_ ${noneScheduled.join(", ")}`);
      }
      blocks.push({ type: "divider" });
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: lines.join("\n") }] });
    }

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Daily materials-expiry sweep" }],
    });

    ctx.setItemsProcessed(rows.length);
    if (unresolved) {
      await ctx.log(`${unresolved} operator(s) shown by name — email not in the Slack directory`, {
        level: "warn",
        step: "directory",
      });
    }

    const fallback = rows.length
      ? `${rows.length} material(s) expiring in ${DAYS} days`
      : `Nothing to review in the next ${DAYS} days`;
    const res = await postSlackMessage({ channel: CHANNEL, text: fallback, blocks });
    if (!res.ok) throw new Error(`Slack post failed: ${res.error}`);

    ctx.setStatus("success");
    ctx.setSummary(`${rows.length} material(s) expiring within ${DAYS} days — digest posted`);
  },
});
