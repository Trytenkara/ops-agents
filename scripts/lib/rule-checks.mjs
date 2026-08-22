// Every machine-enforced rule, as one pure function over a corpus of files.
//
// This lives apart from the CLI for one reason: a guard that is never exercised
// is indistinguishable from a guard that works. COMM-08 sat in the ledger as an
// enforced Guard while its pattern matched zero lines out of 1,083 candidates.
// Because `runChecks` takes the corpus as an argument, the self-test can hand it
// a deliberately broken copy and insist the check fires. See rule-self-test.mjs.
//
// A rule that is only written down is a convention: it holds until someone who
// has not read it adds a call site. Each rule below is one that has already
// been broken in this repo at least once. CI runs this on every push, so the
// break is caught at the commit rather than in production weeks later.
//
// Adding a rule here is cheap. If you are tempted to add an exemption instead,
// that usually means the guard belongs in a shared module, not in a waiver.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UNCLASSIFIED, vocabularyHint } from "./enforcement-vocab.mjs";
import { collectRules, renderLedger, renderSnapshot } from "./enforcement-ledger.mjs";

/**
 * @param {Array<{path: string, text: string}>} files the corpus to check
 * @param {string} rulesDir path to the rules/ folder
 * @returns {Array<{rule: string, why: string, fix: string, where: string, line: string}>}
 */
