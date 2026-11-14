/**
 * Workflow Runs read surface — `GET /workflow-runs` (internally; the
 * Worker forwards `/api/workflow-runs` here).
 *
 * Answers one question the other panels answer only in fragments:
 * "what did the workflow engine actually do?" The response is a list
 * of runs — a run per job chain (or standalone job) plus a run per
 * outcome with no job twin — each carrying its ordered stages, the
 * normalized inputs/outputs of every stage, its failures and their
 * reasons, the trigger and how it was evidenced, artifacts, and
 * delivery states.
 *
 * Reads are scoped to this Durable Object (one per signed-in user):
 * jobs by session id, outcomes by the object's own store, stage
 * transitions by the verified login. Each source is read defensively:
 * one broken store never hides the others — its error is named in
 * `storeErrors` and the rest of the ledger still renders.
 *
 * Only summaries leave this module: raw job payloads/results are
 * normalized by src/services/workflowRuns.ts (secret-shaped keys
 * redacted, long values clipped) and the raw rows are never returned.
 */
import { createAsyncJobPorts } from "../../data/createAsyncJobPorts";
import type { ScanRunSummary } from "../../data/scanRunPorts";
import { createShardJobAdapter } from "../../data/createShardJobPorts";
import type { ShardJobReader, ShardJobRow } from "../../data/shardJobPorts";
import { listD1JobRunRecords } from "../../services/jobRunRecordReads";
import type { JobRunRecord } from "../../services/jobRunRecords";
import { listJobOutcomes } from "../../services/jobOutcomes";
import { listScreeningActivity } from "../../services/screeningActivity";
import { listScheduledReports } from "../../services/scheduledReports";
import { runSummaryFromReport, type RunSummary } from "../../services/runSummaries";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { sagaAuditOwnerStub, type AuditOwnerStub } from "../../workflows/sagaJourneyGate";
import type { SqlStorage } from "../../orm";
import {
  buildWorkflowRunsPage,
  d1RecordLinkedToJobs,
  innerShardScanJobId,
  runFromJobRunRecord,
  runFromSagaChain,
  runFromScanRun,
  stagesFromEngineViews,
  summarizeWorkflowRuns,
  type UnifiedWorkflowRunRecord,
  type WorkflowRun,
  type WorkflowRunDocuments,
  type WorkflowRunJobRow,
  type WorkflowRunOutcomeRow,
  type WorkflowRunStage,
  type WorkflowRunStageTransition,
} from "../../services/workflowRuns";
import {
  scheduleRunsFromItems,
} from "../../services/workflowLifecycle";
import { mapSagaAuditToJobs, readSagaAuditRows } from "./sagaStatus";
import { getScheduledAgentDoor } from "../orchestrator/meshDoors";
import { resolveWorkflowRunsStageReadLimit } from "../../config/workflowRunsStageRead";
import {
  readStagesFromPipelineStores,
  type JobStageView,
  type JobStagesRead,
} from "../../services/jobPipelineEngine";
import { createJobPipelineStoresFromSql } from "../../data/createJobPipelinePorts";

export interface WorkflowRunsSql {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
}

export interface WorkflowRunsRouteContext {
  ensureTables: () => SqlStorage;
  /** The verified login (src/server.ts sets x-user-login from the session). */
  userLogin: string;
  env?: unknown;
  /** Saga read seams (issue #2780). Production builds them from env. */
  sagaAuditStub?: AuditOwnerStub;
  sagaProjectionReader?: Pick<ShardJobReader, "listJobsForChain">;
  sagaTenantId?: string;
  /**
   * Issue #3021 deliverable (b): agent-scheduler schedule rows.
   * Production builds this from env (orchestrator stub, mirroring
   * the saga audit read); tests inject a mock list. A failing read
   * is named in storeErrors and never hides the other runs.
   */
  scheduleReader?: () => Promise<unknown[]>;
  /**
   * Issue #3946 (Option B): the engine's D1 run-record reader.
   * Production builds this from env (listD1JobRunRecords); tests
   * inject a mock list. A failing read is named in storeErrors and
   * never hides the other runs.
   */
  jobRunRecordReader?: (limit: number) => Promise<JobRunRecord[]>;
  /**
   * Issue #4069 (Option B for options): the scanner's scan-run
   * reader (mas_opportunity_scans). Production builds this from the
   * DO store (createOptionsDiscoveryPorts, the same reader /api/runs
   * uses); tests inject a mock list. A failing read is named in
   * storeErrors and never hides the other runs.
   */
  scanRunReader?: (limit: number) => Promise<ScanRunSummary[]>;
  /**
   * Issue #4359 — the engine's stage read for this page's runs. One
   * batch call keyed by engine job id; each entry carries the views and
   * the run id the checkpoint describes. Production builds this from
   * the ScheduledAgent door (getPipelineRunStages); tests inject a map.
   * A failing read is named in storeErrors and never hides the runs.
   */
  jobStageReader?: (jobIds: string[]) => Promise<Map<string, JobStagesRead>>;
  /**
   * Issue #4420 — the inner per-symbol engine stages of this page's options
   * feed shards, keyed by the SHARD job id. Production reads the shard
   * host's own pipeline store (readInnerShardScanStages); tests inject a
   * map. A shard the reader omits renders no inner block; an entry with an
   * empty stage list renders the honest empty.
   */
  innerShardStageReader?: (
    refs: Array<{ shardJobId: string; engineJobId: string }>,
  ) => Promise<Map<string, JobStagesRead>>;
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

function clampLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read the job tree with payloads — the only read that needs them. */
export function readWorkflowRunJobs(sql: WorkflowRunsSql, sessionId: string, limit: number): WorkflowRunJobRow[] {
  // #2358 (#1976 step 4a): the SELECT serves through the async-job
  // read port (workflowRunRows in src/data/asyncJobPorts.ts); the
  // row projection below stays this route's domain logic.
  const rows = createAsyncJobPorts(sql as never).read.workflowRunRows(
    sessionId,
    Math.max(1, Math.min(limit, 500)),
  ) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    job_id: String(row.job_id ?? ""),
    capability: String(row.capability ?? ""),
    display_name: String(row.display_name ?? ""),
    status: String(row.status ?? "unknown"),
    payload_json: str(row.payload_json),
    result_json: str(row.result_json),
    error: str(row.error),
    created_at: String(row.created_at ?? ""),
    updated_at: str(row.updated_at),
    started_at: str(row.started_at),
    completed_at: str(row.completed_at),
    parent_job_id: str(row.parent_job_id),
    job_kind: str(row.job_kind),
    channel: str(row.channel),
    not_before: str(row.not_before),
    stage: str(row.stage),
    chain_id: str(row.chain_id),
    // Issue #3784: the stuck-alert claim stamp rides the row so
    // the runs view can derive the Stuck display (the SQL
    // projection already selects it).
    stuck_alerted_at: str(row.stuck_alerted_at),
    // Issue #3810: provenance stamped at submission rides the row
    // so the read model can evidence the run's own trigger and
    // schedule (the SQL projection already selects it).
    trigger: str(row.trigger),
    triggered_by: str(row.triggered_by),
    schedule_id: str(row.schedule_id),
    // Issue #3811: the execution telemetry rides the row so the
    // runs view can show last activity, heartbeat age, and the
    // coded error (the SQL projection already selects both).
    last_activity_at: str(row.last_activity_at),
    error_code: str(row.error_code),
  }));
}

