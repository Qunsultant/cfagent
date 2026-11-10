/**
 * Issue #3926 (slice: lint + coverage) — lint the files a PR changes.
 *
 * A repo-wide lint would fail on decades of legacy code on day one. This gate
 * lints only the files in the diff against the base commit, so:
 *   - a PR can never introduce a new defect-class violation;
 *   - an untouched legacy file never blocks anyone;
 *   - touching a file adopts it into the ratchet.
 *
 * Usage:
 *   node scripts/lint-changed.mjs                    # base: origin/main, else HEAD~1
 *   node scripts/lint-changed.mjs --base <sha|ref>   # explicit base (CI passes the PR base)
 *   node scripts/lint-changed.mjs --all              # the whole tree (manual audit only)
 *
 * Exit codes: 0 = clean or nothing to lint, 1 = violations or a failed run.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { ESLint } from "eslint";

const LINTABLE = /^(src|scripts)\/.*\.(ts|tsx|mjs|js)$/;

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf-8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveBase(explicit) {
  if (explicit) {
    try {
      git(["rev-parse", "--verify", `${explicit}^{commit}`]);
      return explicit;
    } catch {
      // CI hands us a base sha that a shallow clone does not have yet: fetch it.
      try {
        git(["fetch", "--no-tags", "--depth=1", "origin", explicit]);
        return explicit;
      } catch {
        console.warn(`lint-changed: base '${explicit}' is unavailable; falling back.`);
      }
    }
  }
  for (const candidate of ["origin/main", "HEAD~1"]) {
    try {
      git(["rev-parse", "--verify", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function changedFiles(base) {
  const out = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    ...(base ? [`${base}...HEAD`] : ["HEAD"]),
  ]);
  return out
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0 && LINTABLE.test(line));
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const baseFlag = argv.indexOf("--base");
  const explicitBase = baseFlag >= 0 ? argv[baseFlag + 1] : process.env.LINT_BASE;

  const base = all ? null : resolveBase(explicitBase);
  const files = all ? ["src", "scripts"] : changedFiles(base);

  if (files.length === 0) {
    console.log("lint-changed: no changed lintable files — nothing to check.");
    return 0;
  }

  const eslint = new ESLint({ cwd: process.cwd() });
  const results = await eslint.lintFiles(files);
  const formatter = await eslint.loadFormatter("stylish");
  const output = formatter.format(results);
  if (output.trim().length > 0) console.log(output);

  const errors = results.reduce((sum, result) => sum + result.errorCount, 0);
  const warnings = results.reduce((sum, result) => sum + result.warningCount, 0);
  const linted = results.filter((result) => result.errorCount > 0 || result.warningCount > 0).length;

  const scope = all ? "the whole tree" : `${files.length} changed file(s) against ${base ?? "HEAD"}`;
  if (errors === 0 && warnings === 0) {
    console.log(`lint-changed: clean — ${scope}.`);
    return 0;
  }
  console.error(
    `lint-changed: ${errors} error(s), ${warnings} warning(s) in ${linted} file(s) — ${scope}. ` +
      "These rules are defect-class only; fix them in this PR or split the offending change out.",
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`lint-changed: failed — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
