// supabase-js constructs a RealtimeClient that needs a WebSocket ctor on Node<22.
// These tools never open a channel, so a no-op stub satisfies the check.
// @ts-ignore
globalThis.WebSocket = globalThis.WebSocket ?? class {};

import { runRunbookTool } from "@/lib/runbook/tools";
import { getAssignedOrgIds } from "@/lib/org-access";
import type { SessionContext } from "@/lib/auth";

function sess(userId: string, roles: SessionContext["roles"]): SessionContext {
  return { userId, email: "t@t", displayName: "Test", status: "active", roles };
}

const GLOBAL = sess("5ce3a8cd-ad1c-4ea7-92c5-298f24f93bd3", ["admin"]);
const NO_ACCESS = sess("00000000-0000-0000-0000-000000000000", ["ops_operator"]);
const SCOPED_AM = sess("08f6d933-62cc-4dd1-bcaa-1086a1355f5e", ["account_manager"]);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function sum(counts: Record<string, number>) {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

const gCounts: any = await runRunbookTool("get_lead_counts_by_stage", {}, GLOBAL);
check("global sees leads", sum(gCounts.counts) > 0, `total=${sum(gCounts.counts)} ${JSON.stringify(gCounts.counts)}`);

const nCounts: any = await runRunbookTool("get_lead_counts_by_stage", {}, NO_ACCESS);
check("no-assignment user sees ZERO lead counts", sum(nCounts.counts) === 0, JSON.stringify(nCounts.counts));

const nLeads: any = await runRunbookTool("find_leads", {}, NO_ACCESS);
check("no-assignment user find_leads empty", nLeads.count === 0);

const nCases: any = await runRunbookTool("get_open_cases", {}, NO_ACCESS);
check("no-assignment user open_cases empty", nCases.count === 0);

const nOrgs: any = await runRunbookTool("list_my_orgs", {}, NO_ACCESS);
check("no-assignment user list_my_orgs empty", (nOrgs.orgs?.length ?? 0) === 0);

const gLeads: any = await runRunbookTool("find_leads", {}, GLOBAL);
check("global find_leads returns rows", gLeads.count > 0, `count=${gLeads.count}`);

// Scoped account-manager: every returned lead must belong to an org they're assigned to.
const assignedIds = (await getAssignedOrgIds(SCOPED_AM)) ?? [];
const amOrgsRes: any = await runRunbookTool("list_my_orgs", {}, SCOPED_AM);
const amOrgNames = new Set((amOrgsRes.orgs ?? []).map((o: any) => o.name));
check("scoped AM has a bounded (non-global) org set", Array.isArray(assignedIds) && assignedIds.length > 0, `${assignedIds.length} orgs`);
const amLeads: any = await runRunbookTool("find_leads", {}, SCOPED_AM);
const leak = (amLeads.leads ?? []).find((l: any) => l.org && !amOrgNames.has(l.org));
check("scoped AM leads contain no org outside their assignments", !leak, leak ? `LEAK: ${leak.org}` : `${amLeads.count} leads, all in-scope`);

console.log(failures === 0 ? "\nALL SCOPE TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