/** Flatten the stage-kind activity rows this surface joins on. */
export function readWorkflowRunTransitions(sql: WorkflowRunsSql, userLogin: string, limit: number): WorkflowRunStageTransition[] {
  return listScreeningActivity(sql, userLogin, limit)
    .filter((entry) => entry.kind === "stage")
    .map((entry) => {
      const detail =
        entry.detail && typeof entry.detail === "object" ? (entry.detail as Record<string, unknown>) : {};
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        summary: entry.summary,
        chainId: str(detail.chainId),
        jobId: str(detail.jobId) ?? entry.refId,
        stage: str(detail.stage),
        status: String(detail.status ?? ""),
        reason: str(detail.reason),
      };
    });
}

/**
 * Build unified-record overlays from canonical strategy rows — the
 * SAME record Docs Run Details reads (mas_reports body.stages /
 * body.input / body.feed), keyed by runId. Pure: no I/O, so tests
 * can pin the overlay without a DO. Rows without a well-formed
 * stored stage trace are skipped, never fabricated — a legacy
 * strategy run keeps its outcome-only view.
 */
/**
 * Issue #2786 losslessness fix: the canonical body.stages parser,
 * shared by the options_strategy unified overlay and the Part 3
 * second-read report-only path. One parser for both — a canonical
 * body's stages mean the same thing wherever they surface. Entries
 * without a string stage and status are dropped, never invented;
 * the feed/analysis/generation/delivery detail synthesis is the
 * unified path's own wording, moved verbatim.
 */
