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
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runChecks } from "./rule-checks.mjs";
import { collectRules, renderSnapshot } from "./enforcement-ledger.mjs";

/** Where the runtime snapshot sits relative to a rules folder. */
const snapshotPath = (rulesDir) => join(rulesDir, "..", "src", "lib", "rules-ledger.generated.json");

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
  // OUT-10. Five: both halves of the shared module, the sweep that runs it, the
  // hold that has to say what it waits on, and a second copy of the live list.
  {
    expect: "outreach/cancel-must-release-alias",
    label: "the sweep that gives a dead hold back is deleted",
    mutate: rename("src/lib/outreach-holds.ts", "export async function releaseDeadPhasedHolds", "async function unusedReleaseDeadPhasedHolds"),
  },
  {
    expect: "outreach/cancel-must-release-alias",
    label: "the shared definition of a live draft is deleted",
    mutate: rename("src/lib/outreach-holds.ts", "export const LIVE_DRAFT_STATUSES", "const unusedLiveDraftStatuses"),
  },
  {
    expect: "outreach/cancel-must-release-alias",
    label: "outreach stops releasing leads held behind a cancelled email",
    mutate: edit("src/agents-runtime/agents/outreach/index.ts", (t) => t.split("releaseDeadPhasedHolds(").join("noRelease(")),
  },
  {
    expect: "outreach/cancel-must-release-alias",
    label: "a hold stops recording the thread it waits on",
    mutate: edit("src/agents-runtime/agents/outreach/index.ts", (t) => t.split("first_pool_thread_id").join("first_pool_unused_id")),
  },
  {
    expect: "outreach/cancel-must-release-alias",
    label: "a second copy of the live-draft list appears",
    mutate: fixture(
      "src/__selftest__/live-draft-copy.ts",
      `const { data } = await admin\n  .from("draft_references")\n  .select("id")\n  .in("status", ["staged", "reviewed", "sent", "linked"]);\n`,
    ),
  },
  // OUT-08. Six: a new askable field with no stage, the cap, the narrowing to
  // one stage, both drafting paths, and the backstop that must stay a backstop.
  {
    expect: "outreach/asks-must-be-staged",
    label: "a new askable field is added with no stage",
    mutate: edit("src/lib/quote-completeness.ts", (t) =>
      t.replace('if (!any((row) => has(row.price)))', 'if (!has(supplier?.vat_number)) add("vat_number", "your VAT number", /vat/i);\n  if (!any((row) => has(row.price)))')
    ),
  },
  {
    expect: "outreach/asks-must-be-staged",
    label: "the per-reply cap is deleted",
    mutate: rename("src/lib/quote-completeness.ts", "export const MAX_ASKS_PER_REPLY", "const UNUSED_MAX_ASKS_PER_REPLY"),
  },
  {
    expect: "outreach/asks-must-be-staged",
    label: "the selector caps but no longer narrows to one stage",
    mutate: edit("src/lib/quote-completeness.ts", (t) =>
      t.split("askStage(f.key) === stage").join("f.key !== undefined")
    ),
  },
  {
    expect: "outreach/asks-must-be-staged",
    label: "the reply drafter asks without staging",
    mutate: edit("src/lib/reply-drafter.ts", (t) => t.split("selectStagedAsks(").join("selectEverything(")),
  },
  {
    expect: "outreach/asks-must-be-staged",
    label: "the stalled-conversation chase asks without staging",
    mutate: edit("src/agents-runtime/agents/reply-manager/stalled-followup.ts", (t) =>
      t.split("selectStagedAsks(").join("selectEverything(")
    ),
  },
  {
    expect: "outreach/asks-must-be-staged",
    label: "the appended ask fires alongside the model's own asks again",
    mutate: edit("src/lib/reply-drafter.ts", (t) => t.split("countAsksInBody(draft.body) === 0").join("true")),
  },
  // DISC-09. Twelve: the two halves of the three-state lookup, and for each of
  // the five gates both the asking and the handling of "could not ask".
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "the lookup goes back to returning a bare set",
    mutate: rename("src/lib/self-supplied-materials.ts", "export async function loadSelfSuppliedMaterials", "async function unusedLoadSelfSuppliedMaterials"),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "a Tenkara outage resolves to \"nothing is self-supplied\" again",
    mutate: edit("src/lib/self-supplied-materials.ts", (t) => t.split("known: false").join("ids: new Set()  // known: no")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "discovery stops asking whether the client makes it themselves",
    mutate: edit("src/agents-runtime/agents/lead-creator/index.ts", (t) => t.split("loadSelfSuppliedMaterials(").join("neverSelfSupplied(")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "discovery reads the answer without checking it got one",
    mutate: edit("src/agents-runtime/agents/lead-creator/index.ts", (t) => t.replace(/if\s*\(!\s*(\w+(?:\.\w+)*)\.known\)/, "if (false)")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "enrichment stops asking whether the client makes it themselves",
    mutate: edit("src/agents-runtime/agents/data-enrichment/index.ts", (t) => t.split("loadSelfSuppliedMaterials(").join("neverSelfSupplied(")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "enrichment reads the answer without checking it got one",
    mutate: edit("src/agents-runtime/agents/data-enrichment/index.ts", (t) => t.replace(/if\s*\(!\s*(\w+(?:\.\w+)*)\.known\)/, "if (false)")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "outreach stops asking whether the client makes it themselves",
    mutate: edit("src/agents-runtime/agents/outreach/index.ts", (t) => t.split("loadSelfSuppliedMaterials(").join("neverSelfSupplied(")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "outreach reads the answer without checking it got one",
    mutate: edit("src/agents-runtime/agents/outreach/index.ts", (t) => t.replace(/if\s*\(!\s*(\w+(?:\.\w+)*)\.known\)/, "if (false)")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "the price pull stops asking whether the client makes it themselves",
    mutate: edit("src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts", (t) => t.split("loadSelfSuppliedMaterials(").join("neverSelfSupplied(")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "the price pull reads the answer without checking it got one",
    mutate: edit("src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts", (t) => t.replace(/if\s*\(!\s*(\w+(?:\.\w+)*)\.known\)/, "if (false)")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "the lead ingest route stops asking whether the client makes it themselves",
    mutate: edit("src/app/api/agent/leads/route.ts", (t) => t.split("loadSelfSuppliedMaterials(").join("neverSelfSupplied(")),
  },
  {
    expect: "discovery/self-supplied-gate-must-fail-closed",
    label: "the lead ingest route reads the answer without checking it got one",
    mutate: edit("src/app/api/agent/leads/route.ts", (t) => t.replace(/if\s*\(!\s*(\w+(?:\.\w+)*)\.known\)/, "if (false)")),
  },
  // DISC-05. Four: the two shared tests, and the two chokepoints that use them.
  {
    expect: "discovery/platform-is-never-manufacturer",
    label: "the shared test for a platform's own address is deleted",
    mutate: rename("src/lib/aggregator-hosts.ts", "export function isPlatformOwnedContact", "function unusedIsPlatformOwnedContact"),
  },
  {
    expect: "discovery/platform-is-never-manufacturer",
    label: "the shared test for a platform's own name is deleted",
    mutate: rename("src/lib/aggregator-hosts.ts", "export function isAggregatorPlatformName", "function unusedIsAggregatorPlatformName"),
  },
  {
    expect: "discovery/platform-is-never-manufacturer",
    label: "discovery stops rejecting a directory staged as a company",
    mutate: edit("src/agents-runtime/agents/lead-creator/scout.ts", (t) =>
      t.split("isAggregatorPlatformName(").join("neverTrue(")
    ),
  },
  {
    expect: "discovery/platform-is-never-manufacturer",
    label: "outreach can address the platform's own inbox as the supplier",
    mutate: edit("src/lib/draft-staging.ts", (t) => t.split("isPlatformOwnedContact(").join("noPlatformCheck(")),
  },

  // PERS-02. Four: the read that hides the flag, the write that skips the
  // module, and both halves of the sweep that gives a held lead back.
  {
    expect: "queues/flag-must-not-exit-queue",
    label: "a work read filters out everything marked for a human",
    mutate: fixture(
      "src/__selftest__/hide-flagged.ts",
      `const { data } = await admin\n  .from("staged_quotes")\n  .select("id")\n  .eq("needs_review", false);\n`,
    ),
  },
  {
    expect: "queues/flag-must-not-exit-queue",
    label: "a lead is parked against a case by hand, recording no case id",
    mutate: fixture(
      "src/__selftest__/hand-hold.ts",
      `await admin.from("leads_in_flight").update({\n  status: "dropped",\n  drop_reason: "escalated_to_case",\n}).eq("id", lead.id);\n`,
    ),
  },
  {
    expect: "queues/flag-must-not-exit-queue",
    label: "the sweep that gives a held lead back is deleted",
    mutate: rename("src/lib/lead-queue-holds.ts", "export async function releaseClosedHolds", "async function unusedReleaseClosedHolds"),
  },
  {
    expect: "queues/flag-must-not-exit-queue",
    label: "the sweep survives but nothing calls it",
    mutate: edit("src/agents-runtime/agents/escalation/index.ts", (t) =>
      t.split("releaseClosedHolds(").join("noopRelease(")
    ),
  },

  // AUTO-08. Six, because the invariant has six limbs and each one on its own
  // is enough to put a phone task on somebody who does not make calls.
  {
    expect: "assignment/call-owner-must-be-call-operator",
    label: "the call router picks over the whole team instead of the callers",
    mutate: rename("src/lib/call-escalation.ts", 'poolForWork(ctx.pool, { type: "call"', 'poolForWork(ctx.pool, { type: "email"'),
  },
  {
    expect: "assignment/call-owner-must-be-call-operator",
    label: "a call task is stamped with the email thread's operator",
    mutate: edit("src/agents-runtime/agents/reply-manager/call-tasks.ts", (t) =>
      t.replace("assigned_operator: routing.caller?.userId ?? null,", "assigned_operator: r.assigned_operator ?? null,")
    ),
  },
  {
    expect: "assignment/call-owner-must-be-call-operator",
    label: "a new call task insert takes its owner from the session user",
    mutate: fixture(
      "src/__selftest__/call-case-insert.ts",
      `await admin.from("cases").insert({\n  org_id: orgId,\n  type: "calling_escalation",\n  status: "open",\n  assigned_operator: actorUserId,\n});\n`,
    ),
  },
  {
    expect: "assignment/call-owner-must-be-call-operator",
    label: "case owners are all derived as desk work",
    mutate: rename("src/lib/org-cases.ts", 'call ? "call" : "email"', '"email"'),
  },
  {
    expect: "assignment/call-owner-must-be-call-operator",
    label: "a declined call derivation keeps a stamp belonging to the email desk",
    mutate: rename("src/lib/org-cases.ts", 'operatorType !== "call"', "operatorType !== undefined"),
  },
  {
    expect: "assignment/call-owner-must-be-call-operator",
    label: "removing an operator hands their calls to the email pool",
    mutate: rename("src/lib/reassign-owners.ts", 'poolForWork(pickPool, { type: "call", lane: null })', "pickPool"),
  },
  {
    expect: "assignment/call-owner-must-be-call-operator",
    label: "removing an operator leaves their open cases stamped to them",
    mutate: edit("src/lib/reassign-owners.ts", (t) => t.split('.from("cases")').join('.from("case_events")')),
  },

  // PERS-06. Three shapes, because the check has to find the table three ways:
  // a chained read, a builder held in a variable, and a real call site whose
  // reporting has been taken away.
  {
    expect: "reads/limit-must-report-remainder",
    label: "a chained read of a work table caps itself and reports nothing",
    mutate: fixture(
      "src/__selftest__/capped-chain.ts",
      `const { data } = await admin\n  .from("leads_in_flight")\n  .select("id, supplier_name")\n  .eq("status", "active")\n  .limit(200);\n`,
    ),
  },
  {
    expect: "reads/limit-must-report-remainder",
    label: "a builder variable is capped lines away from its own .from()",
    mutate: fixture(
      "src/__selftest__/capped-builder.ts",
      `let q = admin.from("cases").select("id, type").eq("status", "open");\n` +
        `if (orgIds) q = q.in("org_id", orgIds);\n` +
        `const { data } = await q.limit(50);\n`,
    ),
  },
  {
    expect: "reads/limit-must-report-remainder",
    label: "a live capped read loses its exact count, so the remainder is unknowable",
    mutate: edit("src/agents-runtime/agents/outreach-qa/index.ts", (t) =>
      t
        .split('created_at", { count: "exact" })')
        .join('created_at")')
        .split("cappedRead")
        .join("plainRead"),
    ),
  },
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
  // The copy ban is scoped to a named list of files, so a fixture in a new
  // path proves nothing: it would not be scanned either way. These break the
  // real copy that shipped the breach.
  {
    expect: "copy/no-rfq-or-em-dash-in-templates",
    label: "RFQ back in the client-facing report",
    mutate: edit("src/components/expedited-report-view.tsx", (t) =>
      t.replace("Weeks of manual\n            sourcing inquiries", "Weeks of manual\n            RFQ work"),
    ),
  },
  {
    expect: "copy/no-rfq-or-em-dash-in-templates",
    label: "em dash back in the supplier reply prompt",
    mutate: edit("src/lib/reply-drafter.ts", (t) =>
      t.replace("- MATERIAL SCOPE: stay", "- MATERIAL SCOPE — stay"),
    ),
  },
  // Comment stripping has to take the comment and leave the code. Strip too
  // eagerly and every line carrying a trailing note becomes a blind spot.
  // reply-drafter.ts:14 already holds an em dash in a comment, so the clean
  // baseline is the other half of this proof.
  {
    expect: "copy/no-rfq-or-em-dash-in-templates",
    label: "an em dash in real copy on a line that also carries a comment",
    mutate: edit("src/lib/reply-drafter.ts", (t) =>
      `const teaser = "Following up — did you get this?"; // chase copy\n${t}`,
    ),
  },
  {
    expect: "copy/no-rfq-or-em-dash-in-templates",
    label: "a scoped file is renamed, so the ban silently stops reading it",
    mutate: (files) =>
      files.map((f) =>
        f.path === "src/lib/reply-drafter.ts" ? { ...f, path: "src/lib/reply-drafter-v2.ts" } : f,
      ),
  },
  {
    expect: "copy/scope-must-cover-every-draft-site",
    label: "a new draft-staging call site that nobody added to the copy scope",
    mutate: fixture(
      "src/agents-runtime/agents/new-outreach/index.ts",
      `await stageDraft({ body: "hello" });\n`,
    ),
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
    expect: "shipping/no-blanket-stage",
    label: "the pre-commit hook is gone",
    mutate: drop(".githooks/pre-commit"),
  },
  {
    expect: "shipping/no-blanket-stage",
    label: "the hook stops looking at what was added",
    mutate: rename(".githooks/pre-commit", "diff-filter=A", "diff-filter=X"),
  },
  {
    expect: "shipping/no-blanket-stage",
    label: "a script stages everything",
    mutate: fixture("scripts/__selftest__/ship.sh", `git add -A\ngit commit -m x\n`),
  },
  {
    expect: "orgs/supplier-query-must-scope-to-client",
    label: "an unscoped read rides in on a scoped one in the same file",
    mutate: fixture(
      "src/__selftest__/supplier-query-two.ts",
      `const scoped = \`select id from public.suppliers where $1 = any(organization_ids)\`;\n` +
        `const all = \`select id, name, poc_email from public.suppliers order by name\`;\n`,
    ),
  },
  {
    expect: "orgs/supplier-query-must-scope-to-client",
    label: "the whole table read back and filtered in JS",
    mutate: edit("src/lib/supplier-profile-fill.ts", (s) =>
      s.replace("     WHERE $1::uuid = any(organization_ids)`,\n    [tenkaraOrgId]", "`")
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
    expect: "density/solids-require-bulk",
    label: "the writer stops calling the density guard",
    mutate: rename("src/lib/staged-quotes.ts", "validateQuoteDensity", "validateQuoteDensityX"),
  },
  {
    expect: "density/solids-require-bulk",
    label: "the guard stops exporting its throwing entry point",
    mutate: rename(
      "src/lib/quote-density-guard.ts",
      "export function assertQuoteDensity",
      "function assertQuoteDensity",
    ),
  },
  {
    // The version of this check that shipped read the file with `files.find`,
    // so deleting it was silence rather than a violation. This is the mutation
    // that would have caught that.
    expect: "density/solids-require-bulk",
    label: "the guard module is deleted outright",
    mutate: drop("src/lib/quote-density-guard.ts"),
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

  // DISC-01. The rule already held when the check was written, so every
  // mutation here has to break real code — a fixture alone would only prove the
  // check can fire on something nobody wrote.
  {
    expect: "discovery/source-must-use-alias-resolver",
    label: "the alias resolver is deleted",
    mutate: drop("src/lib/material-aliases.ts"),
  },
  {
    expect: "discovery/source-must-use-alias-resolver",
    label: "the resolver stops exporting the entry point every source calls",
    mutate: rename(
      "src/lib/material-aliases.ts",
      "export async function getMaterialAliases",
      "async function getMaterialAliases",
    ),
  },
  {
    expect: "discovery/source-must-use-alias-resolver",
    label: "a live source stops asking what else the trade calls it",
    mutate: edit("src/agents-runtime/agents/lead-creator/sourceready.ts", (t) =>
      t.split("aliases").join("searchTerms"),
    ),
  },
  {
    // The case the rule is actually written against: not a source that stops
    // using the resolver, but a new one that never started.
    expect: "discovery/source-must-use-alias-resolver",
    label: "a fifth source stages leads without ever asking for aliases",
    mutate: fixture(
      "src/agents-runtime/agents/lead-creator/newsource.ts",
      `const rows = hits.map((h) => ({ org_id: orgId, supplier_name: h.name }));\n` +
        `await admin.from("leads_in_flight").insert(rows);\n`,
    ),
  },

  // DISC-02. Both sources explain in a comment above the seed why aliases
  // belong in the word set. `codeLines` strips the comment, so the mutation
  // proves the check is reading the code and not the explanation.
  {
    expect: "discovery/relevance-filter-must-accept-aliases",
    label: "SourceReady filters its alias hits against our name alone",
    mutate: rename(
      "src/agents-runtime/agents/lead-creator/sourceready.ts",
      "[req.materialName, req.inci, ...(req.aliases ?? [])]",
      "[req.materialName, req.inci]",
    ),
  },
  {
    expect: "discovery/relevance-filter-must-accept-aliases",
    label: "ImportYeti filters its alias hits against our name alone",
    mutate: rename(
      "src/agents-runtime/agents/lead-creator/importyeti.ts",
      "[req.materialName, req.inci, ...(req.aliases ?? [])]",
      "[req.materialName, req.inci]",
    ),
  },

  // DISC-07. Same name, different grade, is deliberately two materials.
  {
    expect: "materials/never-merge-on-name-alone",
    label: "the grade gate is dropped from the candidate loop",
    mutate: rename(
      "src/lib/material-merge-flags.ts",
      "      if (!gradesMergeable(live[i].grades, live[j].grades)) continue;\n",
      "",
    ),
  },
  {
    expect: "materials/never-merge-on-name-alone",
    label: "a second flagger writes merge pairs that never met the grade test",
    mutate: fixture(
      "src/agents-runtime/agents/material-sweep/index.ts",
      `await admin.from("material_merge_flags").insert({ keep_material_id: a, drop_material_id: b });\n`,
    ),
  },
  {
    expect: "materials/never-merge-on-name-alone",
    label: "the merge module is deleted outright",
    mutate: drop("src/lib/material-merge-flags.ts"),
  },

  // AUTO-05. This rule holds today by absence — no agent writes membership —
  // so there is no real code to break. That makes the fixtures the whole proof,
  // and each one is a shape that would otherwise have gone unseen.
  {
    expect: "orgs/no-operator-membership-writes",
    label: "an agent adds the call operator the audit found missing",
    mutate: fixture(
      "src/agents-runtime/agents/ownership-repair/index.ts",
      `await admin.from("user_org_assignments").insert({ user_id: u, org_id: o, operator_type: "call" });\n`,
    ),
  },
  {
    // The builder split over three lines. A line-at-a-time scanner sees
    // `.from(...)` and `.update(...)` as unrelated and reports nothing.
    expect: "orgs/no-operator-membership-writes",
    label: "the write is spread across a multi-line builder chain",
    mutate: fixture(
      "src/app/api/agent/retype-operator/route.ts",
      `await admin\n  .from("user_org_assignments")\n  .update({ lanes: ["direct"] })\n  .eq("user_id", userId);\n`,
    ),
  },
  {
    expect: "orgs/no-operator-membership-writes",
    label: "a repair script goes round PostgREST and writes the table in SQL",
    mutate: fixture(
      "src/scripts/fix-membership.ts",
      "const sql = `insert into user_org_assignments (user_id, org_id) values ($1, $2)`;\n",
    ),
  },
  {
    // The allow list is three paths, and it has to be a path match. A substring
    // match would wave through anything whose name merely ends the same way.
    expect: "orgs/no-operator-membership-writes",
    label: "a near-miss filename is not the allowed server action",
    mutate: fixture(
      "src/app/actions/bulk-operators.ts",
      `await admin.from("user_roles").delete().eq("user_id", userId);\n`,
    ),
  },

  // OUT-02. Both of these are the state the code was actually in, so each
  // mutation is a revert rather than an invention.
  {
    expect: "outreach/no-terminal-drop-without-channel",
    label: "a listing URL counts as having a website again",
    mutate: rename(
      "src/agents-runtime/agents/data-enrichment/enrich.ts",
      "const ownDomainWebsite = website && !isAggregatorDomain(hostOf(website)) ? website : null;",
      "const ownDomainWebsite = website;",
    ),
  },
  {
    expect: "outreach/no-terminal-drop-without-channel",
    label: "the resolver is gated on something other than the missing own domain",
    mutate: rename(
      "src/agents-runtime/agents/data-enrichment/enrich.ts",
      "if (!ownDomainWebsite && sourceUrl) {",
      "if (isContactPath(scoutEmail) && sourceUrl) {",
    ),
  },
  {
    expect: "outreach/no-terminal-drop-without-channel",
    label: "an unread page can retire the row again",
    mutate: rename(
      "src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts",
      "if (platformAsSupplier && !noCheckout && result.infra_failure !== true) {",
      "if (platformAsSupplier && !noCheckout) {",
    ),
  },
  {
    expect: "outreach/no-terminal-drop-without-channel",
    label: "the enrichment agent this rule is anchored to is gone",
    mutate: drop("src/agents-runtime/agents/data-enrichment/enrich.ts"),
  },

  // PERS-05. The first two are the code as it shipped for three weeks.
  {
    expect: "outreach/contactless-must-park-not-drop",
    label: "a contactless lead is dropped again",
    mutate: fixture(
      "src/agents-runtime/agents/outreach/retire.ts",
      `await admin.from("leads_in_flight").update({ status: "dropped", drop_reason: "no_contact_recovered" }).eq("id", id);\n`,
    ),
  },
  {
    expect: "outreach/contactless-must-park-not-drop",
    label: "the no-contact branch stops parking the lead",
    mutate: rename(
      "src/agents-runtime/agents/outreach/index.ts",
      "contactlessParkIds.push(lead.id);",
      "noop(lead.id);",
    ),
  },
  {
    expect: "outreach/contactless-must-park-not-drop",
    label: "the branch this rule reads is renamed out from under it",
    mutate: rename("src/agents-runtime/agents/outreach/index.ts", "if (!hasEmail) {", "if (!hasAnyEmail) {"),
  },
  {
    expect: "outreach/contactless-must-park-not-drop",
    label: "the outreach agent is deleted outright",
    mutate: drop("src/agents-runtime/agents/outreach/index.ts"),
  },
  {
    expect: "retry/bound-must-be-declared",
    label: "a new agent bounds its retries and tells nobody",
    mutate: fixture("src/__selftest__/retry.ts", `const MAX_RETRY_ROUNDS = 4;\n`),
  },
  {
    expect: "retry/bound-must-be-declared",
    label: "an existing bound is renamed, so the rules folder no longer names it",
    mutate: rename(
      "src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts",
      "FLAG_AFTER_ATTEMPTS",
      "REVIEW_ATTEMPTS_BEFORE_CASE",
    ),
  },
  {
    expect: "ship/migration-must-accompany-schema-read",
    label: "code reads a table no migration creates",
    mutate: fixture(
      "src/__selftest__/schema.ts",
      `const rows = await admin.from("lead_contact_attempts").select("id");\n`,
    ),
  },
  {
    expect: "ship/migration-must-accompany-schema-read",
    label: "code calls an RPC no migration creates",
    mutate: fixture("src/__selftest__/rpc.ts", `await admin.rpc("requeue_dropped_contact_leads", {});\n`),
  },
  {
    // The other direction, and the one ENG-1036 actually was: the read is
    // fine and the schema is what is missing.
    expect: "ship/migration-must-accompany-schema-read",
    label: "the migration creating a live table is lost",
    mutate: edit("supabase/migrations/0001_init.sql", (t) =>
      t.replace("create table if not exists public.leads_in_flight", "create table if not exists public.leads_tmp"),
    ),
  },
  {
    expect: "crawl/no-agent-identifying-user-agent",
    label: "a crawler introduces itself and is refused",
    mutate: fixture(
      "src/__selftest__/ua.ts",
      `const headers = { "User-Agent": "Mozilla/5.0 (compatible; TenkaraSourcing/1.0; +https://ops.tenkara.ai)" };\n`,
    ),
  },
  {
    expect: "crawl/no-agent-identifying-user-agent",
    label: "the name is a bare bot token rather than the company",
    mutate: fixture("src/__selftest__/ua2.ts", `const h = { "user-agent": "PriceScout/2.1 (+contact)" };\n`),
  },
  {
    expect: "ui/no-numeric-placeholder-in-value-field",
    label: "an empty price field looks like a filled one",
    mutate: fixture("src/__selftest__/Price.tsx", `export const P = () => <input placeholder="450.00" />;\n`),
  },
  {
    expect: "fetch/blocked-must-not-read-as-empty",
    label: "a new fetcher's refusal flag is never read at the call site",
    mutate: fixture(
      "src/__selftest__/crawl.ts",
      [
        "async function grabPage(url: string): Promise<{ ok: boolean; html: string } | null> {",
        "  const res = await fetch(url);",
        "  return { ok: res.ok, html: await res.text() };",
        "}",
        "export async function scan(url: string) {",
        "  const page = await grabPage(url);",
        "  return page ? page.html.length : 0;",
        "}",
        "",
      ].join("\n"),
    ),
  },
  {
    expect: "fetch/blocked-must-not-read-as-empty",
    label: "the crawl parses a refused page's body anyway",
    mutate: edit("src/agents-runtime/agents/data-enrichment/enrich.ts", (t) =>
      t.replace(
        /\} else \{\n(?:[^\n]*\n){5}\s*continue;\n\s*\}/,
        "}",
      ),
    ),
  },
  {
    expect: "fetch/blocked-must-not-read-as-empty",
    label: "a challenge page is read as the supplier's listing",
    mutate: rename(
      "src/agents-runtime/agents/data-enrichment/storefront-resolve.ts",
      "if (!listing.ok)",
      "if (false)",
    ),
  },
  {
    expect: "retry/no-inline-classifier",
    label: "the shared classifier stops being exported",
    mutate: rename(
      "src/lib/retry-verdict.ts",
      "export function classifyFailure(",
      "function classifyFailure(",
    ),
  },
  {
    expect: "retry/no-inline-classifier",
    label: "a page refusing a visitor goes back to reading as a credentials verdict",
    mutate: rename("src/lib/retry-verdict.ts", 'scope === "page"', 'scope === "api"'),
  },
  {
    expect: "retry/no-inline-classifier",
    label: "the browser pull hand-rolls its retry test again",
    mutate: edit("src/lib/browserbase-pull.ts", (t) =>
      t.replace(/classifyFailure\(/g, "localVerdict("),
    ),
  },
  {
    expect: "retry/no-inline-classifier",
    label: "the browser pull calls an exhausted retry a login wall",
    mutate: edit("src/lib/browserbase-pull.ts", (t) =>
      t.replace('emptyResult("needs_review", `${v.reason} after', 'emptyResult("login_required", `${v.reason} after'),
    ),
  },
  {
    expect: "retry/no-inline-classifier",
    label: "the owner push loop hand-rolls its retry test again",
    mutate: edit("src/lib/sync-thread-owners.ts", (t) =>
      t.replace(/classifyFailure\(/g, "localVerdict("),
    ),
  },
  {
    expect: "retry/no-inline-classifier",
    label: "a second rate-limit test appears in a runtime file",
    mutate: fixture(
      "src/lib/scratch-retry.ts",
      'const isRateLimit = (msg: string) => /\\b429\\b|rate.?limit|too many requests/i.test(msg);\n',
    ),
  },
  {
    expect: "contacts/guessed-combo-requires-own-domain-and-flag",
    label: "the guess is no longer gated on the supplier's own domain",
    mutate: rename(
      "src/agents-runtime/agents/data-enrichment/enrich.ts",
      "!isAggregatorDomain(",
      "Boolean(",
    ),
  },
  {
    expect: "contacts/guessed-combo-requires-own-domain-and-flag",
    label: "a guessed address is stored without being labelled a guess",
    mutate: edit("src/agents-runtime/agents/data-enrichment/enrich.ts", (t) =>
      t.replace('contactConfidence = "guessed"', 'contactConfidence = "low"'),
    ),
  },
  {
    expect: "contacts/guessed-combo-requires-own-domain-and-flag",
    label: "the file the rule is anchored to is gone",
    mutate: drop("src/agents-runtime/agents/data-enrichment/enrich.ts"),
  },
  {
    expect: "contacts/guessed-combo-requires-own-domain-and-flag",
    label: "the gate goes back to its own private copy of the host list",
    mutate: edit("src/agents-runtime/agents/data-enrichment/enrich.ts", (t) =>
      t.replace(
        "const AGGREGATOR_DOMAINS = NOT_A_SUPPLIER_HOST;",
        'const AGGREGATOR_DOMAINS = ["knowde.com", "alibaba.com"];',
      ),
    ),
  },
  {
    expect: "contacts/guessed-combo-requires-own-domain-and-flag",
    label: "the shared union of platform hosts stops being exported",
    mutate: rename(
      "src/lib/aggregator-hosts.ts",
      "export const NOT_A_SUPPLIER_HOST",
      "const NOT_A_SUPPLIER_HOST",
    ),
  },
  {
    expect: "contacts/guessed-combo-requires-own-domain-and-flag",
    label: "the directory hosts are restated instead of imported",
    mutate: edit("src/lib/aggregator-hosts.ts", (t) =>
      t.replace(
        'import { DIRECTORY_HOSTS } from "@/lib/marketplace-hosts";',
        'const DIRECTORY_HOSTS = ["knowde.com", "thomasnet.com"];',
      ),
    ),
  },
  {
    expect: "contacts/confidence-derived-from-source",
    label: "every resolved address is stamped verified again, whatever found it",
    mutate: edit("src/agents-runtime/agents/data-enrichment/enrich.ts", (t) =>
      t.replace(
        /contactConfidence =\n\s*!cacheServed[^;]*;/,
        'contactConfidence = "verified";',
      ),
    ),
  },
  {
    expect: "contacts/confidence-derived-from-source",
    label: "a cache replay inherits a previous run's verification",
    mutate: rename(
      "src/agents-runtime/agents/data-enrichment/enrich.ts",
      "!cacheServed && contactSource && VERIFYING_SOURCES",
      "contactSource && VERIFYING_SOURCES",
    ),
  },
  {
    expect: "contacts/confidence-derived-from-source",
    label: "a second site hands out the label with no test behind it",
    mutate: fixture(
      "src/__selftest__/confidence.ts",
      'export function label(email: string) {\n  return { email, contact_confidence: "verified" };\n}\n',
    ),
  },
  {
    expect: "contacts/confidence-derived-from-source",
    label: "a writer invents a fourth confidence word",
    mutate: fixture(
      "src/__selftest__/confidence-word.ts",
      'export const row = { contact_confidence: "high" };\n',
    ),
  },
  {
    expect: "contacts/confidence-derived-from-source",
    label: "another system's confidence rating is copied into the column",
    mutate: fixture(
      "src/__selftest__/confidence-copied.ts",
      'export function fill(payload: Record<string, unknown>, r: Record<string, unknown>) {\n  payload.contact_confidence = r["confidence"];\n}\n',
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "the shared helper drops the infra outcome and goes back to two",
    mutate: rename("src/lib/dry-pass.ts", 'export type PassOutcome = "found" | "dry" | "infra";', 'export type PassOutcome = "found" | "dry";'),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "the import client reads a 200 with no rows array as an empty market",
    mutate: rename(
      "src/lib/importyeti-client.ts",
      'rowsOrThrow(body, "data", "ImportYeti") as ImportYetiSupplier[]',
      "Array.isArray(body.data) ? body.data : []",
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "an empty alias list goes back to being cached as the answer",
    mutate: edit("src/lib/material-aliases.ts", (t) =>
      t.replace(/const pass = advanceDryPass\([\s\S]*?\);/, "const pass = { dry: 0, done: true };"),
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "the price pull retires an umbrella lead on one clean zero again",
    mutate: edit("src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts", (t) =>
      t.replace(/const pass = advanceDryPass\([\s\S]*?\);/, "const pass = { dry: 1, done: true };"),
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "a site that printed nothing freezes its fields on the first read",
    mutate: edit("src/agents-runtime/agents/data-enrichment/web-fill-run.ts", (t) =>
      t.replace(/advanceDryPass\(/g, "noCount("),
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "a blocked document page rests for sixty days as if it were read",
    mutate: rename(
      "src/agents-runtime/agents/document-retrieval/index.ts",
      "retry_after: wall && !pass.done ? retryAfter(pass.dry, BLOCKED_RETRY_DAYS) : null,",
      "retry_after: null,",
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "SourceReady goes back to its own private copy of the counter",
    mutate: edit("src/agents-runtime/agents/lead-creator/index.ts", (t) =>
      t.replace(/const \{ dry, done, persist, note: boundNote \} = advanceDryPass\([\s\S]*?\);/, "const { dry, done, persist, note: boundNote } = { dry: 0, done: true, persist: true, note: null };"),
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "a crashed re-check is written back as an operator finding",
    mutate: edit("src/agents-runtime/agents/marketplace-validation/index.ts", (t) =>
      t.replace(
        "        return null;\n      }\n\n      // Same class",
        '        result = { classification: "needs_review", notes: `Re-check failed: ${e.message}` } as any;\n      }\n\n      // Same class',
      ),
    ),
  },
  {
    expect: "discovery/zero-must-not-be-terminal",
    label: "the re-check ignores an infra failure that arrived by return value",
    mutate: rename(
      "src/agents-runtime/agents/marketplace-validation/index.ts",
      "if (result.infra_failure) {",
      "if (false) {",
    ),
  },
  {
    expect: "orgs/inbound-org-must-try-the-thread",
    label: "the router gives up on the mailbox without asking the thread",
    mutate: rename("src/lib/tenkara-inbound.ts", '.from("draft_references")\n        .select("org_id")', '.from("orgs")\n        .select("id")'),
  },
  {
    expect: "orgs/inbound-org-must-try-the-thread",
    label: "a thread naming two clients hands back the first one",
    mutate: rename("src/lib/tenkara-inbound.ts", "if (owners.size === 1) {", "if (owners.size >= 1) {"),
  },
  {
    expect: "ui/flagged-set-must-have-a-surface",
    label: "the client's own tab stops rendering the flagged panel",
    mutate: rename("src/app/(app)/work/orgs/[slug]/page.tsx", "<FlaggedWorkPanel", "<FlaggedWorkPanelDisabled"),
  },
  {
    expect: "ui/flagged-set-must-have-a-surface",
    label: "the panel picks the sets it knows about instead of the ones that exist",
    mutate: edit("src/components/flagged-work-panel.tsx", (t) =>
      t.replace("const live = groups.filter((g) => g.total !== 0);", 'const live = groups.filter((g) => g.key === "withheld_price");'),
    ),
  },
  {
    expect: "ui/flagged-set-must-have-a-surface",
    label: "the loader names its sets rather than walking the registry",
    mutate: rename("src/lib/flagged-work.ts", "FLAGGED_SETS.map(async (set)", "[FLAGGED_SETS[0]].map(async (set)"),
  },
  {
    expect: "ui/flagged-set-must-have-a-surface",
    label: "an agent runs the publish gate and drops what it took away",
    mutate: edit("src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts", (t) =>
      t.replace(/const withheld = withheldMark\(/, "const withheld = noMark("),
    ),
  },
  {
    expect: "ui/flagged-set-must-have-a-surface",
    label: "a new agent gates a price with no mark at all",
    mutate: fixture(
      "src/agents-runtime/agents/__selftest__/gate.ts",
      'import { publishableTiers } from "@/lib/price-publish";\n\nexport function store(tiers: any[]) {\n  return publishableTiers(tiers, { where: "selftest" }).tiers;\n}\n',
    ),
  },
  {
    expect: "outreach/one-thread-per-supplier",
    label: "the material joins the consolidation key, so one supplier gets four emails",
    mutate: edit("src/agents-runtime/agents/outreach/index.ts", (t) =>
      t.replace(
        'return orgScopedKey(c.lead.org_id, "s", c.lead.supplier_id);',
        'return orgScopedKey(c.lead.org_id, "s", c.lead.supplier_id, c.lead.material_id);',
      ),
    ),
  },
  {
    expect: "outreach/one-thread-per-supplier",
    label: "the group is staged one lead at a time",
    mutate: edit("src/agents-runtime/agents/outreach/index.ts", (t) =>
      t.replace("leads: pool.map((c) => c.lead as OutreachLead),", "leads: [primary.lead as OutreachLead],"),
    ),
  },
  {
    expect: "outreach/one-thread-per-supplier",
    label: "the file the rule is anchored to is gone",
    mutate: drop("src/agents-runtime/agents/outreach/index.ts"),
  },
  {
    expect: "suppliers/approval-denied-is-not-do-not-contact",
    label: "the reverted guard comes back at the do-not-contact chokepoint",
    mutate: fixture(
      "src/__selftest__/denied.ts",
      `if (deniedIds.has(supplierId)) return { blocked: true, reason: "denied in Tenkara" };\n`,
    ),
  },
  {
    expect: "suppliers/approval-denied-is-not-do-not-contact",
    label: "something reads the denied set out of the suppliers table again",
    mutate: fixture("src/__selftest__/denied2.ts", `const q = \`select id from suppliers where approval = 'denied'\`;\n`),
  },
  {
    expect: "ui/no-global-review-route",
    label: "an eighth route joins the global review tree",
    mutate: fixture(
      "src/app/(app)/work/review/quotes/page.tsx",
      `export default async function Page() { return null; }\n`,
    ),
  },
  {
    expect: "comm/one-slack-sender",
    label: "an agent rolls its own Slack post",
    mutate: fixture(
      "src/__selftest__/notify.ts",
      `await fetch("https://slack.com/api/chat.postMessage", { method: "POST" });\n`,
    ),
  },
  {
    expect: "comm/one-slack-sender",
    label: "a user token appears, so the fleet could post as a person",
    mutate: fixture("src/__selftest__/token.ts", `const tok = process.env.SLACK_USER_TOKEN;\n`),
  },
  {
    expect: "comm/one-slack-sender",
    label: "the alert helper goes back to its own fetch",
    mutate: edit("src/lib/slack-alert.ts", (t) =>
      t.replace("const res = await postSlackMessage({ text: body });", 'const res = await fetch("https://slack.com/api/chat.postMessage");'),
    ),
  },
  {
    expect: "outreach/no-send-outside-operator-action",
    label: "an agent sends the draft it just staged",
    mutate: fixture("src/__selftest__/send.ts", 'await tenkara.post("/drafts/" + id + "/send");\n'),
  },
  {
    expect: "outreach/no-send-outside-operator-action",
    label: "auto-send arrives as a flag on the draft body",
    mutate: fixture("src/__selftest__/send2.ts", `const body = { subject, auto_send: true };\n`),
  },
  {
    expect: "retry/bound-must-be-declared",
    label: "the shared bound stops naming its own exhaustion",
    mutate: rename("lib/dry-pass.ts", "note: string | null", "quiet: string | null"),
  },
  {
    expect: "retry/bound-must-be-declared",
    label: "a caller spends a bound to exhaustion without saying so",
    mutate: edit("lib/material-aliases.ts", (t) =>
      t.replace("if (pass.note) await log?.(`Retry bound reached", "if (false) await log?.(`Retry bound reached").replace(/pass\.note/g, "pass.done")),
  },
  {
    expect: "copy/no-direct-draft-create",
    label: "the transport stops sanitising outbound copy",
    mutate: rename("lib/tenkara.ts", "function sanitizeOutbound(", "function unusedSanitizeOutbound("),
  },
  {
    expect: "copy/no-direct-draft-create",
    label: "a new conversation sends the caller's unsanitised body",
    mutate: rename("lib/tenkara.ts", "body_html: conv.bodyHtml", "body_html: input.bodyHtml"),
  },
  {
    expect: "data/required-grade-resolved-at-staging",
    label: "the dealbreaker grade goes back to being one drafter's job",
    mutate: rename("lib/draft-staging.ts", "await resolveRequiredGrade(", "await Promise.resolve({}); void ("),
  },
  {
    expect: "data/required-grade-resolved-at-staging",
    label: "the resolved grade is dropped before the linter sees it",
    mutate: rename("lib/draft-staging.ts", "const lintMeta = { ...meta,", "const lintMeta = { ...callerMeta,"),
  },
  {
    expect: "data/required-grade-resolved-at-staging",
    label: "an unreachable Tenkara reads as no dealbreaker",
    mutate: edit("lib/draft-staging.ts", (t) => t.split("grade_spec_unavailable").join("grade_ok")),
  },
  {
    expect: "discovery/marker-shape-must-fail-closed",
    label: "an unreadable credit-gate marker defaults back to finished",
    mutate: rename(
      "agents/lead-creator/index.ts",
      "done: r.value?.done === true",
      "done: r.value?.done !== undefined ? !!r.value.done : true",
    ),
  },
  {
    expect: "discovery/marker-shape-must-fail-closed",
    label: "the marker is written without the key the reader looks for",
    mutate: edit("agents/lead-creator/index.ts", (t) => {
      const i = t.indexOf("SOURCEREADY_SEARCHED_KEY(material.id)");
      return t.slice(0, i) + t.slice(i).replace("\n                  done,", "");
    }),
  },
  {
    expect: "rules/no-orphaned-check-id",
    label: "a check is added under an id no rule names",
    mutate: fixture(
      "scripts/lib/rule-checks.mjs",
      'const rule = "zzz/no-rule-names-this";\n',
    ),
  },
  {
    // A waiver that holds nothing back still grants permission, and it pads the
    // ratchet so the real debt underneath cannot be read. Handing the corpus a
    // cleaned-up copy of a waived file is the same thing as somebody fixing it
    // and leaving the entry behind.
    expect: "meta/no-second-copy-of-a-shared-guard",
    label: "a grandfathered site is fixed and its waiver is left in place",
    mutate: fixture(
      "skills/contact-finder-agent/backfill.py",
      "# the inline mailbox list is gone\n",
    ),
  },
];

// The checks over rules/ itself read from disk, so they mutate a copy.
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
    // The same generator writes a second artefact, the snapshot the weekly
    // review reads at runtime (SHIP-08). A stale one is worse than a stale
    // ledger: the review would report a rulebook that no longer exists and
    // read as a clean bill of health.
    expect: "rules/enforcement-ledger-must-match",
    label: "someone hand-edits the runtime snapshot",
    mutate: () => {},
    mutateSnapshot: (p) =>
      writeFileSync(p, readFileSync(p, "utf8").replace('"bucket": "Guard"', '"bucket": "Guarded"')),
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
    // Both directions, because the register drifted both ways at once: it
    // listed rules closed that morning and omitted three that owed work.
    expect: "rules/debt-register-must-match-the-ledger",
    label: "an owing rule is dropped from the debt register",
    mutate: (dir) => {
      const p = join(dir, "OUTSTANDING.md");
      const text = readFileSync(p, "utf8");
      const row = text.slice(text.indexOf("## The full enforcement debt")).match(/^\| [A-Z]+-\d+ \|.*$/m);
      if (!row) return;
      writeFileSync(p, text.replace(row[0] + "\n", ""));
    },
  },
  {
    expect: "rules/debt-register-must-match-the-ledger",
    label: "the register keeps a row for a rule that no longer owes anything",
    mutate: (dir) => {
      const p = join(dir, "OUTSTANDING.md");
      const text = readFileSync(p, "utf8");
      const row = text.slice(text.indexOf("## The full enforcement debt")).match(/^\| [A-Z]+-\d+ \|.*$/m);
      if (!row) return;
      writeFileSync(p, text.replace(row[0], row[0] + "\n| META-01 | long since settled |"));
    },
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

// Every check owes a mutation, and until now nothing said so. `covered` was
// computed and used only to print a count, so a check added with no mutation
// was indistinguishable from one that had passed — the same shape as the bug
// META-09 exists for, one level up. DATA-07's check was added on 2026-08-20
// with no mutation behind it, and it was also fail-open and reachable under an
// id the ledger did not use. Nothing noticed for a day.
//
// Reading the source is the point: the id has to be discoverable without
// running the check, because a check only announces its id when it fires and a
// check that never fires is exactly the one being looked for.
const CHECKS_SRC = fileURLToPath(new URL("./rule-checks.mjs", import.meta.url));
const declaredCheckIds = () =>
  new Set(
    [...readFileSync(CHECKS_SRC, "utf8").matchAll(/(?:^|[\s{(])rule:\s*"([^"]+)"/g)].map((m) => m[1]),
  );

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
    // Path counts as well as text: a mutation that renames a file to prove an
    // anchor fires leaves every byte of content untouched.
    const unchanged = (f, i) => f.text === files[i].text && f.path === files[i].path;
    if (mutated.length === files.length && mutated.every(unchanged)) {
      inert.push({ ...m, why: "the mutation changed nothing — the pattern it edits is already gone" });
      continue;
    }
    if (!ids(runChecks(mutated, rulesDir)).has(m.expect)) inert.push(m);
  }

  const tmp = mkdtempSync(join(tmpdir(), "rules-self-test-"));
  try {
    for (const m of RULES_MUTATIONS) {
      ran++;
      const dir = join(tmp, `case-${ran}`, "rules");
      cpSync(rulesDir, dir, { recursive: true });
      m.mutate(dir);
      // The case has to mirror the repository, not just the rules folder: the
      // drift check also compares the runtime snapshot, which lives under a
      // sibling src/. Written from the mutated rules, so the only thing wrong
      // in this world is the one thing the mutation broke.
      mkdirSync(dirname(snapshotPath(dir)), { recursive: true });
      writeFileSync(snapshotPath(dir), renderSnapshot(collectRules(dir), dir));
      if (m.mutateSnapshot) m.mutateSnapshot(snapshotPath(dir));
      if (!ids(runChecks(files, dir)).has(m.expect)) inert.push(m);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const covered = new Set([...MUTATIONS, ...RULES_MUTATIONS].map((m) => m.expect));
  const uncovered = [...declaredCheckIds()].filter((id) => !covered.has(id)).sort();

  if (uncovered.length) {
    console.error(
      `\ncheck-rules --self-test FAILED: ${uncovered.length} check(s) have no mutation.\n`,
    );
    for (const id of uncovered) console.error(`  ${id}`);
    console.error("\nA check with nothing breaking it on purpose is a claim, not a guard.");
    console.error("Add a mutation to MUTATIONS in scripts/lib/rule-self-test.mjs that breaks");
    console.error("the codebase and expects this id back.\n");
    return false;
  }

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
