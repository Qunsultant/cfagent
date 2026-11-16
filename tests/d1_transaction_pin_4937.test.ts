/**
 * Issue #4937 — Conformance pin: forbid drizzle `db.transaction()` on D1
 * (non-atomic) in CI.
 *
 * The finding (ADR 0022 D-C.2, `src/data/migrationRunner.ts` header,
 * `src/aspects/transactionAspect.ts` header): drizzle-orm/d1 implements
 * `db.transaction()` as sequential BEGIN/COMMIT statements, which is not
 * Postgres-equivalent atomicity on D1's request-per-statement API. The
 * correct primitive is the transaction aspect (`withTransaction`,
 * `src/aspects/transactionAspect.ts`, issue #2288) or the store's atomic
 * primitive — D1 `batch()`, DO `storage.transaction()`.
 *
 * The discipline held by convention only (header warnings + zero
 * production uses) until this pin: a mistaken `db.transaction()` call
 * compiled and passed CI. This pin scans `src/` and fails CI on any
 * `.transaction(` call whose receiver is not the allowed DO storage API.
 *
 * Allowlist (issue #4937):
 *  - Comment mentions. Every D1 adapter header and the migrationRunner /
 *    transactionAspect headers document the finding by naming
 *    `db.transaction()` in prose. The scanner strips `//` and `/* ... *\/`
 *    comments before matching, so those mentions never trip it.
 *  - The DO `storage.transaction` API. `src/agents/screener-agent.ts`
 *    calls `storage.transaction(...)` on the Durable Object storage
 *    handle — a different primitive (synchronous DO storage transaction),
 *    not the D1 footgun. Any `.transaction(` call whose receiver is the
 *    identifier `storage` is allowed, in any file.
 *
 * Measured baseline on the base this pin was written against (fresh main
 * 2026-11-16): 15 comment mentions + 1 allowed `storage.transaction`
 * call (`src/agents/screener-agent.ts:742`), 0 violations. The pin does
 * NOT pin those counts: a future header warning or a second DO storage
 * call still passes. It pins only the zero-tolerance rule.
 *
 * Scanner limits (documented, not hidden): this is a conformance guard,
 * not a parser. It strips `//` and `/* ... *\/` comments while respecting
 * single- and double-quoted string literals (a `.transaction(` inside
 * one is string content, not a call). Template literals are scanned as
 * code: a `.transaction(` inside a template literal's text is flagged
 * (conservative — reword it), and a `//` or `/*` inside a template
 * literal's text can shift comment state for that line. A bare reference
 * without a call (`db.transaction` with no parens) is not a call shape
 * and is not flagged. A failure names the file:line, so the reviewer can
 * see whether it is real.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SRC_DIR = path.join(REPO_ROOT, "src");

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * The one allowed `.transaction(` receiver: the DO storage transaction
 * API. Everything else is the D1 footgun (or a call shape this pin does
 * not recognise, which fails closed — the author rewords or allowlists
 * it deliberately, never silently).
 */
const ALLOWED_RECEIVER = "storage";

/** Matches `<receiver>.transaction(` — the receiver is captured so the allowlist can check it. */
const TRANSACTION_CALL = /([A-Za-z_$][\w$]*)\s*\.\s*transaction\s*\(/g;

export interface TransactionCallOccurrence {
  /** Repo-relative path, e.g. "src/data/doSqliteAsyncJobAdapter.ts". */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The identifier immediately before `.transaction(`. */
  receiver: string;
  /** The trimmed code line (for the failure output). */
  text: string;
}

export interface TransactionScanResult {
  violations: TransactionCallOccurrence[];
  /** Allowed `storage.transaction(` call sites, listed so the allowlist stays visible. */
  allowed: TransactionCallOccurrence[];
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments from each line,
 * preserving line numbering (one code-only line out per line in). Single-
 * and double-quoted string literals are respected: comment markers inside
 * them do not open a comment, and their contents are not scanned (a
 * `.transaction(` inside a string is prose, not a call). Template literals
 * are scanned as code — see the file header for the documented limit.
 */
export function stripComments(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((raw) => {
    let out = "";
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    while (i < raw.length) {
      const ch = raw[i];
      const next = raw[i + 1] ?? "";
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (inSingle) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "'") inSingle = false;
        i += 1;
        continue;
      }
      if (inDouble) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === '"') inDouble = false;
        i += 1;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlock = true;
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  });
}

/** Classify one code-only line: every `.transaction(` call on it, split into violations vs allowed. */
export function classifyTransactionCalls(
  file: string,
  line: number,
  codeLine: string,
): TransactionScanResult {
  const violations: TransactionCallOccurrence[] = [];
  const allowed: TransactionCallOccurrence[] = [];
  for (const match of codeLine.matchAll(TRANSACTION_CALL)) {
    const occurrence: TransactionCallOccurrence = {
      file,
      line,
      receiver: match[1],
      text: codeLine.trim(),
    };
    if (match[1] === ALLOWED_RECEIVER) allowed.push(occurrence);
    else violations.push(occurrence);
  }
  return { violations, allowed };
}