export function canonicalBodyStages(body: unknown): UnifiedWorkflowRunRecord["stages"] {
  if (!body || typeof body !== "object") return [];
  const stages = (body as Record<string, unknown>).stages;
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) => {
      const o = s && typeof s === "object" ? (s as Record<string, unknown>) : null;
      if (!o || typeof o.stage !== "string" || typeof o.status !== "string") return null;
      const evidence =
        o.evidence && typeof o.evidence === "object" && !Array.isArray(o.evidence)
          ? (o.evidence as Record<string, unknown>)
          : {};
      const detail =
        o.stage === "feed"
          ? `Feed — ${String(evidence.connector ?? "unknown connector")}: ${String(evidence.contractsEvaluated ?? "unknown")} contracts evaluated, ${String(evidence.fetchErrorCount ?? 0)} fetch errors`
          : o.stage === "analysis"
            ? `Analysis — ${String(evidence.rankedCount ?? "unknown")} ranked, ${String(evidence.screenedOutCount ?? "unknown")} screened out`
            : o.stage === "generation"
              ? `Generation — PDF ${String(evidence.pdfStatus ?? "unknown")}, XLSX ${String(evidence.xlsxStatus ?? "unknown")}, CSV ${String(evidence.csvStatus ?? "unknown")}`
              : o.stage === "delivery"
                ? "Delivery — no delivery channel requested for this panel run"
                : null;
      return {
        stage: o.stage,
        status: o.status,
        durationMs: typeof o.durationMs === "number" ? o.durationMs : null,
        detail,
        reason: typeof o.reason === "string" ? o.reason : null,
        error: typeof o.error === "string" ? o.error : null,
        input: Array.isArray(o.inputIds) ? o.inputIds : undefined,
        output: Array.isArray(o.outputIds) ? o.outputIds : evidence,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}

export function unifiedRecordsFromCanonicalReports(
  hits: Array<{ id: string; runId: string; title: string; body: unknown }>,
): UnifiedWorkflowRunRecord[] {
  const records: UnifiedWorkflowRunRecord[] = [];
  for (const hit of hits) {
    let body: Record<string, any> = {};
    try {
      body = typeof hit.body === "string" ? JSON.parse(hit.body || "{}") : (hit.body as Record<string, any>);
    } catch {
      continue;
    }
    if (!body || typeof body !== "object" || body.jobType !== "options-strategy-panel") continue;
    const stages = canonicalBodyStages(body);
    if (stages.length === 0) continue;
    const input = body.input && typeof body.input === "object" ? body.input : {};
    const feed = body.feed && typeof body.feed === "object" ? (body.feed as Record<string, unknown>) : {};
    records.push({
      runId: hit.runId,
      asyncJobId: typeof body.asyncJobId === "string" ? body.asyncJobId : null,
      reportId: hit.id,
      title: hit.title,
      trigger: typeof body.trigger === "string" ? body.trigger : null,
      triggerDetail: typeof body.provenance?.submittedVia === "string" ? body.provenance.submittedVia : null,
      // Issue #3655: broker + data-provider provenance from the
      // canonical body's provenance object.
      brokerId: typeof body.provenance?.brokerId === "string" ? body.provenance.brokerId : null,
      dataProviderId: typeof body.provenance?.dataProviderId === "string" ? body.provenance.dataProviderId : null,
      // Issue #3655 (effective mode): the resolver source, from the
      // canonical provenance when present, else the top-level body
      // (the scheduled stock callback writes it there). Absent on
      // rows recorded before effective-mode provenance existed.
      modeSource:
        body.provenance?.modeSource === "pin" || body.provenance?.modeSource === "selection" || body.provenance?.modeSource === "inference"
          ? body.provenance.modeSource
          : body.modeSource === "pin" || body.modeSource === "selection" || body.modeSource === "inference"
            ? body.modeSource
            : null,
      stages,
      inputs: {
        kind: "options",
        origin: "options-strategy-screener",
        symbols: (input as Record<string, unknown>).symbols ?? null,
        thesis: (input as Record<string, unknown>).thesis ?? null,
        strategyMode: body.strategyMode ?? null,
        mode: body.mode ?? null,
      },
      outputs: {
        status: "completed",
        scanned: typeof feed.scanned === "number" ? feed.scanned : (typeof feed.contractsEvaluated === "number" ? feed.contractsEvaluated : null),
        matched: typeof body.withTrades === "number" ? body.withTrades : null,
        ranked: typeof body.withTrades === "number" ? body.withTrades : null,
        feed: feed,
      },
    });
  }
  return records;
}

/**
 * Issue #2786 Part 3: the Docs-tab family for a Runs row. This mirrors
 * src/client/docsAndReports.ts documentRunSource exactly — recorded
 * runSource wins, then kind, then store source — so a row the Docs
 * tab lists lands in the same family here, and a row Docs filters
 * out (research reports, IV collection) yields null here too. The
 * agreement test pins the two together over a (kind, source,
 * runSource) matrix; change one and the test names the other.
 */
export type DocsReportFamily = "stock" | "options" | "goal" | "strategy";

const DOCS_SOURCE_BY_KIND: Record<string, DocsReportFamily> = {
  screener: "stock",
  options_scanner: "options",
  goal: "goal",
  discovery: "strategy",
};

const DOCS_SOURCE_BY_STORE_SOURCE: Record<string, DocsReportFamily> = {
  screener: "stock",
  options_scanner: "options",
  options_screen: "options",
  options_research: "options",
  goal_screen: "goal",
  discovery: "strategy",
};

const DOCS_RECORDED_SOURCES: Record<string, DocsReportFamily> = {
  stock: "stock",
  options: "options",
  goal: "goal",
  strategy: "strategy",
  screener: "stock",
  options_scanner: "options",
  options_screen: "options",
  goal_screen: "goal",
  discovery: "strategy",
};

export function docsFamilyForRunSummary(
  summary: Pick<RunSummary, "kind" | "source" | "runSource">,
): DocsReportFamily | null {
  const recorded =
    typeof summary.runSource === "string" ? DOCS_RECORDED_SOURCES[summary.runSource] : undefined;
  if (recorded) return recorded;
  const byKind = DOCS_SOURCE_BY_KIND[summary.kind];
  if (byKind) return byKind;
  return DOCS_SOURCE_BY_STORE_SOURCE[summary.source] ?? null;
}

/**
 * Issue #2786 Part 3: a canonical mas_reports row's Docs columns.
 * Null when the row is not a Docs family (research reports, IV
 * collection) — those rows never appear in the Docs tab, so they
 * never attach here either. matchKeys are the run ids this row may
 * twin with: its own runId, plus the async job id its body records
 * (the unified-overlay twin case, where the outcome id differs from
 * the canonical runId). Pure: no I/O.
 */
export function reportDocumentsFromCanonicalHit(hit: {
  id: string;
  runId: string;
  title: string;
  source: string;
  summary: string;
  body: string;
  createdAt: string;
  bodyR2Key: string | null;
  fanoutOutcome: unknown;
}): { documents: WorkflowRunDocuments; matchKeys: string[]; stages: UnifiedWorkflowRunRecord["stages"] } | null {
  const summary = runSummaryFromReport(hit as never);
  const family = docsFamilyForRunSummary(summary);
  if (!family) return null;
  let body: Record<string, unknown> = {};
  try {
    body = typeof hit.body === "string" ? JSON.parse(hit.body || "{}") : {};
  } catch {
    body = {};
  }
  const asyncJobId =
    typeof body.asyncJobId === "string" && body.asyncJobId ? body.asyncJobId : null;
  return {
    documents: {
      reportId: hit.id,
      family,
      pdfUrl: summary.reportUrl,
      pdfStatus: summary.pdfStatus,
      pdfError: summary.pdfError,
      xlsxUrl: summary.xlsxUrl,
      xlsxStatus: summary.xlsxStatus ?? null,
      xlsxError: summary.xlsxError ?? null,
      csvUrl: summary.csvUrl,
      csvStatus: summary.csvStatus ?? null,
      csvError: summary.csvError ?? null,
    },
    matchKeys: asyncJobId ? [hit.runId, asyncJobId] : [hit.runId],
    stages: canonicalBodyStages(body),
  };
}

/**
 * Issue #2786 Part 3: the #2910 (G3) parent-absorption rule, mirrored
 * from mergeRunSummaries so Workflow Runs agrees with Docs on which
 * rows are top-level: a row absorbed by a parent canonical row
 * (childRunIds / childReportIds) is dropped, and a parent row is
 * never absorbed by its own linkage. Pure: no I/O.
 */
export function dropAbsorbedReportSummaries<
  T extends {
    id: string;
    runId: string;
    kind: string;
    childRunIds?: string[] | null;
    childReportIds?: string[] | null;
  },
>(rows: T[]): T[] {
  const absorbedRunIds = new Set<string>();
  const absorbedReportIds = new Set<string>();
  const parentKeys = new Set<string>();
  for (const row of rows) {
    if (row.childRunIds || row.childReportIds) {
      parentKeys.add(`${row.kind}:${row.id}`);
      for (const id of row.childRunIds ?? []) absorbedRunIds.add(id);
      for (const id of row.childReportIds ?? []) absorbedReportIds.add(id);
    }
  }
  return rows.filter(
    (row) =>
      parentKeys.has(`${row.kind}:${row.id}`) ||
      (!absorbedRunIds.has(row.runId) && !absorbedReportIds.has(row.id)),
  );
}

function outcomeRow(row: ReturnType<typeof listJobOutcomes>[number]): WorkflowRunOutcomeRow {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    scanned: num(row.scanned),
    matched: num(row.matched),
    codedError: row.codedError,
    reportUrl: row.reportUrl,
    pdfKey: row.pdfKey,
    xlsxKey: row.xlsxKey,
    csvKey: row.csvKey,
    deliveryStates: row.deliveryStates,
    origin: row.origin,
    createdAt: row.createdAt,
  };
}