export function runChecks(files, rulesDir) {
  const violations = [];

  // Most checks below are anchored to one file: find it, then assert something
  // about its contents. Written as `const m = files.find(...); if (m && ...)`
  // that fails OPEN — rename or move the file and the check stops running, the
  // build stays green, and the rule it protects is silently unenforced. That is
  // the same shape as the bug PERS-08 is about: absence read as success.
  //
  // `anchor` makes the missing file the violation. If a file is legitimately
  // renamed, this check is the thing that tells you a guard moved with it.
  function anchor(pathSuffix, { rule, why, fix }) {
    const found = files.find((f) => f.path.endsWith(pathSuffix));
    if (found) return found;
    violations.push({
      rule,
      why: `${why} — and the file this check reads is no longer there, so nothing was checked at all`,
      fix: `${fix}. If the file moved, update the path in scripts/check-rules.mjs so the guard moves with it`,
      where: pathSuffix,
      line: "anchor file not found; this rule is currently unenforced",
    });
    return null;
  }

  // Comments are where a rule explains itself, so they name the very symbols
  // these checks look for. Testing raw text means the explanation satisfies the
  // check that the code is still there.
  const code = (text) =>
    text
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  // A comment is prose about the code, not the code. Skipping only lines that
  // START with `//` left `foo(); // convertToUsd is banned here` reading as a
  // call to convertToUsd, and left every JSDoc and `{/* ... */}` line in. The
  // `[^:]` keeps `https://` intact.
  const uncommented = (line) => {
    if (/^\s*(?:\{?\/\*|\*)/.test(line)) return "";
    return line.replace(/\/\*.*?\*\//g, "").replace(/(^|[^:])\/\/.*$/, "$1");
  };

  // Python and shell say the same thing with `#`, and Python's docstring is a
  // triple-quoted string used as prose — the same trap in a syntax the JS
  // stripper cannot see. A skill's module docstring said "downstream
  // convertToUsd handles conversion" and was read as a call to it.
  const stripPython = (text) => {
    let fence = null;
    return text.split("\n").map((raw) => {
      let out = "";
      let i = 0;
      while (i < raw.length) {
        if (fence) {
          const end = raw.indexOf(fence, i);
          if (end === -1) break;
          i = end + 3;
          fence = null;
        } else {
          const m = /"""|'''/.exec(raw.slice(i));
          if (!m) {
            out += raw.slice(i);
            break;
          }
          out += raw.slice(i, i + m.index);
          fence = m[0];
          i += m.index + 3;
        }
      }
      // A `#` inside a string literal is stripped too. That can only lose a
      // hit on that one line; reading a comment as code invents one.
      return out.replace(/#.*$/, "");
    });
  };

  const stripped = new Map();
  const codeLines = (f) => {
    let lines = stripped.get(f.path);
    if (!lines) {
      lines = /\.(py|sh)$/.test(f.path)
        ? stripPython(f.text)
        : f.text.split("\n").map(uncommented);
      stripped.set(f.path, lines);
    }
    return lines;
  };

  // The skills in /workspace/.claude/skills are a second repository, older than
  // these checks, and they hand-roll lists this repo keeps in one module. They
  // cannot import a TypeScript module, so the real fix is a shared data file
  // both languages read; that is owed work, not something to do behind a build
  // gate. These exact sites are grandfathered so the gate can be switched on
  // today and every NEW break fails. A ratchet, not an exemption: nothing is
  // added to this list. See rules/OUTSTANDING.md, the skills-corpus section.
  const GRANDFATHERED = new Set([
    "contacts/no-inline-mailbox-list@skills/contact-finder-agent/backfill.py",
    "contacts/no-inline-mailbox-list@skills/detect-supplier-dupes/detect.mjs",
    "contacts/no-inline-mailbox-list@skills/importyeti-resolve-contacts/resolve.py",
    "queues/no-inline-org-priority@skills/contact-finder-agent/bulk_backfill_workflow.js",
    // Four skill scripts post to Slack directly. They run outside the deploy
    // and cannot import from src, so the shared sender is not reachable from
    // them; the user-token half of COMM-05 still covers them.
    "comm/one-slack-sender@skills/aggregator-inquiry/prepare.mjs",
    "comm/one-slack-sender@skills/california-chemicals-watchdog/check.py",
    "comm/one-slack-sender@skills/materials-expiry-slack/expiry_sweep.py",
    "comm/one-slack-sender@skills/sourcing-health-watchdog/check.py",
    "comm/one-slack-sender@skills/report-issue-triage/SKILL.md",
  ]);

  /**
   * @param {object} o
   * @param {string[]} [o.allow]  paths this rule does not apply to
   * @param {string[]} [o.scope]  if given, the ONLY paths this rule applies to
   * @param {RegExp[]} [o.exempt] lines that are not what the rule is about
   * @param {(l: string) => string} [o.normalize] applied before `test`
   */
  function forbid({ rule, why, fix, test, allow = [], scope, exempt = [], normalize }) {
    for (const f of files) {
      if (scope && !scope.includes(f.path)) continue;
      if (allow.some((a) => f.path.endsWith(a))) continue;
      if (GRANDFATHERED.has(`${rule}@${f.path}`)) continue;
      const lines = codeLines(f);
      f.text.split("\n").forEach((raw, i) => {
        const line = lines[i];
        if (!line.trim()) return;
        if (exempt.some((re) => re.test(line))) return;
        if (test(normalize ? normalize(line) : line, f)) {
          violations.push({ rule, why, fix, where: `${f.path}:${i + 1}`, line: raw.trim().slice(0, 120) });
        }
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
  // prompt still teaches the model to produce them, and a client deliverable
  // that is rendered rather than staged never meets sanitizeDraft at all: the
  // expedited report has been telling clients about "Weeks of manual RFQ work"
  // in exactly that gap.
  //
  // The old pattern required the line to BEGIN with body/subject/prompt/etc.
  // Not one line in the repo does, so it matched 0 of 540 candidate lines while
  // COMM-08 was published as an enforced Guard. That is the case META-09 exists
  // for, and it is why this check has mutations behind it.
  //
  // Scope is a named list rather than the corpus, per the CONFLICTS.md K
  // ruling: the ban binds supplier- and client-facing copy and the prompts that
  // generate it, not internal notes, logs or Slack alerts. A named list rots,
  // so `copy/scope-must-cover-every-draft-site` below makes an unlisted
  // draft-staging call site the violation instead of a silent gap.
  const OUTBOUND_COPY = [
    // supplier-facing bodies, and the prompts that write them
    "src/agents-runtime/agents/outreach/drafter.ts",
    "src/agents-runtime/agents/outreach/run-outreach.ts",
    "src/agents-runtime/agents/quote-revalidation/drafter.ts",
    "src/agents-runtime/agents/operator-email-outreach/index.ts",
    "src/agents-runtime/agents/reply-manager/no-reply-followup.ts",
    "src/agents-runtime/agents/reply-manager/stalled-followup.ts",
    "src/lib/reply-drafter.ts",
    "src/lib/thread-tailor.ts",
    "src/lib/call-followup.ts",
    "src/lib/draft-staging.ts",
    "src/lib/tenkara-inbound.ts",
    "src/app/actions/cases.ts",
    // client deliverables, which are rendered and never pass sanitizeDraft
    "src/components/expedited-report-view.tsx",
    "src/components/savings-report-view.tsx",
    "src/lib/expedited-report.ts",
    "src/lib/savings-report.ts",
  ];

  // A scope list is an anchor list, and skipping a path that is not in the
  // corpus fails open exactly the way `files.find(...)` did: rename a drafter
  // and the copy ban quietly stops reading it while the build stays green.
  for (const path of OUTBOUND_COPY) {
    anchor(path, {
      rule: "copy/no-rfq-or-em-dash-in-templates",
      why: "this file authors outbound copy and the copy ban is scoped to it",
      fix: "update the path in OUTBOUND_COPY in scripts/lib/rule-checks.mjs",
    });
  }

  forbid({
    rule: "copy/no-rfq-or-em-dash-in-templates",
    why: "outbound copy says 'sourcing inquiry', and em dashes are banned in all output",
    fix: "rewrite the literal; sanitizeDraft is the runtime backstop, not a licence",
    scope: OUTBOUND_COPY,
    // email-style.ts and internal-notes.ts define the ban and quote what they
    // strip; a file cannot be caught by the rule it implements.
    allow: ["src/lib/email-style.ts", "src/lib/internal-notes.ts"],
    exempt: [
      // Diagnostics, internal notes and operator alerts. `:warning:` and its
      // siblings are Slack mrkdwn shortcodes and appear nowhere else in src.
      /\bconsole\.|\blog(?:ger)?\(|\bctx\.log\(|postAgentAlert|postSlackMessage/,
      /\b(?:resolution_note|internal_note|internalNote|reason)\s*:/,
      /(?:^|[\s"'`(])!?:[a-z_][a-z0-9_+-]*:\s/,
      // A line that states the prohibition has to name the thing it forbids.
      /\b(?:never|do not|don't|avoid|no)\b[^.]{0,40}\b(?:em[- ]dash|en[- ]dash|RFQ)e?s?\b/i,
    ],
    // A string holding nothing but an em dash is the null glyph the report
    // tables render for a missing number, not prose.
    normalize: (l) => l.replace(/(["'`])\s*—\s*\1/g, "$1$1"),
    test: (l) => /\bRFQ\b|—/.test(l),
  });

  // The scope list above is only as good as its coverage. Anything that stages
  // a draft is by definition authoring outbound copy, so an unlisted one is not
  // "out of scope", it is the list going stale.
  for (const f of files) {
    if (OUTBOUND_COPY.includes(f.path)) continue;
    if (!/\bstageDraft\s*\(/.test(code(f.text))) continue;
    violations.push({
      rule: "copy/scope-must-cover-every-draft-site",
      why: "this file stages a draft, so it authors outbound copy, and the copy ban is not scanning it",
      fix: "add the path to OUTBOUND_COPY in scripts/lib/rule-checks.mjs",
      where: f.path,
      line: "calls stageDraft() but is not in the copy-ban scope",
    });
  }

  // 6. The staging chokepoint must keep applying the style sanitizer. This is the
  // guard on the guard: if someone removes the call, every drafter silently loses
  // it and nothing else in CI would notice.
  {
    const staging = anchor("src/lib/draft-staging.ts", {
      rule: "copy/staging-must-sanitize",
      why: "stageDraft is the only point every outbound draft passes through",
      fix: "restore the sanitizeDraft call in stageDraft",
    });
    if (staging && !/sanitizeDraft\(/.test(staging.text)) {
      violations.push({
        rule: "copy/staging-must-sanitize",
        why: "stageDraft is the only point every outbound draft passes through",
        fix: "restore the sanitizeDraft call in stageDraft",
        where: "src/lib/draft-staging.ts",
        line: "sanitizeDraft call missing",
      });
    }
    const style = anchor("src/lib/email-style.ts", {
      rule: "copy/sanitize-must-strip-internal-notes",
      why: "a drafter once pasted the raw call log into a supplier email ('Unable to reach after two call attempts')",
      fix: "restore the stripInternalNotes call in sanitizeDraft",
    });
    if (style && !/stripInternalNotes\(/.test(style.text)) {
      violations.push({
        rule: "copy/sanitize-must-strip-internal-notes",
        why: "a drafter once pasted the raw call log into a supplier email ('Unable to reach after two call attempts')",
        fix: "restore the stripInternalNotes call in sanitizeDraft",
        where: "src/lib/email-style.ts",
        line: "stripInternalNotes call missing",
      });
    }
    // Twice, in code, on a word boundary. A bare substring test passed when the
    // constant was renamed to CONCESSION_STRIPS_X, and passed again on nothing
    // but the comment at the top of the file naming it. Declaring it and
    // applying it are two occurrences; a comment is zero.
    if (style && (code(style.text).match(/\bCONCESSION_STRIPS\b/g) ?? []).length < 2) {
      violations.push({
        rule: "copy/sanitize-must-strip-concessions",
        why: "a chase told a live supplier \"if the timing isn't right, just say the word and I'll stop chasing\"",
        fix: "restore the CONCESSION_STRIPS pass in clean()",
        where: "src/lib/email-style.ts",
        line: "CONCESSION_STRIPS missing",
      });
    }
    // Same file as `staging` above; looked up once.
    const chokepoint = staging;
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
    const mod = anchor(f, {
      rule: "reads/client-must-guard-truncation",
      why: "PostgREST silently drops rows past 1000 and reports no error",
      fix: "pass global: { fetch: truncationGuardedFetch() } when creating the client",
    });
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
    const mod = anchor(f, {
      rule: "price/writer-must-gate",
      why: "a price must never be stored unreadable, negative or in a foreign currency",
      fix: "route the write through publishablePrice / publishableTiers from @/lib/price-publish",
    });
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

  // DATA-14. The publish gate above holds the NUMBER. It cannot hold the BASIS:
  // it tests finite, positive, under ten million and the currency invariant, and
  // every one of those passed on Katonah's 620.5410 USD/lb, which was a unit price
  // multiplied by a drum weight and roughly 518x the real figure. Four more rows
  // held per-tonne prices labelled per kg. Nothing anywhere compared a stored
  // price against the words it came from, so every path that captures one now
  // verifies it does appear in them.
  for (const f of [
    "src/lib/staged-quotes.ts",
    "src/lib/tenkara-inbound.ts",
  ]) {
    const mod = anchor(f, {
      rule: "price/capture-must-carry-source-text",
      why: "a price that does not appear in the supplier's own words was computed rather than read",
      fix: "check it with verifyPriceProvenance from @/lib/price-provenance and withhold the price when it fails, never repair it",
    });
    if (mod && !/verifyPriceProvenance\(/.test(mod.text)) {
      violations.push({
        rule: "price/capture-must-carry-source-text",
        why: "a price that does not appear in the supplier's own words was computed rather than read, and no other gate can see that: 620.5410 USD/lb is a perfectly plausible number",
        fix: "check it with verifyPriceProvenance from @/lib/price-provenance and withhold the price when it fails, never repair it",
        where: f,
        line: "price provenance check missing",
      });
    }
  }

  // The two extractors are the other half: a fragment can only be verified if it
  // was asked for. Both prompts must demand it alongside the price.
  for (const f of ["src/lib/reply-quote-extract.ts", "src/lib/attachment-parser.ts"]) {
    const mod = anchor(f, {
      rule: "price/capture-must-carry-source-text",
      why: "the writer withholds any price it cannot trace, so an extractor that stops asking for the supplier's wording silently withholds every price it captures",
      fix: "keep the 'price_source_text is MANDATORY whenever price is not null' rule in this extractor's system prompt",
    });
    if (mod && !/price_source_text is MANDATORY/.test(mod.text)) {
      violations.push({
        rule: "price/capture-must-carry-source-text",
        why: "the writer withholds any price it cannot trace, so an extractor that stops asking for the supplier's wording silently withholds every price it captures",
        fix: "keep the 'price_source_text is MANDATORY whenever price is not null' rule in this extractor's system prompt",
        where: f,
        line: "extractor prompt no longer requires price_source_text",
      });
    }
  }

  // DATA-16. A tiered quote is several prices, and every rung is its own row. The
  // dedup keys decide that, and each of them is a tuple that can fuse two rungs:
  // two rungs at one amount whose thresholds we could not read differ only in the
  // words they were read from. Silent, and shaped exactly like dedup working.
  {
    const w = anchor("src/lib/staged-quotes.ts", {
      rule: "price/tier-rungs-never-collapse",
      why: "two rungs of one ladder can agree on material, price, currency and unit, and collapse into one row",
      fix: "include provenanceKey(price_source_text) in the dedup keys in this file",
    });
    if (w) {
      for (const key of ["dupKey", "echoKey", "pricelessKey"]) {
        // A fixed window rather than a brace match: these signatures are typed
        // object literals, so the first `\n}` is the end of the parameter type,
        // not the end of the function.
        const body = w.text.match(new RegExp(`function ${key}\\([\\s\\S]{0,1200}`));
        if (body && !/\b(provenanceKey|sourceTextKey)\b/.test(body[0])) {
          violations.push({
            rule: "price/tier-rungs-never-collapse",
            why: "two rungs of one ladder can agree on material, price, currency and unit; without the words each was read from they collapse into one row and the rest of the ladder is dropped as a duplicate",
            fix: "include provenanceKey(price_source_text) in the key when there is no case_size to tell the rungs apart",
            where: "src/lib/staged-quotes.ts",
            line: `${key} cannot tell two rungs of one ladder apart`,
          });
        }
      }
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
    // Lookahead, not a capture: consuming the tail would swallow a second
    // `public.suppliers` sitting inside the first query's 200-char window.
    for (const m of f.text.matchAll(/public\.suppliers(?=([\s\S]{0,200}))/g)) {
      const tail = m[1];
      // `join public.suppliers s on s.id = q.supplier_id`, `where id = $1`.
      if (/\bon\s+\w*\.?id\s*=|\bwhere\s+id\s*=/i.test(tail)) continue;
      // The scope has to be a filter in THIS query. Two weaker tests were tried
      // first and both let the real fault through: a file-wide search for the
      // column let a second unscoped read ride in on a scoped one, and reading
      // the column in the select list is not a scope at all — that is exactly
      // what supplier-profile-fill did, pulling all 17,148 rows and filtering
      // in JS, which is the same answer only while every reader remembers to
      // filter, and the name map in that very file did not.
      if (/(=|<@|@>|&&)\s*any\(organization_ids\)|organization_ids\s*(@>|&&)/.test(tail)) continue;
      // The linker builds the (client, name) owner map itself and is the one
      // reader that must see every row to do it. Waived by path, and it is the
      // module every other caller is pointed at.
      if (f.path.endsWith("src/lib/tenkara-supplier-linker.ts")) continue;
      violations.push({
        rule: "orgs/supplier-query-must-scope-to-client",
        why: "Tenkara's suppliers table is shared between clients, so searching it by name can return another client's supplier (this labelled 907 conversations and filled profiles with the wrong client's contact)",
        fix: "filter on organization_ids, or resolve through resolveSupplierIdByName(admin, orgId, name) from @/lib/tenkara-supplier-linker",
        where: f.path,
        line: "public.suppliers searched with no client scope",
      });
    }
  }

  // ORG-10. Scoping the name lookup was half the fault. An id already in hand was
  // still trusted, and a quote's supplier id belongs to whoever quoted the
  // material, so Agent 02 wrote another client's supplier record onto a live
  // thread hours after the name lookup was scoped.
  //
  // Two halves of one class, because a supplier id arrives two ways:
  //   (a) copied off a row we are reading (a quote, a lead),
  //   (b) handed to us over the wire by an agent.
  // Both are checked before storage; neither is trusted for being present.
  for (const f of files) {
    if (f.path.endsWith("src/lib/tenkara-supplier-linker.ts")) continue;

    // (a) draft_references is the pointer a client's thread carries: it names the
    // supplier record ownership, quotes and profiles hang off. insert/update/upsert
    // only, a select that filters on supplier_id stores nothing.
    for (const m of f.text.matchAll(/from\(["']draft_references["']\)\s*\.\s*(?:insert|update|upsert)\(([\s\S]{0,900})/g)) {
      const w = m[1].match(/\bsupplier_id:\s*([A-Za-z_$][\w$?.]*)/);
      if (!w) continue;
      const src = w[1];
      // Locals the linker already answered for. Anything else is a raw row field.
      if (/^(supplierId|ownSupplierId|scopedId)$/.test(src)) continue;
      if (!src.includes(".")) continue;
      violations.push({
        rule: "orgs/supplier-id-written-must-be-scoped",
        why: "a supplier id taken off a quote or lead row belongs to whoever created that row, not necessarily the client being drafted for, and one stored unchecked put another client's supplier record on a California Chemicals thread hours after the name lookup was scoped",
        fix: "resolve it through scopedSupplierId(admin, orgId, supplierId, name) from @/lib/tenkara-supplier-linker",
        where: f.path,
        line: `draft_references written with supplier_id: ${src}`,
      });
    }

    // (b) an id posted to an agent API is a claim by the caller, not a fact. The
    // caller is another agent that may be working for a different client, so it is
    // checked in the route before it reaches any table.
    if (!f.path.includes("src/app/api/")) continue;
    for (const m of f.text.matchAll(/\bsupplier_id:\s*(parsed\.data\.supplier_id|body\.supplier_id|input\.supplier_id)/g)) {
      violations.push({
        rule: "orgs/supplier-id-written-must-be-scoped",
        why: "an agent posting to this route can be working for a different client than the one being written to, so an id off the request body is a claim and not a fact",
        fix: "resolve it through scopedSupplierId(admin, orgId, supplierId, name) from @/lib/tenkara-supplier-linker, and store null where the route has no client to scope against",
        where: f.path,
        line: `request-body supplier id stored unchecked: ${m[1]}`,
      });
    }
  }

  // ORG-11. The inbound router decides whether the drafts on a thread agree about
  // who is replying. Keying that test on `supplier_id ?? ""` counts an unlinked
  // row as a second supplier, and half of all cold outreach is written before the
  // link exists — so the cold_outbound row said `null:material`, the follow-up
  // said `supplier:material`, and every reply on the thread was refused as
  // ambiguous. Agreement is tested over the values a row actually names; that
  // lives in `soleReplyTarget`, once.
  {
    const router = files.find((f) => f.path.endsWith("src/lib/tenkara-inbound.ts"));
    if (!router || !/\bsoleReplyTarget\s*\(/.test(router.text)) {
      violations.push({
        rule: "orgs/candidate-match-must-not-key-on-null",
        why: "without the shared resolver the router is back to hand-rolling the agreement test, which is where the null-as-a-value bug came from",
        fix: "resolve the thread's candidates through soleReplyTarget from @/lib/org-isolation",
        where: router?.path ?? "src/lib/tenkara-inbound.ts",
        line: "inbound router does not call soleReplyTarget",
      });
    }
    for (const f of files) {
      if (!f.path.endsWith("src/lib/tenkara-inbound.ts")) continue;
      for (const line of f.text.split("\n")) {
        // Prose explaining the bug is allowed to spell it. Only code counts.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        const m = line.match(/\b(supplier_id|material_id)\s*\?\?\s*""/);
        if (!m) continue;
        violations.push({
          rule: "orgs/candidate-match-must-not-key-on-null",
          why: "a null id means the row was never linked, not that it names a different supplier; folding it into a match key refuses replies on threads with exactly one counterparty",
          fix: "compare only the non-null values the candidates name — soleReplyTarget in @/lib/org-isolation does this",
          where: f.path,
          line: `match key treats an unset id as a value: ${m[0]}`,
        });
      }
    }
  }

  // ORG-12. The mailbox lookup answers "which client owns this inbox", which is
  // empty for a webhook carrying no account and for an account id two orgs
  // share. The thread is the answer in both cases and it is already on file.
  {
    const router = anchor("src/lib/tenkara-inbound.ts", {
      rule: "orgs/inbound-org-must-try-the-thread",
      why: "the inbound router is where a reply is matched to a client",
      fix: "restore src/lib/tenkara-inbound.ts",
    });
    const resolver = router?.text.match(/async function resolveInboundOrg[\s\S]*?\n}/)?.[0] ?? "";
    if (router && !/draft_references[\s\S]{0,400}?thread_id/.test(resolver)) {
      violations.push({
        rule: "orgs/inbound-org-must-try-the-thread",
        why: "26 of 30 dead-lettered conversations name their client on their own draft references, 23 of them a paying client's; giving up on the mailbox alone parks a reply that was never in doubt",
        fix: "ask draft_references for the conversation's owner before returning null",
        where: router.path,
        line: "resolveInboundOrg never asks the thread who owns it",
      });
    }
    // One owner or none. A thread naming two clients is ORG-06's shared thread,
    // and picking either is the guess ORG-04 forbids.
    if (router && resolver && !/\bsize\s*===\s*1\b/.test(resolver)) {
      violations.push({
        rule: "orgs/inbound-org-must-try-the-thread",
        why: "a conversation whose draft references name more than one client is a shared thread, not an answer; taking the first owner routes one client's reply into another client's workspace",
        fix: "resolve from the thread only when its references name exactly one org",
        where: router.path,
        line: "thread fallback does not require a single owner",
      });
    }
  }

  // PERS-03. A pass that returned nothing has three meanings — found, dry,
  // infra — and every one of these nine sites collapsed two of them. The
  // distinction now lives in `src/lib/dry-pass.ts`, once, so a source cannot
  // quietly re-invent a two-outcome version of it.
  {
    const helper = anchor("src/lib/dry-pass.ts", {
      rule: "discovery/zero-must-not-be-terminal",
      why: "the found/dry/infra distinction lives in one place so nine sources cannot each get it wrong differently",
      fix: "restore src/lib/dry-pass.ts",
    });
    if (
      helper &&
      !/type\s+PassOutcome\s*=\s*"found"\s*\|\s*"dry"\s*\|\s*"infra"/.test(helper.text)
    ) {
      violations.push({
        rule: "discovery/zero-must-not-be-terminal",
        why: "collapsing infra into dry burns a real attempt on an outage, and collapsing dry into found writes 'searched, nothing here' on a single zero",
        fix: "keep all three outcomes in PassOutcome",
        where: helper.path,
        line: "dry-pass.ts no longer names all three outcomes",
      });
    }

    // Per site, because each one settles a different record and there is no one
    // shape to match. The token is what that site's fix turns on.
    const PERS03_SITES = [
      [
        "src/lib/importyeti-client.ts",
        /\browsOrThrow\s*\(/,
        "a 200 carrying an error envelope or a renamed field parsed to zero suppliers and logged a healthy pass, which is how an outage reads as an empty market",
        "take the rows through rowsOrThrow(body, field, source)",
      ],
      [
        "src/lib/material-aliases.ts",
        /\badvanceDryPass\s*\(/,
        "an empty alias list cached with no expiry is accepted forever and blinds all three discovery sources for that material, the exact failure this file was written to fix",
        "bank an empty answer as a dry pass instead of caching it as the answer",
      ],
      [
        "src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts",
        /\badvanceDryPass\s*\(/,
        "a model call that succeeds and names no sellers is indistinguishable from a JS-rendered page or a bot wall, and retiring on one killed the umbrella lead and its sellers for good",
        "bank a dry pass and retire only at DRY_PASS_LIMITS.aggregator_index",
      ],
      [
        "src/agents-runtime/agents/data-enrichment/web-fill-run.ts",
        /\badvanceDryPass\s*\(/,
        "a read that printed no fields stamped web_checked_at on the first pass, froze all twelve fields as never-published, and dropped the profile out of every future run",
        "settle not_published only once the read has printed nothing DRY_PASS_LIMITS.supplier_web_fill times",
      ],
      [
        "src/agents-runtime/agents/document-retrieval/index.ts",
        /\bretryAfter\s*\(/,
        "a 403 or 429 wrote last_scanned_at like a clean scan, resting a page that was never read for sixty days, and bot-blocking is this agent's measured ceiling",
        "give a blocked page a short retry_after ladder instead of the sixty-day clock",
      ],
      [
        "src/agents-runtime/agents/lead-creator/index.ts",
        /\badvanceDryPass\s*\(/,
        "this is the source that had the found/dry/infra split right first; a private copy of it is how the other eight drifted",
        "keep the SourceReady counter on the shared helper",
      ],
    ];
    for (const [path, token, why, fix] of PERS03_SITES) {
      const site = anchor(path, { rule: "discovery/zero-must-not-be-terminal", why, fix });
      if (site && !token.test(site.text)) {
        violations.push({
          rule: "discovery/zero-must-not-be-terminal",
          why,
          fix,
          where: site.path,
          line: `no longer distinguishes a dry pass from an answer (${token.source})`,
        });
      }
    }

    // The re-check crash is its own shape: it did not fail to write, it wrote a
    // finding. A pending_review row locks the quote out of every future run, so
    // laundering a crash into an ordinary verdict is permanent.
    const recheck = anchor("src/agents-runtime/agents/marketplace-validation/index.ts", {
      rule: "discovery/zero-must-not-be-terminal",
      why: "the marketplace re-check decides whether a failed read becomes an operator finding",
      fix: "restore src/agents-runtime/agents/marketplace-validation/index.ts",
    });
    if (recheck && /notes:\s*[`"']Re-check failed/.test(recheck.text)) {
      violations.push({
        rule: "discovery/zero-must-not-be-terminal",
        why: "a crashed re-check written as a needs_review finding parks the quote at pending_review, and the pendingFor skip then excludes it from every future run until an operator dismisses a finding whose only content is the error message",
        fix: "log the failure and return null so the quote stays in the queue",
        where: recheck.path,
        line: "a re-check crash is still written as a finding",
      });
    }
    if (recheck && !/result\.infra_failure/.test(recheck.text)) {
      violations.push({
        rule: "discovery/zero-must-not-be-terminal",
        why: "the same failure arrives by return value as well as by throw: the model answered with something that was not JSON, so the page was never read",
        fix: "skip the finding when result.infra_failure is set",
        where: recheck.path,
        line: "infra_failure returned by the re-check is not checked",
      });
    }
  }

  // PERS-08. The clarification draft staged on a parked message names that
  // message, so an idempotency check keyed on the name alone reads the record of
  // a failure as proof the work was done, and no later attempt can ever undo it.
  // The check has to exclude the triage artefact, and has to read the set rather
  // than maybeSingle, which returns nothing when a message carries both.
  {
    const router = anchor("src/lib/tenkara-inbound.ts", {
      rule: "replies/idempotency-must-exclude-triage-artefacts",
      why: "the reply-drafted check must keep telling a real reply from the clarification draft staged on a parked message",
      fix: "restore the check in the inbound router",
    });
    // The check itself: from the lookup key to the early return it guards.
    const idempotency = router?.text.match(/in_reply_to_message_id[\s\S]{0,800}?deduped:\s*true/)?.[0];
    const distinguishes = /\bunmatched_inbound_clarification\b/.test(idempotency ?? "");
    const failsOpen = /maybeSingle\(\)/.test(idempotency ?? "");
    if (!distinguishes || failsOpen) {
      violations.push({
        rule: "replies/idempotency-must-exclude-triage-artefacts",
        why: !distinguishes
          ? "the clarification draft staged on a parked reply names the message it failed to match, so counting it as a prior reply makes one miss permanent — the fixed router replays the message and returns deduped against its own failure"
          : "maybeSingle returns nothing when a message carries both a real reply and a clarification draft, so the duplicate check fails open and the supplier is answered twice",
        fix: "read the matching draft_references as a list and ignore rows whose metadata.draft_kind is unmatched_inbound_clarification",
        where: router?.path ?? "src/lib/tenkara-inbound.ts",
        line: !distinguishes
          ? "reply-drafted check does not exclude unmatched_inbound_clarification"
          : "reply-drafted check uses maybeSingle on a set that can hold two rows",
      });
    }
    // The other half: an answered message must not leave its triage artefacts
    // behind. The clarification draft is review-only and still sendable.
    if (router && !/await retireUnmatchedTriage\(/.test(router.text)) {
      violations.push({
        rule: "replies/idempotency-must-exclude-triage-artefacts",
        why: "the open case and the review-only 'who are you?' draft outlive the failure they describe, and an operator can still send the draft on a thread we have just answered properly",
        fix: "call retireUnmatchedTriage on the successful-draft path in handleInboundReply",
        where: router.path,
        line: "a matched reply does not retire the triage case and clarification draft",
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
      /process\.env\.(SLACK_ESCALATION_CHANNEL_ID|SLACK_FEEDBACK_CHANNEL_ID|SLACK_CONTACT_GUARD_CHANNEL_ID|SOURCING_HEALTH_SLACK_CHANNEL|EXPIRY_CHANNEL_ID|LEAD_SCANNER_SLACK_CHANNEL_ID|SAM_SLACK_DM_ID)\b/.test(line) ||
      // Any Slack id at all that is not the one channel. The clauses above look
      // for the shapes code uses, and missed the shape prose uses: a SKILL.md
      // told an agent to watch and reply in #control-room-feedback by bare id,
      // months after COMM-06 retired it. Instructions are a call site.
      /\b(?!C0B5M1QCE9E\b)(?:C0[A-Z0-9]{8,}|D0[A-Z0-9]{8,})\b/.test(line),
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
    const dir = rulesDir;
    const rules = collectRules(dir);
    const outstanding = readFileSync(join(dir, "OUTSTANDING.md"), "utf8");

    for (const r of rules) {
      const where = `rules/${r.file}`;
      const line = `${r.id} — ${r.title}`;

      if (r.bucket === UNCLASSIFIED) {
        violations.push({
          rule: "rules/every-rule-declares-enforcement",
          why: "a rule whose enforcement is not stated in the fixed vocabulary reads as protected without saying what protects it",
          fix: `make the Enforcement line begin with one of: ${vocabularyHint()}`,
          where,
          line: r.enforcement ? line : `${line} (no Enforcement line at all)`,
        });
        continue;
      }

      // A debt that is not on the outstanding list is a debt nobody will pay.
      //
      // Both halves of this used to be wrong. The debt test searched the whole
      // section for the word "owed", so a rule whose prose happened to say a
      // check "is owed elsewhere" was filed as a debt though its Enforcement
      // line read Guard. And the lookup was a substring, so `ORG-1` was
      // satisfied by any mention of `ORG-10`: a real debt could be discharged
      // by a different rule's entry. The bucket decides, and the id matches on
      // a word boundary.
      if (r.owes && !new RegExp(`\\b${r.id}\\b`).test(outstanding)) {
        violations.push({
          rule: "rules/owed-enforcement-must-be-outstanding",
          why: "a rule that admits it needs a guard, and is not on the outstanding list, is how a gap goes quiet",
          fix: `add ${r.id} to rules/OUTSTANDING.md, or change its Enforcement line to Judgement if nothing mechanical can ever check it`,
          where,
          line,
        });
      }
    }

    // The register at the bottom of OUTSTANDING.md is the answer to "what is
    // still breakable", and it was hand-kept, so it drifted both ways at once:
    // it still listed rules closed that morning, and three rules that owed work
    // appeared nowhere in it. The check above only asks whether an owing id is
    // mentioned SOMEWHERE in the file, which a narrative paragraph satisfies,
    // so neither direction failed a build. Membership is mechanical — the rule
    // files already say who owes — so it is checked, and only the prose in the
    // second column stays a human's job.
    const registerAt = outstanding.indexOf("## The full enforcement debt");
    if (registerAt === -1) {
      violations.push({
        rule: "rules/debt-register-must-match-the-ledger",
        why: "the debt register is the one place that answers what is still unguarded",
        fix: "restore the '## The full enforcement debt' section in rules/OUTSTANDING.md",
        where: "rules/OUTSTANDING.md",
        line: "the enforcement debt register is gone",
      });
    } else {
      const listed = new Set(
        [...outstanding.slice(registerAt).matchAll(/^\|\s*([A-Z]+-\d+)\s*\|/gm)].map((m) => m[1])
      );
      const owing = new Set(rules.filter((r) => r.owes).map((r) => r.id));
      for (const id of owing) {
        if (!listed.has(id)) {
          violations.push({
            rule: "rules/debt-register-must-match-the-ledger",
            why: "a rule whose Enforcement line admits a debt, and which the register does not list, is a gap nobody counting the register would ever see",
            fix: `add a ${id} row to the register at the bottom of rules/OUTSTANDING.md saying what is owed`,
            where: "rules/OUTSTANDING.md",
            line: `${id} owes work and is missing from the enforcement debt register`,
          });
        }
      }
      for (const id of listed) {
        if (!owing.has(id)) {
          violations.push({
            rule: "rules/debt-register-must-match-the-ledger",
            why: "a register that lists settled rules overstates the debt, and the next person to read it works from a number that is wrong in the safe-sounding direction",
            fix: `remove the ${id} row from the register, or say on ${id}'s Enforcement line what is still owed`,
            where: "rules/OUTSTANDING.md",
            line: `${id} is in the enforcement debt register and owes nothing`,
          });
        }
      }
    }

    // The ledger is a view of the rule files, so it must be exactly what the
    // generator would write today. It was not: production shipped an
    // ENFORCEMENT.md that listed PERS-08 as an enforced Guard while the rule
    // text and the guard itself were uncommitted. A generated file nobody
    // regenerates is a claim nobody checks.
    const expected = renderLedger(rules);
    if (readFileSync(join(dir, "ENFORCEMENT.md"), "utf8") !== expected) {
      violations.push({
        rule: "rules/enforcement-ledger-must-match",
        why: "the ledger states which rules are actually enforced; when it is stale it overstates that, which is the one direction that matters",
        fix: "run `npm run gen:enforcement` and commit the result; never hand-edit rules/ENFORCEMENT.md",
        where: "rules/ENFORCEMENT.md",
        line: "does not match what gen:enforcement would write from the rule files",
      });
    }

    // The same generator also writes the snapshot the weekly review reads at
    // runtime, and a stale snapshot is worse than a stale ledger: the review
    // would report last month's rulebook as this week's and read as a clean
    // bill of health.
    const snapshot = join(dir, "..", "src", "lib", "rules-ledger.generated.json");
    if (readFileSync(snapshot, "utf8") !== renderSnapshot(rules, dir)) {
      violations.push({
        rule: "rules/enforcement-ledger-must-match",
        why: "the weekly review reads this snapshot, so when it is stale the review reports a rulebook that no longer exists",
        fix: "run `npm run gen:enforcement` and commit the result; never hand-edit the snapshot",
        where: "src/lib/rules-ledger.generated.json",
        line: "does not match what gen:enforcement would write from the rule files",
      });
    }
  }


  // DATA-07. A volume-priced quote needs a density to reach $/lb, and it has to
  // be the right kind: bulk for a solid, specific gravity for a liquid. True
  // density overstates a packed weight badly.
  //
  // This check was added on 2026-08-20 in three shapes that could not hold, all
  // of them the failures the rest of this file is written against. It reported
  // under the id `DATA-07`, which is the rule's name and not the check id the
  // ledger points at, so the id in rules/ was unreachable. It carried `message`
  // where the CLI prints `why`, so a real break would have printed
  // `why: undefined` above the fix. And it read each file with
  // `files.find(...)` guarded by `if (found && ...)`, so renaming either file
  // disabled the check and left the build green — the fail-open shape `anchor`
  // exists for. It also had no mutation behind it, which is now itself a
  // failure in rule-self-test.mjs rather than something a reader has to notice.
  {
    const rule = "density/solids-require-bulk";

    const writer = anchor("src/lib/staged-quotes.ts", {
      rule,
      why: "insertStagedQuotes is the one writer that converts a volume price, so it is where the density guard has to be called",
      fix: "restore src/lib/staged-quotes.ts",
    });
    if (writer && !/\bvalidateQuoteDensity\b/.test(codeLines(writer).join("\n"))) {
      violations.push({
        rule,
        why: "a volume-priced quote with no density, or with a true density where a bulk one is required, converts to a $/lb figure wrong by the packing fraction",
        fix: "call validateQuoteDensity from @/lib/quote-density-guard inside insertStagedQuotes",
        where: writer.path,
        line: "insertStagedQuotes does not call validateQuoteDensity",
      });
    }

    const guard = anchor("src/lib/quote-density-guard.ts", {
      rule,
      why: "this module is the single place the density rule is expressed (META-04)",
      fix: "restore src/lib/quote-density-guard.ts exporting validateQuoteDensity and assertQuoteDensity",
    });
    if (guard) {
      const text = codeLines(guard).join("\n");
      for (const fn of ["validateQuoteDensity", "assertQuoteDensity"]) {
        if (!new RegExp(`export function ${fn}\\b`).test(text)) {
          violations.push({
            rule,
            why: "both entry points are load-bearing: the validator reports, the assert throws, and a caller that finds only one reimplements the other",
            fix: `export ${fn} from src/lib/quote-density-guard.ts`,
            where: guard.path,
            line: `${fn} is not exported`,
          });
        }
      }
    }
  }

  // DISC-01. Every source searches the trade's names as well as the client's
  // intake string. One material sat at a clean zero from all three sources for
  // four days while three marketplaces carried it under two other names.
  //
  // The rule already held when this was written, and that is the reason to
  // write it: what was guarding it was that three authors happened to thread an
  // argument through by hand. The resolver is imported in exactly one file and
  // passed down; nothing stopped a fourth source from staging leads without
  // ever asking for aliases. So the subject is the INSERT, not a list of known
  // sources — a source is in scope from the day it can stage a lead, which is
  // the only day that matters.
  {
    const rule = "discovery/source-must-use-alias-resolver";

    const resolver = anchor("src/lib/material-aliases.ts", {
      rule,
      why: "one model-resolved, per-material cache is what every source searches through (META-04)",
      fix: "restore src/lib/material-aliases.ts exporting getMaterialAliases",
    });
    if (resolver && !/export async function getMaterialAliases\b/.test(codeLines(resolver).join("\n"))) {
      violations.push({
        rule,
        why: "the resolver is the shared module the rule names; without this export every source resolves its own",
        fix: "export async function getMaterialAliases from src/lib/material-aliases.ts",
        where: resolver.path,
        line: "getMaterialAliases is not exported",
      });
    }

    for (const f of files) {
      if (!f.path.includes("agents/lead-creator/")) continue;
      const text = codeLines(f).join("\n");
      if (!/from\(\s*["']leads_in_flight["']\s*\)[\s\S]{0,600}?\.insert\s*\(/.test(text)) continue;
      if (/\baliases\b/.test(text)) continue;
      violations.push({
        rule,
        why: "this file stages a lead, so it is a discovery source, and it never asks what else the trade calls the material",
        fix: "thread the aliases from getMaterialAliases into this source's search terms",
        where: f.path,
        line: "inserts into leads_in_flight without naming aliases",
      });
    }
  }

  // DISC-02. Searching the aliases and then filtering the results against our
  // own string throws away the exact rows the alias search just won. Both
  // filtering sources say so in a comment above the seed; the comment is not
  // the guard.
  {
    const rule = "discovery/relevance-filter-must-accept-aliases";
    for (const p of [
      "src/agents-runtime/agents/lead-creator/sourceready.ts",
      "src/agents-runtime/agents/lead-creator/importyeti.ts",
    ]) {
      const f = anchor(p, {
        rule,
        why: "this source filters candidates against a material word set, so the word set is where aliases have to arrive",
        fix: `restore ${p}`,
      });
      if (!f) continue;
      if (/materialWords[\s\S]{0,400}?req\.aliases/.test(codeLines(f).join("\n"))) continue;
      violations.push({
        rule,
        why: "a supplier surfaced by the alias search describes its goods in the alias's vocabulary, so filtering on our name alone discards it",
        fix: "seed materialWords from [req.materialName, req.inci, ...(req.aliases ?? [])]",
        where: f.path,
        line: "the relevance filter's word set does not include req.aliases",
      });
    }
  }

  // DISC-07. Two materials sharing a name but differing in grade are
  // intentionally distinct. The name match alone is the dangerous half, so the
  // grade test has to sit in the same loop, between the name match and the
  // candidate — not somewhere downstream where a second flagger could skip it.
  {
    const rule = "materials/never-merge-on-name-alone";

    const merge = anchor("src/lib/material-merge-flags.ts", {
      rule,
      why: "this module is the only place a merge candidate is decided (META-04)",
      fix: "restore src/lib/material-merge-flags.ts exporting gradesMergeable",
    });
    if (merge) {
      const text = codeLines(merge).join("\n");
      if (!/export function gradesMergeable\b/.test(text)) {
        violations.push({
          rule,
          why: "the grade test is what separates a real duplicate from two deliberately distinct grades",
          fix: "export function gradesMergeable from src/lib/material-merge-flags.ts",
          where: merge.path,
          line: "gradesMergeable is not exported",
        });
      }
      if (!/mergeReasonFor\([\s\S]{0,300}?gradesMergeable\(/.test(text)) {
        violations.push({
          rule,
          why: "a name match that reaches the candidate list without passing the grade test is a merge on name alone",
          fix: "keep the gradesMergeable gate in the same loop as mergeReasonFor, before the pair becomes a candidate",
          where: merge.path,
          line: "the name match is not followed by the grade test",
        });
      }
    }

    for (const f of files) {
      if (f.path.endsWith("src/lib/material-merge-flags.ts")) continue;
      const text = codeLines(f).join("\n");
      if (!/from\(\s*["']material_merge_flags["']\s*\)[\s\S]{0,200}?\.(?:insert|upsert)\s*\(/.test(text)) continue;
      violations.push({
        rule,
        why: "a second flagger writes merge candidates that never met the grade test",
        fix: "flag through flagDuplicateMaterials in @/lib/material-merge-flags",
        where: f.path,
        line: "writes material_merge_flags outside the shared module",
      });
    }
  }

  // AUTO-05. Never add, remove or re-type an operator, and never change org
  // membership, to close a gap or make an assignment work. Sam, after an audit
  // found Tenkara had no call operator at all and its 12 open calls unowned:
  // "no dont add until ops adds it — as long as everything is according to the
  // rules leave it."
  //
  // The rule holds today by absence: no agent, no API route and no repair
  // script writes these tables. Absence is the state a check exists to freeze,
  // because nothing about it is visible in a diff that adds the first one.
  //
  // Keyed on the table rather than on the column names, because operator_type
  // and lanes ARE columns of user_org_assignments — a write to either is a
  // write here. Matched across lines: the builder is routinely split so that
  // `.from(...)` and `.update(...)` are three lines apart, and a line scanner
  // sees neither half as a write.
  //
  // The allow list is three server actions, each behind a session and a role
  // check, each writing audit_log. Two of them were missed by a survey that
  // named only the first, which is the argument for the list being explicit:
  // a fourth writer has to be added here, in a diff, on purpose.
  {
    const rule = "orgs/no-operator-membership-writes";
    const why =
      "operator and org membership is ops' call; an agent or a repair script that adds, removes or re-types one is closing a gap that ops has not decided to close";
    const fix =
      "report the gap and stop. Membership changes go through the Control Room server actions, which are behind a role check and write audit_log";
    const ALLOW = [
      "src/app/actions/operators.ts",
      "src/app/actions/assignment-settings.ts",
      "src/app/actions/signup.ts",
    ];
    // The verb has to be reached without leaving the statement. A flat window
    // of N characters ran `from("user_roles").select(...)` straight into the
    // next line's `from("users").insert(...)` and reported the session reader
    // in src/lib/auth.ts as a membership write. Cut the window at the first `;`
    // or the next `from(`, and what is left is one builder chain.
    const TABLE = /from\(\s*["'](?:user_org_assignments|user_roles)["']\s*\)/g;
    const RAW_SQL = /(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:user_org_assignments|user_roles)\b/gi;
    const at = (text, i) => text.slice(0, i).split("\n").length;

    for (const f of files) {
      if (ALLOW.some((a) => f.path.endsWith(a))) continue;
      const text = codeLines(f).join("\n");

      TABLE.lastIndex = 0;
      let m;
      while ((m = TABLE.exec(text))) {
        const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
        const end = Math.min(
          ...[rest.indexOf(";"), rest.search(/\bfrom\(/)].filter((i) => i !== -1).concat([rest.length]),
        );
        const chain = rest.slice(0, end);
        const verb = /\.(insert|upsert|update|delete)\s*\(/.exec(chain);
        if (!verb) continue;
        violations.push({
          rule,
          why,
          fix,
          where: `${f.path}:${at(text, m.index)}`,
          line: `${m[0]}${chain.slice(0, verb.index + verb[0].length)}`.replace(/\s+/g, " ").slice(0, 120),
        });
      }

      RAW_SQL.lastIndex = 0;
      while ((m = RAW_SQL.exec(text))) {
        violations.push({
          rule,
          why,
          fix,
          where: `${f.path}:${at(text, m.index)}`,
          line: m[0].replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
  }

  // OUT-02. A marketplace storefront is a supplier we found; it is not a
  // supplier we may quietly stop talking to. Both halves of this are the same
  // shape — an absence read as a verdict — and both were live:
  //
  //   * the storefront resolver, the one module whose job is finding a seller's
  //     own domain, was gated on `!website`. Measured 2026-08-20: 309 storefront
  //     leads parked out of outreach with no contact, 0 ever attempted, 235 of
  //     them carrying a `supplier_website` and 204 of those an aggregator host.
  //     Having a listing URL counted as having a website, so the resolver never
  //     ran on the exact population it was written for.
  //   * the umbrella-row retirement fired when zero sellers were readable, which
  //     is also what a 5xx or a token-exhausted read looks like.
  //
  // Neither is a rule a reader can hold in their head while editing a 900-line
  // agent, which is why they are checks.
  {
    const rule = "outreach/no-terminal-drop-without-channel";

    const enrich = anchor("src/agents-runtime/agents/data-enrichment/enrich.ts", {
      rule,
      why: "this is where a storefront lead gets its own domain resolved, which is the only way it ever becomes contactable",
      fix: "restore src/agents-runtime/agents/data-enrichment/enrich.ts",
    });
    if (enrich) {
      const text = codeLines(enrich).join("\n");
      if (!/ownDomainWebsite\s*=[^;\n]*isAggregatorDomain\(/.test(text)) {
        violations.push({
          rule,
          why: "an aggregator listing URL in supplier_website is not a website, and counting it as one hides every storefront lead from the resolver",
          fix: "keep the own-domain test (`website && !isAggregatorDomain(hostOf(website))`) as what decides whether the resolver runs",
          where: enrich.path,
          line: "the storefront gate does not exclude aggregator hosts",
        });
      }
      if (!/if\s*\(!ownDomainWebsite\b[\s\S]{0,800}?resolveStorefrontSupplier\(/.test(text)) {
        violations.push({
          rule,
          why: "the resolver has to be reached by the leads that have no own domain; gated on anything else it runs for the wrong population",
          fix: "call resolveStorefrontSupplier under `if (!ownDomainWebsite && sourceUrl)`",
          where: enrich.path,
          line: "resolveStorefrontSupplier is not gated on the absence of an own domain",
        });
      }
    }

    const pull = anchor("src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts", {
      rule,
      why: "this is the only place a marketplace lead is retired as a platform index page",
      fix: "restore src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts",
    });
    if (pull && !/platformAsSupplier\s*&&[^)]*infra_failure/.test(codeLines(pull).join("\n"))) {
      violations.push({
        rule,
        why: "a page that could not be read tells us nothing about the page, and retiring on it makes a brief outage a permanent verdict",
        fix: "add `&& result.infra_failure !== true` to the platformAsSupplier retirement, the way the retry path below already distinguishes it",
        where: pull.path,
        line: "the index-page retirement can fire on an unread page",
      });
    }
  }

  // PERS-05. A lead with no contact is not a lead we have finished with. The
  // re-queue that keeps looking (`requeue_parked_contact_leads`) selects on
  // `status = 'active' and stage = 'enriched'`, so setting the lead to `dropped`
  // is not a status change, it is a deletion from the only path that would have
  // rescued it. Measured 2026-08-20: 3,208 leads dropped as
  // `no_contact_recovered`, 2,325 of them on paying clients, and 3,195 that
  // would qualify for the re-queue this minute if they were still active.
  //
  // Nothing read the drop reason to revive them. The only reader in the repo is
  // a UI label, which is why the label is the one place the string is allowed.
  {
    const rule = "outreach/contactless-must-park-not-drop";

    forbid({
      rule,
      why: "a lead dropped for having no contact leaves the re-queue's `status = active` window and is never tried again",
      fix: "park it instead: stamp outreach_parked_at and leave it active at stage='enriched' so requeue_parked_contact_leads can see it",
      // The Control Room still has to render the 3,208 rows already carrying
      // this reason. Reading it is fine; writing it is the break.
      allow: ["src/components/lead-rich-row.tsx"],
      test: (l) => /no_contact_recovered/.test(l),
    });

    const outreach = anchor("src/agents-runtime/agents/outreach/index.ts", {
      rule,
      why: "this is the one place a lead with no cold-emailable address is routed",
      fix: "restore src/agents-runtime/agents/outreach/index.ts",
    });
    if (outreach) {
      const branch = /if\s*\(!hasEmail\)\s*\{([\s\S]{0,2000}?)\n      \}/.exec(codeLines(outreach).join("\n"));
      if (!branch) {
        violations.push({
          rule,
          why: "the no-contact branch is what this rule is about, and it cannot be found to check",
          fix: "keep the routing for a lead with no cold-emailable address in a single `if (!hasEmail)` block",
          where: outreach.path,
          line: "no `if (!hasEmail)` branch found",
        });
      } else {
        if (!/ParkIds\.push\(/.test(branch[1])) {
          violations.push({
            rule,
            why: "without the park stamp the lead sits in the outreach fetch window forever, starving actionable leads behind it",
            fix: "push the lead id onto contactlessParkIds so the bulk park below stamps it",
            where: outreach.path,
            line: "the no-contact branch does not park the lead",
          });
        }
        if (/["']dropped["']/.test(branch[1])) {
          violations.push({
            rule,
            why: "dropping is what put 3,208 leads outside the re-queue; having no contact yet is not a verdict",
            fix: "park the lead instead of setting status to dropped",
            where: outreach.path,
            line: "the no-contact branch still drops the lead",
          });
        }
      }
    }
  }

  // PERS-04. A bounded retry is allowed as a spend control and banned as a
  // verdict, and the only way to tell which one a bound is, is to read the
  // reasoning next to it. So every bound has to be named in the rules folder.
  // Seven exist and none were named until 2026-08-20, which meant PERS-01 was
  // being enforced against the ones anybody happened to notice.
  //
  // The name is the whole check. A bound that has to be written down in a file
  // that is reviewed weekly is a bound somebody decided on; a fresh
  // `MAX_ATTEMPTS = 2` in a new agent is the shape this rule exists to catch.
  {
    const rule = "retry/bound-must-be-declared";
    const NAMES = /\b[A-Z][A-Z0-9_]*(?:ATTEMPTS?|RETRIES|RETRY|DRY_PASSE?S?)[A-Z0-9_]*\b/;
    // Read the rules folder directly. It is not part of the scanned corpus,
    // and treating an empty read as "nothing is declared" would fail every
    // bound at once rather than saying the folder could not be found.
    const declared = readdirSync(rulesDir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => readFileSync(join(rulesDir, n), "utf8"))
      .join("\n");
    for (const f of files) {
      if (!/^src\//.test(f.path)) continue;
      codeLines(f).forEach((line, i) => {
        // Only a declaration with a literal number is a bound. A comparison
        // against one (`attempts >= MAX_ATTEMPTS`) is the bound being used.
        const m = /(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\d/.exec(line);
        if (!m || !NAMES.test(m[1])) return;
        if (declared.includes(m[1])) return;
        violations.push({
          rule,
          why: "an undeclared retry bound is indistinguishable from a verdict, which is the PERS-01 break",
          fix: `name ${m[1]}, its value and why it is a spend control in rules/40-persistence.md under PERS-04`,
          where: `${f.path}:${i + 1}`,
          line: line.trim().slice(0, 120),
        });
      });
    }

    // The shared dry-pass bounds are object keys, not SHOUTING_CONSTANTS, so
    // the scan above cannot see them. Collecting them in one place must not be
    // the way a bound stops being declared.
    const limits = files.find((f) => f.path.endsWith("src/lib/dry-pass.ts"));
    const body = limits?.text.match(/DRY_PASS_LIMITS\s*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    for (const m of body.matchAll(/^\s{2}([a-z][a-z0-9_]*):\s*\d/gm)) {
      if (declared.includes(`DRY_PASS_LIMITS.${m[1]}`)) continue;
      violations.push({
        rule,
        why: "a bound nobody wrote down is indistinguishable from a verdict, and gathering the bounds into one object does not declare them",
        fix: `name DRY_PASS_LIMITS.${m[1]} and why it is a spend control in rules/40-persistence.md under PERS-04`,
        where: limits.path,
        line: `undeclared dry-pass bound: ${m[1]}`,
      });
    }
  }

  // SHIP-07. Deploy and schema move together. ENG-1036 went out reading a
  // column that production did not have yet, and the failure surfaced as
  // ordinary agent errors rather than as a missing migration.
  //
  // Table and function granularity is the part that can be read statically and
  // is where the damage is: a whole table or RPC that does not exist yet fails
  // every call, whereas a missing column usually fails one field. Both lists
  // are complete as of 2026-08-20, so this is a ratchet.
  {
    const rule = "ship/migration-must-accompany-schema-read";
    const sql = files
      .filter((f) => /supabase\/migrations\/.*\.sql$/.test(f.path))
      .map((f) => f.text)
      .join("\n")
      .toLowerCase();
    if (!sql) {
      violations.push({
        rule,
        why: "no migrations were read, so every table would look unmigrated and nothing would be checked",
        fix: "run this check from the repo root so supabase/migrations is in the corpus",
        where: "supabase/migrations",
        line: "no migration files in the corpus",
      });
    } else {
      const tables = new Set(
        [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_0-9]+)/g)].map((m) => m[1]),
      );
      const fns = new Set(
        [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)/g)].map((m) => m[1]),
      );
      for (const f of files) {
        if (!/^src\/.*\.tsx?$/.test(f.path)) continue;
        codeLines(f).forEach((line, i) => {
          for (const [re, known, kind] of [
            [/\.from\("([a-z_0-9]+)"\)/g, tables, "table"],
            [/\.rpc\("([a-z_0-9]+)"/g, fns, "function"],
          ]) {
            for (const m of line.matchAll(re)) {
              if (known.has(m[1])) continue;
              violations.push({
                rule,
                why: `this reads a ${kind} that no migration in this repo creates, so the deploy would run against a schema that does not have it`,
                fix: `add the migration that creates ${m[1]} in the same change, or correct the name`,
                where: `${f.path}:${i + 1}`,
                line: line.trim().slice(0, 120),
              });
            }
          }
        });
      }
    }
  }

  // COMM-09. A crawler that announces itself gets refused, and PERS-10 says a
  // refusal is then filed as "this supplier publishes nothing". So the two
  // rules compound: naming ourselves in the user agent turns our own politeness
  // into bad data about the client's market. 1,751 residual leads were parsed
  // from 403 bodies on 2026-08-05 for this reason.
  //
  // The check is on the literal, not on a shared constant, because there are
  // six user agents in the fleet and consolidating them is its own change. What
  // matters is that none of them says who we are.
  forbid({
    rule: "crawl/no-agent-identifying-user-agent",
    why: "a self-identifying crawler is refused, and PERS-10 then files the refusal as an empty page",
    fix: "use an ordinary browser user agent; if a supplier needs to allow us, arrange it out of band",
    // The rule has to be able to name the thing it forbids.
    allow: ["rules/10-communication.md"],
    test: (l) =>
      /user-?agent/i.test(l) &&
      /(?:Tenkara|TackleBox|Sierra|ops-agents|[A-Za-z-]*(?:Bot|Crawler|Spider|Agent|Scout|Enrich))[A-Za-z-]*\/\d/.test(l),
  });

  // UI-11. A placeholder is what the operator sees when the field is empty, so
  // one that reads as a number is indistinguishable from a stored value that
  // happens to be greyed out. The marketplace pricing card had three: 25, 450.00
  // and 18.00, on case size, case price and unit price.
  //
  // Anything that is ONLY digits is the break. A unit ("kg"), a format hint
  // ("price per unit") or an "e.g." are the correct forms and must stay legal,
  // which is why this matches the whole string rather than a leading digit.
  forbid({
    rule: "ui/no-numeric-placeholder-in-value-field",
    why: "a numeric placeholder is read as a stored value, so an empty field looks like a filled one",
    fix: "use the unit or the format instead: placeholder=\"kg\", \"price per unit\", \"e.g. 4\"",
    test: (l, f) => f.path.endsWith(".tsx") && /placeholder=(?:"|\{")\s*[$€£]?\d[\d,]*(?:\.\d+)?\s*(?:"|"\})/.test(l),
  });

  // DATA-05. Guessing which mailbox a named person has is allowed. Guessing on
  // a platform host is not: `first.last@alibaba.com` is not that supplier's
  // address, it is somebody else's. And a guess that is not labelled a guess
  // becomes a fact the moment it is stored.
  //
  // Both conditions live in one block in enrich.ts, which is the only place in
  // the repo that builds an address out of a name and a domain. The check keeps
  // them together: the failure mode is one of the two being moved or dropped in
  // a cleanup, since each looks redundant next to the other.
  {
    const rule = "contacts/guessed-combo-requires-own-domain-and-flag";
    const enrich = anchor("src/agents-runtime/agents/data-enrichment/enrich.ts", {
      rule,
      why: "this is the only file that synthesises an email address from a name and a domain",
      fix: "restore src/agents-runtime/agents/data-enrichment/enrich.ts",
    });
    if (enrich) {
      const text = codeLines(enrich).join("\n");
      const guess = /contactSource\s*=\s*"pattern_guess"/.exec(text);
      if (!guess) {
        violations.push({
          rule,
          why: "the guessed-combo branch is what this rule is about, and it cannot be found to check",
          fix: "keep the guess stamping contactSource = \"pattern_guess\" so it stays identifiable",
          where: enrich.path,
          line: "no pattern_guess branch found",
        });
      } else {
        const around = text.slice(Math.max(0, guess.index - 1200), guess.index + 400);
        if (!/!isAggregatorDomain\(/.test(around)) {
          violations.push({
            rule,
            why: "guessing on a platform host invents an address at a company that is not the supplier",
            fix: "keep the guess gated on !isAggregatorDomain(host)",
            where: enrich.path,
            line: "the guess branch is no longer gated on the host being the supplier's own",
          });
        }
        if (!/contactConfidence\s*=\s*"guessed"/.test(around)) {
          violations.push({
            rule,
            why: "a guess that is not labelled a guess is stored as a fact",
            fix: "keep contactConfidence = \"guessed\" alongside the pattern_guess source",
            where: enrich.path,
            line: "the guess branch no longer stamps a guessed confidence",
          });
        }
      }
    }
  }

  // DATA-06. "verified" is a claim that somebody tested the mailbox. It was
  // being stamped on every address the waterfall resolved, so a name scraped off
  // an about page and a mailbox a provider actually validated were stored as the
  // same thing, and the one column that could tell an operator which is which
  // said "verified" either way.
  //
  // The check is on the derivation, not on the word: the confidence must be
  // computed from the source that produced the address, and the cache replay
  // must be excluded, because a hit is a previous run's answer and DATA-06 only
  // credits a verdict from this one. Anything else assigning the literal is the
  // regression — it reads as a harmless default and silently re-widens the claim.
  {
    const rule = "contacts/confidence-derived-from-source";
    const enrich = anchor("src/agents-runtime/agents/data-enrichment/enrich.ts", {
      rule,
      why: "this is the only file that resolves a primary contact and labels it",
      fix: "restore src/agents-runtime/agents/data-enrichment/enrich.ts",
    });
    if (enrich) {
      const text = codeLines(enrich).join("\n");
      const derived = /VERIFYING_SOURCES\.has\(\s*contactSource\s*\)\s*\?\s*"verified"/.test(text);
      if (!derived) {
        violations.push({
          rule,
          why: "confidence is no longer derived from the source, so an untested address can be stored as verified",
          fix: 'derive it: VERIFYING_SOURCES.has(contactSource) ? "verified" : "discovered"',
          where: enrich.path,
          line: "no source-derived confidence expression found",
        });
      } else if (!/!cacheServed\s*&&\s*contactSource\s*&&\s*VERIFYING_SOURCES/.test(text)) {
        violations.push({
          rule,
          why: "a cached address carries a previous run's verdict, and DATA-06 counts only a same-run one",
          fix: "keep !cacheServed in front of the VERIFYING_SOURCES test",
          where: enrich.path,
          line: "the cache replay is no longer excluded from a verified verdict",
        });
      }
    }
    // Nowhere else may hand out the label. The set is the one place that decides
    // which providers verify, so a literal outside it is a claim with no test
    // behind it. The skills are in scope and are where the second writer was:
    // `contact-finder-agent/backfill.py` stamped verified on three of its own
    // paths, and `importyeti-resolve-contacts/resolve.py` wrote a vocabulary of
    // its own (`strong`, `medium`, `lead`) into the same column.
    for (const f of files) {
      if (!/\.(tsx?|py)$/.test(f.path)) continue;
      for (const [i, line] of codeLines(f).entries()) {
        // `p["contact_confidence"] = "verified"` and `contact_confidence:
        // "verified"` are the same statement in two languages.
        if (!/(?:contactConfidence|contact_confidence|confidence)["'\]\s]*[:=]\s*["']verified["']/.test(line)) continue;
        if (/VERIFYING_SOURCES/.test(line)) continue;
        violations.push({
          rule,
          why: "this stamps a verification verdict without a provider having tested the mailbox",
          fix: "derive the confidence from contactSource via VERIFYING_SOURCES, or add the provider to that set if it really validates",
          where: `${f.path}:${i + 1}`,
          line: line.trim(),
        });
      }
    }
    // The column has three words and they mean specific things. A writer with a
    // vocabulary of its own is not caught by the test above and is worse than a
    // wrong value: `importyeti-resolve-contacts` was copying the model's own
    // "strong"/"medium"/"lead" rating of whether it had found the right COMPANY
    // into the column an operator reads as a verdict on the ADDRESS.
    const WORDS = new Set(["verified", "discovered", "guessed"]);
    for (const f of files) {
      if (!/\.(tsx?|py)$/.test(f.path)) continue;
      for (const [i, line] of codeLines(f).entries()) {
        const m = /contact_confidence["'\]\s]*[:=]\s*(.+)$/.exec(line);
        if (!m) continue;
        const rhs = m[1].trim();
        const lit = /^["']([^"']*)["']/.exec(rhs);
        const copied = /\.get\(\s*["']confidence["']\s*\)|\[\s*["']confidence["']\s*\]/.test(rhs);
        if (!lit && !copied) continue;
        if (lit && WORDS.has(lit[1])) continue;
        violations.push({
          rule,
          why: copied
            ? "this copies another system's confidence word into a column that is read as a verdict on the address"
            : `"${lit[1]}" is not one of the three states this column has, so nothing downstream can read it`,
          fix: 'write "verified", "discovered" or "guessed", derived from the source that produced the address',
          where: `${f.path}:${i + 1}`,
          line: line.trim(),
        });
      }
    }
  }

  // UI-06 / PERS-07. Work the fleet flags for a person has to be somewhere a
  // person looks. Five withholding reasons were computed every day and not one
  // was rendered anywhere in the product: the reason was appended to an object
  // already frozen for storage, or written onto the very row the gate had just
  // deleted, and the three surfaces that would have shown it all gated on a
  // status migration 0089 retired. The price-index tab rendered a blank cell,
  // which reads as "nobody has got to this yet", so nothing was ever picked up.
  //
  // Three things have to hold, and they are checked against each other rather
  // than against a list written here: the registry declares the sets, the loader
  // iterates the registry rather than naming sets, and the panel knows none of
  // the keys. A panel that names its sets is a panel a sixth set can be left off.
  {
    const rule = "ui/flagged-set-must-have-a-surface";
    let keys = [];
    const registry = anchor("src/lib/flagged-work.ts", {
      rule,
      why: "this registry is what gives a flagged set a place on the client's tab",
      fix: "restore src/lib/flagged-work.ts",
    });
    if (registry) {
      const text = codeLines(registry).join("\n");
      keys = [...text.matchAll(/key:\s*"([a-z_]+)"/g)].map((m) => m[1]);
      if (!keys.length) {
        violations.push({
          rule,
          why: "the registry declares no flagged sets, so the panel it feeds renders nothing whatever the fleet flags",
          fix: "declare each flagged set in FLAGGED_SETS with a key, a label, the rule it serves and a loader",
          where: registry.path,
          line: "no `key: \"...\"` entries found in FLAGGED_SETS",
        });
      }
      if (!/FLAGGED_SETS\s*\.\s*map\(|for \(const \w+ of FLAGGED_SETS\)/.test(text)) {
        violations.push({
          rule,
          why: "the loader does not walk the registry, so a set added to it is loaded only if someone also remembers to wire it up",
          fix: "load every set by iterating FLAGGED_SETS; never name the sets individually",
          where: registry.path,
          line: "loadFlaggedWork does not iterate FLAGGED_SETS",
        });
      }
    }

    const panel = anchor("src/components/flagged-work-panel.tsx", {
      rule,
      why: "this panel is the only surface any flagged set has",
      fix: "restore src/components/flagged-work-panel.tsx",
    });
    if (panel) {
      const text = codeLines(panel).join("\n");
      if (!/\bgroups\b/.test(text) || !/\.map\(/.test(text)) {
        violations.push({
          rule,
          why: "the panel does not render the groups it is handed, so a declared set still has no surface",
          fix: "render every group passed in; the panel must not decide which sets are worth showing",
          where: panel.path,
          line: "no map over `groups` found",
        });
      }
      for (const k of keys) {
        if (!text.includes(k)) continue;
        violations.push({
          rule,
          why: `the panel names the "${k}" set, so it renders the sets it knows about rather than the sets that exist`,
          fix: "render the groups generically; a set is declared once, in FLAGGED_SETS, and nowhere else",
          where: panel.path,
          line: `flagged set key "${k}" hardcoded in the surface`,
        });
      }
    }

    const overview = anchor("src/app/(app)/work/orgs/[slug]/page.tsx", {
      rule,
      why: "the client's own workspace is the tab a flagged set has to appear on",
      fix: "restore the org overview page",
    });
    if (overview && !/<FlaggedWorkPanel[\s/>]/.test(codeLines(overview).join("\n"))) {
      violations.push({
        rule,
        why: "the client's workspace does not render the flagged panel, so every declared set is computed and shown to nobody",
        fix: "render <FlaggedWorkPanel groups={...} /> on the org overview",
        where: overview.path,
        line: "no <FlaggedWorkPanel> on the client's own tab",
      });
    }

    // The write half. An agent that runs the publish gate and does not record
    // the withholding has produced a missing price indistinguishable from one
    // nobody has pulled yet — which is how the withheld set stayed invisible
    // even before the surface existed.
    for (const f of files) {
      if (!f.path.includes("src/agents-runtime/")) continue;
      const text = codeLines(f).join("\n");
      if (!/\bpublishable(?:Tiers|Price)\s*\(/.test(text)) continue;
      if (/\bwithheldMark\s*\(/.test(text)) continue;
      violations.push({
        rule,
        why: "this agent runs the publish gate but never marks what the gate took away, so the reason dies with the row",
        fix: "pass the gate's issues through withheldMark() and store the mark on the object that is written",
        where: f.path,
        line: "publishable* called with no withheldMark()",
      });
    }
  }

  // PERS-10. A 403 body is a challenge page. Parsing it finds no email and no
  // company name, which is indistinguishable from a page that publishes
  // neither, so our own block ends up stored as the supplier's missing data.
  //
  // The helper list is derived from the corpus rather than written down: any
  // function that returns both an `ok` flag and a body is a fetcher, so a
  // seventh fetcher written next month is covered the day it exists. That is
  // the half a hand-maintained list always loses.
  {
    const rule = "fetch/blocked-must-not-read-as-empty";
    const fetchers = new Map();
    for (const f of files) {
      if (!/\.tsx?$/.test(f.path)) continue;
      const text = codeLines(f).join("\n");
      const decl = /(?:async function|const)\s+(\w+)\s*(?:=\s*async\s*)?\([^)]*\)\s*:\s*Promise<([^\n]*)>/g;
      let m;
      while ((m = decl.exec(text))) {
        const [, name, ret] = m;
        if (!/\bok\s*:/.test(ret)) continue;
        if (!/\b(?:html|text|body)\s*:/.test(ret)) continue;
        fetchers.set(name, f.path);
      }
    }
    for (const f of files) {
      if (!/\.tsx?$/.test(f.path)) continue;
      const text = codeLines(f).join("\n");
      for (const name of fetchers.keys()) {
        const call = new RegExp(`\\b${name}\\s*\\(`, "g");
        let m;
        while ((m = call.exec(text))) {
          // Skip the declaration itself.
          if (/(?:function|const)\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
          const after = text.slice(m.index, m.index + 700);
          if (/\.ok\b|\.status\b|\bstatus\s*===|\bok\s*\?/.test(after)) continue;
          violations.push({
            rule,
            why: `${name} reports whether the page was refused and this call site never reads it, so a 403 body is parsed as the page`,
            fix: `consult .ok or .status on the result before touching its body; record the refusal separately from "publishes nothing"`,
            where: f.path,
            line: text.slice(m.index, m.index + 90).split("\n")[0].trim(),
          });
        }
      }
    }
  }

  // The call-site half above proves the refusal was READ. These two prove it
  // was ACTED ON, at the only two places in the fleet that parse fetched HTML.
  // Both shipped breaking this rule while consulting `ok` elsewhere in the same
  // file, which is exactly why one conjunct is not enough.
  {
    const rule = "fetch/blocked-must-not-read-as-empty";
    const enrich = anchor("src/agents-runtime/agents/data-enrichment/enrich.ts", {
      rule,
      why: "this is the crawl that reads a supplier's own site for contacts",
      fix: "restore src/agents-runtime/agents/data-enrichment/enrich.ts",
    });
    if (enrich) {
      const text = codeLines(enrich).join("\n");
      const parse = /for \(const e of extractEmails\(page\.html\)\)/.exec(text);
      if (!parse) {
        violations.push({
          rule,
          why: "the crawl's contact extraction is what this rule gates, and it cannot be found to check",
          fix: "keep the page extraction identifiable inside the crawl loop",
          where: enrich.path,
          line: "no extractEmails(page.html) found in the crawl loop",
        });
      } else {
        // Between the loop's last look at `page.ok` and the extraction there
        // has to be a way out. Any `continue` in a fixed-size window would also
        // count the two guards at the top of the loop, which say nothing about
        // whether the page was refused.
        const okAt = text.lastIndexOf("page.ok", parse.index);
        const between = okAt === -1 ? "" : text.slice(okAt, parse.index);
        if (okAt === -1 || !/\bcontinue;/.test(between)) {
          violations.push({
            rule,
            why: "a refused page's body reaches the extractors, so our block is written into the supplier's record as absent data",
            fix: "keep the non-ok branch continuing past the extractors, above the extraction",
            where: enrich.path,
            line: "extraction is reachable for a page that was refused",
          });
        }
      }
    }
    const store = anchor("src/agents-runtime/agents/data-enrichment/storefront-resolve.ts", {
      rule,
      why: "this is the resolver that reads a marketplace listing for the supplier's identity",
      fix: "restore src/agents-runtime/agents/data-enrichment/storefront-resolve.ts",
    });
    if (store) {
      const text = codeLines(store).join("\n");
      const parse = /identityFromListing\(listing\.html\)/.exec(text);
      if (!parse) {
        violations.push({
          rule,
          why: "the listing parse is what this rule gates, and it cannot be found to check",
          fix: "keep the listing parse identifiable",
          where: store.path,
          line: "no identityFromListing(listing.html) found",
        });
      } else if (!/!listing\.ok/.test(text.slice(Math.max(0, parse.index - 700), parse.index))) {
        violations.push({
          rule,
          why: "a challenge page is parsed as the listing, so the supplier carries our block as their own missing identity",
          fix: "return early on !listing.ok, with a note saying the page refused the request",
          where: store.path,
          line: "the listing is parsed without checking whether it was refused",
        });
      }
    }
  }

  // OUT-04. A supplier gets one thread, so the consolidation key is per supplier
  // and per org and nothing else. Adding the material to the key is the plausible
  // regression — it looks like it fixes subject-line collisions and instead sends
  // the same person four emails.
  //
  // Two conjuncts, because the rule can break at either end: the key, and the
  // call. The call must be fed the whole group; `leads: [one]` inside the loop
  // is the same fault expressed differently.
  {
    const rule = "outreach/one-thread-per-supplier";
    const f = anchor("src/agents-runtime/agents/outreach/index.ts", {
      rule,
      why: "this is the only place cold outreach decides how many threads a supplier gets",
      fix: "restore src/agents-runtime/agents/outreach/index.ts",
    });
    if (f) {
      const text = codeLines(f).join("\n");
      const key = /const supplierKeyOf[\s\S]{0,600}?\n {4}\};/.exec(text);
      if (!key || !/for \(const \[\w+, \w+\] of emailBySupplier\)/.test(text)) {
        violations.push({
          rule,
          why: "the per-supplier grouping is what makes one thread per supplier true",
          fix: "keep supplierKeyOf building emailBySupplier and keep the drafting loop over that map",
          where: f.path,
          line: "supplierKeyOf / emailBySupplier loop not found",
        });
      } else if (/material|lead\.id|created_at/.test(key[0])) {
        violations.push({
          rule,
          why: "a key that includes the material splits one supplier into one thread per material",
          fix: "key on org and supplier only; the material belongs in the body, not in the key",
          where: f.path,
          line: "supplierKeyOf mentions the material or the lead",
        });
      }
      const calls = text.match(/runOutreachForSupplier\(\{/g) ?? [];
      if (calls.length !== 1 || !/leads:\s*\w+\.map\(/.test(text)) {
        violations.push({
          rule,
          why: "a second staging call, or one fed a single lead, is a second thread to the same supplier",
          fix: "stage once per group and pass the whole pool as leads",
          where: f.path,
          line: `${calls.length} staging call(s), grouped leads argument ${/leads:\s*\w+\.map\(/.test(text) ? "present" : "missing"}`,
        });
      }
    }
  }

  // OUT-12. "Denied" in the email app means a supplier has not been validated
  // yet. It was read as do-not-contact on 2026-08-19, a guard was built on that
  // reading, and it was reverted the same day. Nothing in the repo makes that
  // read today, and the check exists so it cannot come back under a new name.
  //
  // The durable half is the second conjunct: the old symbols are deleted, so a
  // check written against them would be dead text. What recurs is the meaning —
  // the word `denied` arriving at a suppression verdict.
  forbid({
    rule: "suppliers/approval-denied-is-not-do-not-contact",
    why: "denied in Tenkara means not yet validated; treating it as do-not-contact silently shelves live suppliers",
    fix: "leave approval to the suppliers display; suppression comes from supplier_do_not_contact and client dnc_suppliers only",
    // The two display sites that legitimately bucket the column.
    allow: ["src/lib/campaign-suppliers.ts", "src/lib/client-suppliers.ts", "rules/60-outreach.md"],
    test: (l) =>
      /\bdenied\b/.test(l) &&
      /suppressed|isDraftSuppressed|isDoNotContact|do_not_contact|\bdnc_|blocked:\s*true/.test(l),
  });
  forbid({
    rule: "suppliers/approval-denied-is-not-do-not-contact",
    why: "reading the denied set out of the suppliers table is how the reverted guard started",
    fix: "do not query suppliers by approval for outreach purposes",
    allow: ["src/lib/campaign-suppliers.ts", "src/lib/client-suppliers.ts"],
    test: (l) => /from\s+(?:public\.)?suppliers\b[\s\S]{0,80}approval/.test(l) || /approval\s*=\s*'denied'/.test(l),
  });

  // UI-02. Work is looked at per client, because a cross-org worklist is how a
  // draft for one client gets read, approved and sent against another's supplier.
  // Seven global review routes predate the rule and deleting them is a product
  // decision, not a cleanup, so this is a ratchet: the seven are named, and an
  // eighth fails the build. Removing one of the seven from this list is how the
  // debt gets paid down; adding to it is not.
  {
    const rule = "ui/no-global-review-route";
    const PREDATES = new Set([
      "src/app/(app)/work/review/page.tsx",
      "src/app/(app)/work/review/leads/page.tsx",
      "src/app/(app)/work/review/drafts/page.tsx",
      "src/app/(app)/work/review/marketplace/page.tsx",
      "src/app/(app)/work/review/marketplace-outreach/page.tsx",
      "src/app/(app)/work/review/staged-quotes/page.tsx",
      "src/app/(app)/work/review/pricing-pipeline/page.tsx",
    ]);
    // The scope is the review tree itself, not every cross-org page. The
    // operator home and the work index also read worklist tables, and they are
    // not the fault: both scope by org access and label every row with its
    // client. What UI-02 is about is a screen that presents work as one pile.
    for (const f of files) {
      if (!/^src\/app\/\(app\)\/work\/review\/.*page\.tsx$/.test(f.path)) continue;
      if (PREDATES.has(f.path)) continue;
      violations.push({
        rule,
        why: "the global review tree presents two clients' work as one pile, which is how a draft crosses clients",
        fix: "put the page under work/orgs/[slug]/ and scope every query to that org",
        where: f.path,
        line: "new route in the deprecated global review tree",
      });
    }
  }

  // COMM-05. The fleet posts as the bot, never as a person. A user token would
  // put words in someone's mouth, and a second hand-rolled sender is how a
  // channel override or a user token gets in without anyone reviewing it, so
  // both halves are one check: one sender, and no user token anywhere.
  //
  // Four skill scripts post directly and are grandfathered, because skills run
  // outside the deploy and cannot import from src. They are the reason the
  // second conjunct exists: a user token in one of them would be invisible.
  forbid({
    rule: "comm/one-slack-sender",
    why: "a second sender is where a channel override or a user token gets in unreviewed",
    fix: "post through postSlackMessage in src/lib/slack.ts, or postAgentAlert for anything an operator must act on",
    allow: ["src/lib/slack.ts"],
    test: (l) => /chat\.postMessage/.test(l),
  });
  forbid({
    rule: "comm/one-slack-sender",
    why: "a user token posts as a person, so the fleet would be speaking in someone's voice",
    fix: "use SLACK_BOT_TOKEN; if a message must come from a person, a person sends it",
    allow: ["rules/10-communication.md"],
    test: (l) => /xoxp-|SLACK_USER_TOKEN|slack_user_token/.test(l),
  });

  // OUT-10. A phased hold waits on a first email. The held leads are excluded
  // from the outreach fetch window, so when that email is cancelled the hold is
  // both permanent and invisible — 128 blocked drafts on 2026-08-03 shelved 219
  // suppliers, and on 2026-08-22 59 leads were still waiting on a draft that had
  // been discarded, superseded or deleted outright.
  {
    const rule = "outreach/cancel-must-release-alias";
    const MOD = "src/lib/outreach-holds.ts";
    const AGENT = "src/agents-runtime/agents/outreach/index.ts";

    const mod = anchor(MOD, {
      rule,
      why: "one sweep gives a held lead back, and one list says what a live draft is",
      fix: "restore src/lib/outreach-holds.ts",
    });
    if (mod) {
      for (const [sym, why] of [
        ["releaseDeadPhasedHolds", "without the sweep a cancelled email shelves its supplier's other materials for good"],
        ["LIVE_DRAFT_STATUSES", "two copies of what counts as a live draft drift, and the half that drifts holds leads on drafts that are gone"],
      ]) {
        if (!new RegExp(`export (async function|const) ${sym}\\b`).test(mod.text)) {
          violations.push({
            rule,
            why,
            fix: `keep ${sym} exported from ${MOD}`,
            where: MOD,
            line: `${sym} is gone`,
          });
        }
      }
    }

    const agent = anchor(AGENT, {
      rule,
      why: "the outreach sweep is the only pass that can see these leads at all",
      fix: `restore ${AGENT}`,
    });
    if (agent) {
      if (!/releaseDeadPhasedHolds\(/.test(agent.text)) {
        violations.push({
          rule,
          why: "held leads are filtered out of every fetch, so if this pass does not release them nothing will",
          fix: "call releaseDeadPhasedHolds before pulling candidates",
          where: agent.path,
          line: "nothing gives a dead hold back",
        });
      }
      if (!/first_pool_thread_id/.test(agent.text)) {
        violations.push({
          rule,
          why: "a hold that names neither a draft nor a thread cannot be released when that thing dies",
          fix: "record first_pool_thread_id alongside first_pool_draft_ref_id when holding",
          where: agent.path,
          line: "a hold no longer records what it waits on",
        });
      }
    }

    // One definition of a live draft, everywhere.
    for (const f of files) {
      if (!f.path.startsWith("src/") || f.path.endsWith(MOD)) continue;
      codeLines(f).forEach((line, i) => {
        if (/"staged",\s*"reviewed",\s*"sent",\s*"linked"/.test(line)) {
          violations.push({
            rule,
            why: "a second copy of the live-draft list is the drift that leaves a lead held on a draft this copy still calls alive",
            fix: "import LIVE_DRAFT_STATUSES from src/lib/outreach-holds.ts",
            where: `${f.path}:${i + 1}`,
            line: line.trim().slice(0, 120),
          });
        }
      });
    }
  }

  // OUT-08. Asking a supplier for every blank field at once is what ops flagged
  // on 2026-08-15 ("It sounds too AI because its asking all of the blank
  // fields"), and suppliers stopped answering. The cadence that fixed it is
  // three stages and a cap of three asks, and every part of it is quiet when it
  // breaks: a new askable field with no stage is exiled to the end of the
  // conversation by a `?? 3` default, and a second drafting path that skips the
  // selector reads as a working email right up until the supplier goes silent.
  {
    const rule = "outreach/asks-must-be-staged";
    const MOD = "src/lib/quote-completeness.ts";

    const mod = anchor(MOD, {
      rule,
      why: "one stage map, one cap, one selector — the cadence only holds if there is a single copy of it",
      fix: "restore src/lib/quote-completeness.ts",
    });
    if (mod) {
      // Every field this module can ask for has to be staged on purpose.
      const stageMap = mod.text.match(/const ASK_STAGE_BY_KEY[^{]*\{([\s\S]*?)\n\};/);
      const staged = new Set(
        stageMap ? Array.from(stageMap[1].matchAll(/^\s*([a-z_]+)\s*:\s*[123]\s*,/gm)).map((m) => m[1]) : []
      );
      const askable = new Set([
        ...Array.from(mod.text.matchAll(/\badd\("([a-z_]+)"/g)).map((m) => m[1]),
        ...Array.from(mod.text.matchAll(/merged:\s*\{\s*\n?\s*key:\s*"([a-z_]+)"/g)).map((m) => m[1]),
      ]);
      for (const key of askable) {
        if (!staged.has(key)) {
          violations.push({
            rule,
            why: "an unstaged field falls to the `?? 3` default, which asks for it only once we already intend to buy — silently, and possibly never",
            fix: `add "${key}" to ASK_STAGE_BY_KEY with the stage the next decision actually needs`,
            where: MOD,
            line: `${key} is askable but has no stage`,
          });
        }
      }
      if (!/export const MAX_ASKS_PER_REPLY\s*=\s*\d+/.test(mod.text)) {
        violations.push({
          rule,
          why: "without a declared cap the reply goes back to enumerating every blank field",
          fix: "keep MAX_ASKS_PER_REPLY exported as the default limit of the selector",
          where: MOD,
          line: "the per-reply cap is gone",
        });
      }
      if (!/askStage\(f\.key\)\s*===\s*stage/.test(mod.text)) {
        violations.push({
          rule,
          why: "capping without narrowing to one stage lets a logistics question ride along with a price question, which is the checklist again",
          fix: "keep selectStagedAsks narrowing to the earliest stage that still has anything outstanding",
          where: MOD,
          line: "the selector no longer narrows to one stage",
        });
      }
    }

    // Both paths that put an ask in front of a supplier go through the selector.
    for (const caller of ["src/lib/reply-drafter.ts", "src/agents-runtime/agents/reply-manager/stalled-followup.ts"]) {
      const f = anchor(caller, {
        rule,
        why: "a reply and a chase both ask, and if they disagree the supplier is asked for two different things",
        fix: `restore ${caller}`,
      });
      if (f && !/selectStagedAsks\(/.test(f.text)) {
        violations.push({
          rule,
          why: "an ask assembled outside the selector is unstaged and uncapped, which is exactly the draft ops rejected",
          fix: "select what to ask with selectStagedAsks",
          where: f.path,
          line: "this path asks without staging",
        });
      }
    }

    // Anywhere the ask sentence is built, it is built from a staged selection.
    for (const f of files) {
      if (!f.path.startsWith("src/") || f.path.endsWith(MOD)) continue;
      if (!/buildCompletenessAsk\(/.test(f.text)) continue;
      if (!/selectStagedAsks\(/.test(f.text)) {
        violations.push({
          rule,
          why: "building the sentence from the raw missing set is the original break: nineteen blank fields in one paragraph",
          fix: "pass buildCompletenessAsk the output of selectStagedAsks, never the full missing set",
          where: f.path,
          line: "the ask sentence is built from an unstaged set",
        });
      }
      if (!/countAsksInBody\([^)]*\)\s*===\s*0/.test(f.text)) {
        violations.push({
          rule,
          why: "appended alongside the model's own asks it doubles them, which is how one reply came to ask thirteen things",
          fix: "fire the appended ask only when the drafted body asks nothing at all",
          where: f.path,
          line: "the appended ask is no longer a backstop",
        });
      }
    }
  }

  // DISC-09. Whether a client makes a material themselves is read from Tenkara
  // over a link that timed out or throttled 18 times in one day. Every one of
  // the five gates resolved that failure to "nothing is self-supplied", which
  // is the one answer that resumes sourcing on all of it — 217 California
  // Chemicals leads on Glycerin, held out 1,118 times, would have gone back
  // through enrichment and outreach on the first outage. So the lookup reports
  // whether it knows, and a caller that does not know stops.
  {
    const rule = "discovery/self-supplied-gate-must-fail-closed";
    const MOD = "src/lib/self-supplied-materials.ts";

    const mod = anchor(MOD, {
      rule,
      why: "one lookup, and it is the thing that has to distinguish a no from a silence",
      fix: "restore src/lib/self-supplied-materials.ts",
    });
    if (mod) {
      if (!/export async function loadSelfSuppliedMaterials\b/.test(mod.text)) {
        violations.push({
          rule,
          why: "a loader that returns a bare Set cannot say it failed, so every caller reads an outage as an empty answer",
          fix: "keep loadSelfSuppliedMaterials returning { known: true; ids } | { known: false; reason }",
          where: MOD,
          line: "the three-state lookup is gone",
        });
      }
      if (!/known:\s*false/.test(mod.text) || !/known:\s*true/.test(mod.text)) {
        violations.push({
          rule,
          why: "'could not ask' has to be a value a caller can branch on, not an empty set that looks like a no",
          fix: "return { known: false, reason } on a Tenkara error and { known: true, ids } otherwise",
          where: MOD,
          line: "the lookup no longer reports whether it knows",
        });
      }
    }

    // Every caller has to branch on it, and none may swallow the failure.
    const CALLERS = [
      "src/agents-runtime/agents/lead-creator/index.ts",
      "src/agents-runtime/agents/data-enrichment/index.ts",
      "src/agents-runtime/agents/outreach/index.ts",
      "src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts",
      "src/app/api/agent/leads/route.ts",
    ];
    for (const caller of CALLERS) {
      const f = anchor(caller, {
        rule,
        why: "this is one of the five places that source, enrich, email or price a material",
        fix: `restore ${caller}`,
      });
      if (!f) continue;
      if (!/loadSelfSuppliedMaterials\(/.test(f.text)) {
        violations.push({
          rule,
          why: "a path that never asks whether the client makes it themselves will source it",
          fix: "call loadSelfSuppliedMaterials() before the pass does any work",
          where: f.path,
          line: "the self-supplied lookup is gone from this path",
        });
        continue;
      }
      if (!/if\s*\(!\s*\w+(\.\w+)*\.known\)/.test(f.text)) {
        violations.push({
          rule,
          why: "reading `.ids` without checking `.known` is the fail-open again under a new name",
          fix: "stop the pass when the lookup is not known, before filtering on it",
          where: f.path,
          line: "the unknown answer is no longer handled",
        });
      }
    }
  }

  // DISC-05. A platform is a route to a supplier, never the supplier. Two
  // halves, and only the first was held. Discovery refuses to stage a platform
  // as a company (`isAggregatorPlatformName` in the scout), but nothing stopped
  // the platform's own inbox being stamped as a supplier's contact: 100 leads
  // carry one today, including `service@echemi.com` on a Chinese manufacturer.
  // None was ever written to, but only because those leads had not reached
  // outreach yet.
  {
    const rule = "discovery/platform-is-never-manufacturer";
    const HOSTS = "src/lib/aggregator-hosts.ts";

    const hosts = anchor(HOSTS, {
      rule,
      why: "one list of platforms, and one answer to whether a name or an address belongs to one",
      fix: "restore src/lib/aggregator-hosts.ts",
    });
    for (const fn of ["isAggregatorPlatformName", "isPlatformOwnedContact"]) {
      if (hosts && !new RegExp(`export function ${fn}`).test(hosts.text)) {
        violations.push({
          rule,
          why: "without the shared test each caller invents its own, and the ones that never had a test are exactly where the platform got recorded as the supplier",
          fix: `keep ${fn} exported from ${HOSTS}`,
          where: HOSTS,
          line: `${fn} is gone`,
        });
      }
    }

    // Discovery: a platform's own name is never staged as a company.
    const scout = anchor("src/agents-runtime/agents/lead-creator/scout.ts", {
      rule,
      why: "the scout is where a search result becomes a company, so it is where a directory would become one",
      fix: "restore src/agents-runtime/agents/lead-creator/scout.ts",
    });
    if (scout && !/isAggregatorPlatformName\(/.test(scout.text)) {
      violations.push({
        rule,
        why: "a directory staged as a company is chased for a quote it can never give, and the client's list of suppliers is wrong",
        fix: "reject a result whose company name is the platform's own, via isAggregatorPlatformName",
        where: scout.path,
        line: "discovery no longer rejects a platform staged as a company",
      });
    }

    // Outreach: a platform's own address is never the supplier's contact.
    const staging = anchor("src/lib/draft-staging.ts", {
      rule,
      why: "eighteen places stamp a contact email on a lead and one place sends to it, so the gate belongs at the send",
      fix: "restore src/lib/draft-staging.ts",
    });
    if (staging && !/isPlatformOwnedContact\(/.test(staging.text)) {
      violations.push({
        rule,
        why: "a directory's inbox reaches the directory; the manufacturer may never hear of it and the reply comes back from the platform, which then reads as the supplier",
        fix: "block a draft whose recipient is a platform's own address at the staging chokepoint",
        where: staging.path,
        line: "outreach can address a platform's own inbox as the supplier",
      });
    }
  }

  // PERS-02. A "needs a human" mark may move a record to a person's queue. It
  // may never take it out of every queue. Two shapes break that: a read that
  // filters the marked rows away, and a write that parks a record against a
  // person and leaves it parked after the person is gone. The second is the one
  // that happened: 147 leads sat `dropped` pointing at a case, and nothing
  // anywhere gave them back when that case was dismissed or resolved.
  {
    const rule = "queues/flag-must-not-exit-queue";
    const HOLDS = "src/lib/lead-queue-holds.ts";

    // A read that hides the flagged rows. The flag is for the operator's eyes;
    // it is not a reason the machine stops looking.
    for (const f of files) {
      if (!f.path.startsWith("src/") || f.path === HOLDS) continue;
      codeLines(f).forEach((line, i) => {
        if (
          /\.(eq|is)\(\s*"needs_review"\s*,\s*false/.test(line) ||
          /\.neq\(\s*"[a-z_]*(status|classification)"\s*,\s*"needs_review"/.test(line) ||
          /filter\([^)]*=>\s*!\w+\.needs_review/.test(line)
        ) {
          violations.push({
            rule,
            why: "filtering the flagged rows out of the work read is how a record marked for a human stops being retried and is never seen again",
            fix: "leave the flagged rows in the queue and render the flag; a flag is for the operator's eyes, not a reason to stop looking",
            where: f.path,
            line: `${i + 1}: ${line.trim().slice(0, 100)}`,
          });
        }
      });
    }

    // A write that parks a lead against a case. Allowed, and only through the
    // module that also knows how to give it back.
    const holds = anchor(HOLDS, {
      rule,
      why: "parking a lead against a case is a loan, and this is the only place that records the loan and calls it in",
      fix: "restore src/lib/lead-queue-holds.ts",
    });
    if (holds && !/export async function releaseClosedHolds/.test(holds.text)) {
      violations.push({
        rule,
        why: "without the release sweep a parked lead has no way back, which is the exact state the rule forbids",
        fix: "keep releaseClosedHolds in src/lib/lead-queue-holds.ts",
        where: HOLDS,
        line: "the sweep that gives a held lead back is gone",
      });
    }
    const escalation = anchor("src/agents-runtime/agents/escalation/index.ts", {
      rule,
      why: "the escalation agent both parks leads and is the run that gives them back",
      fix: "restore src/agents-runtime/agents/escalation/index.ts",
    });
    if (escalation && !/releaseClosedHolds\(/.test(escalation.text)) {
      violations.push({
        rule,
        why: "a sweep nothing calls is the same as no sweep, and the leads stay dropped",
        fix: "call releaseClosedHolds at the start of the escalation run",
        where: escalation.path,
        line: "nothing releases leads held by a closed case",
      });
    }
    for (const f of files) {
      if (!f.path.startsWith("src/") || f.path === HOLDS) continue;
      codeLines(f).forEach((line, i) => {
        if (!/drop_reason\s*:/.test(line)) return;
        if (!/"(escalated_to_case|duplicate_open_case)"/.test(line)) return;
        violations.push({
          rule,
          why: "a hold written by hand records no case id and no sweep can find it, so the lead never comes back",
          fix: "park the lead with holdLeadForCase from src/lib/lead-queue-holds.ts",
          where: f.path,
          line: `${i + 1}: ${line.trim().slice(0, 100)}`,
        });
      });
    }
  }

  // AUTO-08. A call task is owned by a call operator or by nobody. The pool
  // filter in `poolForWork` already refuses to degrade a call to the email desk,
  // and that was read as the rule being held — but the filter only governs a
  // fresh derivation. Two paths reach a stamp without it: a case row written
  // straight to the table, and a stamp already in the database that nothing
  // revisits. The second is how an operator moved to the email desk kept
  // showing as the owner of open calls, and how a removed operator kept them
  // after every other surface had moved on.
  //
  // Three anchors, because the invariant is only true if all three hold: the
  // router asks for the call side, every insert takes its owner from that
  // router, and both re-derivation paths route calls over callers alone.
  {
    const rule = "assignment/call-owner-must-be-call-operator";
    const CALL_TYPE = '"calling_escalation"';

    const router = anchor("src/lib/call-escalation.ts", {
      rule,
      why: "call routing is the one place that asks for the call side of a client's team",
      fix: "restore src/lib/call-escalation.ts",
    });
    if (router && !/poolForWork\(\s*ctx\.pool\s*,\s*\{\s*type:\s*"call"/.test(router.text)) {
      violations.push({
        rule,
        why: "a call routed over the whole pool reaches whoever owns the supplier's inbox, and a ping to somebody who does not dial is a task nobody performs",
        fix: 'resolve the caller from poolForWork(ctx.pool, { type: "call", ... })',
        where: router.path,
        line: "the call router no longer asks for the call pool",
      });
    }

    // Every row that IS a call task takes its owner from the router. A literal
    // anywhere else — the draft's operator, a session user, a spread over the
    // email pool — is the 2026-08-07 break coming back.
    for (const f of files) {
      if (!f.path.startsWith("src/")) continue;
      const text = codeLines(f).join("\n");
      if (!text.includes(CALL_TYPE)) continue;
      for (const m of text.matchAll(/type:\s*"calling_escalation"[\s\S]{0,1200}?assigned_operator:\s*([^,\n]+)/g)) {
        const value = m[1].trim();
        if (/caller/.test(value)) continue;
        violations.push({
          rule,
          why: "a call task stamped with an owner the call router did not choose is how the email operator became the assignee in the first place",
          fix: "take the owner from CallOperatorResolver.route(...).caller, and write null when the client has named no caller",
          where: f.path,
          line: `call task assigned_operator: ${value.slice(0, 80)}`,
        });
      }
    }

    // Re-derivation, both paths. A stored stamp is the right fallback for desk
    // work and never for a call.
    const reader = anchor("src/lib/org-cases.ts", {
      rule,
      why: "every case surface derives its owner here, so this is where a stale call stamp is caught",
      fix: "restore src/lib/org-cases.ts",
    });
    if (reader && !/isCallCase\([\s\S]{0,80}?\?\s*"call"\s*:\s*"email"/.test(reader.text)) {
      violations.push({
        rule,
        why: "deriving a call owner as if it were desk work puts the supplier's inbox owner on the phone task",
        fix: 'pass isCallCase(c) ? "call" : "email" as the work type',
        where: reader.path,
        line: "case owner derivation no longer distinguishes a call",
      });
    }
    if (reader && !/operatorType\s*!==\s*"call"/.test(reader.text)) {
      violations.push({
        rule,
        why: "when derivation declines, the stored stamp stands — and on a call that stamp may name somebody who has since moved to the email desk, so the tab shows a caller who is not one",
        fix: "clear assigned_operator on a call case whose stamped operator is not a call operator today",
        where: reader.path,
        line: "a declined call derivation keeps whatever is stamped",
      });
    }

    const reassign = anchor("src/lib/reassign-owners.ts", {
      rule,
      why: "removing an operator is the moment their calls need a live owner or none",
      fix: "restore src/lib/reassign-owners.ts",
    });
    if (reassign && !/type:\s*"call"/.test(reassign.text)) {
      violations.push({
        rule,
        why: "reassigning a removed operator's calls over the ordinary pool hands phone work to the email desk, which is the fallback AUTO-08 exists to forbid",
        fix: 'pick a call case\'s new owner from poolForWork(pool, { type: "call", lane: null })',
        where: reassign.path,
        line: "operator removal reassigns calls over the email pool",
      });
    }
    if (reassign && !/from\("cases"\)/.test(reassign.text)) {
      violations.push({
        rule,
        why: "cases were the one owner stamp removal never touched, so a removed operator stayed the named owner of every open escalation they held",
        fix: "reassign open and in-progress cases alongside claims, drafts and leads",
        where: reassign.path,
        line: "operator removal does not touch case owners",
      });
    }
  }

  // PERS-06. A deliberate cap is allowed; a cap nobody is told about is not.
  //
  // The truncation guard catches the accidental thousand-row cut and waves
  // through anything carrying an explicit `.limit()`, on the grounds that the
  // caller asked for it. That is the hole this closes: a window is invisible in
  // exactly the same way an accident is, because nothing downstream is handed
  // the remainder. "Found 25 stale leads" read as the whole backlog when it was
  // the cap, four drain-caps reported no queue behind them, and a page showing
  // 50 of 3,461 staged drafts looked like a page showing 50 drafts.
  //
  // PostgREST returns the true matching count on the SAME request as the capped
  // page, so the fix costs nothing: `.select(..., { count: "exact" })`, then
  // cappedRead in src/lib/capped-read.ts carries the remainder out with the
  // rows. selectAllPaged is the other answer — read all of it and there is no
  // remainder to report.
  {
    const WORK_TABLES = new Set([
      "leads_in_flight",
      "draft_references",
      "staged_quotes",
      "cases",
      "supplier_profiles",
      "supplier_documents",
      "quote_profiles",
      "marketplace_check_findings",
      "supplier_do_not_contact",
      "pending_approvals",
    ]);
    // A window that genuinely hides no work, keyed by file AND by the exact
    // limit expression: rename the constant or move the file and the waiver
    // stops applying, which is the point. Each one states why in a comment at
    // the call site. Nothing is added here to silence a check — if work can be
    // left behind, it gets counted instead.
    const DECLARED_WINDOWS = new Set([
      // A statistical prior over already-pulled leads. Every lead is still
      // pulled on its own schedule; a wider sample moves a starting interval by
      // at most a day.
      "src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts@HOST_PRIOR_SAMPLE",
      // The discard history a re-draft is checked against. A remainder here
      // would not be work waiting, it would be a discard that fell off the end
      // and let the same email be staged twice, so the window is sized to make
      // that impossible rather than reported.
      "src/lib/draft-suppression.ts@DISCARD_WINDOW",
    ]);
    const REPORTS = /count:\s*["']exact["']|cappedRead|selectAllPaged|remainderNote|ShowingNote|windowed\(/;

    for (const f of files) {
      if (!f.path.startsWith("src/")) continue;
      const lines = codeLines(f);
      const text = lines.join("\n");

      // Which table a query builder held onto, for the `let q = admin.from(...)`
      // shape where the `.limit()` lands lines away from the `.from()`.
      const varTable = new Map();
      for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?\w+\s*\.from\(\s*["'`](\w+)["'`]/g)) {
        varTable.set(m[1], m[2]);
      }

      lines.forEach((line, i) => {
        const lim = /\.limit\(\s*([A-Za-z0-9_.]+)\s*\)/.exec(line);
        if (!lim) return;
        const arg = lim[1];
        // A one- or two-row lookup is an existence check, not a window.
        if (/^\d+$/.test(arg) && Number(arg) < 3) return;

        // The table this limit belongs to: nearest `.from()` above it in the
        // same chain, or the table the builder variable was created from.
        let table = null;
        for (let j = i; j >= Math.max(0, i - 40); j--) {
          const from = /\.from\(\s*["'`](\w+)["'`]/.exec(lines[j]);
          if (from) {
            table = from[1];
            break;
          }
          if (j < i && /;\s*$/.test(lines[j])) break;
        }
        if (!table) {
          const viaVar = /(?:await\s+)?(\w+)\s*\.limit\(/.exec(line);
          if (viaVar) table = varTable.get(viaVar[1]) ?? null;
        }
        if (!table || !WORK_TABLES.has(table)) return;
        if (DECLARED_WINDOWS.has(`${f.path}@${arg}`)) return;

        // The remainder has to be visible near the read, not in principle.
        const window = lines.slice(Math.max(0, i - 20), i + 20).join("\n");
        if (REPORTS.test(window)) return;

        violations.push({
          rule: "reads/limit-must-report-remainder",
          why: `a capped read of ${table} that never says what it left behind — the short list reads as the whole queue`,
          fix: "add { count: \"exact\" } to the select and pass it through cappedRead (src/lib/capped-read.ts), or read all of it with selectAllPaged",
          where: `${f.path}:${i + 1}`,
          line: line.trim().slice(0, 120),
        });
      });
    }
  }

  // AUTO-06. Nothing in this codebase sends an email to a supplier. It writes a
  // draft into the email app and an operator presses send there, which is what
  // makes the guessed recipient in DATA-05 safe to stage at all.
  //
  // The check is a ban on the send verbs, because the fault would arrive as a
  // convenience: an auto_send flag on a draft body, or a POST to the send
  // endpoint from a night-time agent. The one real send in the repo is the
  // operator invite, which is an account email to a colleague, not outbound.
  forbid({
    rule: "outreach/no-send-outside-operator-action",
    why: "an agent that can send removes the human review every guessed recipient and every draft depends on",
    fix: "stage the draft and let an operator send it in the email app",
    allow: ["rules/20-autonomy.md"],
    test: (l) =>
      /auto_?send|send_now|send_immediately|sendDraft|\/send["'`)]/i.test(l),
  });

  return violations;
}
