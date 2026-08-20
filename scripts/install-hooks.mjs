#!/usr/bin/env node
// Switches on the git hooks for every repository here that ships a .githooks
// directory. Runs from `prepare`, so `npm install` installs them.
//
// `core.hooksPath` is local machine config, not a tracked file. Committing a
// hook therefore does nothing until someone sets it, and nothing anywhere
// reports that it is unset: a repository with its hooks off is indistinguishable
// from one where every hook passed. That is the same silent-pass shape as a
// guard that matches nothing (META-09), one level further out.
//
// The skills repository is the sharper case. It has no package manager of its
// own, so it had no installer at all, and its pre-commit hook is the only thing
// checking the agent skills against the rules.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Repositories whose hooks this installer owns: this one, and the checkout it
 * sits inside if that is a separate repository. The skills repository is the
 * parent of this one on the agent container, and deriving it beats hardcoding
 * a path that exists only there.
 */
export function hookRepos(from = HERE) {
  const seen = new Set();
  return [from, dirname(from)].filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    // `.git` is a file rather than a directory inside a worktree, so test for
    // existence and not for a directory.
    return existsSync(join(dir, ".git")) && existsSync(join(dir, ".githooks"));
  });
}

/** The configured hooks path, or "" when unset or git cannot answer. */
export function hooksPathOf(dir) {
  try {
    return execFileSync("git", ["-C", dir, "config", "--local", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Never fail an install. On the deploy host there is nothing to commit and
  // git may not be there at all; a missing hook is checked at build time by
  // check-rules.mjs, which is the place that can tell the difference.
  for (const dir of hookRepos()) {
    try {
      execFileSync("git", ["-C", dir, "config", "core.hooksPath", ".githooks"], {
        stdio: "ignore",
      });
      console.log(`install-hooks: ${dir} -> .githooks`);
    } catch {
      console.log(`install-hooks: could not configure ${dir}, skipping.`);
    }
  }
}
