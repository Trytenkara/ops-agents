#!/usr/bin/env node
// Regenerates rules/ENFORCEMENT.md from the Enforcement line of every rule.
// The rule files are the source of truth; this is only a view of them, so it
// is generated rather than hand-maintained and cannot drift silently.
// Run with `npm run gen:enforcement`.
//
// The parsing and rendering live in scripts/lib/enforcement-ledger.mjs, which
// check-rules.mjs also imports to verify the committed file still matches.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRules, renderLedger, unclassified } from "./lib/enforcement-ledger.mjs";

const RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");

const rules = collectRules(RULES);

const bad = unclassified(rules);
if (bad.length) {
  console.error(`gen-enforcement: ${bad.length} rule(s) outside the vocabulary:`);
  for (const r of bad) console.error(`  ${r.id} — ${r.enforcement}`);
  process.exit(1);
}

writeFileSync(join(RULES, "ENFORCEMENT.md"), renderLedger(rules));
console.log(`gen-enforcement: ${rules.length} rules written to rules/ENFORCEMENT.md`);
