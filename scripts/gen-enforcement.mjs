#!/usr/bin/env node
// Regenerates rules/ENFORCEMENT.md from the Enforcement line of every rule.
// The rule files are the source of truth; this is only a view of them, so it
// is generated rather than hand-maintained and cannot drift silently.
// Run with `npm run gen:enforcement`.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");

const BUCKETS = [
  ["Guard", /^Guard\b/, "A shared module or build check makes it impossible."],
  ["Audit", /^Audit —/, "A scheduled job reports the break after the fact."],
  ["Check owed", /^Check owed\b/, "A build check is possible and is not built yet."],
  ["Audit owed", /^Audit owed\b/, "No build check can see it; a scheduled job can. Not built."],
  ["Judgement", /^Judgement\./, "Nothing mechanical can ever verify it. Human, by design."],
  ["Cross-reference", /^See [A-Z]+-\d+\./, "Restates a rule enforced elsewhere."],
  ["None", /^None\./, "Outside this repository. Cannot be checked here."],
  ["Retired", /^Retired\b/, "No longer applies."],
];

const rules = [];
for (const name of readdirSync(RULES).sort()) {
  if (!/^\d+.*\.md$/.test(name)) continue;
  const text = readFileSync(join(RULES, name), "utf8");
  for (const section of text.split(/\n(?=## )/)) {
    const head = section.match(/^## ([A-Z]+-\d+) — (.+)/);
    if (!head) continue;
    const body = section.match(/^\*\*Enforcement:\*\*([\s\S]*?)(?=\n\n|\n*$)/m);
    if (!body) continue;
    const enforcement = body[1].replace(/\s+/g, " ").trim();
    const bucket = BUCKETS.find(([, re]) => re.test(enforcement));
    rules.push({ id: head[1], title: head[2], enforcement, bucket: bucket ? bucket[0] : "UNCLASSIFIED", file: name });
  }
}

const counts = new Map();
for (const r of rules) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);

const owed = (counts.get("Check owed") ?? 0) + (counts.get("Audit owed") ?? 0);
const real = (counts.get("Guard") ?? 0) + (counts.get("Audit") ?? 0);

const out = [];
out.push("# Enforcement ledger");
out.push("");
out.push("Generated from the Enforcement line of every rule by");
out.push("`npm run gen:enforcement`. Do not edit by hand: the rule files are the");
out.push("source of truth and this is only a view of them.");
out.push("");
out.push(`${rules.length} rules. ${real} are actually enforced, ${owed} owe a check or a job,`);
out.push(`${counts.get("Judgement") ?? 0} are human judgement that nothing could ever check.`);
out.push("");
out.push("| Status | Meaning | Count |");
out.push("|---|---|---|");
for (const [name, , meaning] of BUCKETS) {
  if (!counts.get(name)) continue;
  out.push(`| **${name}** | ${meaning} | ${counts.get(name)} |`);
}
out.push("");
out.push("Anything \"owed\" is also listed in `OUTSTANDING.md`; the build refuses");
out.push("otherwise, so a gap cannot go quiet.");

for (const [name] of BUCKETS) {
  const list = rules.filter((r) => r.bucket === name);
  if (!list.length) continue;
  out.push("", `## ${name} (${list.length})`, "");
  out.push("| Rule | | Enforcement |");
  out.push("|---|---|---|");
  for (const r of list) out.push(`| \`${r.id}\` | ${r.title} | ${r.enforcement} |`);
}

const unclassified = rules.filter((r) => r.bucket === "UNCLASSIFIED");
if (unclassified.length) {
  console.error(`gen-enforcement: ${unclassified.length} rule(s) outside the vocabulary:`);
  for (const r of unclassified) console.error(`  ${r.id} — ${r.enforcement}`);
  process.exit(1);
}

writeFileSync(join(RULES, "ENFORCEMENT.md"), out.join("\n") + "\n");
console.log(`gen-enforcement: ${rules.length} rules written to rules/ENFORCEMENT.md`);
