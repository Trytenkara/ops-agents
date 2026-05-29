import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { queryOverdueRows, type OverdueRow } from "./sql";
import { classifyClient, type OutreachMode, MISSIVE_ORGANIZATION_ID, MISSIVE_TEAM_ID } from "./config";
import { generateRevalidationEmail, formatUserMessage } from "./drafter";
import { buildCsv, type GroupResult } from "./csv-builder";
import { uploadCsvAndSign } from "@/lib/storage";
import { createMissiveDraft, missiveDraftLink } from "@/lib/missive";
import { lintDraft } from "../outreach-qa/lint";
import { postQrSummary } from "./slack-notifier";

// Now runs daily (was weekly), so a quote that's expiring stays "overdue" for
// days. Debounce: don't re-draft a quote we already drafted within this window,
// regardless of whether the operator has sent it yet.
const REDRAFT_DEBOUNCE_DAYS = 7;

// Group key: (client_org × supplier).
function groupKey(r: OverdueRow): string {
  return `${r.client_org_id}|${r.supplier_id}`;
}

interface Group {
  client_org_id: string;
  client_org_name: string;
  client_purchasing_email: string | null;
  supplier_id: string;
  supplier_name: string;
  supplier_contact_name: string | null;
  supplier_contact_email: string;
  mode: OutreachMode;
  ghostBrand?: string;
  rows: OverdueRow[];
}

// Run draft generation + Missive staging with bounded concurrency.
async function pMap<T, R>(items: T[], concurrency: number, mapper: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await mapper(items[i]);
      }
    })
  );
  return results;
}

