#!/usr/bin/env node
// Machine enforcement for the standing rules in /rules. First step of
// `npm run build`, so a covered rule break fails the deploy.
//
// The checks themselves are in scripts/lib/rule-checks.mjs. This file only
// gathers the corpus and prints the result.
//
//   node scripts/check-rules.mjs              check this working tree
//   node scripts/check-rules.mjs --self-test  check that the checks work
//   node scripts/check-rules.mjs --also DIR   check a second corpus too
//
// `--also` exists because a rule binds the fleet, not this repository. The
// agent skills are a separate repo on the container, they post to Slack and
// query the same tables, and four of them were found breaking COMM-06 a day
// after it was written — while ENFORCEMENT.md reported it as enforced. The
// deploy host has no skills directory, so this cannot run inside `next build`;
// the workspace repo's pre-commit hook is what runs it.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./lib/rule-checks.mjs";
import { selfTest } from "./lib/rule-self-test.mjs";

const ROOT = process.cwd();
const RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");

function walk(dir, keep = /\.(ts|tsx)$/) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    if (name === "__pycache__" || name === ".venv") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep.test(p)) out.push(p);
  }
  return out;
}

const read = (p, base) => ({ path: relative(base, p), text: readFileSync(p, "utf8") });

const files = walk(join(ROOT, "src")).map((p) => read(p, ROOT));

// Skills are Python and plain JS as well as TypeScript, and their SKILL.md is
// where an agent is told which channel to watch, so markdown is code here too.
let only = null;
const alsoAt = process.argv.indexOf("--also");
if (alsoAt !== -1) {
  const dir = process.argv[alsoAt + 1];
  if (!dir || !existsSync(dir)) {
    console.error(`check-rules: --also needs a directory that exists (got ${dir ?? "nothing"})`);
    process.exit(1);
  }
  files.push(...walk(dir, /\.(ts|tsx|js|mjs|cjs|py|sh|md)$/).map((p) => read(p, dirname(dir))));
  // The second corpus still needs this repository in the file list — several
  // checks read a module here to decide whether a rule holds. But when the
  // caller is the other repository's commit hook, only its own files are its
  // business: this repo's uncommitted work in progress is not that commit's
  // fault, and blocking on it teaches people to reach for --no-verify.
  if (process.argv.includes("--also-only")) only = `${basename(dir)}/`;
}

if (process.argv.includes("--self-test")) {
  process.exit(selfTest(files, RULES) ? 0 : 1);
}

const violations = runChecks(files, RULES).filter((v) => !only || v.where.startsWith(only));

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
