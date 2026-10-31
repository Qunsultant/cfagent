/**
 * Record a sharded options run at serve time (issue #2091).
 *
 * The sharded chain produces PDF + XLSX + CSV blobs and a serve outcome
 * carrying their keys — but before #2091 it wrote NO canonical row and
 * NO scan-row keys, so Docs and Reports showed nothing for the run
 * (the blobs existed, unlisted). The monolithic path already writes
 * its own canonical row; this helper is the sharded path's equivalent,
 * called from the serve executor's key-adoption path.
 *
 * Writes, both idempotent:
 * - one canonical mas_reports row (generationId `options:<timestamp>`,
 *   so a re-delivery replays to the same row, never a duplicate),
 *   carrying pdfKey/xlsxKey/csvKey + reportUrl in its body;
 * - the Durable Object options history row (timestamp-keyed upsert via
 *   recordOptionsRun), carrying the same keys so /api/options/latest
 *   surfaces them.
 *
 * Failures warn and return false, never fail the serve job: a run that
 * produced artifacts must not fail because its record did not land.
 * The history-row write is attempted even when the canonical write
 * fails — one record landing beats neither.
 */

import { recordOptionsRun } from "../agents/optionsRuns";
import { recordJobOutcome } from "./jobOutcomes";
import type { SqlStorage } from "../orm";
import type { ScreenerRunOutcome } from "./screenerFollowups";

export interface OptionsServeRecordDeps {
  orm: {
    storeCanonicalReport: (input: Record<string, unknown>) => { reportId: string; created: boolean } | null;
    /** The DO SQLite behind the ORM — the job-outcome sink lives there. */
    getSql?: () => unknown;
  };
  storage: unknown;
}

/** The canonical store slice every options path needs. */
export interface OptionsCanonicalStore {
  // `any` keeps DatabaseORM's stricter ScheduledReportInput signature
  // assignable while the helper still spreads a plain record into it.
  // Issue #1169 S4-1: the optional env threads the AI/Vectorize
  // bindings to the index hook.
  storeCanonicalReport: (
    input: any,
    env?: { AI?: any; VECTOR_MEMORY?: any }
  ) => { reportId: string; created: boolean } | null;
}

/**
 * The one owner-aware canonical write for options runs (options run-record fix).
 *
 * `mas_reports` rows are owner-scoped on read (`user_login = ?` in
 * listScheduledReports / `/api/runs` / report detail). A write without
 * `userLogin` stores the row under the `default` owner, which no signed-in
 * user can then see — the report exists in the table and in R2, but the
 * Reports tab renders nothing. Every options canonical write goes through
 * here so a new call site cannot forget the owner again.
 *
 * Never throws: a report that was generated must not fail because its
 * index row could not be written.
 */
