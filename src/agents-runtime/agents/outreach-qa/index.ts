import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { lintDraft, type Finding } from "./lint";

// v1: a defensive lint over staged drafts. Operators may sit on a draft for
// a while before opening it — we want to surface problems (unfilled
// placeholders, missing operator assignment, suspicious phrasing) so they
// see them when they pick the draft up.
//
// The lint rules themselves live in ./lint.ts so intake agents (02/03/08) run
// the identical checks inline when they stage a draft. This scheduled sweep is
// a backstop for drafts that weren't linted at creation time.
//
// We grace-period 1 hour so we don't QA a draft Agent 04 staged 30s ago.
// Drafts older than ~7 days are skipped (operator already abandoned them).
//
// Findings get written to draft_references.metadata.qa_findings as an array
// of {severity, code, message}. We don't change status — only flag.
const GRACE_MINUTES = 60;
const MAX_AGE_DAYS = 7;
const MAX_DRAFTS_PER_RUN = 100;

registerAgent({
  slug: "agent-10-qa-outreach",
  displayName: "Agent 10 - QA Outreach",
  description:
    "Lints staged outreach drafts for placeholders, broken templates, missing operators, and ghost-mode brand leaks. Writes findings into draft_references.metadata.qa_findings.",
  async run(ctx) {
    const admin = createAdminClient();

    const minAge = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString();
    const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString();

    const { data: drafts, error: pullErr } = await admin
      .from("draft_references")
      .select("id, subject, body_preview, assigned_operator, metadata, status, created_at")
      .eq("status", "staged")
      .lt("created_at", minAge)
      .gt("created_at", maxAge)
      .order("created_at", { ascending: true })
      .limit(MAX_DRAFTS_PER_RUN);

    if (pullErr) {
      await ctx.log(`Pull failed: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }
    if (!drafts || drafts.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No staged drafts in QA window.");
      return;
    }

    await ctx.log(`Linting ${drafts.length} staged drafts (older than ${GRACE_MINUTES}m, younger than ${MAX_AGE_DAYS}d)`, { step: "pull" });

    let clean = 0;
    let withWarnings = 0;
    let withErrors = 0;
    let errored = 0;
    const codeCounts: Record<string, number> = {};

    for (const d of drafts as any[]) {
      const findings: Finding[] = lintDraft(d);
      for (const f of findings) codeCounts[f.code] = (codeCounts[f.code] ?? 0) + 1;

      const newMetadata = {
        ...(d.metadata ?? {}),
        qa_findings: findings,
        qa_run_id: ctx.runId,
        qa_ran_at: new Date().toISOString(),
      };

      const { error: upErr } = await admin
        .from("draft_references")
        .update({ metadata: newMetadata })
        .eq("id", d.id);
      if (upErr) {
        errored++;
        await ctx.log(`Update failed for draft ${d.id}: ${upErr.message}`, {
          level: "error",
          step: "update",
          data: { draft_id: d.id },
        });
        continue;
      }

      if (findings.length === 0) clean++;
      else if (findings.some((f) => f.severity === "error")) withErrors++;
      else withWarnings++;
    }

    ctx.setItemsProcessed(drafts.length);
    ctx.setStatus(errored > 0 && drafts.length - errored === 0 ? "failure" : errored > 0 ? "partial" : "success");
    const codeStr = Object.entries(codeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    ctx.setSummary(
      `QA'd ${drafts.length} drafts · ${clean} clean · ${withWarnings} warn · ${withErrors} error${codeStr ? ` (${codeStr})` : ""}${errored ? ` · ${errored} update failures` : ""}`
    );
  },
});
