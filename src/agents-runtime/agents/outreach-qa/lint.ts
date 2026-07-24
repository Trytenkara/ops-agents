// Draft QA lint rules — the reusable core of Agent 10. Extracted so the same
// checks run both in the scheduled sweep (outreach-qa/index.ts) and inline when
// an intake agent (02/03/08) stages a draft via stageDraft().

import { findFabricatedContacts } from "@/lib/contact-guard";
import { findMisspellings } from "@/lib/material-spelling";

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
  // Steadfast anti-fabrication guard: an outgoing supplier email must never
  // state a shipping address, phone, or email that wasn't given to us. The
  // allowlist (approved per-brand values + the recipient's own address) is
  // injected by the caller as metadata.approved_contacts. An error here
  // HARD-BLOCKS the draft in draft-staging.ts (status="blocked").
  fabricated_contact_info: ({ body_preview, subject, metadata }) => {
    const text = [subject ?? "", body_preview ?? ""].join("\n");
    if (!text.trim()) return [];
    const allowed = Array.isArray(metadata?.approved_contacts) ? (metadata.approved_contacts as string[]) : [];
    const violations = findFabricatedContacts(text, allowed);
    if (!violations.length) return [];
    const detail = violations.map((v) => `${v.kind}: ${v.value}`).join("; ");
    return [{
      severity: "error",
      code: "fabricated_contact_info",
      message: `Draft states contact info not on the approved allowlist — likely fabricated: ${detail}. Defer to a human or add the real value to BRAND_CONTACTS.`,
    }];
  },
  likely_misspelling: ({ subject, body_preview }) => {
    const found = findMisspellings(`${subject ?? ""}\n${body_preview ?? ""}`);
    if (!found.length) return [];
    const pairs = found.map(([wrong, right]) => `"${wrong}" → "${right}"`);
    return [{
      severity: "warn",
      code: "likely_misspelling",
      message: `Likely misspelled material name(s): ${pairs.join(", ")}. Confirm the ingredient before sending.`,
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
