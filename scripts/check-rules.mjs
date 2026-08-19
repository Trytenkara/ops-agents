#!/usr/bin/env node
// Machine enforcement for the standing rules in /rules.
//
// A rule that is only written down is a convention: it holds until someone who
// has not read it adds a call site. Each rule below is one that has already
// been broken in this repo at least once. CI runs this on every push, so the
// break is caught at the commit rather than in production weeks later.
//
// Adding a rule here is cheap. If you are tempted to add an exemption instead,
// that usually means the guard belongs in a shared module, not in a waiver.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));
const violations = [];

function forbid({ rule, why, fix, test, allow = [] }) {
  for (const f of files) {
    if (allow.some((a) => f.path.endsWith(a))) continue;
    f.text.split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("//")) return;
      if (test(line, f)) violations.push({ rule, why, fix, where: `${f.path}:${i + 1}`, line: line.trim().slice(0, 120) });
    });
  }
}

// 1. Foreign prices. convertToUsd converts ONE amount, so calling it per tier
// lets a single failed lookup fall back to the raw foreign number and publish
// yuan as dollars. normalizeToUsd takes one rate for the whole listing and
// quarantines when there is none.
forbid({
  rule: "fx/no-direct-convertToUsd",
  why: "converting per amount republishes the raw foreign number when one lookup fails",
  fix: "use normalizeToUsd(currency) once per listing and apply fx.convert to every amount",
  allow: ["src/lib/fx.ts"],
  test: (l) => /\bconvertToUsd\b/.test(l),
});

