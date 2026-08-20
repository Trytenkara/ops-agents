// Does each guard actually fire?
//
// Every check in rule-checks.mjs claims a rule is enforced, and the enforcement
// ledger repeats that claim to anyone reading rules/. Nothing tested the claim.
// COMM-08 is the proof it needed testing: it was published as an enforced Guard
// while its pattern matched zero of the 1,083 lines it was written to catch. A
// check that matches nothing and a check that finds nothing wrong produce the
// same green build.
//
// So each entry below breaks the codebase on purpose, in memory, and demands
// the matching rule id come back. A guard that stays silent under its own
// mutation is inert: reclassify it from `Guard` to `Check owed` in rules/ and
// list it in OUTSTANDING.md. Do not delete the mutation to make this pass.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChecks } from "./rule-checks.mjs";

// --- corpus mutators -------------------------------------------------------

/** Add a file holding a known-bad snippet. */
const fixture = (path, text) => (files) => files.concat([{ path, text }]);

/** Rewrite the one file whose path ends with `suffix`. */
const edit = (suffix, fn) => (files) =>
  files.map((f) => (f.path.endsWith(suffix) ? { ...f, text: fn(f.text) } : f));

/** Break a required call by renaming it, leaving the file otherwise intact. */
const rename = (suffix, from, to) => edit(suffix, (t) => t.split(from).join(to));

/** Delete a file outright. Anchored checks must treat this as a violation, not
 *  as nothing to check — that is the fail-open shape PERS-08 is about. */
const drop = (suffix) => (files) => files.filter((f) => !f.path.endsWith(suffix));

// --- the mutations ---------------------------------------------------------

