/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — scan-run
 * port for the options/discovery family: persistence for
 * opportunity scan runs (issue #27).
 *
 * ADR D-0 ruled this family DO-resident behind a port: the runs
 * are written by the executing OrchestratorAgent instance and
 * read back by the same user's surfaces on the same host class
 * (colocation, menu property (e); save+prune and updatePdfKey
 * lean weakly on per-instance serialization, (b)). No reader in
 * another instance class exists.
 *
 * This module carries the record types, the retention
 * constants, the #103 visibility rule, and the port interface
 * ONLY (ADR 0002 R1/R2): no store client, no env binding, no
 * SQL. Adapters: doSqliteScanRunAdapter.ts (production, the
 * legacy SqlScanRunStore moved into the layer),
 * inMemoryScanRunAdapter.ts (test double). The types moved
 * here from src/trading/options/scanRunStore.ts, which is now
 * a re-export shim over this port and the DO adapter.
 *
 * TRANSACTION SEAM (ADR D-C): save() is INSERT + retention
 * prune — one unit. On the DO adapter the pair runs through
 * withTransaction when the host supplies the transaction-
 * capable storage object; over a bare sql handle it applies
 * sequentially, which is exactly today's behaviour under the
 * DO's per-instance serialization.
 */
import type {
  FitGateBucket,
  OpportunityScanResult,
  OptionsPartialQualification,
  ScanCoverage,
  ScanMode,
} from "../trading";
import type { ProfileRef } from "../trading";
import type { LedgerLinkage } from "./jobRunRecordPorts";
import { isMissingIdLiteral } from "../services/consolidatedScheduling";

/** Re-exported so scan-store consumers name the §4 linkage shape
 *  from the port, not from the ledger's home. */
export type { LedgerLinkage } from "./jobRunRecordPorts";

/** Days a persisted scan run is retained. 365 matches the settled
 *  retention for discovery runs: diffing a scan against the same setup
 *  a year apart stays possible, and nothing older silently accumulates. */
export const SCAN_RUN_RETENTION_DAYS = 365;

/** Hard row cap for the scan-run table (oldest pruned first), so a
 *  high-frequency caller cannot grow DO storage without bound inside
 *  the retention window. */
export const SCAN_RUN_MAX_ROWS = 1000;

/**
 * Issue #3327 (programme #3292): which broker's chain produced a scan run.
 *
 * The scan ENGINE is neutral (#3272), but a run is evidence about one broker's
 * chains, so history has to say which. A run saved before this field existed
 * was produced by E*TRADE — the only broker wired to the scanner then — and
 * reads back as `etrade`, exactly like the IV series (#3326). The field rides
 * inside `summary_json`, so no column migration is needed.
 */
export type ScanRunBroker = "etrade" | "alpaca" | "public"; // Issue #3990: Public runs record their own broker.

export function normalizeScanRunBroker(value: unknown): ScanRunBroker {
  return String(value ?? "").trim().toLowerCase() === "alpaca" ? "alpaca" : "etrade";
}

/**
 * Issue #3314: normalize a §4 linkage for stamping onto a scan row —
 * the S1 value shape (`LedgerLinkage` ids) with S1 null-handling: a
 * missing id, or a poisoned #3650 literal ("undefined"/"null"), reads
 * as an explicit null, never an invented id. One definition for both
 * scan adapters (no parallel linkage scheme); the trigger is NOT part
 * of it — it still rides `summary_json` (the #3264 fix, unchanged).
 */
export function normalizeScanRunLinkage(
  linkage: Pick<LedgerLinkage, "scheduleId" | "asyncJobId" | "workflowId"> | undefined,
): { scheduleId: string | null; asyncJobId: string | null; workflowId: string | null } {
  const clean = (value: unknown): string | null =>
    typeof value === "string" && value.trim() && !isMissingIdLiteral(value) ? value : null;
  return {
    scheduleId: clean(linkage?.scheduleId),
    asyncJobId: clean(linkage?.asyncJobId),
    workflowId: clean(linkage?.workflowId),
  };
}

/** The listing projection of a stored run: everything a history view
 *  needs, without hauling the full result. */
export interface ScanRunSummary {
  id: string;
  generatedAt: string;
  mode: ScanMode;
  modelVersion: string;
  gate: OpportunityScanResult["gate"];
  coverage: ScanCoverage;
  /** The saved profile the run ran under (issue #103, completing
   *  #28's stamp): copied from the result so history rows can show it
   *  without fetching every run in full. Null when no profile was
   *  applied. Summaries persisted before issue #103 lack the field at
   *  runtime (undefined); readers must treat absent as null. */
  profileRef: ProfileRef | null;
  /** The run's generated PDF storage key when the producing flow
   *  stamped one at save time (issue #1239). Optional deliberately:
   *  summaries persisted before #1239 lack the field at runtime;
   *  readers must treat absent as null. */
  pdfKey?: string | null;
  /**
   * Issue #2091: the workbook/CSV storage keys, mirroring pdfKey's
   * pattern and comment. Optional deliberately: summaries persisted
   * before #2091 lack the fields at runtime; readers treat absent
   * as null. Producers stamp them when the artifacts exist.
   */
  xlsxKey?: string | null;
  csvKey?: string | null;
  /** The run's partial-coverage qualification when the scan did not
   *  evaluate the full requested universe (issue #1850, R6's
   *  OptionsPartialQualification). Optional deliberately, same pattern
   *  as pdfKey: summaries persisted before #1850 lack the field at
   *  runtime; readers must treat absent as null. Null (not absent)
   *  means the run evaluated completely. */
  partial?: OptionsPartialQualification | null;
  /**
   * Issue #3264: the trigger the producing run recorded ("manual" /
   * "scheduled"), when the producer knew it. Optional deliberately,
   * same pattern as pdfKey: summaries persisted before this field
   * existed — and saves whose caller did not know the trigger —
   * lack it at runtime; readers must treat absent as null, never a
   * guessed trigger (the Docs Run Type renders "—" for null).
   */
  trigger?: "manual" | "scheduled" | null;
  /** Issue #3327: the broker whose chains the run read. Absent on runs saved
   *  before provenance existed — readers normalize absent to `etrade`. */
  broker?: ScanRunBroker | null;
  /**
   * Issue #3314: the §4 linkage ids (the S1 shape) stamped onto the
   * row at save time — the schedule that armed the run, the async job
   * it is or links to, the workflow it ran through. Optional
   * deliberately, same pattern as trigger: rows saved before #3314 —
   * and saves whose caller knew no linkage — lack the fields at
   * runtime; readers must treat absent as null, never a guessed id.
   * The columns carry the same three values (explicit NULLs), so the
   * row joins its ledger row on `schedule_id` (+ the generated_at
   * window) without parsing JSON.
   */
  scheduleId?: string | null;
  asyncJobId?: string | null;
  workflowId?: string | null;
  /** The login that saved the run (issue #103 per-user scoping).
   *  Optional deliberately: runs persisted before scoping existed —
   *  and runs saved by contexts with no identity — carry none, and
   *  an absent login is exactly what makes a run "legacy" under the
   *  visibility rule (see visibleToCaller). */
  userLogin?: string;
}

/** A persisted scan run: its summary plus the full result as produced. */
export interface StoredScanRun extends ScanRunSummary {
  result: OpportunityScanResult;
}

export interface ScanRunStore {
  /** Persist a scan result and return the stored run (with its id).
   *  Saving also prunes: rows older than the retention window and rows
   *  beyond the row cap are deleted, oldest first. `userLogin` stamps
   *  the saver's identity for per-user scoping (issue #103); call
   *  sites with no identity omit it and the run is saved unscoped —
   *  identity is never invented here. `id` (issue #1157, E2) lets a
   *  caller that minted the run id BEFORE the scan ran — so fetch-time
   *  captures could be attributed to it — persist the run under that
   *  very id; absent, the store's idFactory mints one as before.
   *  `trigger` (issue #3264) stamps the producing run's trigger so
   *  the history row can say how the run started; absent, the row
   *  records none. `linkage` (issue #3314) stamps the §4 linkage ids
   *  onto the row's columns (and the summary) so the row joins its
   *  ledger row; absent, the columns read NULL — an explicit absence,
   *  never a guessed id. */
  save(result: OpportunityScanResult, options?: { userLogin?: string; id?: string; trigger?: "manual" | "scheduled"; broker?: ScanRunBroker; linkage?: Pick<LedgerLinkage, "scheduleId" | "asyncJobId" | "workflowId"> }): Promise<StoredScanRun>;
  /** Newest-first summaries (generatedAt descending, id descending on
   *  ties), paginated by limit/offset, filtered by the visibility
   *  rule when a `userLogin` scope is given (and when it is not — an
   *  unscoped caller sees only unscoped runs). */
  list(options?: { limit?: number; offset?: number; userLogin?: string; broker?: ScanRunBroker }): Promise<ScanRunSummary[]>;
  /** The full stored run, or null when the id is unknown (or pruned)
   *  or the run is not visible to the `userLogin` scope — invisibility
   *  reads exactly like absence, so a run's existence never leaks
   *  across users. */
  get(id: string, options?: { userLogin?: string }): Promise<StoredScanRun | null>;
  /** Stamp a generated PDF key onto an already-saved run (issue
   *  #1209: the interactive route generates the PDF AFTER the scan is
   *  saved, so the row's pdfKey stays null until this backfill — the
   *  runs-list badge reads pdfKey, so without it the badge never
   *  lights up). Updates both the summary and the stored result so
   *  they agree. Returns true when a visible row was updated, false
   *  when the id is unknown, invisible to `userLogin`, or the key is
   *  blank — invisibility reads exactly like absence. Never throws
   *  for unknown ids; callers that must not fail a response treat
   *  false as "badge stays dark". */
  updatePdfKey(id: string, pdfKey: string, options?: { userLogin?: string }): Promise<boolean>;
  /** XLSX twin of updatePdfKey: stamp a generated workbook key onto
   *  an already-saved run (same visibility, blank-key and
   *  unknown-id discipline — updates both summary and result). */
  updateXlsxKey(id: string, xlsxKey: string, options?: { userLogin?: string }): Promise<boolean>;
  /** CSV twin of updatePdfKey, same discipline as updateXlsxKey. */
  updateCsvKey(id: string, csvKey: string, options?: { userLogin?: string }): Promise<boolean>;
  /** Stamp the §4 linkage onto an already-saved run (issue #3314:
   *  the scheduled path's persist stage runs inside the workflow,
   *  where the schedule id is unknowable — threading it through the
   *  workflow command is #4198's scope — so the scheduled task
   *  backfills it here, after the workflow returns, where both the
   *  scan id and the schedule id are known; same visibility,
   *  unknown-id and never-throws discipline as updatePdfKey).
   *  Updates the linkage columns and the summary (the result JSON
   *  carries no linkage, so it is untouched). Returns true when a
   *  visible row was updated, false when the id is unknown or
   *  invisible to `userLogin`. A poisoned #3650 literal stamps as
   *  null, never as an id. */
  updateLedgerLinkage(
    id: string,
    linkage: Pick<LedgerLinkage, "scheduleId" | "asyncJobId" | "workflowId">,
    options?: { userLogin?: string },
  ): Promise<boolean>;
  /** Delete rows older than the retention window (relative to `now`)
   *  and rows beyond the row cap; returns how many rows were deleted.
   *  Retention is global (not per-user), as before issue #103. */
  prune(now: Date): Promise<number>;
}

/**
 * The per-user visibility rule (issue #103), applied identically by
 * every adapter and relied on by the scans routes: a run saved WITH a
 * userLogin is visible only to that login; a run saved WITHOUT one
 * (everything persisted before issue #103, and anything saved by an
 * identity-less context) is visible to every caller, scoped or not.
 * An unscoped caller (no userLogin) therefore sees only legacy runs.
 */
export function visibleToCaller(summary: ScanRunSummary, userLogin?: string): boolean {
  return summary.userLogin === undefined || summary.userLogin === null || summary.userLogin === userLogin;
}

/**
 * Minimal SQL executor matching the Durable Object SqlStorage `exec`
 * signature (the same shape src/orm/index.ts declares): run a statement
 * with bound parameters, get back an iterable of row objects. The real
 * `this.ctx.storage.sql` satisfies it structurally.
 */
export interface ScanSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export interface ScanRunStoreOptions {
  /** Id factory for new runs. Default: crypto.randomUUID() (available
   *  in Workers and Node ≥ 19); injectable for deterministic tests. */
  idFactory?: () => string;
  /** Retention window override (days). Default SCAN_RUN_RETENTION_DAYS. */
  retentionDays?: number;
  /** Row-cap override. Default SCAN_RUN_MAX_ROWS. */
  maxRows?: number;
}

/** Run-over-run diff of two scan results (issue #27). */
export interface ScanRunDiff {
  /** Symbols gated "fit" in `b` that were not fit in `a`. */
  newFits: string[];
  /** Symbols gated "fit" in `a` that are no longer fit in `b`. */
  droppedFits: string[];
  /** Symbols gated "fit" in both runs. */
  stillFitting: string[];
  /** Symbols evaluated in BOTH runs (gate judged in both) whose gate
   *  bucket changed. Symbols skipped in either run are never judged,
   *  so they cannot appear here. */
  bucketChanges: Array<{ symbol: string; from: FitGateBucket; to: FitGateBucket }>;
  /** Symbols present in `b`'s matrix but not in `a`'s. */
  addedSymbols: string[];
  /** Symbols present in `a`'s matrix but not in `b`'s. */
  removedSymbols: string[];
}

/**
 * Diff two scan results run-over-run (issue #27): `a` is the older run,
 * `b` the newer. Fit membership is the #24 gate bucket on each matrix
 * row. Pure — operates on the results (or the results of two stored
 * runs), no store involved. (Carried in the port module like the
 * step-1 ports' pure merge helpers.)
 */
export function diffScanRuns(a: OpportunityScanResult, b: OpportunityScanResult): ScanRunDiff {
  const rowsA = new Map(a.matrix.map((r) => [r.symbol, r]));
  const rowsB = new Map(b.matrix.map((r) => [r.symbol, r]));
  const fitsOf = (rows: Map<string, OpportunityScanResult["matrix"][number]>) =>
    new Set([...rows.values()].filter((r) => r.gateBucket === "fit").map((r) => r.symbol));
  const fitsA = fitsOf(rowsA);
  const fitsB = fitsOf(rowsB);
  const ascending = (symbols: Iterable<string>) => [...symbols].sort((x, y) => x.localeCompare(y));

  const bucketChanges: ScanRunDiff["bucketChanges"] = [];
  for (const [symbol, rowA] of rowsA) {
    const rowB = rowsB.get(symbol);
    if (!rowB) continue;
    if (rowA.gateBucket !== null && rowB.gateBucket !== null && rowA.gateBucket !== rowB.gateBucket) {
      bucketChanges.push({ symbol, from: rowA.gateBucket, to: rowB.gateBucket });
    }
  }
  bucketChanges.sort((x, y) => x.symbol.localeCompare(y.symbol));

  return {
    newFits: ascending([...fitsB].filter((s) => !fitsA.has(s))),
    droppedFits: ascending([...fitsA].filter((s) => !fitsB.has(s))),
    stillFitting: ascending([...fitsA].filter((s) => fitsB.has(s))),
    bucketChanges,
    addedSymbols: ascending([...rowsB.keys()].filter((s) => !rowsA.has(s))),
    removedSymbols: ascending([...rowsA.keys()].filter((s) => !rowsB.has(s))),
  };
}
