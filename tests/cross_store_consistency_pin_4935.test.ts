/**
 * Issue #4935 — Conformance pins for the cross-store consistency
 * contract (ADR 0033: DO + D1 dual-write discipline and
 * read-your-writes rules).
 *
 * The contract states rules the tree already follows in its named
 * projection paths (run ledger, chain/schedule, shard jobs, audit
 * reports, telemetry realizations, canonical seed) — and records the
 * five violations the #4935 audit found as follow-up sub-issues
 * (#4961–#4965). These pins hold the conforming shape so a new
 * dual-write path, a reordered write, a throwing hook, a scheduled
 * reconcile, or a non-atomic idempotency guard fails CI instead of
 * landing silently.
 *
 * The five pins (each has unit tests for its scanner below, then a
 * live test against src/):
 *
 * P-A — Call-site census. Every call to a projection entry point
 *   occurs in a census file (ADR 0033 Appendix A.1). A new
 *   dual-write path outside the census fails CI: the author adds
 *   it to the census AND to the ADR's ledger, or the path does not
 *   land. `*.deprecated.ts` files are out of the scan (retired
 *   code, not a live path). Interface / stub type members
 *   (`recordRealizations(` in `ThesisRealizationStore`,
 *   `seedCanonicalReports(` in a `stub<{...}>` type argument)
 *   are not calls: a line starting with the bare callee name
 *   and ending at the open paren (or carrying a `):` return-type
 *   annotation) is skipped — projection calls in this tree are
 *   always awaited, returned, or assigned, so a real call never
 *   takes that shape. The ambiguous name `recordAuditEvent`
 *   exists twice in the tree (the D1 projection in
 *   `auditReportProjection.ts` and the IAAA audit log in
 *   `src/security/iaaaAudit.ts`): a call counts as a projection
 *   call only when the file imports it from the projection module
 *   (or IS the projection module); IAAA callers are ignored and
 *   listed, never silently counted.
 * P-B — DO-first ordering. In each census call-site function, the
 *   DO persist precedes the projection call (line order inside the
 *   function body). The async-job helper is pinned on its re-read:
 *   `projectAsyncJobTransition` reads the stored row (`getRow`)
 *   before projecting it, so the projection carries what landed.
 * P-C — Never-throw. Each named projection hook / posting helper /
 *   projector function contains its own try/catch (or collects
 *   per-item errors into a result): a projection failure never
 *   throws into the DO write, the submission, or the run. The one
 *   deliberate exception is the canonical seed
 *   (`seedCanonicalReports`): a store failure during the seed
 *   propagates by design (an operator step whose failure the
 *   operator must see), so it is NOT in this pin.
 * P-D — Reconcile operator-only. The reconcile entry points are
 *   referenced only from admin-gated routes / DO doors (the
 *   allowlist); no tick, boot, or scheduled path references them.
 * P-E — Idempotency mechanism. Each D1 projection adapter write
 *   uses a statement-level guard (`onConflictDoNothing` /
 *   `onConflictDoUpdate`); the report projector's read-before-write
 *   guard is listed as an exception until its fix lands.
 *
 * Known exceptions (allowlisted by finding number, removed by the
 * fix that clears them — the D-D shrink-only pattern):
 * - P-E: `d1TelemetryAdapter.recordRealizations` has no
 *   `ON CONFLICT` (F-2, #4962: SELECT-then-INSERT throws a PK
 *   violation under concurrent redelivery instead of no-op'ing).
 * - P-E: `runLedgerProjection.projectReport` has a read-before-write
 *   guard (latest version + LWW) but the version bump is not atomic
 *   (F-3, #4963: concurrent carriers can silently drop the newer
 *   content while reporting projected:true).
 *
 * Not pin-able here (ADR 0033 "Not pin-able", recorded with
 * grounds): the d1-only gate (F-1, #4961 — a runtime config
 * validation), the audit-publication logging (F-4, #4964 — the
 * current tree has zero conforming call sites to anchor the pin;
 * the fix's own tests cover it), the chain/schedule tenant
 * threading (F-5, #4965 — runtime tenant resolution), the
 * projection-lag tolerance per carrier (runtime property;
 * observability is #4933), and the stable-eventId discipline
 * (R-1c — caller-constructed).
 *
 * Scanner limits (documented, not hidden): this is a conformance
 * guard, not a parser. It strips `//` and `/* ... *\/` comments
 * while respecting single- and double-quoted string literals (the
 * #4937 scanner, reused). Template literals are scanned as code:
 * a projection call inside a template literal's text is flagged
 * (conservative — reword it), and a `//` or `/*` inside a template
 * literal's text can shift comment state for that line. Brace
 * matching for function bodies counts braces on code-only lines;
 * a `{` or `}` inside a template literal can shift the count, so
 * a body that ends early fails loudly (the pin reports the
 * function as unparseable) rather than silently passing.
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

/* ------------------------------------------------------------------ */
/* Shared scanner helpers (comment stripping: the #4937 pattern)       */
/* ------------------------------------------------------------------ */

