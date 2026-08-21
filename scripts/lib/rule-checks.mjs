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