export interface SagaChainRunsInput {
  auditRows: Array<Record<string, unknown>>;
  /** Per-chain saga projection rows (null when the D1 read did not answer). */
  projections: Map<string, ShardJobRow | null>;
  userLogin: string;
}

function sagaIdOfAuditRow(row: Record<string, unknown>, userLogin: string): string | null {
  const payload = row["payload"];
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return p["userLogin"] === userLogin && typeof p["sagaId"] === "string" && p["sagaId"] !== ""
    ? (p["sagaId"] as string)
    : null;
}

function stringField(payload: Record<string, unknown> | undefined, field: string): string | null {
  if (!payload) return null;
  const value = payload[field];
  return typeof value === "string" ? value : null;
}

/**
 * Build saga chain runs from the session user's own audit rows (issue
 * #2780). Chain discovery is owner-scoped by construction: only chains
 * whose audit rows carry the session login appear. A chain with no
 * mappable audit stages shows its projection row's submitted stage;
 * a chain with neither is skipped, never fabricated. Non-saga
 * projection rows are ignored. Pure: the handler does the I/O.
 */
export function buildSagaChainRuns(input: SagaChainRunsInput): WorkflowRun[] {
  const byChain = new Map<string, Array<Record<string, unknown>>>();
  for (const row of input.auditRows) {
    const sagaId = sagaIdOfAuditRow(row, input.userLogin);
    if (!sagaId) continue;
    const list = byChain.get(sagaId) ?? [];
    list.push(row);
    byChain.set(sagaId, list);
  }
  const runs: WorkflowRun[] = [];
  for (const [sagaId, rows] of byChain) {
    const jobs = mapSagaAuditToJobs(rows, sagaId);
    const projRow = input.projections.get(sagaId) ?? null;
    const projection =
      projRow && projRow.jobKey === "saga"
        ? {
            stage: projRow.stage,
            status: projRow.status,
            detail: projRow.detail,
            createdAtMs: projRow.createdAtMs,
            updatedAtMs: projRow.updatedAtMs,
          }
        : null;
    const startedPayload = rows.find((r) => r["type"] === "saga.started")?.["payload"] as
      | Record<string, unknown>
      | undefined;
    const endedPayload = rows.find((r) => r["type"] === "saga.ended")?.["payload"] as
      | Record<string, unknown>
      | undefined;
    // Issue #3810: the saga entry carries its own trigger (manual /
    // scheduled, validated at the entry) — pass it through so the
    // chain evidences its trigger instead of "unknown". Any other
    // value stays uncarried (the chain stays "unknown", never
    // guessed).
    const sagaTrigger = stringField(startedPayload, "trigger");
    const run = runFromSagaChain({
      sagaId,
      jobs,
      projection,
      triggeredBy: input.userLogin,
      ...(sagaTrigger === "manual" || sagaTrigger === "scheduled"
        ? {
            trigger: sagaTrigger,
            triggerDetail: `${sagaTrigger === "scheduled" ? "Scheduled" : "Manual"} — recorded by the saga entry`,
          }
        : {}),
      endedCode: stringField(endedPayload, "outcomeCode"),
      endedAtMs: jobs.find((j) => j.stage === "done")?.updatedAtMs ?? null,
      started: startedPayload
        ? {
            family: stringField(startedPayload, "family"),
            rail: stringField(startedPayload, "rail"),
            runRequestId: stringField(startedPayload, "runRequestId"),
          }
        : null,
    });
    if (run) runs.push(run);
  }
  return runs;
}

