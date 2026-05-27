import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";

// v1: a defensive lint over staged drafts. Operators may sit on a draft for
// a while before opening it — we want to surface problems (unfilled
// placeholders, missing operator assignment, suspicious phrasing) so they
// see them when they pick the draft up.
//
// We grace-period 1 hour so we don't QA a draft Agent 04 staged 30s ago.
// Drafts older than ~7 days are skipped (operator already abandoned them).
//
// Findings get written to draft_references.metadata.qa_findings as an array
// of {severity, code, message}. We don't change status — only flag.
const GRACE_MINUTES = 60;
const MAX_AGE_DAYS = 7;
const MAX_DRAFTS_PER_RUN = 100;

type Severity = "warn" | "error";
interface Finding { severity: Severity; code: string; message: string; }

// Each rule looks at the draft row and returns 0..n findings.
type Rule = (d: { subject: string | null; body_preview: string | null; assigned_operator: string | null; metadata: any }) => Finding[];

const PLACEHOLDER_RE = /\{\{[^}]+\}\}|\{[A-Z_][A-Z0-9_]*\}|<<[^>]+>>|TBD|TODO|XXX/g;

const RULES: Record<string, Rule> = {
  placeholders_in_body: ({ body_preview }) => {
    if (!body_preview) return [];
    const matches = body_preview.match(PLACEHOLDER_RE);
    if (!matches) return [];
    return [{
      severity: "error",
      code: "placeholders_in_body",
      message: `Unfilled placeholders in body: ${Array.from(new Set(matches)).join(", ")}`,
    }];
  },
  placeholders_in_subject: ({ subject }) => {
    if (!subject) return [];
    const matches = subject.match(PLACEHOLDER_RE);
    if (!matches) return [];
    return [{
      severity: "error",
      code: "placeholders_in_subject",
      message: `Unfilled placeholders in subject: ${Array.from(new Set(matches)).join(", ")}`,
    }];
  },
  missing_operator: ({ assigned_operator }) => {
    if (assigned_operator) return [];
    return [{
      severity: "warn",
      code: "missing_operator",
      message: "Draft has no assigned_operator — operator org_default_operators row likely missing.",
    }];
  },
  empty_body: ({ body_preview }) => {
    if (body_preview && body_preview.trim().length > 50) return [];
    return [{
      severity: "error",
      code: "empty_body",
      message: "Body is empty or suspiciously short (<50 chars).",
    }];
  },
  ghost_brand_leak: ({ body_preview, metadata }) => {
    // If we're in ghost mode but the body mentions the real client org name,
    // we'd be leaking attribution. metadata.outreach_mode + ghost_brand are
    // set by Agent 04.
    if (!body_preview || metadata?.outreach_mode !== "ghost") return [];
    const ghost = metadata?.ghost_brand as string | undefined;
    if (!ghost) return [];
    // Look for known client names that should not appear in ghost outreach.
    // We only have a few — list them inline so we don't have to import config.
    const CLIENT_NAMES = ["Aurora", "Bobber", "Vita Organica", "McGinley", "Nutripro", "PharmaLab", "Sphere", "Ulo", "Tenkara"];
    const leaks = CLIENT_NAMES
      .filter((c) => c !== ghost && body_preview.toLowerCase().includes(c.toLowerCase()));
    if (!leaks.length) return [];
    return [{
      severity: "error",
      code: "ghost_brand_leak",
      message: `Ghost-mode draft mentions: ${leaks.join(", ")} — should only mention ${ghost}.`,
    }];
  },
};

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
      const findings: Finding[] = [];
      for (const rule of Object.values(RULES)) {
        try {
          findings.push(...rule(d));
        } catch {
          // A buggy rule shouldn't kill the run.
        }
      }
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