export function storeOptionsCanonicalReport(
  orm: OptionsCanonicalStore | null | undefined,
  input: Record<string, unknown>,
  env?: { AI?: any; VECTOR_MEMORY?: any },
): { reportId: string; created: boolean } | null {
  if (!orm || typeof orm.storeCanonicalReport !== "function") return null;
  const { userLogin, ...rest } = input as Record<string, unknown> & { userLogin?: unknown };
  try {
    return orm.storeCanonicalReport(
      {
        ...rest,
        ...(typeof userLogin === "string" && userLogin ? { userLogin } : {}),
      },
      env
    );
  } catch (err) {
    console.warn(
      `[optionsServeRecord] canonical write failed for run ${String((input as { runId?: unknown }).runId ?? "?")}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * The single canonical recorder for options runs (issue #2528, slice 1).
 * Every options channel must record through this function (or through
 * `storeOptionsCanonicalReport`, its underlying seam) after generation,
 * with the same field names, so Docs reads one row shape regardless of
 * channel. It does not generate, deliver, or change report content —
 * it only normalises the record: owner required, strategyMode carried
 * when known, artifact keys/statuses/errors carried only when present.
 * Legacy recorders in this file remain as thin callers during migration
 * and are deprecated in place (superseded by recordUnifiedOptionsRun)
 * once their call sites migrate; they are not deleted.
 */
export interface UnifiedOptionsRunRecord {
  runId: string;
  generationId: string;
  title: string;
  source: string;
  summary: string;
  trigger: "manual" | "scheduled" | "triggered" | "goal" | "agentic";
  strategyMode?: "thesis" | "all" | "no-view";
  symbol?: string;
  thesis?: string;
  scheduleId?: string;
  goalId?: string;
  scanRunId?: string;
  userLogin: string;
  createdAt?: string;
  pdfKey?: string;
  pdfStatus?: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus?: "generated" | "failed";
  csvError?: string;
  reportUrl?: string;
}

export function recordUnifiedOptionsRun(
  orm: OptionsCanonicalStore | null | undefined,
  input: UnifiedOptionsRunRecord,
  env?: { AI?: any; VECTOR_MEMORY?: any },
): { reportId: string; created: boolean } | null {
  return storeOptionsCanonicalReport(
    orm,
    {
      runId: input.runId,
      generationId: input.generationId,
      title: input.title,
      source: input.source,
      summary: input.summary,
      body: {
        trigger: input.trigger,
        strategyMode: input.strategyMode,
        symbol: input.symbol,
        thesis: input.thesis,
        scheduleId: input.scheduleId,
        goalId: input.goalId,
        scanRunId: input.scanRunId,
        ...(input.pdfKey ? { pdfKey: input.pdfKey } : {}),
        ...(input.pdfStatus ? { pdfStatus: input.pdfStatus } : {}),
        ...(input.pdfError ? { pdfError: input.pdfError } : {}),
        ...(input.xlsxKey ? { xlsxKey: input.xlsxKey } : {}),
        ...(input.xlsxStatus ? { xlsxStatus: input.xlsxStatus } : {}),
        ...(input.xlsxError ? { xlsxError: input.xlsxError } : {}),
        ...(input.csvKey ? { csvKey: input.csvKey } : {}),
        ...(input.csvStatus ? { csvStatus: input.csvStatus } : {}),
        ...(input.csvError ? { csvError: input.csvError } : {}),
        ...(input.reportUrl ? { reportUrl: input.reportUrl } : {}),
      },
      createdAt: input.createdAt,
      userLogin: input.userLogin,
    },
    env,
  );
}

export interface OptionsRunOutcomeRecord {
  id: string;
  trigger: "manual" | "scheduled";
  status: "completed" | "failed" | "partial";
  scanned?: number;
  matched?: number;
  error?: string;
  reportUrl?: string;
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
  deliveryStates?: Record<string, string>;
  origin: string;
  createdAt?: string;
}

/**
 * Record one options run in the job-outcome sink (options run-record fix). This is
 * what makes a run visible in Workflow Runs: the ledger forms a run from
 * an outcome that has no job twin, and reads the artifact list from that
 * outcome. Paths that already have a job tree (the follow-up bridge)
 * record their own outcome; this is for the paths that do not.
 * Never throws — a sink failure must not fail the run.
 */
export function recordOptionsRunOutcome(
  sql: SqlStorage | null | undefined,
  run: OptionsRunOutcomeRecord,
): void {
  if (!sql) return;
  try {
    recordJobOutcome(sql, {
      id: run.id,
      kind: "options",
      trigger: run.trigger,
      status: run.status,
      scanned: run.scanned,
      matched: run.matched,
      codedError: run.error,
      reportUrl: run.reportUrl,
      pdfKey: run.pdfKey,
      xlsxKey: run.xlsxKey,
      csvKey: run.csvKey,
      deliveryStates: run.deliveryStates,
      origin: run.origin,
      createdAt: run.createdAt,
    });
  } catch (err) {
    console.warn(`[optionsServeRecord] outcome write failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One strategy-screener run (the Strategy Discovery panel route,
 * `POST /trading/options/strategies` and `/best-trade`). The route
 * returned ranked strategies but recorded nothing: no canonical row,
 * no outcome, so the run was invisible on the Reports tab and in
 * Workflow Runs. It produces no PDF/XLSX/CSV (its unit is a ranked
 * strategy, not a contract), so the canonical body is the record and
 * the artifact list is honestly empty.
 */
/**
 * One stage of a unified strategy run record. Stored verbatim in the
 * canonical body (`body.stages`) so Docs Run Details and Workflow Runs
 * read the same stages for the same runId — never a second, divergent
 * stage list. Durations are recorded only when actually measured;
 * a stage whose duration was not measured carries null, never a
 * split of a combined timer.
 */
export interface UnifiedStrategyStage {
  stage: "feed" | "analysis" | "generation" | "delivery";
  status: "completed" | "failed" | "skipped";
  durationMs: number | null;
  inputIds: string[];
  outputIds: string[];
  errorCode: string | null;
  error: string | null;
  reason: string | null;
  evidence: Record<string, string | number | null>;
}

export interface StrategyScreenRecordInput {
  userLogin: string;
  symbol: string;
  trigger: "manual" | "scheduled";
  mode: "strategies" | "best-trade";
  ranked: unknown[];
  bestTrade?: unknown;
  riskReports?: unknown[];
  screenedOut?: unknown[];
  screen?: unknown;
  contracts?: unknown[];
  dataSource?: string;
  asyncJobId?: string;
  createdAt?: string;
  /** Request fields, as submitted — the input.* fields runDetails.ts reads. */
  thesis?: string;
  strategyMode?: "thesis" | "all" | "no-view";
  targetDate?: string;
  riskProfile?: string;
  allowedStrategies?: unknown;
  targetPrice?: number;
  dteMin?: number;
  dteMax?: number;
  sector?: string;
  contractType?: string;
  universe?: string;
  /** Provenance: the panel route that handled this run. */
  submittedVia?: string;
  scheduleId?: string;
  goalId?: string;
  /** Measured generation duration (ms), when the caller timed it. */
  generationDurationMs?: number;
  /** Combined discover-panel duration (ms) — feed + analysis together, never split. */
  discoverPanelDurationMs?: number;
  /** Strategy report artifacts (pdf/xlsx/csv), when generated. */
  pdfKey?: string;
  pdfStatus?: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus?: "generated" | "failed";
  csvError?: string;
}

function clipStr(v: unknown, max = 240): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function screenNumbers(screen: unknown): {
  underlyingsScanned: number | null;
  contractsEvaluated: number | null;
  contractsMatched: number | null;
  fetchErrors: Array<{ symbol?: string; reason?: string }>;
  warnings: string[];
  validationError: string | null;
} {
  const s = (screen && typeof screen === "object" ? (screen as Record<string, unknown>) : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const fetchErrors = Array.isArray(s.fetchErrors)
    ? (s.fetchErrors as Array<Record<string, unknown>>).map((e) => ({
        ...(typeof e.symbol === "string" ? { symbol: e.symbol } : {}),
        ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
      }))
    : [];
  return {
    underlyingsScanned: num(s.underlyingsScanned),
    contractsEvaluated: num(s.contractsEvaluated),
    contractsMatched: num(s.contractsMatched),
    fetchErrors,
    warnings: Array.isArray(s.warnings) ? (s.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [],
    validationError: typeof s.validationError === "string" ? s.validationError : null,
  };
}

/**
 * Build the unified stage trace for a strategy run from the evidence
 * the route already has — snapshot screen, screened-out reasons,
 * ranked list, and per-format generation outcomes. No stage is
 * inferred: feed status follows the snapshot (fetch errors with no
 * contracts = failed; a validation error = failed; otherwise
 * completed, even when the evaluated count is 0 — an empty slice
 * with no provider error is a filter/window outcome, not a
 * connector failure, and the evidence says so). The recording
 * stage is NOT stored here: it is derived by both readers from
 * the written canonical row id, so a failed write cannot leave a
 * stored "recording completed" behind. Delivery is skipped with
 * a reason when no delivery channel was requested — the panel
 * route requests none, so Docs download is not invented as a
 * delivery channel.
 */
export function buildUnifiedStrategyStages(
  input: StrategyScreenRecordInput,
  matched: number,
): UnifiedStrategyStage[] {
  const screen = screenNumbers(input.screen);
  const contractsEvaluated = screen.contractsEvaluated ?? (Array.isArray(input.contracts) ? input.contracts.length : null);
  const scanned = Array.isArray(input.contracts) ? input.contracts.length : contractsEvaluated;
  const firstFetchError = screen.fetchErrors[0]?.reason ?? null;
  const feedStatus: UnifiedStrategyStage["status"] =
    screen.validationError
      ? "failed"
      : screen.fetchErrors.length > 0 && (contractsEvaluated === 0 || contractsEvaluated === null) && (scanned === 0 || scanned === null)
        ? "failed"
        : "completed";
  const feedError = screen.validationError ?? (feedStatus === "failed" ? firstFetchError : null);
  const anyGenerated = input.pdfStatus === "generated" || input.xlsxStatus === "generated" || input.csvStatus === "generated";
  const allFailed =
    input.pdfStatus === "failed" && input.xlsxStatus === "failed" && input.csvStatus === "failed";
  const firstGenError = input.pdfError ?? input.xlsxError ?? input.csvError ?? null;
  return [
    {
      stage: "feed",
      status: feedStatus,
      durationMs: null,
      inputIds: [`symbol:${input.symbol}`],
      outputIds: contractsEvaluated !== null ? [`contractsEvaluated:${contractsEvaluated}`] : [],
      errorCode: feedStatus === "failed" ? (screen.validationError ? "RUN_STAGE_FAILED" : "RUN_PROVIDER_FETCH_FAILED") : null,
      error: clipStr(feedError),
      reason: feedStatus === "failed" ? (screen.validationError ? screen.validationError : firstFetchError) : null,
      evidence: {
        dataSource: input.dataSource ?? null,
        connector: input.dataSource === "calibrated-demo" ? "calibrated-demo" : "E*TRADE",
        underlyingsScanned: screen.underlyingsScanned,
        contractsEvaluated,
        contractsMatched: screen.contractsMatched,
        scanned,
        fetchErrorCount: screen.fetchErrors.length,
        firstFetchError: clipStr(firstFetchError),
        validationError: clipStr(screen.validationError),
        warningCount: screen.warnings.length,
        discoverPanelMs: typeof input.discoverPanelDurationMs === "number" ? input.discoverPanelDurationMs : null,
      },
    },
    {
      stage: "analysis",
      status: "completed",
      durationMs: null,
      inputIds: contractsEvaluated !== null ? [`contractsEvaluated:${contractsEvaluated}`] : [],
      outputIds: [`ranked:${matched}`],
      errorCode: null,
      error: null,
      reason: null,
      evidence: {
        candidatesIn: contractsEvaluated,
        screenedOutCount: Array.isArray(input.screenedOut) ? input.screenedOut.length : null,
        rankedCount: matched,
        bestTrade: input.mode === "best-trade" ? (input.bestTrade ? 1 : 0) : null,
        discoverPanelMs: typeof input.discoverPanelDurationMs === "number" ? input.discoverPanelDurationMs : null,
      },
    },
    {
      stage: "generation",
      status: allFailed ? "failed" : anyGenerated ? "completed" : "completed",
      durationMs: typeof input.generationDurationMs === "number" ? input.generationDurationMs : null,
      inputIds: [`ranked:${matched}`],
      outputIds: [input.pdfKey, input.xlsxKey, input.csvKey].filter((k): k is string => Boolean(k)),
      errorCode: allFailed ? "RUN_STAGE_FAILED" : null,
      error: clipStr(allFailed ? firstGenError : null),
      reason: allFailed ? firstGenError : null,
      evidence: {
        pdfStatus: input.pdfStatus ?? null,
        xlsxStatus: input.xlsxStatus ?? null,
        csvStatus: input.csvStatus ?? null,
        pdfError: clipStr(input.pdfError),
        xlsxError: clipStr(input.xlsxError),
        csvError: clipStr(input.csvError),
      },
    },
    {
      stage: "delivery",
      status: "skipped",
      durationMs: null,
      inputIds: [],
      outputIds: [],
      errorCode: null,
      error: null,
      reason: "no delivery channel requested for this panel run",
      evidence: { requestedChannels: null, deliveredVia: null },
    },
  ];
}

export function recordStrategyScreenRun(
  orm: (OptionsCanonicalStore & { getSql?: () => unknown }) | null | undefined,
  input: StrategyScreenRecordInput,
): { reportId: string; created: boolean } | null {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const generationId = `options_strategy:${input.mode}:${input.symbol}:${createdAt}`;
  const matched = input.mode === "best-trade" ? (input.bestTrade ? 1 : 0) : input.ranked.length;
  const summary =
    input.mode === "best-trade"
      ? `Best-trade pick for ${input.symbol}: ${input.bestTrade ? "one selected strategy" : "no qualifying strategy"}.`
      : `Strategy screen for ${input.symbol}: ${matched} ranked strateg${matched === 1 ? "y" : "ies"}.`;
  const stages = buildUnifiedStrategyStages(input, matched);
  const feed = stages[0];
  const strategyMode = input.strategyMode ?? "thesis";
  const submittedVia = input.submittedVia ?? `ui — POST /trading/options/${input.mode === "best-trade" ? "best-trade" : "strategies"} (options-strategy-panel)`;
  const stored = storeOptionsCanonicalReport(orm, {
    runId: generationId,
    generationId,
    title: `${input.mode === "best-trade" ? "Best trade" : "Strategy screen"} — ${input.symbol} (${input.trigger})`,
    source: "options_strategy",
    summary,
    body: {
      timestamp: createdAt,
      trigger: input.trigger,
      symbol: input.symbol,
      mode: input.mode,
      dataSource: input.dataSource,
      connector: String(feed.evidence.connector ?? ""),
      provider: String(feed.evidence.connector ?? ""),
      // Shape parity with the other canonical run bodies: success +
      // the match count the Runs read model renders.
      success: true,
      withTrades: matched,
      ranked: input.ranked,
      ...(input.bestTrade !== undefined ? { bestTrade: input.bestTrade } : {}),
      riskReports: input.riskReports ?? [],
      screenedOut: input.screenedOut ?? [],
      screen: input.screen,
      feed: {
        dataSource: input.dataSource ?? null,
        connector: feed.evidence.connector,
        underlyingsScanned: feed.evidence.underlyingsScanned,
        contractsEvaluated: feed.evidence.contractsEvaluated,
        contractsMatched: feed.evidence.contractsMatched,
        scanned: feed.evidence.scanned,
        fetchErrors: screenNumbers(input.screen).fetchErrors,
        warnings: screenNumbers(input.screen).warnings,
        validationError: screenNumbers(input.screen).validationError,
      },
      // The unified record: request as submitted, provenance, and
      // the stage trace. runDetails.ts reads input.* / strategyMode
      // / provenance / stages from exactly these fields, so a new
      // strategy run no longer renders its request as unknown.
      input: {
        symbols: [input.symbol],
        ...(input.universe ? { universe: input.universe } : {}),
        ...(input.thesis ? { thesis: input.thesis } : {}),
        strategyMode,
        ...(input.targetDate ? { targetDate: input.targetDate } : {}),
        ...(input.riskProfile ? { riskProfile: input.riskProfile } : {}),
        ...(input.allowedStrategies !== undefined ? { allowedStrategies: input.allowedStrategies } : {}),
        ...(input.targetPrice !== undefined ? { targetPrice: input.targetPrice } : {}),
        ...(input.dteMin !== undefined ? { dteMin: input.dteMin } : {}),
        ...(input.dteMax !== undefined ? { dteMax: input.dteMax } : {}),
        ...(input.sector ? { sector: input.sector } : {}),
        ...(input.contractType ? { contractType: input.contractType } : {}),
      },
      thesis: input.thesis,
      strategyMode,
      jobType: "options-strategy-panel",
      provenance: {
        executionMode: "online",
        syncAsync: "sync",
        interface: "ui",
        parallelism: "sequential",
        submittedVia,
        deliveredVia: null,
        trigger: input.trigger,
        scheduleId: input.scheduleId ?? null,
        goalId: input.goalId ?? null,
        asyncJobId: input.asyncJobId ?? null,
        jobType: "options-strategy-panel",
        strategyMode,
      },
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.asyncJobId ? { asyncJobId: input.asyncJobId } : {}),
      stages,
      deliveredVia: null,
      ...(input.pdfKey ? { pdfKey: input.pdfKey } : {}),
      ...(input.pdfStatus ? { pdfStatus: input.pdfStatus } : {}),
      ...(input.pdfError ? { pdfError: input.pdfError } : {}),
      ...(input.xlsxKey ? { xlsxKey: input.xlsxKey } : {}),
      ...(input.xlsxStatus ? { xlsxStatus: input.xlsxStatus } : {}),
      ...(input.xlsxError ? { xlsxError: input.xlsxError } : {}),
      ...(input.csvKey ? { csvKey: input.csvKey } : {}),
      ...(input.csvStatus ? { csvStatus: input.csvStatus } : {}),
      ...(input.csvError ? { csvError: input.csvError } : {}),
    },
    createdAt,
    userLogin: input.userLogin,
  });
  const sql = orm && typeof orm.getSql === "function" ? (orm.getSql() as any) : undefined;
  recordOptionsRunOutcome(sql, {
    // When the route runs as an async job, the outcome twins that job
    // so the ledger attaches it instead of inventing a second run.
    id: input.asyncJobId ?? generationId,
    trigger: input.trigger,
    status: "completed",
    scanned: input.contracts?.length,
    matched,
    pdfKey: input.pdfKey,
    xlsxKey: input.xlsxKey,
    csvKey: input.csvKey,
    origin: "options-strategy-screener",
    createdAt,
  });
  return stored;
}

export async function recordOptionsServeReport(
  deps: OptionsServeRecordDeps,
  outcome: ScreenerRunOutcome & { userLogin?: string },
): Promise<boolean> {
  if (outcome.kind !== "options" || !outcome.timestamp) return false;
  const timestamp = outcome.timestamp;
  const pdfKey = outcome.pdfKeys?.[0] ?? null;
  const xlsxKey = outcome.xlsxKey ?? null;
  const csvKey = outcome.csvKey ?? null;
  // Per-format statuses: a carried status wins; a key with no carried
  // status means the artifact was generated (the HTTP adapter already
  // infers the same way). A failed leg must record "failed" here —
  // without it the Docs list renders the leg as a bare "—".
  const pdfStatus = outcome.pdfStatus ?? (pdfKey ? "generated" : undefined);
  const xlsxStatus = outcome.xlsxStatus ?? (xlsxKey ? "generated" : undefined);
  const csvStatus = outcome.csvStatus ?? (csvKey ? "generated" : undefined);
  let canonicalOk = false;
  try {
    const stored = storeOptionsCanonicalReport(deps.orm, {
      runId: `options:${timestamp}`,
      generationId: `options:${timestamp}`,
      title: `Options scanner — ${outcome.thesis ?? "bullish"}`,
      source: "options_scanner",
      summary: outcome.summary ?? "",
      body: {
        timestamp,
        trigger: outcome.trigger,
        thesis: outcome.thesis ?? "bullish",
        success: outcome.success,
        symbols: outcome.symbols ?? [],
        withTrades: outcome.matchedCount ?? 0,
        opportunities: outcome.opportunities ?? [],
        pdfKey,
        xlsxKey,
        csvKey,
        ...(pdfStatus ? { pdfStatus } : {}),
        ...(outcome.pdfError ? { pdfError: outcome.pdfError } : {}),
        ...(xlsxStatus ? { xlsxStatus } : {}),
        ...(outcome.xlsxError ? { xlsxError: outcome.xlsxError } : {}),
        ...(csvStatus ? { csvStatus } : {}),
        ...(outcome.csvError ? { csvError: outcome.csvError } : {}),
        // Dedup join: runSummaryFromReport reads body.scanRunId, so
        // stamping it here lets mergeRunSummaries() absorb the
        // scan-store UUID row into this canonical row.
        ...(outcome.scanRunId ? { scanRunId: outcome.scanRunId } : {}),
        reportUrl: outcome.reportUrl ?? null,
      },
      createdAt: timestamp,
      userLogin: outcome.userLogin,
    });
    canonicalOk = stored !== null;
    if (!canonicalOk) console.warn(`[optionsServeRecord] canonical write returned null for run ${timestamp}`);
  } catch (err) {
    console.warn(`[optionsServeRecord] canonical write failed for run ${timestamp}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let historyOk = false;
  try {
    await recordOptionsRun(deps.storage, {
      timestamp,
      success: outcome.success,
      trigger: outcome.trigger,
      thesis: outcome.thesis ?? "bullish",
      symbols: outcome.symbols ?? [],
      withTrades: outcome.matchedCount ?? 0,
      summary: outcome.summary ?? "",
      opportunities: (outcome.opportunities ?? []) as unknown[],
      pdfKey,
      xlsxKey,
      csvKey,
      ...(outcome.reportUrl ? { reportUrl: outcome.reportUrl } : {}),
    });
    historyOk = true;
  } catch (err) {
    console.warn(`[optionsServeRecord] history write failed for run ${timestamp}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Options run-record fix: the sharded serve path owns no job-tree outcome, so
  // without this row the run's artifacts exist but Workflow Runs has
  // nothing to attach them to. Keyed by the run's delivery id when one
  // exists, so a replayed serve converges on the same row.
  const sql = typeof deps.orm.getSql === "function" ? (deps.orm.getSql() as SqlStorage | undefined) : undefined;
  recordOptionsRunOutcome(sql, {
    id: outcome.deliveryId ?? `options:${timestamp}`,
    trigger: outcome.trigger,
    status: outcome.success ? "completed" : "failed",
    scanned: outcome.totalScanned,
    matched: outcome.matchedCount,
    error: outcome.success ? undefined : outcome.error,
    reportUrl: outcome.reportUrl,
    pdfKey: pdfKey ?? undefined,
    xlsxKey: xlsxKey ?? undefined,
    csvKey: csvKey ?? undefined,
    origin: "options-serve",
    createdAt: timestamp,
  });
  return canonicalOk && historyOk;
}

/**
 * The orchestrator wrapper's record step (issue #223 history +
 * issue #910 canonical), extracted from OrchestratorAgent so the
 * #992 orchestrator size budget holds: the wrapper calls this with
 * the service result instead of inlining both writes. Semantics are
 * exactly the wrapper's: the history row is always written; the
 * canonical row is skipped when the service already wrote one
 * (canonicalReportId set — issue #2091, otherwise a second keyless
 * row hides the artifacts); failures warn, never throw.
 */
export interface OptionsOrchestratorRun {
  timestamp: string;
  success: boolean;
  trigger: "manual" | "scheduled";
  thesis: string;
  symbols: string[];
  withTrades: number;
  summary: string;
  opportunities: unknown[];
  error?: string;
  pdfKey?: string | null;
  xlsxKey?: string | null;
  csvKey?: string | null;
  reportUrl?: string | null;
  canonicalReportId?: string | null;
  userLogin?: string;
  /** Scan-store run id, when the service result carried it — stamped
   *  into the canonical body for the mergeRunSummaries() join. */
  scanRunId?: string | null;
}

export async function recordOptionsOrchestratorRun(
  deps: OptionsServeRecordDeps,
  run: OptionsOrchestratorRun,
): Promise<void> {
  try {
    await recordOptionsRun(deps.storage, {
      timestamp: run.timestamp,
      success: run.success,
      trigger: run.trigger,
      thesis: run.thesis,
      symbols: run.symbols,
      withTrades: run.withTrades,
      summary: run.summary,
      opportunities: run.opportunities.slice(0, 10),
      ...(run.success ? {} : { error: run.error }),
      pdfKey: run.pdfKey ?? null,
      xlsxKey: run.xlsxKey ?? null,
      csvKey: run.csvKey ?? null,
      ...(run.reportUrl ? { reportUrl: run.reportUrl } : {}),
    });
  } catch (err) {
    console.warn("[OrchestratorAgent] Could not persist options run:", err);
  }
  if (run.canonicalReportId) return;
  try {
    deps.orm.storeCanonicalReport({
      runId: `options:${run.timestamp}`,
      generationId: `options:${run.timestamp}`,
      title: `Autonomous options analysis — ${run.thesis} (${run.trigger})`,
      source: "options_scanner",
      summary: run.success
        ? run.summary || `Analyzed ${run.symbols.length} symbols.`
        : `Options analysis failed: ${run.error ?? "unknown error"}.`,
      body: {
        timestamp: run.timestamp,
        trigger: run.trigger,
        thesis: run.thesis,
        success: run.success,
        symbols: run.symbols,
        withTrades: run.withTrades,
        opportunities: run.opportunities,
        error: run.error,
        pdfKey: run.pdfKey ?? null,
        xlsxKey: run.xlsxKey ?? null,
        csvKey: run.csvKey ?? null,
        ...(run.scanRunId ? { scanRunId: run.scanRunId } : {}),
        reportUrl: run.reportUrl ?? null,
      },
      createdAt: new Date().toISOString(),
      ...(run.userLogin ? { userLogin: run.userLogin } : {}),
    });
  } catch (err) {
    console.warn("[OrchestratorAgent] Could not store options report canonical:", err);
  }
}