/** Production schedule reader: the orchestrator's schedule list over its stub (same stub as the saga audit read). */
export async function readScheduleItemsFromOrchestrator(env: unknown): Promise<unknown[]> {
  const stub = sagaAuditOwnerStub(env);
  const res = await stub.fetch(new Request("https://agent.internal/api/schedules", { method: "GET" }));
  if (!res.ok) {
    throw new Error(`Schedule list read failed: HTTP ${res.status}.`);
  }
  const body = (await res.json().catch(() => null)) as { schedules?: unknown } | null;
  return Array.isArray(body?.schedules) ? body.schedules : [];
}

/**
 * Issue #4359 — the page's engine stages in one call. The ScheduledAgent
 * answers from its own pipeline store through the same projection its
 * job-status surface serves (getPipelineRunStages → getJobStages), so the
 * runs page and the job surfaces cannot disagree about a stage. A door
 * that cannot answer throws; the caller names the failure in storeErrors.
 */
export async function readPipelineRunStagesFromScheduledAgent(
  env: unknown,
  jobIds: string[],
): Promise<Map<string, JobStagesRead>> {
  if (jobIds.length === 0) return new Map();
  const door = getScheduledAgentDoor(env as never);
  const body = await door.getPipelineRunStages(jobIds);
  return new Map(Object.entries(body ?? {}));
}

/**
 * Issue #4420 — the inner engine stages of options feed shards, read from
 * the pipeline store the shard executor wrote them to (this host's own
 * SQLite: a shard runs on the Orchestrator, and so does this read). One
 * projection — readStagesFromPipelineStores — shares the job-status
 * surface's stage rule; a shard with no stored definition answered an
 * honest empty rather than being dropped from the page.
 */