const MUTATIONS = [
  // Line scanners. A synthetic file is enough: these read one line at a time.
  {
    expect: "fx/no-direct-convertToUsd",
    mutate: fixture("src/__selftest__/fx.ts", `const usd = convertToUsd(amount, "CNY");\n`),
  },
  {
    expect: "contacts/no-inline-mailbox-list",
    mutate: fixture("src/__selftest__/mailbox.ts", `const free = ["gmail.com", "qq.com"];\n`),
  },
  {
    expect: "queues/no-inline-org-priority",
    mutate: fixture(
      "src/__selftest__/queue.ts",
      `orgs.sort((a, b) => Number(a.is_internal) - Number(b.is_internal));\n`,
    ),
  },
  {
    expect: "ui/no-native-select",
    mutate: fixture("src/__selftest__/Picker.tsx", `export const P = () => <select name="tier" />;\n`),
  },
  {
    expect: "copy/no-rfq-or-em-dash-in-templates",
    mutate: fixture("src/__selftest__/copy.ts", `  subject: "RFQ for propylene glycol",\n`),
  },
  {
    expect: "copy/no-rfq-or-em-dash-in-templates",
    label: "em dash in a template literal",
    mutate: fixture("src/__selftest__/copy-dash.ts", `  body: "Following up — did you get this?",\n`),
  },
  {
    expect: "orgs/no-fixed-index-org-membership",
    mutate: fixture("src/__selftest__/membership.ts", `const owner = row.organization_ids[0];\n`),
  },
  {
    expect: "comm/one-slack-channel",
    mutate: fixture(
      "src/__selftest__/slack.ts",
      `await postSlackMessage({ channel: "C0ABCDEFGHI", text: "hi" });\n`,
    ),
  },

  // Whole-file scanners.
  {
    expect: "orgs/conversation-create-must-scope-external-id",
    mutate: fixture(
      "src/__selftest__/convo.ts",
      `await createTenkaraConversation({ externalId: \`\${supplierId}:\${materialId}\` });\n`,
    ),
  },
  {
    expect: "orgs/upsert-conflict-key-must-include-org",
    mutate: fixture(
      "src/__selftest__/upsert.ts",
      `await admin.from("supplier_profiles").upsert(row, { onConflict: "supplier_email" });\n`,
    ),
  },
  {
    expect: "assignment/derive-owner-via-recordOwnerId",
    mutate: fixture(
      "src/__selftest__/owner.ts",
      `const key = spreadOwnerId(ctx, k);\nconst n = row.metadata?.supplier_name;\n`,
    ),
  },
  {
    expect: "orgs/supplier-query-must-scope-to-client",
    mutate: fixture(
      "src/__selftest__/supplier-query.ts",
      `const q = \`select id from public.suppliers where lower(name) = lower($1) limit 1\`;\n`,
    ),
  },
  {
    expect: "orgs/supplier-id-written-must-be-scoped",
    label: "id copied off a row",
    mutate: fixture(
      "src/__selftest__/write-supplier.ts",
      `await admin.from("draft_references").insert({ supplier_id: quote.supplier_id });\n`,
    ),
  },
  {
    expect: "orgs/supplier-id-written-must-be-scoped",
    label: "id off a request body",
    mutate: fixture(
      "src/app/api/__selftest__/route.ts",
      `await admin.from("x").insert({ supplier_id: parsed.data.supplier_id });\n`,
    ),
  },

  // Anchored checks: break the required call in the real file.
  {
    expect: "copy/staging-must-sanitize",
    mutate: rename("src/lib/draft-staging.ts", "sanitizeDraft(", "sanitizeDraftX("),
  },
  {
    expect: "copy/staging-must-tailor-to-thread",
    mutate: rename("src/lib/draft-staging.ts", "tailorToThread(", "tailorToThreadX("),
  },
  {
    expect: "contacts/staging-must-guard-fabrication",
    mutate: rename("src/lib/draft-staging.ts", "approvedContactsFor(", "approvedContactsForX("),
  },
  {
    expect: "orgs/staging-must-scope-external-id",
    mutate: rename("src/lib/draft-staging.ts", "orgScopedExternalId(", "orgScopedExternalIdX("),
  },
  {
    expect: "copy/sanitize-must-strip-internal-notes",
    mutate: rename("src/lib/email-style.ts", "stripInternalNotes(", "stripInternalNotesX("),
  },
  {
    expect: "copy/sanitize-must-strip-concessions",
    mutate: rename("src/lib/email-style.ts", "CONCESSION_STRIPS", "CONCESSIONS"),
  },
  {
    // This one already got through once. The check was a bare substring test,
    // so the rename left it matching and the guard reported nothing.
    expect: "copy/sanitize-must-strip-concessions",
    label: "the constant is renamed rather than removed",
    mutate: rename("src/lib/email-style.ts", "CONCESSION_STRIPS", "CONCESSION_STRIPS_X"),
  },
  {
    expect: "copy/sanitize-must-strip-concessions",
    label: "only the comment naming it is left behind",
    mutate: edit("src/lib/email-style.ts", (t) =>
      t
        .split("\n")
        .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? l : l.replace(/\bCONCESSION_STRIPS\b/g, "GONE")))
        .join("\n"),
    ),
  },
  {
    expect: "reads/client-must-guard-truncation",
    mutate: rename("src/lib/supabase/admin.ts", "truncationGuardedFetch(", "truncationGuardedFetchX("),
  },
  {
    expect: "price/writer-must-gate",
    mutate: edit("src/lib/staged-quotes.ts", (t) =>
      t.replace(/publishable(Price|Tiers)\(/g, "publishableX$1("),
    ),
  },
  {
    expect: "price/capture-must-carry-source-text",
    label: "the writer stops checking provenance",
    mutate: rename("src/lib/tenkara-inbound.ts", "verifyPriceProvenance(", "verifyPriceProvenanceX("),
  },
  {
    expect: "price/capture-must-carry-source-text",
    label: "an extractor stops asking for the supplier's wording",
    mutate: rename(
      "src/lib/reply-quote-extract.ts",
      "price_source_text is MANDATORY",
      "price_source_text is optional",
    ),
  },
  {
    expect: "price/tier-rungs-never-collapse",
    mutate: edit("src/lib/staged-quotes.ts", (t) =>
      t.replace(/provenanceKey|sourceTextKey/g, "plainKey"),
    ),
  },
  {
    expect: "orgs/candidate-match-must-not-key-on-null",
    label: "the shared resolver is gone",
    mutate: rename("src/lib/tenkara-inbound.ts", "soleReplyTarget(", "soleReplyTargetX("),
  },
  {
    expect: "replies/idempotency-must-exclude-triage-artefacts",
    label: "the triage artefact is counted as a prior reply",
    mutate: rename(
      "src/lib/tenkara-inbound.ts",
      "unmatched_inbound_clarification",
      "some_other_draft_kind",
    ),
  },
  {
    expect: "replies/idempotency-must-exclude-triage-artefacts",
    label: "an answered message keeps its open case and sendable draft",
    mutate: rename("src/lib/tenkara-inbound.ts", "await retireUnmatchedTriage(", "await retireX("),
  },
  {
    expect: "orgs/duplicate-guard-requires-exclusive-supplier",
    mutate: rename(
      "src/agents-runtime/agents/duplicate-guard/index.ts",
      "cardinality(organization_ids) = 1",
      "true",
    ),
  },

  // Fail-closed. Renaming a guarded file must not quietly retire its guard.
  {
    expect: "copy/staging-must-sanitize",
    label: "the anchor file is renamed away",
    mutate: drop("src/lib/draft-staging.ts"),
  },
  {
    expect: "reads/client-must-guard-truncation",
    label: "the anchor file is renamed away",
    mutate: drop("src/lib/supabase/server.ts"),
  },
  {
    expect: "price/writer-must-gate",
    label: "the anchor file is renamed away",
    mutate: drop("src/app/actions/leads.ts"),
  },
];

