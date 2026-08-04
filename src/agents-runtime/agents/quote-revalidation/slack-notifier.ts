import { postSlackMessage } from "@/lib/slack";
import { OPERATOR_SLACK_IDS } from "./config";
import type { GroupResult } from "./csv-builder";

export interface DroppedSummary {
  skipped_rows: number;
  skipped_orgs: number;
}

interface BuildOpts {
  results: GroupResult[];
  dropped: DroppedSummary;
  csvSignedUrl: string;
  csvFilename: string;
}

function buildText({ results, dropped, csvSignedUrl, csvFilename }: BuildOpts): string {
  const ok = results.filter((r) => r.stage === "ok");
  const fails = results.filter((r) => r.stage !== "ok");

  const activeOk = ok.filter((r) => r.mode === "active");
  const ghostOk = ok.filter((r) => r.mode === "ghost");
  const nSuppliersActive = new Set(activeOk.map((r) => r.group.supplier_id)).size;
  const nSuppliersGhost = new Set(ghostOk.map((r) => r.group.supplier_id)).size;
  const nClientsActive = new Set(activeOk.map((r) => r.group.client_org_id)).size;
  const nClientsGhost = new Set(ghostOk.map((r) => r.group.client_org_id)).size;
  const nOpInvalid = ok.reduce(
    (acc, r) => acc + r.group.rows.filter((row) => !row.author_is_active_operator).length,
    0
  );
  const nDrafts = ok.length;
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const m = (handle: keyof typeof OPERATOR_SLACK_IDS) => `<@${OPERATOR_SLACK_IDS[handle]}>`;

  const lines: string[] = [
    `*Weekly quote revalidation — ${today}*`,
    "",
    `${m("rosie")} ${m("mildred")} ${m("andrea")} — *${nDrafts} drafts staged in Tenkara* across ${nSuppliersActive + nSuppliersGhost} suppliers.`,
    "",
    `📎 *CSV:* <${csvSignedUrl}|${csvFilename}>`,
    "",
    "*Flow*",
    "1. Open the CSV → review the *Suggested From Email* + *Suggested Signoff* columns",
    "2. Open each draft in the Tenkara inbox (conversation id in CSV), set the From field, then click Send",
    "3. Anything marked `Operator Invalid` or `Failed` needs manual triage",
    "",
    "*Audit*",
    `• Active clients: ${activeOk.length} drafts (${nClientsActive} clients, ${nSuppliersActive} suppliers)`,
    `• Ghost clients:  ${ghostOk.length} drafts (${nClientsGhost} clients, ${nSuppliersGhost} suppliers)`,
    `• Skipped (in skip-list or unknown): ${dropped.skipped_rows} quotes from ${dropped.skipped_orgs} org(s)`,
  ];

  if (nOpInvalid > 0) {
    lines.push(
      "",
      `⚠️ ${m("rosie")} ${m("mildred")} — *${nOpInvalid} quote(s) have \`Operator Invalid\` status* (likely a client user authored the quote). Please review and re-assign in the CSV.`
    );
  }
  if (fails.length > 0) {
    lines.push(
      "",
      `❌ ${fails.length} draft creation(s) failed — see CSV \`Draft Status\` column for details.`
    );
  }
  if (nDrafts === 0) {
    lines.push("", "_No expired quotes found this week — heartbeat CSV uploaded._");
  } else {
    lines.push("", "_Drafts staged in the Tenkara inbox, unsent._");
  }
  return lines.join("\n");
}

export async function postQrSummary(opts: BuildOpts) {
  const text = buildText(opts);
  return postSlackMessage({ text });
}
