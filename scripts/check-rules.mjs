#!/usr/bin/env node
// Machine enforcement for the standing rules in /rules. First step of
// `npm run build`, so a covered rule break fails the deploy.
//
// The checks themselves are in scripts/lib/rule-checks.mjs. This file only
// gathers the corpus and prints the result.
//
//   node scripts/check-rules.mjs              check this working tree
//   node scripts/check-rules.mjs --self-test  check that the checks work

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./lib/rule-checks.mjs";
import { selfTest } from "./lib/rule-self-test.mjs";

const ROOT = process.cwd();
const RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");

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

const files = walk(join(ROOT, "src")).map((p) => ({
  path: relative(ROOT, p),
  text: readFileSync(p, "utf8"),
}));

if (process.argv.includes("--self-test")) {
  process.exit(selfTest(files, RULES) ? 0 : 1);
}

const violations = runChecks(files, RULES);

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