/**
 * Strip `//` line comments and `/* ... *\/` block comments from each line,
 * preserving line numbering (one code-only line out per line in). Single-
 * and double-quoted string literals are respected: comment markers inside
 * them do not open a comment, and their contents are not scanned.
 * Template literals are scanned as code — see the file header.
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

/** Count `{` minus `}` on one code-only line (strings/comments stripped). */
function braceDelta(codeLine: string): number {
  let delta = 0;
  for (const ch of codeLine) {
    if (ch === "{") delta += 1;
    else if (ch === "}") delta -= 1;
  }
  return delta;
}

export interface FunctionBody {
  /** 1-based line of the definition. */
  defLine: number;
  /** 1-based line of the closing brace (inclusive). */
  endLine: number;
  /** Code-only lines of the body, 1-based by absolute line number. */
  lines: Map<number, string>;
}

/**
 * Find a function by name and return its brace-matched body. Matches
 * module functions (`export async function NAME(`, `async function
 * NAME(`, `function NAME(`) and class methods (`async NAME(`,
 * `NAME(` at statement start). Returns null when the definition is
 * not found, or when the braces never balance (unparseable — the
 * caller fails loudly instead of passing).
 */
export function findFunctionBody(
  codeLines: string[],
  functionName: string,
): FunctionBody | null {
  const defPattern = new RegExp(
    `(?:^|\\s)(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(|^\\s*(?:async\\s+)?${functionName}\\s*\\(`,
  );
  let defIndex = -1;
  for (let i = 0; i < codeLines.length; i += 1) {
    if (defPattern.test(codeLines[i])) {
      defIndex = i;
      break;
    }
  }
  if (defIndex === -1) return null;
  let depth = 0;
  let started = false;
  const lines = new Map<number, string>();
  for (let i = defIndex; i < codeLines.length; i += 1) {
    const line = codeLines[i];
    lines.set(i + 1, line);
    depth += braceDelta(line);
    if (depth > 0) started = true;
    if (started && depth === 0) {
      return { defLine: defIndex + 1, endLine: i + 1, lines };
    }
  }
  return null;
}

