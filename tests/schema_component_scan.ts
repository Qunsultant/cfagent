/**
 * Test-only helper for the #4282 P0 schema-component pins.
 *
 * Scans the working tree (src/) for inline DDL. This helper is test code,
 * not production code: the component itself never reads the tree — the
 * equality harness takes an expected schema as input, and the grep pin
 * feeds it the tree-derived enumeration.
 *
 * Two different scopes, deliberately:
 *  - scanDdlOccurrences: the grep pin's violation set — DDL lines in src/
 *    OUTSIDE the allowed homes (src/data/schemaComponent/ and
 *    src/data/migrationRunner.ts). The pin asserts this set against the
 *    seeded baseline; P3 drives it to zero.
 *  - extractTableNames: the equality harness's expected schema — table
 *    names from CREATE TABLE lines in ALL of src/ (including the allowed
 *    homes, because migrationRunner's tables ARE the current D1 schema).
 *    Comment lines are skipped; a line whose table name cannot be
 *    extracted (template-assembled `${TABLE}`) is counted as unresolved.
 *
 * Limits (documented, not hidden): the comment filter skips lines whose
 * trimmed form starts with an asterisk, a double slash, or a block-comment
 * opener, and tracks block-comment state across lines.
 * A CREATE TABLE mention inside a string literal that is not DDL (a log
 * message, an error string) is counted as a violation by the pin — that
 * is the conservative direction, and the baseline makes it visible.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const SRC_DIR = path.join(REPO_ROOT, "src");

/** DDL forms the pin enumerates (survey §1.4: all four, not just TABLE/INDEX). */
export const DDL_PATTERNS = [
  { name: "createTable", regex: /\bCREATE TABLE\b/ },
  { name: "createIndex", regex: /\bCREATE INDEX\b/ },
  { name: "createUniqueIndex", regex: /\bCREATE UNIQUE INDEX\b/ },
  { name: "alterTable", regex: /\bALTER TABLE\b/ },
] as const;

export type DdlPatternName = (typeof DDL_PATTERNS)[number]["name"];

export interface DdlOccurrence {
  /** Repo-relative path, e.g. "src/data/doSqliteAsyncJobAdapter.ts". */
  file: string;
  /** 1-based line number. */
  line: number;
  pattern: DdlPatternName;
  /** The trimmed source line (for the failure output). */
  text: string;
}

/** Files the pin allows to carry DDL: the component itself + the D1 runner. */
export const ALLOWED_DDL_HOMES = [
  "src/data/schemaComponent/",
  "src/data/migrationRunner.ts",
] as const;

function isAllowedHome(relPath: string): boolean {
  return ALLOWED_DDL_HOMES.some((home) =>
    home.endsWith("/")
      ? relPath.startsWith(home)
      : relPath === home,
  );
}

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkTsFiles(full, out);
    } else if (
      entry.isFile() &&
      SCANNED_EXTENSIONS.has(path.extname(entry.name))
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Enumerate every DDL line in src/ outside the allowed homes, in
 * deterministic order (file, line, pattern). One entry per (line, pattern):
 * a line matching two patterns produces two entries, so the per-pattern
 * totals equal `git grep -c <pattern> -- src/` minus the allowed homes.
 */
export function scanDdlOccurrences(repoRoot: string = REPO_ROOT): DdlOccurrence[] {
  const srcDir = path.join(repoRoot, "src");
  const occurrences: DdlOccurrence[] = [];
  for (const full of walkTsFiles(srcDir)) {
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    if (isAllowedHome(rel)) continue;
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((raw, index) => {
      for (const { name, regex } of DDL_PATTERNS) {
        if (regex.test(raw)) {
          occurrences.push({
            file: rel,
            line: index + 1,
            pattern: name,
            text: raw.trim(),
          });
        }
      }
    });
  }
  occurrences.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.pattern.localeCompare(b.pattern),
  );
  return occurrences;
}

/** Per-file counts, the shape the baseline JSON stores. */
export type DdlBaselineCounts = Record<
  string,
  Record<DdlPatternName, number>
>;