// The three checks over rules/ itself read from disk, so they mutate a copy.
const RULES_MUTATIONS = [
  {
    expect: "rules/enforcement-ledger-must-match",
    label: "someone hand-edits the ledger",
    mutate: (dir) => {
      const p = join(dir, "ENFORCEMENT.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("| **Guard**", "| **Guarded**"));
    },
  },
  {
    expect: "rules/every-rule-declares-enforcement",
    label: "a rule states its enforcement outside the vocabulary",
    mutate: (dir) => {
      const p = join(dir, "00-meta.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("**Enforcement:**", "**Enforcement:** Honour."));
    },
  },
  {
    expect: "rules/owed-enforcement-must-be-outstanding",
    label: "a debt is dropped from the outstanding list",
    mutate: (dir) => writeFileSync(join(dir, "OUTSTANDING.md"), "# Outstanding\n\nNothing.\n"),
  },
  {
    // A rule may hold half its invariant and admit the rest is not built. The
    // admission is on the second line, and the parser used to stop at the first
    // — so 69 of 118 rules were published half-quoted and five read as fully
    // enforced. META-05 is a plain Guard and is not in OUTSTANDING.md, so
    // giving it a second-line debt must be noticed.
    expect: "rules/owed-enforcement-must-be-outstanding",
    label: "a debt declared on the second line of an Enforcement value",
    mutate: (dir) => {
      const p = join(dir, "00-meta.md");
      writeFileSync(
        p,
        readFileSync(p, "utf8").replace(
          "**Enforcement:** Guard — `tsconfig.json` include scope.",
          "**Enforcement:** Guard — `tsconfig.json` include scope.\nCheck owed — `meta/scratch-files-must-not-be-committed`.",
        ),
      );
    },
  },
];

// --- runner ----------------------------------------------------------------

const ids = (vs) => new Set(vs.map((v) => v.rule));

export function selfTest(files, rulesDir) {
  const baseline = runChecks(files, rulesDir);
  if (baseline.length) {
    console.error("check-rules --self-test: the working tree already has violations.");
    console.error("Fix those first; a mutation cannot be told apart from a real break.\n");
    for (const v of baseline) console.error(`  ${v.rule}  ${v.where}  ${v.line}`);
    return false;
  }

  const inert = [];
  let ran = 0;

  for (const m of MUTATIONS) {
    ran++;
    const mutated = m.mutate(files);
    if (mutated.length === files.length && mutated.every((f, i) => f.text === files[i].text)) {
      inert.push({ ...m, why: "the mutation changed nothing — the pattern it edits is already gone" });
      continue;
    }
    if (!ids(runChecks(mutated, rulesDir)).has(m.expect)) inert.push(m);
  }

  const tmp = mkdtempSync(join(tmpdir(), "rules-self-test-"));
  try {
    for (const m of RULES_MUTATIONS) {
      ran++;
      const dir = join(tmp, `case-${ran}`);
      cpSync(rulesDir, dir, { recursive: true });
      m.mutate(dir);
      if (!ids(runChecks(files, dir)).has(m.expect)) inert.push(m);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const covered = new Set([...MUTATIONS, ...RULES_MUTATIONS].map((m) => m.expect));

  if (inert.length) {
    console.error(`\ncheck-rules --self-test FAILED: ${inert.length} of ${ran} mutations went unnoticed.\n`);
    for (const m of inert) {
      console.error(`  ${m.expect}${m.label ? ` (${m.label})` : ""}`);
      console.error(`    ${m.why ?? "the codebase was broken on purpose and this check stayed silent"}`);
    }
    console.error("\nThis guard is inert. Either fix the check, or be honest in rules/:");
    console.error("change its Enforcement line from Guard to Check owed and add it to");
    console.error("OUTSTANDING.md. Deleting the mutation is not a fix.\n");
    return false;
  }

  console.log(`check-rules --self-test: ${ran} mutations, ${covered.size} rules, all caught.`);
  return true;
}