export async function readInnerShardScanStages(
  sql: SqlStorage,
  refs: Array<{ shardJobId: string; engineJobId: string }>,
): Promise<Map<string, JobStagesRead>> {
  const out = new Map<string, JobStagesRead>();
  if (refs.length === 0) return out;
  const stores = createJobPipelineStoresFromSql(sql);
  for (const ref of refs) {
    try {
      const read = await readStagesFromPipelineStores(stores, ref.engineJobId);
      out.set(ref.shardJobId, read ?? { stages: [], checkpointRunId: null });
    } catch (err) {
      // A shard whose read fails keeps the page honest: the caller names
      // the failure once (storeErrors) and the row claims no inner stages.
      throw new Error(
        `Inner shard stage read failed for ${ref.engineJobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

export async function handleWorkflowRunsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: WorkflowRunsRouteContext,
): Promise<Response | null> {
  const isList = path === "/workflow-runs" || path === "/api/workflow-runs";
  if (!isList) return null;
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const limit = clampLimit(url.searchParams.get("limit"));
  // #2786 Part 2 (scope e): paging + server-side filters. Windows
  // scale with offset so a deep page still reads enough rows to fill
  // itself; transitions stay windowed at 400 (deep pages may show
  // fewer transition enrichments — stages still come from job rows).
  const offsetRaw = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.min(offsetRaw, 10000)) : 0;
  const includeTraces = url.searchParams.get("traces") === "all";
  const triggerParam = url.searchParams.get("trigger");
  const statusParam = url.searchParams.get("status");
  const searchParam = url.searchParams.get("search");
  // Issue #3021: lifecycle + schedule-type filters, server-side like
  // trigger/status — the page builder filters BEFORE slicing.
  const lifecycleParam = url.searchParams.get("lifecycle");
  const scheduleParam = url.searchParams.get("schedule");
  // Issue #2786 Part 3: the Reports filter is server-side. The page
  // builder filters BEFORE slicing, so report runs past the fetched
  // window still show (no intermediate widening needed — the
  // canonical read is independent of the job windows).
  const reportsOnly = url.searchParams.get("reports") === "only";
  // Jobs are grouped into runs, so read more rows than runs requested —
  // a 5-stage chain must not displace five single-job runs.
  const jobLimit = Math.min(MAX_LIMIT * 10, Math.max(120, (limit + offset) * 8));
  const storeErrors: Record<string, string> = {};
  // Issue #4116 — the D1-only read mode: when the tenant's readMode
  // is "d1-only", jobs / report docs / unified records read the
  // projected ledgers from D1 alone (no DO read in the path);
  // anything else keeps the Option B merged view. The resolved
  // mode rides the response so it is visible, never silent.
  const { resolveLedgerReadMode, listProjectedReportSummaries, listProjectedWorkflowRunJobs } =
    await import("../../services/runLedgerReads");
  const ledgerReadMode =
    ctx.env !== undefined ? await resolveLedgerReadMode(ctx.env as never) : "merged";
  const tenantId = ctx.env !== undefined ? resolveIaaaTenant(ctx.env as never) : "primary";
  let linkedJobRunIds = new Set<string>();

  let jobs: WorkflowRunJobRow[] = [];
  let outcomes: WorkflowRunOutcomeRow[] = [];
  let transitions: WorkflowRunStageTransition[] = [];
  let unifiedRecords: UnifiedWorkflowRunRecord[] = [];

  try {
    if (ledgerReadMode === "d1-only") {
      if (ctx.env === undefined) {
        throw new Error("run-ledger projection unavailable: no environment available to read the D1 ledgers");
      }
      jobs = await listProjectedWorkflowRunJobs(ctx.env as never, { tenantId, sessionId, limit: jobLimit });
    } else {
      const sql = ctx.ensureTables();
      jobs = readWorkflowRunJobs(sql, sessionId, jobLimit);
    }
  } catch (err) {
    storeErrors.jobs = err instanceof Error ? err.message : String(err);
  }
  if (ledgerReadMode === "d1-only") {
    // Issue #4116 — job outcomes are not projected: the list is
    // empty in D1-only mode, named here, never silent.
    storeErrors.outcomes = "not projected: job outcomes are not part of the #4116 D1 projection";
  } else {
    try {
      outcomes = listJobOutcomes(ctx.ensureTables(), Math.min(MAX_LIMIT * 2, Math.max(50, (limit + offset) * 2))).map(outcomeRow);
    } catch (err) {
      storeErrors.outcomes = err instanceof Error ? err.message : String(err);
    }
  }
  if (ledgerReadMode === "d1-only") {
    // Issue #4116 — stage transitions are not projected: the list
    // is empty in D1-only mode, named here, never silent.
    storeErrors.stages = "not projected: stage transitions are not part of the #4116 D1 projection";
  } else if (ctx.userLogin) {
    try {
      transitions = readWorkflowRunTransitions(ctx.ensureTables(), ctx.userLogin, 400);
    } catch (err) {
      storeErrors.stages = err instanceof Error ? err.message : String(err);
    }
  } else {
    storeErrors.stages = "skipped: no authenticated user identity available to scope the stage records";
  }
  // Unified strategy records: the same canonical bodies Docs Run
  // Details reads, overlaid onto their outcome twins by runId.
  // Best-effort and windowed (newest 100 strategy rows) — a
  // canonical row outside that window simply keeps its
  // outcome-only view, and a read failure never hides the others.
  if (ctx.userLogin) {
    try {
      if (ledgerReadMode === "d1-only") {
        // Issue #4116 — the projected reports (newest 100 rows,
        // strategy rows among them) feed the same overlay; bodies
        // are R2-resolved, read-only, so pointer rows overlay
        // fully here.
        if (ctx.env === undefined) {
          throw new Error("run-ledger projection unavailable: no environment available to read the D1 ledgers");
        }
        const projected = await listProjectedReportSummaries(ctx.env as never, {
          tenantId,
          userLogin: ctx.userLogin,
          limit: 100,
        });
        const strategy = projected.hits.filter((h) => h.source === "options_strategy");
        unifiedRecords = unifiedRecordsFromCanonicalReports(strategy.map((h) => ({ id: h.id, runId: h.runId, title: h.title, body: h.body })));
      } else {
        const hits = listScheduledReports(ctx.ensureTables(), { userLogin: ctx.userLogin, sourceFilter: "options_strategy", limit: 100 });
        unifiedRecords = unifiedRecordsFromCanonicalReports(hits.map((h) => ({ id: h.id, runId: h.runId, title: h.title, body: h.body })));
      }
    } catch (err) {
      storeErrors.canonical = err instanceof Error ? err.message : String(err);
    }
  }

  // Issue #2786 Part 3: Docs columns for every report family. A second
  // canonical read (newest 100 rows, all sources — the same window
  // Docs itself shows) feeds the documents attachment + report-only
  // runs. The options_strategy unified fetch above stays exactly as
  // it was, so strategy stage overlays cannot regress. Scoping is
  // the same owner filter as the unified fetch: without a userLogin
  // no canonical rows are read at all, so no other user's rows can
  // attach or appear here.
  let reportDocs: Array<{
    documents: WorkflowRunDocuments;
    matchKeys: string[];
    stages: UnifiedWorkflowRunRecord["stages"];
    summary: RunSummary;
  }> = [];
  if (ctx.userLogin) {
    try {
      if (ledgerReadMode === "d1-only") {
        // Issue #4116 — the projected reports feed the same Docs
        // attachment + report-only runs, from D1 alone.
        if (ctx.env === undefined) {
          throw new Error("run-ledger projection unavailable: no environment available to read the D1 ledgers");
        }
        const projected = await listProjectedReportSummaries(ctx.env as never, {
          tenantId,
          userLogin: ctx.userLogin,
          limit: 100,
        });
        linkedJobRunIds = projected.linkedJobRunIds;
        const kept = new Set(dropAbsorbedReportSummaries(projected.summaries));
        projected.hits.forEach((h, i) => {
          if (!kept.has(projected.summaries[i])) return;
          const entry = reportDocumentsFromCanonicalHit(h);
          if (!entry) return;
          reportDocs.push({ ...entry, summary: projected.summaries[i] });
        });
      } else {
        const hits = listScheduledReports(ctx.ensureTables(), { userLogin: ctx.userLogin, limit: 100 });
        const summaries = hits.map((h) => runSummaryFromReport(h));
        const kept = new Set(dropAbsorbedReportSummaries(summaries));
        hits.forEach((h, i) => {
          if (!kept.has(summaries[i])) return;
          const entry = reportDocumentsFromCanonicalHit(h);
          if (!entry) return;
          reportDocs.push({ ...entry, summary: summaries[i] });
        });
      }
    } catch (err) {
      storeErrors.canonicalDocs = err instanceof Error ? err.message : String(err);
    }
  }

  // Saga chains (#2780): projection chains with jobKey "saga" join the
  // list. Discovery is owner-scoped by construction — chains are found
  // in the session user's own audit rows. The D1 projection row carries
  // no userLogin, so a pre-audit chain cannot be attributed to a user
  // and is not listed here; the per-sagaId status fallback covers that
  // window for the owner who knows the id. A failed saga read never
  // hides the other runs: it is named in storeErrors.
  let sagaRuns: WorkflowRun[] = [];
  if (ctx.env !== undefined && ctx.userLogin) {
    try {
      const stub = ctx.sagaAuditStub ?? sagaAuditOwnerStub(ctx.env);
      const auditRows = await readSagaAuditRows(stub);
      const tenantId = ctx.sagaTenantId ?? resolveIaaaTenant(ctx.env as never);
      const reader = ctx.sagaProjectionReader ?? createShardJobAdapter(ctx.env as never);
      const ownSagaIds = [
        ...new Set(
          auditRows
            .map((row) => sagaIdOfAuditRow(row, ctx.userLogin))
            .filter((id): id is string => id !== null),
        ),
      ];
      const projections = new Map<string, ShardJobRow | null>();
      for (const sagaId of ownSagaIds) {
        if (!reader) {
          projections.set(sagaId, null);
          continue;
        }
        try {
          const rows = await reader.listJobsForChain(tenantId, sagaId);
          projections.set(sagaId, rows.find((r) => r.jobKey === "saga") ?? null);
        } catch (err) {
          storeErrors.sagaProjection = err instanceof Error ? err.message : String(err);
          projections.set(sagaId, null);
        }
      }
      sagaRuns = buildSagaChainRuns({ auditRows, projections, userLogin: ctx.userLogin });
    } catch (err) {
      storeErrors.saga = err instanceof Error ? err.message : String(err);
    }
  }

  // Issue #3021 deliverable (b): agent-scheduler schedules join the
  // list as scheduled rows, owner-scoped and fail-soft exactly like
  // saga chains. A failed schedule read is named in storeErrors and
  // never hides the other runs.
  let scheduleRuns: WorkflowRun[] = [];
  if (ctx.env !== undefined && ctx.userLogin) {
    try {
      const reader = ctx.scheduleReader ?? (() => readScheduleItemsFromOrchestrator(ctx.env));
      const items = await reader();
      scheduleRuns = scheduleRunsFromItems(items, ctx.userLogin);
    } catch (err) {
      storeErrors.schedules = err instanceof Error ? err.message : String(err);
    }
  }

  // Issue #3946 (Option B): the engine's D1 run records join the
  // list as their own runs — deployment-level, never attributed to
  // the signed-in user (the D1 table carries no login column), and
  // never owner-scoped, so this read needs env but no userLogin. A
  // failed D1 read is named in storeErrors and never hides the
  // other runs, exactly like the saga and schedule reads above.
  let jobRunRecordRuns: WorkflowRun[] = [];
  // Issue #4359 — the D1 records that stay standalone (no bridge row in
  // this window) keep their identity for the stage read below.
  let keptJobRunRecords: JobRunRecord[] = [];
  if (ctx.env !== undefined) {
    try {
      const reader =
        ctx.jobRunRecordReader ??
        ((readLimit: number) => listD1JobRunRecords(ctx.env, readLimit));
      const records = await reader(
        Math.min(MAX_LIMIT * 2, Math.max(50, (limit + offset) * 2)),
      );
      // Issue #4116 — in D1-only mode a job-run-record twin named
      // by a projected report's link is absorbed into the canonical
      // row (one run, one row); in merged mode both rows appear.
      let keptRecords = records;
      if (ledgerReadMode === "d1-only" && linkedJobRunIds.size > 0) {
        const { d1JobRunRecordId } = await import("../../services/jobRunRecordReads");
        keptRecords = records.filter((r) => !linkedJobRunIds.has(d1JobRunRecordId(r)));
      }
      // Issue #4357 — the join key: an engine D1 record whose
      // asyncJobId names a bridge row present in this read is
      // absorbed into that run (one run, one row), in BOTH modes —
      // the grouped run already represents it. A record whose
      // bridge row is absent from the window still renders
      // standalone; unlinked records (asyncJobId null) are
      // untouched, so pre-slice rows render as today.
      keptRecords = keptRecords.filter((r) => !d1RecordLinkedToJobs(r, jobs));
      keptJobRunRecords = keptRecords;
    } catch (err) {
      storeErrors.jobRunRecords = err instanceof Error ? err.message : String(err);
    }
  } else {
    storeErrors.jobRunRecords =
      "skipped: no environment available to read the D1 job run records";
  }

  // Issue #4359 — the page's engine stages, one batch call. The ids are
  // every run row's job id (for a chat screen the bridge row IS the
  // engine job id, #4357) plus each standalone D1 record's job id. The
  // read is fail-soft and named: a stage read that cannot answer never
  // hides a run, and a run with no checkpoint renders an honest empty
  // stage list.
  const stageReads = new Map<string, JobStagesRead>();
  const stageLimit = resolveWorkflowRunsStageReadLimit(
    ctx.env as { WORKFLOW_RUNS_STAGE_READ_LIMIT?: string } | undefined,
  );
  if (ctx.env !== undefined) {
    const stageIds = [
      ...new Set([...jobs.map((job) => job.job_id), ...keptJobRunRecords.map((r) => r.jobId)]),
    ].slice(0, stageLimit);
    if (stageIds.length > 0) {
      try {
        const reader =
          ctx.jobStageReader ??
          ((ids: string[]) => readPipelineRunStagesFromScheduledAgent(ctx.env, ids));
        for (const [jobId, read] of await reader(stageIds)) stageReads.set(jobId, read);
      } catch (err) {
        storeErrors.jobStages = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const engineStages = new Map<string, JobStageView[]>();
  for (const [jobId, read] of stageReads) {
    if (read.stages.length > 0) engineStages.set(jobId, read.stages);
  }
  // Issue #4420 — the shard detail's inner engine stages. An options feed
  // shard dispatches its per-symbol scan under an identity derived from its
  // own payload, and that checkpoint is written into THIS host's SQLite (the
  // shard executor runs here), so the read is store-direct and bounded by
  // the same stage-read knob. Never a second stage read: the rows are the
  // one stagesFromEngineViews projection. A shard with no checkpoint gets an
  // empty list (rendered as an honest empty), and a failing read is named in
  // storeErrors instead of inventing stages or hiding runs.
  const innerShardStages = new Map<string, { jobId: string; stages: WorkflowRunStage[] }>();
  const innerRefs = new Map<string, string>();
  for (const job of jobs) {
    const engineJobId = innerShardScanJobId(job);
    if (engineJobId) innerRefs.set(job.job_id, engineJobId);
    if (innerRefs.size >= stageLimit) break;
  }
  if (innerRefs.size > 0) {
    const refs = [...innerRefs].map(([shardJobId, engineJobId]) => ({ shardJobId, engineJobId }));
    try {
      const reader =
        ctx.innerShardStageReader ??
        ((items: Array<{ shardJobId: string; engineJobId: string }>) =>
          readInnerShardScanStages(ctx.ensureTables(), items));
      for (const [shardJobId, read] of await reader(refs)) {
        const engineJobId = innerRefs.get(shardJobId);
        if (!engineJobId) continue;
        innerShardStages.set(shardJobId, {
          jobId: engineJobId,
          stages: read.stages.length > 0 ? stagesFromEngineViews(read.stages) : [],
        });
      }
    } catch (err) {
      storeErrors.innerShardStages = err instanceof Error ? err.message : String(err);
    }
  }
  // Identity (issue #4359): a checkpoint is projected onto a standalone
  // record only when the checkpoint's run id IS the record's engine run
  // id (workflowId). Another run's stages are never shown under this
  // record, and a record with no engine run id keeps an empty list.
  const stagesForRecord = (record: JobRunRecord): JobStageView[] | null => {
    const read = stageReads.get(record.jobId);
    if (!read || read.stages.length === 0) return null;
    if (!record.workflowId || read.checkpointRunId !== record.workflowId) return null;
    return read.stages;
  };
  jobRunRecordRuns = keptJobRunRecords.map((record) =>
    runFromJobRunRecord(record, stagesForRecord(record)),
  );

  // Issue #4069 (Option B for options): the scanner's scan-run rows
  // join the list as their own runs — scanner legs write no canonical
  // mas_reports row, so without this the scan ledger is invisible
  // here (ReportsPanel and detail already merge it). Owner-scoped
  // like the canonical reads above: without a userLogin the store
  // is skipped and named, never read unscoped. A failed scan read
  // is named in storeErrors and never hides the other runs, exactly
  // like the D1 read above. A scan row a canonical row already
  // claims (its body scanRunId — the same exact join
  // mergeRunSummaries uses) is dropped, so one run never shows
  // twice if a leg ever writes both.
  let scanRuns: WorkflowRun[] = [];
  if (ctx.userLogin) {
    try {
      const reader =
        ctx.scanRunReader ??
        (async (readLimit: number) => {
          const { createOptionsDiscoveryPorts } = await import("../../data/createOptionsDiscoveryPorts");
          return createOptionsDiscoveryPorts({ sql: ctx.ensureTables() }).scanRuns.list({
            limit: readLimit,
            userLogin: ctx.userLogin,
          });
        });
      const claimedScanIds = new Set(
        reportDocs.map((entry) => entry.summary.scanRunId).filter((id): id is string => id !== null),
      );
      const scans = await reader(
        Math.min(MAX_LIMIT * 2, Math.max(50, (limit + offset) * 2)),
      );
      scanRuns = scans
        .filter((scan) => !claimedScanIds.has(scan.id))
        .map(runFromScanRun);
    } catch (err) {
      storeErrors.scanRuns = err instanceof Error ? err.message : String(err);
    }
  } else {
    storeErrors.scanRuns =
      "skipped: no authenticated user identity available to scope the scan runs";
  }

  // Saga chains (#2780) join BEFORE filter/slice (#2786 Part 2), and
  // Part 3 Docs attach + report-only minting happen inside the page
  // builder BEFORE filter/slice, so a saga run, a report run, a
  // schedule run, and a job-backed run all obey the same filters
  // and paging.
  const page = buildWorkflowRunsPage({
    jobs,
    outcomes,
    transitions,
    unifiedRecords,
    limit,
    offset,
    includeTraces,
    trigger: triggerParam ?? undefined,
    status: statusParam ?? undefined,
    search: searchParam ?? undefined,
    lifecycle: lifecycleParam ?? undefined,
    schedule: scheduleParam ?? undefined,
    nowMs: Date.now(),
    reportsOnly,
    reportDocs,
    extraRuns: [...sagaRuns, ...scheduleRuns, ...jobRunRecordRuns, ...scanRuns],
    // Issue #4359 — the engine's own stages for the grouped runs. A
    // group with no entry keeps the job-row projection.
    engineStages,
    // Issue #4420 — the inner shard stages the job-row projection carries.
    innerShardStages,
  });
  return Response.json({
    count: page.runs.length,
    runs: page.runs,
    summary: summarizeWorkflowRuns(page.runs),
    hiddenTraceCount: page.hiddenTraceCount,
    totalMatched: page.totalMatched,
    offset,
    limit,
    ledgerReadMode,
    ...(Object.keys(storeErrors).length > 0 ? { storeErrors } : {}),
    generatedAt: new Date().toISOString(),
  });
}
