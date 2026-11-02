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
import { createShardJobAdapter } from "../../data/createShardJobPorts";
import type { ShardJobReader, ShardJobRow } from "../../data/shardJobPorts";
import { listJobOutcomes } from "../../services/jobOutcomes";
import { listScreeningActivity } from "../../services/screeningActivity";
import { listScheduledReports } from "../../services/scheduledReports";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { sagaAuditOwnerStub, type AuditOwnerStub } from "../../workflows/sagaJourneyGate";
import type { SqlStorage } from "../../orm";
import {
  buildWorkflowRuns,
  compareWorkflowRunsNewestFirst,
  runFromSagaChain,
  summarizeWorkflowRuns,
  type UnifiedWorkflowRunRecord,
  type WorkflowRun,
  type WorkflowRunJobRow,
  type WorkflowRunOutcomeRow,
  type WorkflowRunStageTransition,
} from "../../services/workflowRuns";
import { mapSagaAuditToJobs, readSagaAuditRows } from "./sagaStatus";

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
    if (!Array.isArray(body.stages) || body.stages.length === 0) continue;
    const stages = (body.stages as unknown[])
      .map((s) => {
        const o = s && typeof s === "object" ? (s as Record<string, unknown>) : null;
        if (!o || typeof o.stage !== "string" || typeof o.status !== "string") return null;
        const evidence = o.evidence && typeof o.evidence === "object" && !Array.isArray(o.evidence)
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
    const run = runFromSagaChain({
      sagaId,
      jobs,
      projection,
      triggeredBy: input.userLogin,
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
  // Jobs are grouped into runs, so read more rows than runs requested —
  // a 5-stage chain must not displace five single-job runs.
  const jobLimit = Math.min(MAX_LIMIT * 10, Math.max(120, limit * 8));
  const storeErrors: Record<string, string> = {};

  let jobs: WorkflowRunJobRow[] = [];
  let outcomes: WorkflowRunOutcomeRow[] = [];
  let transitions: WorkflowRunStageTransition[] = [];
  let unifiedRecords: UnifiedWorkflowRunRecord[] = [];

  try {
    const sql = ctx.ensureTables();
    jobs = readWorkflowRunJobs(sql, sessionId, jobLimit);
  } catch (err) {
    storeErrors.jobs = err instanceof Error ? err.message : String(err);
  }
  try {
    outcomes = listJobOutcomes(ctx.ensureTables(), Math.min(MAX_LIMIT * 2, Math.max(50, limit * 2))).map(outcomeRow);
  } catch (err) {
    storeErrors.outcomes = err instanceof Error ? err.message : String(err);
  }
  if (ctx.userLogin) {
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
      const hits = listScheduledReports(ctx.ensureTables(), { userLogin: ctx.userLogin, sourceFilter: "options_strategy", limit: 100 });
      unifiedRecords = unifiedRecordsFromCanonicalReports(hits.map((h) => ({ id: h.id, runId: h.runId, title: h.title, body: h.body })));
    } catch (err) {
      storeErrors.canonical = err instanceof Error ? err.message : String(err);
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

  const runs = buildWorkflowRuns({ jobs, outcomes, transitions, unifiedRecords, limit });
  runs.push(...sagaRuns);
  runs.sort(compareWorkflowRunsNewestFirst);
  const limited = runs.slice(0, limit);
  return Response.json({
    count: limited.length,
    runs: limited,
    summary: summarizeWorkflowRuns(limited),
    ...(Object.keys(storeErrors).length > 0 ? { storeErrors } : {}),
    generatedAt: new Date().toISOString(),
  });
}