registerAgent({
  slug: "agent-02-revalidation",
  displayName: "Agent 02 - Quote Revalidation",
  description: "Weekly platform-wide sweep for expiring/expired supplier quotes.",
  async run(ctx) {
    const today = new Date().toISOString().slice(0, 10);
    await ctx.log("Querying Tenkara prod for overdue quotes…", { step: "query" });

    let overdue: OverdueRow[];
    try {
      overdue = await queryOverdueRows();
    } catch (e: any) {
      await ctx.log(`Tenkara query failed: ${e.message}`, { level: "error", step: "query" });
      ctx.setStatus("failure");
      ctx.setSummary(`Failed at Tenkara query: ${e.message}`);
      return;
    }

    const uniqueOrgs = new Set(overdue.map((r) => r.client_org_id)).size;
    await ctx.log(`Fetched ${overdue.length} overdue rows across ${uniqueOrgs} orgs`, {
      step: "query",
      data: { rows: overdue.length, orgs: uniqueOrgs },
    });

    // Classify; skip/unknown drop out entirely.
    const kept: OverdueRow[] = [];
    const droppedRows: OverdueRow[] = [];
    const droppedOrgNames = new Set<string>();
    const classMap = new Map<string, { mode: OutreachMode; ghostBrand?: string }>();
    for (const r of overdue) {
      const c = classifyClient(r.client_org_name);
      if (c.mode === "skip") {
        droppedRows.push(r);
        droppedOrgNames.add(r.client_org_name);
      } else {
        classMap.set(r.quote_id, c);
        kept.push(r);
      }
    }
    await ctx.log(`Classified: kept=${kept.length}, dropped=${droppedRows.length} (${droppedOrgNames.size} orgs)`, {
      step: "classify",
      data: {
        kept: kept.length,
        dropped: droppedRows.length,
        dropped_orgs: Array.from(droppedOrgNames),
      },
    });

    // Group by (client × supplier).
    const groupsMap = new Map<string, Group>();
    for (const r of kept) {
      const key = groupKey(r);
      let g = groupsMap.get(key);
      if (!g) {
        const c = classMap.get(r.quote_id)!;
        g = {
          client_org_id: r.client_org_id,
          client_org_name: r.client_org_name,
          client_purchasing_email: r.client_purchasing_email,
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          supplier_contact_name: r.supplier_contact_name,
          supplier_contact_email: r.supplier_contact_email,
          mode: c.mode as "active" | "ghost",
          ghostBrand: c.ghostBrand,
          rows: [],
        };
        groupsMap.set(key, g);
      }
      g.rows.push(r);
    }
    const groups = Array.from(groupsMap.values());
    await ctx.log(`${groups.length} (client × supplier) groups → 1 draft each`, { step: "group" });

    // Generate + stage drafts in parallel (5 at a time).
    const results: GroupResult[] = await pMap(groups, 5, async (group): Promise<GroupResult> => {
      const baseResult = {
        group: {
          client_org_id: group.client_org_id,
          client_org_name: group.client_org_name,
          client_purchasing_email: group.client_purchasing_email,
          supplier_id: group.supplier_id,
          supplier_name: group.supplier_name,
          supplier_contact_name: group.supplier_contact_name,
          supplier_contact_email: group.supplier_contact_email,
          rows: group.rows,
        },
        mode: group.mode as "active" | "ghost",
        ghostBrand: group.ghostBrand,
      };

      let draft: { subject: string; body: string };
      try {
        const userMsg = formatUserMessage(group, group.mode as "active" | "ghost", group.ghostBrand);
        const { draft: d } = await generateRevalidationEmail({
          mode: group.mode as "active" | "ghost",
          clientName: group.client_org_name,
          ghostBrand: group.ghostBrand,
          userMessage: userMsg,
        });
        draft = d;
      } catch (e: any) {
        await ctx.log(`LLM error for ${group.client_org_name}/${group.supplier_name}: ${e.message}`, {
          level: "warn",
          step: "draft",
          data: { client: group.client_org_name, supplier: group.supplier_name },
        });
        return { ...baseResult, stage: "llm_error", error: e.message };
      }

      let staged;
      try {
        staged = await createMissiveDraft({
          subject: draft.subject,
          body: draft.body,
          to_fields: [{
            name: group.supplier_contact_name ?? "",
            address: group.supplier_contact_email,
          }],
          organization: MISSIVE_ORGANIZATION_ID,
          team: MISSIVE_TEAM_ID,
          add_to_team_inbox: true,
        });
      } catch (e: any) {
        await ctx.log(`Missive error for ${group.client_org_name}/${group.supplier_name}: ${e.message}`, {
          level: "warn",
          step: "missive",
          data: { client: group.client_org_name, supplier: group.supplier_name },
        });
        return { ...baseResult, stage: "missive_error", error: e.message };
      }

      await ctx.log(`Staged: ${group.client_org_name} × ${group.supplier_name} (${group.rows.length} material${group.rows.length === 1 ? "" : "s"})`, {
        step: "missive",
        data: {
          client: group.client_org_name,
          supplier: group.supplier_name,
          materials: group.rows.length,
          missive_draft_id: staged.id,
        },
      });
      return {
        ...baseResult,
        stage: "ok",
        subject: draft.subject,
        body: draft.body,
        missiveConversationId: staged.conversation_id,
        missiveDraftId: staged.id,
      };
    });

    const okResults = results.filter((r) => r.stage === "ok");
    const failedResults = results.filter((r) => r.stage !== "ok");
    await ctx.log(`Drafts: ${okResults.length} staged, ${failedResults.length} failed`, { step: "stage-summary" });

    // Register each successful draft in Tackle Box's draft_references via direct admin client.
    // (This is an embedded agent — no need to go through the HTTP API.)
    const admin = createAdminClient();
    const tackleAgentId = await getAgentIdBySlug(admin, ctx.agentSlug);
    if (tackleAgentId) {
      let registered = 0;
      for (const r of okResults) {
        if (!r.missiveDraftId || !r.missiveConversationId) continue;
        // Map Tenkara org_id → Tackle Box org_id (one row per (client × supplier)).
        const { data: oaOrg } = await admin
          .from("orgs")
          .select("id, org_default_operators(primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status))")
          .eq("tenkara_org_id", r.group.client_org_id)
          .maybeSingle();
        let assignedOperator: string | null = null;
        if (oaOrg) {
          const ops = (oaOrg as any).org_default_operators?.[0] ?? (oaOrg as any).org_default_operators;
          if (ops) {
            const ooo = ops.primary_user?.status === "out_of_office";
            assignedOperator = ooo ? (ops.backup_user_id ?? ops.primary_user_id) : ops.primary_user_id;
          }
        }
        const qaFindings = lintDraft({
          subject: r.subject ?? null,
          body_preview: r.body ?? null,
          assigned_operator: assignedOperator,
          metadata: { outreach_mode: r.mode, ghost_brand: r.ghostBrand ?? null },
        });
        const debounceSince = new Date(Date.now() - REDRAFT_DEBOUNCE_DAYS * 24 * 3600 * 1000).toISOString();
        for (const row of r.group.rows) {
          // Debounce: skip if we drafted this quote within the window (any status),
          // so the daily sweep doesn't re-draft the same expiring quote each day.
          const { data: existing } = await admin
            .from("draft_references")
            .select("id").eq("quote_id", row.quote_id).eq("agent_id", tackleAgentId).gte("created_at", debounceSince).maybeSingle();
          if (existing) continue;
          await admin.from("draft_references").insert({
            email_client: "missive",
            thread_id: r.missiveConversationId,
            draft_id: r.missiveDraftId,
            agent_id: tackleAgentId,
            org_id: oaOrg?.id ?? null,
            supplier_id: row.supplier_id,
            material_id: row.material_id,
            quote_id: row.quote_id,
            subject: r.subject ?? null,
            body_preview: r.body?.slice(0, 1500) ?? null,
            assigned_operator: assignedOperator,
            metadata: {
              outreach_mode: r.mode,
              suggested_signoff: r.mode === "active" ? `${r.group.client_org_name} Purchasing Team` : `${r.ghostBrand} Sourcing`,
              suggested_from_email: r.group.client_purchasing_email,
              ghost_brand: r.ghostBrand ?? null,
              missive_draft_link: missiveDraftLink(r.missiveConversationId, r.missiveDraftId),
              qa_findings: qaFindings,
              qa_linted_at: new Date().toISOString(),
            },
          });
          registered += 1;
        }
      }
      await ctx.log(`Registered ${registered} draft pointers in Tackle Box`, { step: "register" });
    }

    // Build CSV.
    const csvContent = buildCsv(results);
    const csvFilename = `${today}_quote_revalidation_${okResults.length}drafts.csv`;
    await ctx.log(`Built CSV (${csvContent.length} bytes, ${results.reduce((s, r) => s + r.group.rows.length, 0)} rows)`, { step: "csv" });

    // Upload to Supabase Storage + signed URL.
    let signed;
    try {
      signed = await uploadCsvAndSign({ filename: csvFilename, content: csvContent, expiresInDays: 7 });
    } catch (e: any) {
      await ctx.log(`Storage upload failed: ${e.message}`, { level: "error", step: "storage" });
      ctx.setStatus("partial");
      ctx.setSummary(`Staged ${okResults.length} drafts but storage upload failed: ${e.message}`);
      ctx.setItemsProcessed(okResults.length);
      return;
    }
    await ctx.log(`CSV uploaded → ${signed.signedUrl} (expires ${signed.expiresAt})`, { step: "storage", data: { url: signed.signedUrl } });
    ctx.setMetadata({
      csvSignedUrl: signed.signedUrl,
      csvFilename,
      csvExpiresAt: signed.expiresAt,
    });

    // Slack notify (skip if no token configured — log and continue).
    if (process.env.SLACK_BOT_TOKEN) {
      const slackRes = await postQrSummary({
        results,
        dropped: {
          skipped_rows: droppedRows.length,
          skipped_orgs: droppedOrgNames.size,
        },
        csvSignedUrl: signed.signedUrl,
        csvFilename,
      });
      if ((slackRes as any).ok) {
        await ctx.log(`Slack summary posted (ts=${(slackRes as any).ts})`, { step: "slack" });
      } else {
        await ctx.log(`Slack post failed: ${(slackRes as any).error ?? "unknown"}`, { level: "warn", step: "slack" });
      }
    } else {
      await ctx.log("SLACK_BOT_TOKEN not set — skipping Slack post", { level: "warn", step: "slack" });
    }

    ctx.setItemsProcessed(okResults.length);
    ctx.setSummary(
      `${overdue.length} overdue quotes · ${okResults.length}/${results.length} drafts staged across ${new Set(okResults.map((r) => r.group.supplier_id)).size} suppliers · ` +
      `Active: ${okResults.filter((r) => r.mode === "active").length}, ` +
      `Ghost: ${okResults.filter((r) => r.mode === "ghost").length}, ` +
      `Skipped: ${droppedRows.length} · ` +
      `CSV: ${signed.signedUrl}`
    );
    ctx.setStatus(failedResults.length === 0 ? "success" : "partial");
  },
});

async function getAgentIdBySlug(admin: ReturnType<typeof createAdminClient>, slug: string): Promise<string | null> {
  const { data } = await admin.from("agents").select("id").eq("slug", slug).maybeSingle();
  return data?.id ?? null;
}