export function aggregateDdlCounts(
  occurrences: DdlOccurrence[],
): DdlBaselineCounts {
  const counts: DdlBaselineCounts = {};
  for (const occ of occurrences) {
    counts[occ.file] ??= {
      createTable: 0,
      createIndex: 0,
      createUniqueIndex: 0,
      alterTable: 0,
    };
    counts[occ.file][occ.pattern] += 1;
  }
  return counts;
}

export function countByPattern(
  occurrences: DdlOccurrence[],
): Record<DdlPatternName, number> {
  const totals: Record<DdlPatternName, number> = {
    createTable: 0,
    createIndex: 0,
    createUniqueIndex: 0,
    alterTable: 0,
  };
  for (const occ of occurrences) totals[occ.pattern] += 1;
  return totals;
}

/**
 * Informational only (not a violation at P0): DROP TABLE / DROP INDEX
 * lines in src/ outside the allowed homes. The P3 pin decides whether
 * DROP joins the zero-tolerance set; P0 records the count so the
 * decision is made from a number, not from memory.
 */
export function scanDropStatements(
  repoRoot: string = REPO_ROOT,
): DdlOccurrence[] {
  const srcDir = path.join(repoRoot, "src");
  const dropPatterns = [
    { name: "dropTable", regex: /\bDROP TABLE\b/ },
    { name: "dropIndex", regex: /\bDROP INDEX\b/ },
  ] as const;
  const found: DdlOccurrence[] = [];
  for (const full of walkTsFiles(srcDir)) {
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    if (isAllowedHome(rel)) continue;
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((raw, index) => {
      for (const { name, regex } of dropPatterns) {
        if (regex.test(raw)) {
          found.push({
            file: rel,
            line: index + 1,
            pattern: name as DdlPatternName,
            text: raw.trim(),
          });
        }
      }
    });
  }
  found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return found;
}

const CREATE_TABLE_NAME =
  /CREATE TABLE (?:IF NOT EXISTS )?["`]?([A-Za-z0-9_]+)["`]?\s*\(/;

function isCommentLine(trimmed: string, inBlockComment: boolean): boolean {
  if (inBlockComment) return true;
  return (
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    // SQL comment inside a migration string.
    trimmed.startsWith("--")
  );
}

/**
 * Distinct table names from CREATE TABLE lines in ALL of src/ (allowed
 * homes included — the runner's tables are the current D1 schema).
 * Comment lines are skipped; a line whose name cannot be extracted is
 * counted as unresolved. The name must be followed by `(` on the same
 * line: a CREATE TABLE mention without a column list is prose ("CREATE
 * TABLE IF NOT EXISTS plus ...") or template-assembled DDL
 * (`CREATE TABLE IF NOT EXISTS ${TABLE} (`), and the loose regex would
 * backtrack onto "IF" or the next prose word as a phantom table name.
 * Template-assembled lines are the unresolved ones — P3's parameterized
 * catalogue entries are their answer, and the count is reported, not hidden.
 */
export function extractTableNames(
  repoRoot: string = REPO_ROOT,
): { tables: string[]; unresolvedLines: number; scannedLines: number } {
  const srcDir = path.join(repoRoot, "src");
  const names = new Set<string>();
  let unresolvedLines = 0;
  let scannedLines = 0;
  for (const full of walkTsFiles(srcDir)) {
    const lines = readFileSync(full, "utf8").split("\n");
    let inBlockComment = false;
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed.includes("/*")) inBlockComment = true;
      if (isCommentLine(trimmed, inBlockComment)) {
        if (trimmed.includes("*/")) inBlockComment = false;
        continue;
      }
      if (trimmed.includes("*/")) inBlockComment = false;
      if (!/\bCREATE TABLE\b/.test(raw)) continue;
      scannedLines += 1;
      const match = raw.match(CREATE_TABLE_NAME);
      if (match) {
        names.add(match[1]);
      } else {
        unresolvedLines += 1;
      }
    }
  }
  return {
    tables: [...names].sort(),
    unresolvedLines,
    scannedLines,
  };
}

/** Repo-relative path of a file under the worktree, for test diagnostics. */
export function repoRelative(fullPath: string): string {
  return path.relative(REPO_ROOT, fullPath).split(path.sep).join("/");
}

export function statIfExists(fullPath: string): boolean {
  try {
    statSync(fullPath);
    return true;
  } catch {
    return false;
  }
}