/** Scan one file's text (raw lines, comments included) and classify every `.transaction(` call shape. */
export function scanTransactionCalls(
  file: string,
  content: string,
): TransactionScanResult {
  const violations: TransactionCallOccurrence[] = [];
  const allowed: TransactionCallOccurrence[] = [];
  const codeLines = stripComments(content.split("\n"));
  codeLines.forEach((codeLine, index) => {
    const result = classifyTransactionCalls(file, index + 1, codeLine);
    violations.push(...result.violations);
    allowed.push(...result.allowed);
  });
  return { violations, allowed };
}

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

/** Scan all of `src/` (tests/ are fixtures, out of scope by the issue). */
export function scanSrcForDbTransaction(
  repoRoot: string = REPO_ROOT,
): TransactionScanResult {
  const violations: TransactionCallOccurrence[] = [];
  const allowed: TransactionCallOccurrence[] = [];
  for (const full of walkTsFiles(path.join(repoRoot, "src"))) {
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    const result = scanTransactionCalls(rel, readFileSync(full, "utf8"));
    violations.push(...result.violations);
    allowed.push(...result.allowed);
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  allowed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { violations, allowed };
}

const FAILURE_MESSAGE =
  "db.transaction() is forbidden on D1: drizzle-orm/d1 implements it as " +
  "sequential BEGIN/COMMIT, not atomic (ADR 0022 D-C; migrationRunner.ts " +
  "header). Use the transaction aspect (src/aspects/transactionAspect.ts — " +
  "withTransaction) or the store's atomic primitive: D1 batch(), DO " +
  "storage.transaction().";

describe("D1 db.transaction() conformance pin (#4937)", () => {
  it("fails CI on any db.transaction() call in src/ (zero tolerance)", () => {
    const { violations, allowed } = scanSrcForDbTransaction();
    console.log(
      `d1-transaction-pin: violations ${violations.length}; ` +
        `allowed storage.transaction call sites ${allowed.length} ` +
        `(${allowed.map((a) => `${a.file}:${a.line}`).join(", ") || "none"})`,
    );
    expect(
      violations.map(
        (v) => `${v.file}:${v.line} (${v.receiver}.transaction): ${v.text}`,
      ),
      `${FAILURE_MESSAGE} Violations:`,
    ).toEqual([]);
  });

  it("classifies the forbidden shape, the allowed API, and comments correctly", () => {
    // Forbidden: any receiver other than `storage`.
    expect(
      scanTransactionCalls("src/data/x.ts", "await db.transaction(async (tx) => {});")
        .violations,
    ).toHaveLength(1);
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "await this.db.transaction(async (tx) => {});",
      ).violations.map((v) => v.receiver),
    ).toEqual(["db"]);
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "await db.transaction (async (tx) => {});",
      ).violations,
    ).toHaveLength(1);
    // Allowed: the DO storage.transaction API, whatever qualifies it.
    expect(
      scanTransactionCalls(
        "src/agents/screener-agent.ts",
        "return storage.transaction(async (txn: any) => {",
      ).violations,
    ).toEqual([]);
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "return this.ctx.storage.transaction(async (txn) => {",
      ).violations,
    ).toEqual([]);
    // Excluded: comment mentions, single-line and multi-line, and trailing.
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "// never call db.transaction() on D1",
      ).violations,
    ).toEqual([]);
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "/* db.transaction() is sequential BEGIN/COMMIT, not atomic */",
      ).violations,
    ).toEqual([]);
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "/**\n * drizzle-orm/d1 implements `db.transaction()` as sequential\n * BEGIN/COMMIT statements.\n */\nconst x = 1;",
      ).violations,
    ).toEqual([]);
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "const x = 1; // db.transaction() is not atomic",
      ).violations,
    ).toEqual([]);
    // Excluded: prose inside a string literal is not a call.
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        'const msg = "db.transaction() is not atomic";',
      ).violations,
    ).toEqual([]);
    // Not a call shape: a bare reference without parens, and the DO sync primitive.
    expect(
      scanTransactionCalls("src/data/x.ts", "const t = db.transaction;")
        .violations,
    ).toEqual([]);
    expect(
      scanTransactionCalls(
        "src/data/x.ts",
        "storage.transactionSync(() => {});",
      ).violations,
    ).toEqual([]);
    // The failure message names the correct primitive.
    expect(FAILURE_MESSAGE).toContain("batch()");
    expect(FAILURE_MESSAGE).toContain("transaction aspect");
  });
});
