// Reads every rule out of rules/ and renders the ENFORCEMENT.md ledger.
//
// Both the generator and the build check import this, so the document the
// generator writes and the document the check compares against cannot be
// produced by two different pieces of code. That was the actual failure: the
// ledger shipped to production listing PERS-08 as an enforced Guard while the
// rule text and its guard were still uncommitted, and nothing anywhere
// compared the two.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BUCKETS,
  DISPLAY_ORDER,
  UNCLASSIFIED,
  classify,
  isOwed,
  owesWork,
} from "./enforcement-vocab.mjs";

const RULE_FILE = /^\d+.*\.md$/;
const HEADING = /^## ([A-Z]+-\d+) — (.+)/;

// The Enforcement value runs to the first blank line or the end of the section.
//
// No `m` flag, deliberately. With it, `$` matches at every line ending and
// `\n*$` happily matches zero newlines there, so the capture stopped at the
// first line break and 69 of 118 rules were published half-quoted. That was
// not only cosmetic: five rules read "Guard — <thing>. Check owed — <thing>",
// and the half the ledger kept was the reassuring half. The debt check below
// never saw the words that admitted the debt.
const ENFORCEMENT = /(?:^|\n)\*\*Enforcement:\*\*([\s\S]*?)(?=\n[ \t]*\n|$)/;

/**
 * Every rule in the folder, in file then document order.
 * @returns {Array<{id: string, title: string, enforcement: string, bucket: string, file: string}>}
 */
export function collectRules(rulesDir) {
  const rules = [];
  for (const name of readdirSync(rulesDir).sort()) {
    if (!RULE_FILE.test(name)) continue;
    const text = readFileSync(join(rulesDir, name), "utf8");
    for (const section of text.split(/\n(?=## )/)) {
      const head = section.match(HEADING);
      if (!head) continue;
      // A heading with no Enforcement line at all used to be skipped here, so
      // it never reached the ledger and never reached the count. Silence is
      // the wrong answer: it is the least enforced a rule can be. Keep it and
      // let it fail classification.
      const body = section.match(ENFORCEMENT);
      const enforcement = body ? body[1].replace(/\s+/g, " ").trim() : "";
      const bucket = classify(enforcement);
      rules.push({
        id: head[1],
        title: head[2],
        enforcement,
        bucket,
        owes: owesWork(enforcement, bucket),
        file: name,
      });
    }
  }
  return rules;
}

/** The exact text of rules/ENFORCEMENT.md for a given set of rules. */
export function renderLedger(rules) {
  const counts = new Map();
  for (const r of rules) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);

  const owed = rules.filter((r) => r.owes).length;
  const real = (counts.get("Guard") ?? 0) + (counts.get("Audit") ?? 0);
  const partial = rules.filter((r) => r.owes && !isOwed(r.bucket)).length;

  const out = [];
  out.push("# Enforcement ledger");
  out.push("");
  out.push("Generated from the Enforcement line of every rule by");
  out.push("`npm run gen:enforcement`. Do not edit by hand: the rule files are the");
  out.push("source of truth and this is only a view of them.");
  out.push("");
  out.push(`${rules.length} rules. ${real} are actually enforced, ${owed} owe a check or a job,`);
  out.push(`${counts.get("Judgement") ?? 0} are human judgement that nothing could ever check.`);
  if (partial) {
    out.push("");
    out.push(
      `${partial} of the enforced rules hold only part of their invariant and say so in`,
    );
    out.push("their own Enforcement line. They are counted in both figures above.");
  }
  out.push("");
  out.push("| Status | Meaning | Count |");
  out.push("|---|---|---|");
  for (const name of DISPLAY_ORDER) {
    if (!counts.get(name)) continue;
    const meaning = BUCKETS.find((b) => b.name === name).meaning;
    out.push(`| **${name}** | ${meaning} | ${counts.get(name)} |`);
  }
  out.push("");
  out.push('Anything "owed" is also listed in `OUTSTANDING.md`; the build refuses');
  out.push("otherwise, so a gap cannot go quiet.");

  for (const name of DISPLAY_ORDER) {
    const list = rules.filter((r) => r.bucket === name);
    if (!list.length) continue;
    out.push("", `## ${name} (${list.length})`, "");
    out.push("| Rule | | Enforcement |");
    out.push("|---|---|---|");
    // Escape pipes: the full Enforcement value is prose and would otherwise
    // break the row into extra cells.
    for (const r of list) {
      out.push(`| \`${r.id}\` | ${r.title} | ${r.enforcement.split("|").join("\\|")} |`);
    }
  }

  return out.join("\n") + "\n";
}

/** Rules whose Enforcement line is outside the vocabulary. */
export function unclassified(rules) {
  return rules.filter((r) => r.bucket === UNCLASSIFIED);
}