/** First 1-based line inside `body` whose code matches `pattern`, or null. */
export function findInBody(
  body: FunctionBody,
  pattern: RegExp,
): number | null {
  for (const [line, text] of [...body.lines.entries()].sort((a, b) => a[0] - b[0])) {
    if (pattern.test(text)) return line;
  }
  return null;
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
      SCANNED_EXTENSIONS.has(path.extname(entry.name)) &&
      !entry.name.endsWith(".deprecated.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Read a repo-relative file as code-only lines (comments/strings stripped). */
export function readCodeLines(relPath: string): string[] {
  return stripComments(
    readFileSync(path.join(REPO_ROOT, relPath), "utf8").split("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* P-A — Call-site census                                              */
/* ------------------------------------------------------------------ */

/** Projection entry points whose calls the census governs. */
export const PROJECTION_CALLEES = [
  "projectCanonicalReportBestEffort",
  "projectAsyncJobBestEffort",
  "projectQueuedRunLedger",
  "projectAfterTransition",
  "projectTransition",
  "projectLegOutcomes",
  "projectEvaluationRealizations",
  "seedCanonicalReports",
  "recordAuditEventBestEffort",
  "postRunLedgerBestEffort",
  "recordAuditEvent",
  "recordRealizations",
] as const;

/**
 * The audited census (ADR 0033 Appendix A.1): repo-relative file →
 * the projection callees that file may call. A call outside this
 * table is a new dual-write path without contract review.
 */
export const PROJECTION_CENSUS: Record<string, readonly string[]> = {
  "src/agents/orchestrator.ts": [
    "projectCanonicalReportBestEffort",
    "projectAsyncJobBestEffort",
  ],
  "src/agents/orchestrator/asyncJobs.ts": ["projectAsyncJobBestEffort"],
  "src/agents/orchestrator/reportDispatch.ts": [
    "projectCanonicalReportBestEffort",
  ],
  "src/agents/orchestrator/canonicalReportSeed.ts": ["seedCanonicalReports"],
  "src/agents/scheduled-agent.ts": [
    "projectAfterTransition",
    "recordAuditEventBestEffort",
  ],
  "src/agents/orchestrator/shardJobReconcile.ts": ["recordAuditEventBestEffort"],
  "src/data/createChainSchedulePorts.ts": [
    "projectTransition",
    "recordAuditEventBestEffort",
  ],
  "src/data/createShardJobPorts.ts": [
    "projectLegOutcomes",
    "recordAuditEventBestEffort",
  ],
  "src/server/routes/privacy.ts": ["seedCanonicalReports"],
  "src/workflows/screenerCollation.ts": ["projectLegOutcomes"],
  "src/services/runLedgerProjectionHooks.ts": ["postRunLedgerBestEffort"],
  "src/agents/orchestrator/runLedgerReconcile.ts": ["postRunLedgerBestEffort"],
  "src/agents/research-agent.ts": ["projectEvaluationRealizations"],
  "src/telemetry/telemetryProjection.ts": ["recordRealizations"],
  "src/telemetry/telemetryRoute.ts": ["recordRealizations"],
  "src/data/createAuditReportPorts.ts": ["recordAuditEvent"],
  "src/data/auditReportProjection.ts": ["recordAuditEvent"],
  "src/data/chainScheduleProjection.ts": ["projectTransition"],
  "src/server/routes/queue.ts": ["projectQueuedRunLedger"],
};

/** Modules whose `recordAuditEvent` is the D1 projection (not the IAAA log). */
const PROJECTION_AUDIT_EVENT_SOURCES = [
  "auditReportProjection",
  "createAuditReportPorts",
];

export interface CensusCall {
  file: string;
  line: number;
  callee: string;
  text: string;
}

export interface CensusScanResult {
  /** Calls outside the census table. */
  violations: CensusCall[];
  /** `recordAuditEvent` calls resolved to the IAAA log, not the projection. */
  ignoredIaaaAuditCalls: CensusCall[];
  /** All census calls found (so the census stays visible). */
  allowed: CensusCall[];
}

/**
 * Does this file's `recordAuditEvent` mean the D1 projection?
 * True when the file IS a projection module, or imports the name
 * from one. Otherwise it is the IAAA audit log's same-named
 * function (`src/security/iaaaAudit.ts`) and is out of this pin.
 */
export function isProjectionAuditEventCall(
  relPath: string,
  rawLines: string[],
): boolean {
  if (
    relPath.endsWith("auditReportProjection.ts") ||
    relPath.endsWith("createAuditReportPorts.ts")
  ) {
    return true;
  }
  for (const line of rawLines) {
    if (!line.includes("recordAuditEvent") || !line.includes("import")) continue;
    if (
      PROJECTION_AUDIT_EVENT_SOURCES.some((src) => line.includes(src))
    ) {
      return true;
    }
  }
  return false;
}

/** Scan one file's code-only lines for projection calls. */
export function scanFileForProjectionCalls(
  relPath: string,
  codeLines: string[],
  rawLines: string[],
): CensusScanResult {
  const violations: CensusCall[] = [];
  const ignoredIaaaAuditCalls: CensusCall[] = [];
  const allowed: CensusCall[] = [];
  const allowedCallees = new Set(PROJECTION_CENSUS[relPath] ?? []);
  codeLines.forEach((codeLine, index) => {
    for (const callee of PROJECTION_CALLEES) {
      const pattern = new RegExp(`\\b${callee}\\s*\\(`, "g");
      for (const match of codeLine.matchAll(pattern)) {
        const before = codeLine.slice(0, match.index ?? 0);
        // A definition, not a call: `function NAME(` / `async NAME(`.
        if (/(?:function|async)\s+$/.test(before)) continue;
        // A type member, not a call: an interface / stub signature
        // whose line starts with the bare callee name and ends at
        // the open paren (`recordRealizations(`) or carries a
        // return-type annotation (`): Promise<...>`). Projection
        // calls in this tree are always awaited, returned, or
        // assigned, so a real call never takes that shape.
        const trimmed = codeLine.trim();
        if (
          trimmed.startsWith(callee) &&
          (trimmed === `${callee}(` || trimmed.includes("):"))
        ) {
          continue;
        }
        const call: CensusCall = {
          file: relPath,
          line: index + 1,
          callee,
          text: codeLine.trim(),
        };
        if (
          callee === "recordAuditEvent" &&
          !isProjectionAuditEventCall(relPath, rawLines)
        ) {
          ignoredIaaaAuditCalls.push(call);
          continue;
        }
        if (allowedCallees.has(callee)) allowed.push(call);
        else violations.push(call);
      }
    }
  });
  return { violations, ignoredIaaaAuditCalls, allowed };
}

/** Scan all of `src/` (tests/ are fixtures; `*.deprecated.ts` retired). */
export function scanSrcForProjectionCalls(
  repoRoot: string = REPO_ROOT,
): CensusScanResult {
  const violations: CensusCall[] = [];
  const ignoredIaaaAuditCalls: CensusCall[] = [];
  const allowed: CensusCall[] = [];
  for (const full of walkTsFiles(path.join(repoRoot, "src"))) {
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    const raw = readFileSync(full, "utf8").split("\n");
    const result = scanFileForProjectionCalls(rel, stripComments(raw), raw);
    violations.push(...result.violations);
    ignoredIaaaAuditCalls.push(...result.ignoredIaaaAuditCalls);
    allowed.push(...result.allowed);
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  allowed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { violations, ignoredIaaaAuditCalls, allowed };
}

/* ------------------------------------------------------------------ */
/* P-B — DO-first ordering                                             */
/* ------------------------------------------------------------------ */

export interface DoFirstEntry {
  file: string;
  /** Enclosing function holding both the persist and the projection. */
  functionName: string;
  /** The DO persist (or re-read) that must precede the projection. */
  persist: RegExp;
  /** The projection call that must follow the persist. */
  projection: RegExp;
}

/**
 * DO-first sites (ADR 0033 R-7.1). The async-job helper is pinned on
 * its re-read (`getRow` before the hook), so the projection carries
 * what landed. The chain/shard port wrappers take an already-persisted
 * record by contract — their only callers are the pinned sites here
 * (P-A census), so no separate row is needed for them.
 */
export const DO_FIRST_ENTRIES: DoFirstEntry[] = [
  {
    file: "src/agents/orchestrator/reportDispatch.ts",
    functionName: "persistScreenerReportCanonical",
    persist: /storeReportAtGenerationWithR2\s*\(/,
    projection: /projectCanonicalReportBestEffort\s*\(/,
  },
  {
    file: "src/agents/orchestrator/reportDispatch.ts",
    functionName: "persistPipelineGenerateReportCanonical",
    persist: /storeReportAtGenerationWithR2\s*\(/,
    projection: /projectCanonicalReportBestEffort\s*\(/,
  },
  {
    file: "src/agents/orchestrator/reportDispatch.ts",
    functionName: "persistParentScreenReportCanonical",
    persist: /storeReportAtGenerationWithR2\s*\(/,
    projection: /projectCanonicalReportBestEffort\s*\(/,
  },
  {
    file: "src/agents/scheduled-agent.ts",
    functionName: "synthesizeSchedule",
    persist: /saveSynthesized\s*\(/,
    projection: /projectSynthesized\s*\(/,
  },
  {
    file: "src/agents/scheduled-agent.ts",
    functionName: "approveSynthesizedSchedule",
    persist: /saveSynthesized\s*\(/,
    projection: /projectSynthesized\s*\(/,
  },
  {
    file: "src/agents/scheduled-agent.ts",
    functionName: "killSynthesizedSchedule",
    persist: /saveSynthesized\s*\(/,
    projection: /projectSynthesized\s*\(/,
  },
  {
    file: "src/agents/orchestrator/asyncJobs.ts",
    functionName: "projectAsyncJobTransition",
    persist: /getRow\s*\(/,
    projection: /projectAsyncJobBestEffort\s*\(/,
  },
];

export interface DoFirstCheck {
  entry: DoFirstEntry;
  ok: boolean;
  reason: string;
}

/** Check one DO-first entry against its file's code-only lines. */
export function checkDoFirst(
  entry: DoFirstEntry,
  codeLines: string[],
): DoFirstCheck {
  const body = findFunctionBody(codeLines, entry.functionName);
  if (!body) {
    return {
      entry,
      ok: false,
      reason: `function ${entry.functionName} not found or braces do not balance`,
    };
  }
  const persistLine = findInBody(body, entry.persist);
  const projectionLine = findInBody(body, entry.projection);
  if (persistLine === null) {
    return { entry, ok: false, reason: "persist marker not found in function" };
  }
  if (projectionLine === null) {
    return { entry, ok: false, reason: "projection call not found in function" };
  }
  if (persistLine >= projectionLine) {
    return {
      entry,
      ok: false,
      reason: `persist at line ${persistLine} does not precede projection at line ${projectionLine} (DO-first violated)`,
    };
  }
  return { entry, ok: true, reason: `persist:${persistLine} before projection:${projectionLine}` };
}

/* ------------------------------------------------------------------ */
/* P-C — Never-throw                                                   */
/* ------------------------------------------------------------------ */

export interface NeverThrowEntry {
  file: string;
  functionName: string;
}

/**
 * Projection functions that must contain their own try/catch (or
 * per-item error collection): a projection failure never throws into
 * the DO write, the submission, or the run (ADR 0033 R-7.2).
 * `seedCanonicalReports` is deliberately NOT here: a store failure
 * during the seed propagates by design (an operator step whose
 * failure the operator must see).
 */
export const NEVER_THROW_ENTRIES: NeverThrowEntry[] = [
  { file: "src/services/runLedgerProjectionHooks.ts", functionName: "projectCanonicalReportBestEffort" },
  { file: "src/services/runLedgerProjectionHooks.ts", functionName: "projectAsyncJobBestEffort" },
  { file: "src/services/runLedgerProjectionHooks.ts", functionName: "fireCarriers" },
  { file: "src/services/runLedgerProjectionPosting.ts", functionName: "postRunLedgerBestEffort" },
  { file: "src/data/chainScheduleProjection.ts", functionName: "projectTransition" },
  { file: "src/data/chainScheduleProjection.ts", functionName: "reconcileChainSchedules" },
  { file: "src/data/shardJobProjection.ts", functionName: "projectLegOutcomes" },
  { file: "src/data/shardJobProjection.ts", functionName: "reconcileShardJobs" },
  { file: "src/data/auditReportProjection.ts", functionName: "recordAuditEvent" },
  { file: "src/agents/orchestrator/runLedgerReconcile.ts", functionName: "reconcileRunLedgerProjection" },
];

export interface NeverThrowCheck {
  entry: NeverThrowEntry;
  ok: boolean;
  reason: string;
}

/** Check one never-throw entry: its body must contain a `try`. */
export function checkNeverThrow(
  entry: NeverThrowEntry,
  codeLines: string[],
): NeverThrowCheck {
  const body = findFunctionBody(codeLines, entry.functionName);
  if (!body) {
    return {
      entry,
      ok: false,
      reason: `function ${entry.functionName} not found or braces do not balance`,
    };
  }
  const tryLine = findInBody(body, /\btry\s*\{/);
  if (tryLine === null) {
    return {
      entry,
      ok: false,
      reason: `no try/catch in ${entry.functionName} — a projection failure would throw into the caller`,
    };
  }
  return { entry, ok: true, reason: `try at line ${tryLine}` };
}

/* ------------------------------------------------------------------ */
/* P-D — Reconcile operator-only                                       */
/* ------------------------------------------------------------------ */

/** Reconcile entry points whose references the allowlist governs. */
export const RECONCILE_NAMES = [
  "reconcileRunLedgerProjection",
  "reconcileShardJobProjection",
  "reconcileChainSchedules",
  "reconcileShardJobs",
  "reconcileChainScheduleProjection",
] as const;

/**
 * Files allowed to reference each reconcile entry point: the
 * definition, the DO door, and the admin-gated route. No tick,
 * boot, or scheduled path references them (ADR 0033 R-7.4).
 */
export const RECONCILE_ALLOWLIST: Record<string, readonly string[]> = {
  reconcileRunLedgerProjection: [
    "src/agents/orchestrator.ts",
    "src/agents/orchestrator/runLedgerReconcile.ts",
    "src/server/routes/privacy.ts",
  ],
  reconcileShardJobProjection: [
    "src/agents/orchestrator.ts",
    "src/agents/orchestrator/shardJobReconcile.ts",
    "src/server/routes/privacy.ts",
  ],
  reconcileChainSchedules: [
    "src/agents/scheduled-agent.ts",
    "src/data/chainScheduleProjection.ts",
  ],
  reconcileShardJobs: [
    "src/agents/orchestrator/shardJobReconcile.ts",
    "src/data/shardJobProjection.ts",
  ],
  reconcileChainScheduleProjection: [
    "src/agents/scheduled-agent.ts",
    "src/data/chainScheduleProjection.ts",
    "src/server/routes/privacy.ts",
  ],
};

export interface ReconcileReference {
  file: string;
  line: number;
  name: string;
}

export interface ReconcileScanResult {
  violations: ReconcileReference[];
  allowed: ReconcileReference[];
}

/** Scan one file's code-only lines for reconcile references. */
export function scanFileForReconcile(
  relPath: string,
  codeLines: string[],
): ReconcileScanResult {
  const violations: ReconcileReference[] = [];
  const allowed: ReconcileReference[] = [];
  codeLines.forEach((codeLine, index) => {
    for (const name of RECONCILE_NAMES) {
      if (!new RegExp(`\\b${name}\\b`).test(codeLine)) continue;
      const ref: ReconcileReference = { file: relPath, line: index + 1, name };
      if ((RECONCILE_ALLOWLIST[name] ?? []).includes(relPath)) allowed.push(ref);
      else violations.push(ref);
    }
  });
  return { violations, allowed };
}

/** Scan all of `src/` for reconcile references. */
export function scanSrcForReconcile(
  repoRoot: string = REPO_ROOT,
): ReconcileScanResult {
  const violations: ReconcileReference[] = [];
  const allowed: ReconcileReference[] = [];
  for (const full of walkTsFiles(path.join(repoRoot, "src"))) {
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    const result = scanFileForReconcile(
      rel,
      stripComments(readFileSync(full, "utf8").split("\n")),
    );
    violations.push(...result.violations);
    allowed.push(...result.allowed);
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { violations, allowed };
}

/* ------------------------------------------------------------------ */
/* P-E — Idempotency mechanism                                         */
/* ------------------------------------------------------------------ */

export interface IdempotencyEntry {
  file: string;
  /** D1 projection adapter method whose body must carry the guard. */
  method: string;
  /** Finding whose fix removes this exception (absent = must conform). */
  exceptionFinding?: string;
  /** Follow-up sub-issue under #4935 that clears the exception. */
  exceptionIssue?: number;
}

/**
 * Statement-level idempotency guards (ADR 0033 R-1). A method body
 * must contain `onConflictDoNothing` or `onConflictDoUpdate`, or be
 * an allowlisted exception with its finding + follow-up issue.
 */
export const IDEMPOTENCY_ENTRIES: IdempotencyEntry[] = [
  { file: "src/data/d1AuditReportAdapter.ts", method: "recordAuditEvent" },
  { file: "src/data/d1AuditReportAdapter.ts", method: "recordReport" },
  { file: "src/data/d1RunLedgerAdapter.ts", method: "recordAsyncJob" },
  { file: "src/data/d1ChainScheduleAdapter.ts", method: "recordChain" },
  { file: "src/data/d1ChainScheduleAdapter.ts", method: "recordSchedule" },
  { file: "src/data/d1ShardJobAdapter.ts", method: "recordJob" },
  {
    file: "src/telemetry/d1TelemetryAdapter.ts",
    method: "recordRealizations",
    exceptionFinding: "F-2",
    exceptionIssue: 4962,
  },
  {
    file: "src/data/runLedgerProjection.ts",
    method: "projectReport",
    exceptionFinding: "F-3",
    exceptionIssue: 4963,
  },
];

export interface IdempotencyCheck {
  entry: IdempotencyEntry;
  status: "conform" | "exception" | "violation";
  reason: string;
}

/** Check one idempotency entry against its file's code-only lines. */
export function checkIdempotency(
  entry: IdempotencyEntry,
  codeLines: string[],
): IdempotencyCheck {
  const body = findFunctionBody(codeLines, entry.method);
  if (!body) {
    return {
      entry,
      status: "violation",
      reason: `method ${entry.method} not found or braces do not balance`,
    };
  }
  const guardLine = findInBody(body, /onConflictDoNothing|onConflictDoUpdate/);
  if (guardLine !== null) {
    return { entry, status: "conform", reason: `guard at line ${guardLine}` };
  }
  if (entry.exceptionFinding) {
    return {
      entry,
      status: "exception",
      reason: `no statement-level guard; known exception ${entry.exceptionFinding} (follow-up #${entry.exceptionIssue})`,
    };
  }
  return {
    entry,
    status: "violation",
    reason: `no onConflictDoNothing/onConflictDoUpdate in ${entry.method} — idempotency is not atomic at the statement level (ADR 0033 R-1)`,
  };
}

/* ------------------------------------------------------------------ */
/* Live tests                                                          */
/* ------------------------------------------------------------------ */

const CENSUS_FAILURE_MESSAGE =
  "A projection call outside the ADR 0033 census: a new dual-write " +
  "path needs contract review — add it to the census in this test " +
  "AND to the ADR 0033 Appendix A ledger, or the path does not land.";

describe("Cross-store consistency pins (#4935, ADR 0033)", () => {
  // P-A scans all of src/ synchronously (~10s unloaded, >25s under
  // shard load on shared runners) — the 25s default trips on load,
  // not on a census violation. The 120s bound follows the
  // trading-boundary.test.ts precedent; the census assertions below
  // still run in full and still fail on any real violation.
  it("P-A: every projection call is in the audited census", { timeout: 120_000 }, () => {
    const { violations, ignoredIaaaAuditCalls, allowed } =
      scanSrcForProjectionCalls();
    console.log(
      `cross-store-pin P-A: census calls ${allowed.length}; ` +
        `ignored IAAA recordAuditEvent calls ${ignoredIaaaAuditCalls.length} ` +
        `(${ignoredIaaaAuditCalls.map((c) => `${c.file}:${c.line}`).join(", ") || "none"}); ` +
        `violations ${violations.length}`,
    );
    expect(
      violations.map((v) => `${v.file}:${v.line} (${v.callee}): ${v.text}`),
      `${CENSUS_FAILURE_MESSAGE} Violations:`,
    ).toEqual([]);
    // The census is live, not vestigial: the audited paths are present.
    expect(allowed.length).toBeGreaterThan(0);
  });

  it("P-B: the DO persist precedes the projection call at every site", () => {
    const failures: string[] = [];
    for (const entry of DO_FIRST_ENTRIES) {
      const result = checkDoFirst(entry, readCodeLines(entry.file));
      console.log(
        `cross-store-pin P-B: ${entry.file} ${entry.functionName} — ${result.reason}`,
      );
      if (!result.ok) {
        failures.push(`${entry.file} ${entry.functionName}: ${result.reason}`);
      }
    }
    expect(failures, "DO-first violated (ADR 0033 R-7.1):").toEqual([]);
  });

  it("P-C: projection functions never throw into the caller", () => {
    const failures: string[] = [];
    for (const entry of NEVER_THROW_ENTRIES) {
      const result = checkNeverThrow(entry, readCodeLines(entry.file));
      if (!result.ok) {
        failures.push(`${entry.file} ${entry.functionName}: ${result.reason}`);
      }
    }
    expect(
      failures,
      "Projection function without try/catch (ADR 0033 R-7.2):",
    ).toEqual([]);
  });

  it("P-D: reconcile entry points are referenced only from operator paths", () => {
    const { violations, allowed } = scanSrcForReconcile();
    console.log(
      `cross-store-pin P-D: allowed reconcile references ${allowed.length}; violations ${violations.length}`,
    );
    expect(
      violations.map((v) => `${v.file}:${v.line} (${v.name})`),
      "Reconcile referenced outside admin-gated routes / DO doors (ADR 0033 R-7.4):",
    ).toEqual([]);
    expect(allowed.length).toBeGreaterThan(0);
  });

  it("P-E: D1 projection writes carry a statement-level idempotency guard", () => {
    const violations: string[] = [];
    const exceptions: string[] = [];
    for (const entry of IDEMPOTENCY_ENTRIES) {
      const result = checkIdempotency(entry, readCodeLines(entry.file));
      console.log(
        `cross-store-pin P-E: ${entry.file} ${entry.method} — ${result.status} (${result.reason})`,
      );
      if (result.status === "violation") {
        violations.push(`${entry.file} ${entry.method}: ${result.reason}`);
      } else if (result.status === "exception") {
        exceptions.push(`${entry.file} ${entry.method}: ${result.reason}`);
      }
    }
    expect(
      violations,
      "D1 projection write without a statement-level idempotency guard (ADR 0033 R-1):",
    ).toEqual([]);
    // The known exceptions are visible, not hidden: exactly the two
    // audit findings, each with its follow-up issue.
    expect(exceptions).toHaveLength(2);
    expect(exceptions.join(" ")).toContain("F-2");
    expect(exceptions.join(" ")).toContain("F-3");
  });
});

/* ------------------------------------------------------------------ */
/* Scanner unit tests                                                  */
/* ------------------------------------------------------------------ */

describe("cross-store pin scanners (#4935)", () => {
  it("P-A skips interface / stub type members, not real calls", () => {
    const lines = stripComments([
      "export interface ThesisRealizationStore {",
      "  recordRealizations(",
      "    rows: ThesisRealizationInput[],",
      "  ): Promise<{ recorded: number; duplicates: number }>;",
      "}",
      "  const result = await deps.store.recordRealizations(batch);",
    ]);
    const result = scanFileForProjectionCalls(
      "src/telemetry/telemetryRoute.ts",
      lines,
      lines,
    );
    // Only the real call counts; the interface member does not.
    expect(result.allowed.map((c) => `${c.callee}:${c.line}`)).toEqual([
      "recordRealizations:6",
    ]);
    expect(result.violations).toEqual([]);
  });

  it("P-A classifies a census call, an unknown call, and a definition", () => {
    const lines = stripComments([
      "import { projectCanonicalReportBestEffort } from '../../services/runLedgerProjectionHooks';",
      "await projectCanonicalReportBestEffort({ env, sql, reportId });",
      "await projectLegOutcomes({ store, legs });",
      "export async function projectCanonicalReportBestEffort(args: {}) {}",
      "async projectQueuedRunLedger(input: {}) {}",
    ]);
    const raw = [
      "import { projectCanonicalReportBestEffort } from '../../services/runLedgerProjectionHooks';",
      "await projectCanonicalReportBestEffort({ env, sql, reportId });",
      "await projectLegOutcomes({ store, legs });",
      "export async function projectCanonicalReportBestEffort(args: {}) {}",
      "async projectQueuedRunLedger(input: {}) {}",
    ];
    const result = scanFileForProjectionCalls(
      "src/agents/orchestrator/reportDispatch.ts",
      lines,
      raw,
    );
    // The census call is allowed; the definition lines are not calls.
    expect(result.allowed.map((c) => c.callee)).toEqual([
      "projectCanonicalReportBestEffort",
    ]);
    // projectLegOutcomes is not in this file's census row.
    expect(result.violations.map((v) => v.callee)).toEqual([
      "projectLegOutcomes",
    ]);
  });

  it("P-A resolves recordAuditEvent by import source (projection vs IAAA)", () => {
    const projectionRaw = [
      "import { recordAuditEvent } from './auditReportProjection';",
      "await recordAuditEvent(store, draft, eventId, nowMs);",
    ];
    const iaaaRaw = [
      "import { recordAuditEvent } from '../../security/iaaaAudit';",
      "await recordAuditEvent(stores.auditStore, { action });",
    ];
    const projection = scanFileForProjectionCalls(
      "src/data/createAuditReportPorts.ts",
      stripComments(projectionRaw),
      projectionRaw,
    );
    expect(projection.allowed.map((c) => c.callee)).toEqual([
      "recordAuditEvent",
    ]);
    const iaaa = scanFileForProjectionCalls(
      "src/agents/routes/dataLifecycle.ts",
      stripComments(iaaaRaw),
      iaaaRaw,
    );
    expect(iaaa.allowed).toEqual([]);
    expect(iaaa.violations).toEqual([]);
    expect(iaaa.ignoredIaaaAuditCalls).toHaveLength(1);
  });

  it("P-B finds the persist before the projection in one function", () => {
    const codeLines = stripComments([
      "export async function persistScreenerReportCanonical(ctx, result) {",
      "  const stored = await storeReportAtGenerationWithR2(ctx.ensureTables(), ctx.env, {});",
      "  if (stored) {",
      "    await projectCanonicalReportBestEffort({ env: ctx.env, reportId: stored.reportId });",
      "  }",
      "}",
    ]);
    const result = checkDoFirst(
      {
        file: "src/agents/orchestrator/reportDispatch.ts",
        functionName: "persistScreenerReportCanonical",
        persist: /storeReportAtGenerationWithR2\s*\(/,
        projection: /projectCanonicalReportBestEffort\s*\(/,
      },
      codeLines,
    );
    expect(result.ok).toBe(true);
  });

  it("P-B fails when the projection precedes the persist", () => {
    const codeLines = stripComments([
      "export async function persistScreenerReportCanonical(ctx, result) {",
      "  await projectCanonicalReportBestEffort({ env: ctx.env, reportId: 'x' });",
      "  const stored = await storeReportAtGenerationWithR2(ctx.ensureTables(), ctx.env, {});",
      "}",
    ]);
    const result = checkDoFirst(
      {
        file: "src/agents/orchestrator/reportDispatch.ts",
        functionName: "persistScreenerReportCanonical",
        persist: /storeReportAtGenerationWithR2\s*\(/,
        projection: /projectCanonicalReportBestEffort\s*\(/,
      },
      codeLines,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not precede");
  });

  it("P-C requires a try/catch in the projection function body", () => {
    const withTry = stripComments([
      "export async function postRunLedgerBestEffort(env, tenantId, input, nowMs) {",
      "  try {",
      "    return await projector.projectReport(input.row, nowMs);",
      "  } catch (err) {",
      "    return { posted: false };",
      "  }",
      "}",
    ]);
    expect(
      checkNeverThrow(
        {
          file: "src/services/runLedgerProjectionPosting.ts",
          functionName: "postRunLedgerBestEffort",
        },
        withTry,
      ).ok,
    ).toBe(true);
    const withoutTry = stripComments([
      "export async function postRunLedgerBestEffort(env, tenantId, input, nowMs) {",
      "  return await projector.projectReport(input.row, nowMs);",
      "}",
    ]);
    expect(
      checkNeverThrow(
        {
          file: "src/services/runLedgerProjectionPosting.ts",
          functionName: "postRunLedgerBestEffort",
        },
        withoutTry,
      ).ok,
    ).toBe(false);
  });

  it("P-D allows an operator route and rejects a tick path", () => {
    const route = scanFileForReconcile(
      "src/server/routes/privacy.ts",
      stripComments([
        "const report = await stub.reconcileShardJobProjection(tenantId);",
      ]),
    );
    expect(route.violations).toEqual([]);
    expect(route.allowed).toHaveLength(1);
    const tick = scanFileForReconcile(
      "src/services/scheduledTasks.ts",
      stripComments([
        "await reconcileShardJobs({ store, tenantId, nowMs, railsStates });",
      ]),
    );
    expect(tick.violations).toHaveLength(1);
  });

  it("P-E accepts an ON CONFLICT guard and flags the F-2 exception shape", () => {
    const guarded = stripComments([
      "async recordAsyncJob(row, nowMs) {",
      "  await this.db.insert(agentAsyncJobs).values(values)",
      "    .onConflictDoUpdate({ target: agentAsyncJobs.jobId, set: values });",
      "}",
    ]);
    expect(
      checkIdempotency(
        { file: "src/data/d1RunLedgerAdapter.ts", method: "recordAsyncJob" },
        guarded,
      ).status,
    ).toBe("conform");
    const unguarded = stripComments([
      "async recordRealizations(rows) {",
      "  const existing = await this.db.select().from(agentThesisRealizations);",
      "  await this.db.insert(agentThesisRealizations).values(rows);",
      "}",
    ]);
    const exception = checkIdempotency(
      {
        file: "src/data/d1TelemetryAdapter.ts",
        method: "recordRealizations",
        exceptionFinding: "F-2",
        exceptionIssue: 4962,
      },
      unguarded,
    );
    expect(exception.status).toBe("exception");
    expect(exception.reason).toContain("F-2");
    const violation = checkIdempotency(
      { file: "src/data/d1TelemetryAdapter.ts", method: "recordRealizations" },
      unguarded,
    );
    expect(violation.status).toBe("violation");
  });
});
