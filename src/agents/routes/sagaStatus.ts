/**
 * Issue #2041 S4 — saga status route (gap G-JOB-SURFACE).
 *
 * GET /api/saga/:sagaId/status returns the panel's {jobs} shape
 * (stage rows derived from saga audit rows + live instance
 * status/output), so the EXISTING statusUrl pollers consume it
 * unchanged — no new panel, no new polling system. The entry
 * route also writes one AgentDB projection row (chainId =
 * sagaId, jobKey "saga") so the saga is discoverable via
 * /api/jobs/history?chainId=; the projection row is
 * visibility-only — the audit row is the durable record, and
 * live stages come from this route, not from the projection
 * (the flow cannot write D1 from steps, same limitation as
 * audit).
 *
 * Owner-scoped: a saga with no audit rows for the session user
 * is 404 (no cross-user leak — the filter is applied here even
 * though the audit read is agent-scoped), unless its
 * tenant-scoped projection row exists (issue #2777 fallback for
 * the pre-audit window — same tenant scoping as the jobs/history
 * projection read, never a cross-tenant answer). The status route is
 * NOT flag-gated: a read path for one's own sagas must survive
 * a flag flip. Live instance status is best-effort: an unbound
 * binding or a missing instance degrades to audit-derived
 * state, never a 503 — the audit rows answer on their own.
 */
import type { Env } from "../../types";
import type { ShardJobRow } from "../../data/shardJobPorts";
import type { ShardJobReader } from "../../data/shardJobPorts";
import { createShardJobAdapter } from "../../data/createShardJobPorts";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import {
  sagaAuditOwnerStub,
  type AuditOwnerStub,
} from "../../workflows/sagaJourneyGate";
import { sagaWorkflowInstanceId } from "../../workflows/sagaJourneyGate";

/** Minimal structural surface of the SAGA_WORKFLOW binding.
 * The runtime snapshot also carries an optional error (the
 * cfWorkflowAdapter WorkflowBindingLike shape): issue #2810
 * surfaces it as the errored instance's reason. */
export interface SagaStatusBinding {
  get: (id: string) => Promise<{
    status: () => Promise<{
      status: string;
      output?: unknown;
      error?: { message: string } | string;
    }>;
  }>;
}

/** Minimal structural surface of the shard-job store (recordJob only). */
export interface SagaStatusStore {
  recordJob: (row: ShardJobRow) => Promise<void>;
}

export interface SagaJobRow {
  stage: string;
  status: string;
  detail: string;
  updatedAtMs?: number;
  resultJson?: Record<string, unknown>;
}

