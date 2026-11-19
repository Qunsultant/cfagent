/**
 * Issue #1676 ([AGENTIC] Slice 2) — job-history and
 * jobs-reconcile route handlers (mirrors
 * src/data/chainStatusRoute.ts).
 *
 * Pure handlers: no env, no binding, no store client. The
 * server wires them to the composition root; these handlers
 * decide only status codes and response shape.
 *
 * Decision order for the history route: 401 (no wired
 * session) → 405 (non-GET) → 400 (missing chainId) → 200
 * (projection rows) / 500 (read failure). The history route
 * answers from the projection only, never from the durable
 * object; an unbound store is answered 503 by the server
 * wiring, not here.
 *
 * Decision order for the reconcile route: 401 → 405 →
 * 403 (unwired session) → 403 (non-admin) → 200 (report) /
 * 500 (reconcile failure). Reconciliation is a deliberate
 * operator action; it is never invoked by boot, deploy, or
 * tick logic.
 */
import type { ShardJobRow } from "./shardJobPorts";
import type { ReconcileShardJobsReport } from "./shardJobProjection";

import { createStructuredLogger } from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

export interface JobHistoryRouteInput {
  /** Wired session, or null when unauthenticated. */
  session: unknown;
  method: string;
  tenantId: string;
  chainId: string;
  readHistory: () => Promise<ShardJobRow[]>;
  /**
   * #3515 S3 batch 7 — optional observability sink (d1QueryLogger
   * precedent): the composition root passes the env-constructed sink
   * when it holds env; without one the event goes to the structured
   * console fallback (never a `{}` sink, #5587).
   */
  sink?: ObservabilitySink;
}

export async function handleJobHistoryRoute(
  input: JobHistoryRouteInput,
): Promise<Response> {
  // #3515 S3 batch 7 — logger over the injected sink (d1QueryLogger
  // precedent), else the structured console fallback (never a `{}` sink,
  // #5587). This pure handler has no env; the server wiring passes the
  // env-constructed sink when it holds one (follow-up).
  const structuredLog = createStructuredLogger(
    input.sink ?? new ConsoleObservabilitySink(),
    { component: "data/shardJobRoute" },
  );
  if (!input.session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (input.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  if (!input.chainId) {
    return new Response(JSON.stringify({ error: "chainId_required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    const jobs = await input.readHistory();
    return new Response(
      JSON.stringify({
        chainId: input.chainId,
        jobs: jobs.map((job) => ({
          jobKey: job.jobKey,
          status: job.status,
          stage: job.stage,
          capabilityId: job.capabilityId,
          detail: job.detail,
          version: job.version,
          updatedAtMs: job.updatedAtMs,
          // Issue #1737: the collation record rides here —
          // the parent row's resultJson IS the workflow
          // collation (lifecycle, coverage, shard flags).
          // Already capped (8000) + spec-free + auth-free
          // per the slice-2 contract, so it is safe to expose.
          resultJson: job.resultJson,
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    structuredLog.error("shardJobRoute.job_history_read_failed", {
      message: "[data-foundation] Job history read failed:",
      error: err instanceof Error ? err.message : String(err),
      tenantId: input.tenantId,
      chainId: input.chainId,
    });
    return new Response(JSON.stringify({ error: "job_history_failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

export interface ReconcileJobsRouteInput {
  /** Wired session, or null when unauthenticated. */
  session: unknown;
  method: string;
  /** False when the caller lacks platform-admin membership. */
  isPlatformAdmin: boolean;
  tenantId: string;
  runReconcile: (args: {
    tenantId: string;
  }) => Promise<ReconcileShardJobsReport>;
  /**
   * #3515 S3 batch 7 — optional observability sink (d1QueryLogger
   * precedent): the composition root passes the env-constructed sink
   * when it holds env; without one the event goes to the structured
   * console fallback (never a `{}` sink, #5587).
   */
  sink?: ObservabilitySink;
}

export async function handleReconcileJobsRoute(
  input: ReconcileJobsRouteInput,
): Promise<Response> {
  // #3515 S3 batch 7 — logger over the injected sink (d1QueryLogger
  // precedent), else the structured console fallback (never a `{}` sink,
  // #5587). This pure handler has no env; the server wiring passes the
  // env-constructed sink when it holds one (follow-up).
  const structuredLog = createStructuredLogger(
    input.sink ?? new ConsoleObservabilitySink(),
    { component: "data/shardJobRoute" },
  );
  if (!input.session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (input.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  const sessionRecord = input.session as { internalUserId?: unknown };
  if (typeof sessionRecord.internalUserId !== "string") {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (!input.isPlatformAdmin) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    const report = await input.runReconcile({ tenantId: input.tenantId });
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    structuredLog.error("shardJobRoute.shard_job_reconcile_failed", {
      message: "[data-foundation] Shard job reconcile failed:",
      error: err instanceof Error ? err.message : String(err),
      tenantId: input.tenantId,
    });
    return new Response(JSON.stringify({ error: "reconcile_failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
