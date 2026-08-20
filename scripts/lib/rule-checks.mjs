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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNCLASSIFIED, vocabularyHint } from "./enforcement-vocab.mjs";
import { collectRules, renderLedger } from "./enforcement-ledger.mjs";

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
  }


  return violations;
}
