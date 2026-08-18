#!/usr/bin/env node
// Machine enforcement for the standing rules in /CLAUDE.md.
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
  const chokepoint = files.find((f) => f.path.endsWith("src/lib/draft-staging.ts"));
  if (chokepoint && !/approvedContactsFor\(/.test(chokepoint.text)) {
    violations.push({
      rule: "contacts/staging-must-guard-fabrication",
      why: "agents must never invent an address, phone or email in an outgoing body",
      fix: "restore the contact-guard allowlist in stageDraft",
      where: "src/lib/draft-staging.ts",
      line: "approvedContactsFor call missing",
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
console.error("These are standing rules from /CLAUDE.md. Fix the call site, or move");
console.error("the logic into the shared module the rule points at.\n");
process.exit(1);
