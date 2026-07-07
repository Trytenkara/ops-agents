// Draft QA lint rules — the reusable core of Agent 10. Extracted so the same
// checks run both in the scheduled sweep (outreach-qa/index.ts) and inline when
// an intake agent (02/03/08) stages a draft via stageDraft().

export type Severity = "warn" | "error";
export interface Finding { severity: Severity; code: string; message: string; }

export interface DraftToLint {
  subject: string | null;
  body_preview: string | null;
  assigned_operator: string | null;
  metadata: any;
}

type Rule = (d: DraftToLint) => Finding[];

const PLACEHOLDER_RE = /\{\{[^}]+\}\}|\{[A-Z_][A-Z0-9_]*\}|<<[^>]+>>|TBD|TODO|XXX/g;

const CLIENT_NAMES = ["Aurora", "Bobber", "Vita Organica", "McGinley", "Nutripro", "PharmaLab", "Sphere", "Ulo", "Tenkara", "Rove"];

export const RULES: Record<string, Rule> = {
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
    if (!body_preview || metadata?.outreach_mode !== "ghost") return [];
    const ghost = metadata?.ghost_brand as string | undefined;
    if (!ghost) return [];
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

// Run every rule over a draft and return the combined findings. A buggy rule
// must never break the caller, so each is isolated.
export function lintDraft(draft: DraftToLint): Finding[] {
  const findings: Finding[] = [];
  for (const rule of Object.values(RULES)) {
    try {
      findings.push(...rule(draft));
    } catch {
      /* a buggy rule shouldn't kill the lint */
    }
  }
  return findings;
}