// 2. Who counts as the same company. Every hardcoded provider list in this repo
// has been incomplete (the first held ten Western providers and silently merged
// every Chinese and Indian supplier into five mailboxes).
forbid({
  rule: "contacts/no-inline-mailbox-list",
  why: "a hardcoded consumer-provider list is never complete and merges unrelated suppliers",
  fix: "use isConsumerMailboxDomain / corporateDomainForMatch from @/lib/mailbox-domain",
  allow: ["src/lib/mailbox-domain.ts"],
  test: (l) => /["'](?:gmail|yahoo|hotmail|outlook|qq|163|126|foxmail|rediffmail)\.com["']/.test(l),
});

// 3. Scarce throughput. Real clients before internal test orgs, one comparator.
forbid({
  rule: "queues/no-inline-org-priority",
  why: "five agents each hand-rolled this and a sixth queue would have served orgs first-come",
  fix: "use sortOrgsByPriority / sortByOrgPriority / partitionRealVsInternal from @/lib/org-priority",
  allow: ["src/lib/org-priority.ts"],
  test: (l) => /is_internal/.test(l) && /\.sort\(|localeCompare|\?\s*1\s*:\s*0|Number\(/.test(l),
});

// 4. Control Room never renders a native OS dropdown.
forbid({
  rule: "ui/no-native-select",
  why: "native dropdowns look and behave wrong in the Control Room",
  fix: "use Select from @/components/ui/select",
  allow: ["src/components/ui/select.tsx"],
  test: (l, f) => f.path.endsWith(".tsx") && /<select[\s>]/.test(l),
});

// 5. Outbound copy. sanitizeDraft strips these at staging, but a literal in a
// prompt or template still teaches the model to produce them.
forbid({
  rule: "copy/no-rfq-or-em-dash-in-templates",
  why: "outbound copy says 'sourcing inquiry', and em dashes are banned in all output",
  fix: "rewrite the literal; sanitizeDraft is the runtime backstop, not a licence",
  allow: ["src/lib/email-style.ts", "src/agents-runtime/agents/browserbase-escalation/index.ts"],
  test: (l) => /^\s*(?:body|subject|prompt|template|text)\b.*(?:\bRFQ\b|—)/.test(l),
});

// 6. The staging chokepoint must keep applying the style sanitizer. This is the
// guard on the guard: if someone removes the call, every drafter silently loses
// it and nothing else in CI would notice.
{
  const staging = files.find((f) => f.path.endsWith("src/lib/draft-staging.ts"));
  if (staging && !/sanitizeDraft\(/.test(staging.text)) {
    violations.push({
      rule: "copy/staging-must-sanitize",
      why: "stageDraft is the only point every outbound draft passes through",
      fix: "restore the sanitizeDraft call in stageDraft",
      where: "src/lib/draft-staging.ts",
      line: "sanitizeDraft call missing",
    });
  }
  const style = files.find((f) => f.path.endsWith("src/lib/email-style.ts"));
  if (style && !/stripInternalNotes\(/.test(style.text)) {
    violations.push({
      rule: "copy/sanitize-must-strip-internal-notes",
      why: "a drafter once pasted the raw call log into a supplier email ('Unable to reach after two call attempts')",
      fix: "restore the stripInternalNotes call in sanitizeDraft",
      where: "src/lib/email-style.ts",
      line: "stripInternalNotes call missing",
    });
  }
  if (style && !/CONCESSION_STRIPS/.test(style.text)) {
    violations.push({
      rule: "copy/sanitize-must-strip-concessions",
      why: "a chase told a live supplier \"if the timing isn't right, just say the word and I'll stop chasing\"",
      fix: "restore the CONCESSION_STRIPS pass in clean()",
      where: "src/lib/email-style.ts",
      line: "CONCESSION_STRIPS missing",
    });
  }
  const chokepoint = files.find((f) => f.path.endsWith("src/lib/draft-staging.ts"));
  if (chokepoint && !/tailorToThread\(/.test(chokepoint.text)) {
    violations.push({
      rule: "copy/staging-must-tailor-to-thread",
      why: "template follow-ups re-asked for price, pack size, lead time and MOQ the supplier had already answered in the thread",
      fix: "restore the tailorToThread pass in stageDraft",
      where: "src/lib/draft-staging.ts",
      line: "tailorToThread call missing",
    });
  }
  if (chokepoint && !/approvedContactsFor\(/.test(chokepoint.text)) {
    violations.push({
      rule: "contacts/staging-must-guard-fabrication",
      why: "agents must never invent an address, phone or email in an outgoing body",
      fix: "restore the contact-guard allowlist in stageDraft",
      where: "src/lib/draft-staging.ts",
      line: "approvedContactsFor call missing",
    });
  }
  if (chokepoint && !/orgScopedExternalId\(/.test(chokepoint.text)) {
    violations.push({
      rule: "orgs/staging-must-scope-external-id",
      why: "Tenkara is idempotent on external_id, so an unscoped key lets one client adopt another client's conversation and draft",
      fix: "wrap the externalId in orgScopedExternalId(orgId, ...) from @/lib/org-isolation inside stageDraft",
      where: "src/lib/draft-staging.ts",
      line: "orgScopedExternalId call missing",
    });
  }
}

// 6b. Any file that creates a Tenkara conversation must scope the idempotency
// key to an org. stageDraft is the chokepoint everything should use, but a
// direct caller must not be able to skip the scoping just by not using it.
for (const f of files) {
  if (f.path.endsWith("src/lib/tenkara.ts")) continue;
  if (!/createTenkaraConversation\(\{/.test(f.text)) continue;
  if (/orgScopedExternalId\(/.test(f.text)) continue;
  violations.push({
    rule: "orgs/conversation-create-must-scope-external-id",
    why: "Tenkara is idempotent on external_id, so an unscoped key hands one client another client's conversation",
    fix: "build the key with orgScopedExternalId(orgId, ...) from @/lib/org-isolation, or stage through stageDraft",
    where: f.path,
    line: "orgScopedExternalId missing beside createTenkaraConversation",
  });
}

// 6c. Tables whose natural key is shared across clients (a supplier address, a
// page URL) must always be upserted on a key that includes org_id. Migration
// 0120 moved those unique constraints; this keeps the writer in step with them,
// because an unscoped onConflict silently overwrites another client's row.
const ORG_SCOPED_CONFLICT_KEYS = ["supplier_email", "page_hash"];
for (const f of files) {
  for (const m of f.text.matchAll(/onConflict:\s*"([^"]+)"/g)) {
    const key = m[1];
    const cols = key.split(",").map((c) => c.trim());
    if (cols.includes("org_id")) continue;
    if (!cols.some((c) => ORG_SCOPED_CONFLICT_KEYS.includes(c))) continue;
    violations.push({
      rule: "orgs/upsert-conflict-key-must-include-org",
      why: "this key is shared between clients, so an unscoped upsert overwrites another client's row",
      fix: `use onConflict: "org_id,${key}"`,
      where: f.path,
      line: `onConflict: "${key}"`,
    });
  }
}

// 7. Every Supabase client must keep the truncation guard, or a read that hits
// the 1000-row cap goes back to lying about being complete.
for (const f of ["src/lib/supabase/admin.ts", "src/lib/supabase/server.ts"]) {
  const mod = files.find((x) => x.path.endsWith(f));
  if (mod && !/truncationGuardedFetch\(/.test(mod.text)) {
    violations.push({
      rule: "reads/client-must-guard-truncation",
      why: "PostgREST silently drops rows past 1000 and reports no error",
      fix: "pass global: { fetch: truncationGuardedFetch() } when creating the client",
      where: f,
      line: "truncationGuardedFetch missing",
    });
  }
}

// 8. Every path that persists a price must pass it through the publish gate,
// or an unreadable or unconverted number reaches the client again.
for (const f of [
  "src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts",
  "src/agents-runtime/agents/browserbase-escalation/index.ts",
  "src/app/actions/leads.ts",
  "src/lib/staged-quotes.ts",
]) {
  const mod = files.find((x) => x.path.endsWith(f));
  if (mod && !/publishable(Price|Tiers)\(/.test(mod.text)) {
    violations.push({
      rule: "price/writer-must-gate",
      why: "a price must never be stored unreadable, negative or in a foreign currency",
      fix: "route the write through publishablePrice / publishableTiers from @/lib/price-publish",
      where: f,
      line: "price publish gate missing",
    });
  }
}

// 9. The owner of an open draft or case is derived on every read, and the
// Tenkara inbox is kept in step by pushing that same answer. Three surfaces had
// hand-copied the key-building, which is precisely how Control Room and the
// email app came to name different people in the first place: they agreed only
// as long as nobody edited one copy. Rebuilding it from a record's metadata
// anywhere outside the shared helper is the break.
// The copies spanned several lines each, so this is a whole-file test: building
// an auto key AND reading supplier_name out of a record's metadata in the same
// file means the derivation was re-implemented rather than called.
for (const f of files) {
  if (f.path.endsWith("src/lib/operator-assignment.ts")) continue;
  // spreadOwnerId, not orgAutoKey: the reset planner legitimately builds keys to
  // project the split without deriving anyone's owner, and the rule must not
  // push it into a waiver list.
  if (/spreadOwnerId\(/.test(f.text) && /metadata[^\n]{0,30}supplier_name/.test(f.text)) {
    violations.push({
      rule: "assignment/derive-owner-via-recordOwnerId",
      why: "copies of the owner derivation drift apart, and Control Room then disagrees with the email app",
      fix: "use recordOwnerId(ctx, row, workType) from @/lib/operator-assignment",
      where: f.path,
      line: "owner derivation rebuilt from record metadata",
    });
  }
}

// 10. Tenkara keeps ONE suppliers table for every client, and `organization_ids`
// says whose each row is. A query that reads it without naming a client can
// return another client's supplier: the name-keyed linker did exactly that and
// labelled 907 of 3,141 conversations with the wrong client's supplier record.
// The linker itself now takes the client as a required argument, which the type
// checker enforces; this rule stops the next raw query being written unscoped.
// The invariant is not "never read that table", it is: you may FETCH a supplier
// you have already identified, and you may not SEARCH for one across clients.
// Fetching by id is safe, the id names one row. Searching by name is what
// crossed clients, so a read that is not keyed on a supplier id has to say
// whose suppliers it wants.
for (const f of files) {
  if (f.path.endsWith("src/lib/tenkara-supplier-linker.ts")) continue;
  if (/organization_ids/.test(f.text)) continue;
  for (const m of f.text.matchAll(/public\.suppliers([\s\S]{0,160})/g)) {
    const tail = m[1];
    // `join public.suppliers s on s.id = q.supplier_id`, `where id = $1`.
    if (/\bon\s+\w*\.?id\s*=|\bwhere\s+id\s*=/i.test(tail)) continue;
    violations.push({
      rule: "orgs/supplier-query-must-scope-to-client",
      why: "Tenkara's suppliers table is shared between clients, so searching it by name can return another client's supplier (this labelled 907 conversations and filled profiles with the wrong client's contact)",
      fix: "filter on organization_ids, or resolve through resolveSupplierIdByName(admin, orgId, name) from @/lib/tenkara-supplier-linker",
      where: f.path,
      line: "public.suppliers searched with no client scope",
    });
  }
}

// ORG-08. `organization_ids` is the set of every client that owns a shared row.
// Indexing a fixed slot (`organization_ids[1]`) only matches rows where that
// client sorts first, so a supplier shared with a second client is invisible to
// the query. Agent 20 read the supplier list this way and promoted leads as
// brand-new duplicates of suppliers it simply could not see. Membership is
// `$n = any(organization_ids)` in SQL or `.includes(orgId)` in TS, never a
// positional index.
forbid({
  rule: "orgs/no-fixed-index-org-membership",
  why: "organization_ids holds every client that owns the row; a fixed index (organization_ids[1]) only matches rows where that client sorts first, so a supplier shared by two clients is missed and the lead is promoted as a brand-new duplicate",
  fix: "test membership with `$n = any(organization_ids)` in SQL or `.includes(orgId)` in TS, never a positional index",
  test: (line) => /organization_ids\s*\[\s*\d+\s*\]/.test(line),
});

{
  const duplicateGuard = files.find((f) => f.path.endsWith("src/agents-runtime/agents/duplicate-guard/index.ts"));
  if (!duplicateGuard || !/where\s+\$1\s*=\s*any\(organization_ids\)\s+and\s+cardinality\(organization_ids\)\s*=\s*1/i.test(duplicateGuard.text)) {
    violations.push({
      rule: "orgs/duplicate-guard-requires-exclusive-supplier",
      why: "suppliers are unique per client; a legacy row shared across clients cannot suppress creation of either client's independent supplier row",
      fix: "Agent 20 must require both org membership and cardinality(organization_ids) = 1 when loading duplicate targets",
      where: duplicateGuard?.path ?? "src/agents-runtime/agents/duplicate-guard/index.ts",
      line: "duplicate supplier query does not require exclusive org ownership",
    });
  }
}

forbid({
  rule: "comm/one-slack-channel",
  why: "COMM-06: everything the fleet says goes to one channel. When each caller picked its own, agent output landed in four channels plus two DMs and nobody could tell what had already been read",
  fix: "call postSlackMessage({ text }) — it resolves the single ops channel itself. Never pass a channel, and never read a channel id from env or a literal",
  test: (line) =>
    /postSlackMessage\(\s*\{[^}]*\bchannel\s*:/.test(line) ||
    /\bchannel\s*:\s*(process\.env\.[A-Z_]*(CHANNEL|SLACK|DM)[A-Z_]*|["'`]C0[A-Z0-9]{8,}|["'`]D0[A-Z0-9]{8,})/.test(line) ||
    /process\.env\.(SLACK_ESCALATION_CHANNEL_ID|SLACK_FEEDBACK_CHANNEL_ID|SLACK_CONTACT_GUARD_CHANNEL_ID|SOURCING_HEALTH_SLACK_CHANNEL|EXPIRY_CHANNEL_ID|LEAD_SCANNER_SLACK_CHANNEL_ID|SAM_SLACK_DM_ID)\b/.test(line),
  allow: ["src/lib/slack.ts"],
});

// Every rule in rules/ must declare, in a fixed vocabulary, what actually
// enforces it. "Honour" used to be allowed and 51 rules quietly accumulated
// under it, each one reading as protected and none of them being protected.
// The vocabulary forces the author to choose at the moment of writing:
//   Guard       a check or shared module makes it impossible. Built.
//   Audit       a scheduled job reports the break. Built.
//   Check owed  a build check is possible and is not built yet.
//   Audit owed  no build check can see it, a scheduled job can. Not built.
//   Judgement   nothing mechanical can ever verify it. Human, by design.
//   None        outside this repository, cannot be checked here.
//   Retired     the rule no longer applies.
// Anything "owed" is a debt, so it must also be named in OUTSTANDING.md.
{
  const dir = join(ROOT, "rules");
  const vocabulary =
    /^\*\*Enforcement:\*\* (Guard\b|Audit —|Audit owed\b|Check owed\b|Judgement\.|None\.|Retired\b|See [A-Z]+-\d+\.)/m;
  const outstanding = readFileSync(join(dir, "OUTSTANDING.md"), "utf8");

  for (const name of readdirSync(dir)) {
    if (!/^\d+.*\.md$/.test(name)) continue;
    const text = readFileSync(join(dir, name), "utf8");
    for (const section of text.split(/\n(?=## )/)) {
      const head = section.match(/^## ([A-Z]+-\d+) — (.+)/);
      if (!head) continue;
      const where = `rules/${name}`;
      const line = `${head[1]} — ${head[2]}`;

      if (!vocabulary.test(section)) {
        violations.push({
          rule: "rules/every-rule-declares-enforcement",
          why: "a rule whose enforcement is not stated in the fixed vocabulary reads as protected without saying what protects it",
          fix: "make the Enforcement line begin with one of: 'Guard — <module or check-rules id>', 'Audit — <job>', 'Check owed — <check-rules id>', 'Audit owed — <job>', 'Judgement.', 'None.', 'Retired <date>', or 'See <RULE-ID>.'",
          where,
          line,
        });
        continue;
      }

      // A debt that is not on the outstanding list is a debt nobody will pay.
      if (/^\*\*Enforcement:\*\*[\s\S]*?\bowed\b/m.test(section) && !outstanding.includes(head[1])) {
        violations.push({
          rule: "rules/owed-enforcement-must-be-outstanding",
          why: "a rule that admits it needs a guard, and is not on the outstanding list, is how a gap goes quiet",
          fix: `add ${head[1]} to rules/OUTSTANDING.md, or change its Enforcement line to Judgement if nothing mechanical can ever check it`,
          where,
          line,
        });
      }
    }
  }
}

if (!violations.length) {
  console.log(`check-rules: ${files.length} files, no violations.`);
  process.exit(0);
}

const byRule = new Map();
for (const v of violations) {
  if (!byRule.has(v.rule)) byRule.set(v.rule, []);
  byRule.get(v.rule).push(v);
}
console.error(`\ncheck-rules FAILED with ${violations.length} violation(s).\n`);
for (const [rule, list] of byRule) {
  console.error(`  ${rule}`);
  console.error(`    why: ${list[0].why}`);
  console.error(`    fix: ${list[0].fix}`);
  for (const v of list) console.error(`      ${v.where}  ${v.line}`);
  console.error("");
}
console.error("These are standing rules from /rules. Fix the call site, or move");
console.error("the logic into the shared module the rule points at.\n");
process.exit(1);