interface AuditRowLike {
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const STAGE_FOR_TYPE: Record<string, string> = {
  "saga.started": "saga",
  "saga.payment_started": "payment",
  "saga.payment_not_completed": "payment",
  "saga.screen_start_failed_credit_issued": "screen",
  "saga.screen_completed": "screen",
  "saga.screen_failed": "screen",
  "saga.journey_prompted": "journey",
  "saga.journey_decided": "journey",
  "saga.journey_decision_refused": "journey",
  "saga.journey_expired": "journey",
  "saga.journey_prompts_withdrawn": "journey",
  "saga.trade_proposed": "trade",
  "saga.trade_settled": "trade",
  "saga.trade_decided": "trade",
  "saga.trade_leg_failed": "trade",
  "saga.proposal_failed": "trade",
  "saga.failed": "failed",
  "saga.outcome_notice": "notice",
  "saga.ended": "done",
};

function detailFor(row: AuditRowLike): string {
  const p = row.payload;
  switch (row.type) {
    case "saga.ended":
      return typeof p["outcomeCode"] === "string"
        ? (p["outcomeCode"] as string)
        : "saga ended";
    case "saga.journey_decided":
      return `Journey ${String(p["decision"] ?? "?")} via ${String(p["decidingSurface"] ?? "?")}`;
    case "saga.trade_proposed":
      return `Trade proposed (order ${String(p["orderId"] ?? "?")})`;
    case "saga.failed": {
      // Issue #2810: the terminal failure row names its step +
      // reason, so the panel and Workflow Runs stages show both.
      const reason = typeof p["reason"] === "string" ? (p["reason"] as string) : "";
      const leg = typeof p["leg"] === "string" ? (p["leg"] as string) : "";
      if (reason && leg) return `${leg} leg failed: ${reason}`;
      return reason || "saga failed";
    }
    case "saga.outcome_notice": {
      const notice = p["notice"];
      const slack =
        notice && typeof notice === "object"
          ? String((notice as Record<string, unknown>)["slack"] ?? "?")
          : "?";
      return `Outcome notice (Slack: ${slack})`;
    }
    default:
      return row.type;
  }
}

function statusFor(row: AuditRowLike): string {
  switch (row.type) {
    case "saga.started":
    case "saga.payment_started":
    case "saga.journey_prompted":
    case "saga.journey_decision_refused":
    case "saga.trade_proposed":
      return "submitted";
    case "saga.screen_completed":
    case "saga.journey_prompts_withdrawn":
    case "saga.trade_settled":
    case "saga.trade_decided":
    case "saga.outcome_notice":
      return "completed";
    case "saga.ended": {
      const code =
        typeof row.payload["outcomeCode"] === "string"
          ? (row.payload["outcomeCode"] as string)
          : "";
      return code.startsWith("SUCCESS_") ? "completed" : "failed";
    }
    default:
      return "failed";
  }
}

/**
 * Map saga audit rows (already filtered to one saga) to panel
 * {jobs} stage rows, in audit order. Rows for other sagas are
 * ignored when sagaId is given.
 */
export function mapSagaAuditToJobs(
  rows: Array<Record<string, unknown>>,
  sagaId?: string,
): SagaJobRow[] {
  const jobs: SagaJobRow[] = [];
  for (const raw of rows) {
    const type = typeof raw["type"] === "string" ? (raw["type"] as string) : "";
    const payload =
      raw["payload"] && typeof raw["payload"] === "object"
        ? (raw["payload"] as Record<string, unknown>)
        : {};
    if (sagaId !== undefined && payload["sagaId"] !== sagaId) continue;
    const stage = STAGE_FOR_TYPE[type];
    if (!stage) continue;
    const row: AuditRowLike = {
      type,
      payload,
      created_at:
        typeof raw["created_at"] === "string" ? (raw["created_at"] as string) : "",
    };
    const updatedAtMs = row.created_at
      ? Date.parse(row.created_at)
      : Number.NaN;
    jobs.push({
      stage,
      status: statusFor(row),
      detail: detailFor(row),
      ...(Number.isFinite(updatedAtMs) ? { updatedAtMs } : {}),
      resultJson: payload,
    });
  }
  return jobs;
}

/**
 * Write the saga's visibility-only projection row: chainId =
 * sagaId so /api/jobs/history?chainId= finds it. The row is an
 * existence record (submitted / payment stage), not a live
 * mirror — live stages come from the status route.
 */
export async function recordSagaProjectionRow(
  store: SagaStatusStore,
  input: {
    sagaId: string;
    runRequestId: string;
    tenantId: string;
    statusUrl: string;
    /**
     * Issue #2989: the seam-started saga instance id (the
     * Cloudflare workflow id). Carried on the row so the
     * just-created saga stays addressable even before its
     * first audit row lands.
     */
    workflowRunId?: string;
  },
): Promise<void> {
  const nowMs = Date.now();
  await store.recordJob({
    tenantId: input.tenantId,
    workspaceId: input.tenantId,
    chainId: input.sagaId,
    jobKey: "saga",
    version: 1,
    status: "submitted",
    stage: "payment",
    capabilityId: "saga",
    detail: "Saga submitted; payment leg starting.",
    resultJson: JSON.stringify({
      sagaId: input.sagaId,
      runRequestId: input.runRequestId,
      statusUrl: input.statusUrl,
    }),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    provenanceWriter: "saga-entry-route",
    provenanceSourceDo: "saga",
    provenanceSourceVersion: "1",
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
  });
}

export interface SagaStatusOverrides {
  auditStub?: AuditOwnerStub;
  sagaBinding?: SagaStatusBinding;
  /** Test seam: session tenant for the projection fallback. Absent → resolveIaaaTenant(env). */
  tenantId?: string;
  /** Test seam: projection reader. Absent → createShardJobAdapter(env) (null when unbound). */
  projectionReader?: Pick<ShardJobReader, "listJobsForChain">;
}

/**
 * Issue #2777 — projection fallback. When no audit rows match,
 * the saga may simply be too young for its first audit row: the
 * entry route wrote a projection row synchronously at start.
 * Answer from that row (its submitted stage) instead of 404ing
 * the panel's first polls — tenant-scoped exactly as
 * /api/jobs/history reads it (listJobsForChain filters tenantId
 * AND chainId at the SQL layer), and only for the saga's own
 * projection row (jobKey "saga"). Returns null when there is no
 * such row, no reader, or the read fails: the caller then
 * answers the old 404. A fallback row never overrides audit
 * stages — this runs only when zero audit rows matched.
 */
async function readSagaProjectionFallback(
  env: Env,
  sagaId: string,
  overrides?: SagaStatusOverrides,
): Promise<SagaJobRow | null> {
  const reader =
    overrides?.projectionReader ?? createShardJobAdapter(env);
  if (!reader) return null;
  const tenantId = overrides?.tenantId ?? resolveIaaaTenant(env);
  let rows: ShardJobRow[];
  try {
    rows = await reader.listJobsForChain(tenantId, sagaId);
  } catch {
    // Best-effort visibility: a failed fallback degrades to the
    // old 404, never a 503 — the audit read already answered.
    return null;
  }
  const row = rows.find((r) => r.jobKey === "saga");
  if (!row) return null;
  return {
    stage: row.stage,
    status: row.status,
    detail: row.detail,
    ...(row.updatedAtMs ? { updatedAtMs: row.updatedAtMs } : {}),
  };
}

/** Read all saga audit rows through the ORCHESTRATOR_AGENT stub (agent-scoped, one read). */
export async function readSagaAuditRows(
  stub: AuditOwnerStub,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL("/api/audit", "https://agent.internal");
  url.searchParams.set("agent", "saga");
  url.searchParams.set("limit", "1000");
  const res = await stub.fetch(new Request(url, { method: "GET" }));
  if (!res.ok) {
    throw new Error(`Saga status audit read failed: HTTP ${res.status}.`);
  }
  const body = (await res.json().catch(() => null)) as {
    events?: unknown;
  } | null;
  const events = Array.isArray(body?.events) ? body.events : [];
  return events.filter(
    (e): e is Record<string, unknown> =>
      !!e &&
      typeof e === "object" &&
      typeof (e as { type?: unknown }).type === "string" &&
      (e as { payload?: unknown }).payload !== null &&
      typeof (e as { payload?: unknown }).payload === "object",
  ) as Array<Record<string, unknown>>;
}

/**
 * GET /api/saga/:sagaId/status. Returns null for non-matching
 * paths. 401 without a session; 503 when the audit stub is
 * unbound or the read fails; 404 when no audit rows exist for
 * the session user AND no projection row exists for the session
 * tenant (issue #2777 fallback); otherwise 200 with {jobs} +
 * best-effort live instance state. An errored instance also
 * carries instanceError (#2810).
 */
export async function handleSagaStatusRoutes(
  request: Request,
  _url: URL,
  path: string,
  env: Env,
  sessionLogin: string | null,
  overrides?: SagaStatusOverrides,
): Promise<Response | null> {
  const match = /^\/api\/saga\/([^/]+)\/status$/.exec(path);
  if (!match || request.method !== "GET") return null;
  const sagaId = decodeURIComponent(match[1]);
  if (!sessionLogin) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let stub: AuditOwnerStub;
  try {
    stub = overrides?.auditStub ?? sagaAuditOwnerStub(env);
  } catch {
    return Response.json(
      { error: "Saga status audit read unavailable: ORCHESTRATOR_AGENT is not bound." },
      { status: 503 },
    );
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await readSagaAuditRows(stub);
  } catch (err) {
    return Response.json(
      {
        error: `Saga status audit read failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 503 },
    );
  }
  const own = rows.filter((row) => {
    const payload = row["payload"] as Record<string, unknown>;
    return (
      payload["sagaId"] === sagaId && payload["userLogin"] === sessionLogin
    );
  });
  let jobs: SagaJobRow[];
  if (own.length > 0) {
    jobs = mapSagaAuditToJobs(own, sagaId);
  } else {
    // Issue #2777: a just-created saga has no audit rows yet —
    // answer from its synchronously-written projection row
    // instead of 404ing the panel's first polls. Audit rows win
    // the moment they exist (this branch never runs then).
    const projected = await readSagaProjectionFallback(env, sagaId, overrides);
    if (!projected) {
      return Response.json({ error: "saga not found" }, { status: 404 });
    }
    jobs = [projected];
  }
  const ended = own.find((row) => row["type"] === "saga.ended");
  const endedCode =
    ended && typeof (ended["payload"] as Record<string, unknown>)["outcomeCode"] === "string"
      ? ((ended["payload"] as Record<string, unknown>)["outcomeCode"] as string)
      : undefined;
  const proposed = [...own]
    .reverse()
    .find((row) => row["type"] === "saga.trade_proposed");
  const proposedTradeId =
    proposed &&
    typeof (proposed["payload"] as Record<string, unknown>)["tradeWorkflowId"] === "string"
      ? ((proposed["payload"] as Record<string, unknown>)["tradeWorkflowId"] as string)
      : undefined;

  // Live instance state: best-effort, never a 503 on its own.
  // Issue #2810: an errored instance also surfaces its reason
  // (instanceError) — the binding's error text when present,
  // else the terminal audit row's reason, else the last known
  // step + "instance errored". Never a 503: every source here
  // is already in hand or best-effort.
  let instanceStatus: string | undefined;
  let snapshotError: string | undefined;
  let outcomeCode: string | undefined = endedCode;
  let tradeWorkflowId: string | undefined = proposedTradeId;
  const binding =
    overrides?.sagaBinding ??
    (env["SAGA_WORKFLOW"] as SagaStatusBinding | undefined);
  if (binding && typeof binding.get === "function") {
    try {
      const instance = await binding.get(sagaWorkflowInstanceId(sagaId));
      const snapshot = await instance.status();
      instanceStatus = snapshot.status;
      const rawError = snapshot.error;
      snapshotError =
        typeof rawError === "string"
          ? rawError
          : rawError && typeof rawError === "object" && typeof rawError.message === "string"
            ? rawError.message
            : undefined;
      if (snapshot.output && typeof snapshot.output === "object") {
        const output = snapshot.output as Record<string, unknown>;
        if (typeof output["code"] === "string") {
          outcomeCode = output["code"] as string;
        }
        if (typeof output["tradeWorkflowId"] === "string") {
          tradeWorkflowId = output["tradeWorkflowId"] as string;
        }
      }
    } catch {
      // Missing instance or unbound binding: audit rows answer.
    }
  }
  let instanceError: string | undefined;
  if (instanceStatus === "errored") {
    const reasonOf = (type: string): string | undefined => {
      const row = own.find((r) => r["type"] === type);
      const payload = row?.["payload"] as Record<string, unknown> | undefined;
      const reason = payload?.["reason"];
      return typeof reason === "string" && reason ? reason : undefined;
    };
    const lastJob = jobs[jobs.length - 1];
    instanceError =
      snapshotError ??
      reasonOf("saga.failed") ??
      reasonOf("saga.ended") ??
      (lastJob
        ? `Saga failed at ${lastJob.stage}: instance errored`
        : "Saga failed: instance errored");
  }
  return Response.json({
    sagaId,
    jobs,
    ...(instanceStatus ? { instanceStatus } : {}),
    ...(instanceError ? { instanceError } : {}),
    ...(outcomeCode ? { outcomeCode } : {}),
    ...(tradeWorkflowId ? { tradeWorkflowId } : {}),
  });
}
