/**
 * Issue #5425 (#3515 S5) — the SLO read route: GET
 * /api/otel/v1/slo (`?tenantId=`, default "primary").
 *
 * The read surface for SLO compliance: it evaluates both API
 * SLOs (uptime, P95 latency) against the tenant's configured
 * thresholds through the S2 recorder and returns the fresh
 * evaluation. The evaluation trigger IS this read — there is no
 * background evaluation (the health gauge's dangling-evaluator
 * gap, S2, is not repeated here): each read evaluates, records
 * the gauges (1=within / 0=breached), and reports.
 *
 * Gating follows the IAAA admin pattern exactly (requireAuth →
 * live platform-admin membership, fail-closed): an
 * unauthenticated caller reads 401, a signed-in non-admin reads
 * 403 with a coded OBS-1024 message and a deny audit record.
 * An allowed read is audited BEFORE it is served
 * (audit-before-allow); when the audit write itself fails the
 * route fails closed with 500 — the read is never served
 * unaudited. A deny audit is best-effort (the core.ts
 * service-token precedent): the deny stands even when the
 * audit store is down.
 *
 * States are explicit, never invented: a threshold that is null
 * (or stored but invalid) reports "unconfigured" and claims no
 * compliance; thresholds set but no requests recorded yet report
 * "no-data". The handler takes injectable deps (the
 * telemetry-route pattern): tests pass fakes, production wires
 * the real auth, admin, audit, commercial store, and the server
 * metrics recorder.
 */

import type { Env, SessionData } from "../../types";
import { requireAuth } from "../auth";
import { defaultAudit, defaultIsPlatformAdmin } from "./otelArchive";
import {
  IAAA_AUDIT_POLICY_VERSION,
  type CreateIaaaAuditEventInput,
} from "../../security/iaaaAudit";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import { serverOtelMetricsRecorder } from "../../observability/serverMetrics";
import type { OtelMetricsRecorder } from "../../observability/otelMetricsRecorder";
import {
  parseSloP95LatencyMaxMs,
  parseSloUptimeTargetRatio,
} from "../../config/sloThresholds";
import {
  OBS_SLO_FORBIDDEN,
  OBS_SLO_UNAVAILABLE,
  formatCatalogMessage,
} from "../../observability/otelMessages";

/** The SLO read route path. */
export const OTEL_SLO_ROUTE = "/api/otel/v1/slo" as const;

/** The audit event type for SLO reads. */
export const OTEL_SLO_AUDIT_TYPE = "observability.slo" as const;

/** The per-SLO compliance state the read reports. */
export type SloStatus = "within" | "breached" | "unconfigured" | "no-data";

export interface OtelSloRouteDeps {
  requireSession: (request: Request, env: Env) => Promise<SessionData | null>;
  isPlatformAdmin: (session: SessionData, env: Env) => Promise<boolean>;
  audit: (env: Env, input: CreateIaaaAuditEventInput) => Promise<boolean>;
  commercial: (env: Env) => CommercialStore | null;
  recorder: (env: Env) => OtelMetricsRecorder | null;
}

const defaultOtelSloRouteDeps: OtelSloRouteDeps = {
  requireSession: requireAuth,
  isPlatformAdmin: defaultIsPlatformAdmin,
  audit: defaultAudit,
  commercial: (env) => createCommercialAdapter(env),
  recorder: (env) => serverOtelMetricsRecorder(env),
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Resolve the tenant's SLO thresholds for the read: per-field,
 * best-effort. A null stored value — or a stored value that
 * fails validation — resolves to null (unconfigured): the read
 * reports "unconfigured" for that SLO instead of refusing the
 * whole read or evaluating against an unusable number. The
 * strict resolver (resolveSloThresholds, which throws the named
 * refusal) stays the write/turn path's shape; the read path
 * must report mixed states (one SLO configured, the other not).
 */
async function resolveReadThresholds(
  commercial: CommercialStore,
  tenantId: string,
): Promise<{ uptimeTargetRatio: number | null; p95LatencyMaxMs: number | null }> {
  const rawUptime = await commercial.getTenantSloUptimeTargetRatio(tenantId);
  const rawP95 = await commercial.getTenantSloP95LatencyMaxMs(tenantId);
  let uptimeTargetRatio: number | null = null;
  let p95LatencyMaxMs: number | null = null;
  try {
    uptimeTargetRatio = rawUptime === null ? null : parseSloUptimeTargetRatio(rawUptime);
  } catch {
    uptimeTargetRatio = null;
  }
  try {
    p95LatencyMaxMs = rawP95 === null ? null : parseSloP95LatencyMaxMs(rawP95);
  } catch {
    p95LatencyMaxMs = null;
  }
  return { uptimeTargetRatio, p95LatencyMaxMs };
}

function sloStatus(withinSlo: boolean | null, target: number | null): SloStatus {
  if (target === null) return "unconfigured";
  if (withinSlo === null) return "no-data";
  return withinSlo ? "within" : "breached";
}

/**
 * The SLO route handler (the server.ts dispatch shape: returns
 * a Response when the path matches, null to fall through to the
 * next handler). GET only.
 */
export async function handleSloRoutes(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  deps: OtelSloRouteDeps = defaultOtelSloRouteDeps,
): Promise<Response | null> {
  if (path !== OTEL_SLO_ROUTE) return null;

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  const session = await deps.requireSession(request, env);
  if (!session) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const auditBase = {
    timestamp: Date.now(),
    type: OTEL_SLO_AUDIT_TYPE,
    actorPrincipalId: session.internalUserId ?? session.githubLogin ?? "unknown",
    actorType: "human" as const,
    initiatingPrincipalId: session.internalUserId ?? session.githubLogin ?? "unknown",
    tenantId: resolveIaaaTenant(env),
    correlationId: crypto.randomUUID(),
    action: "observability.slo.read",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
  };

  let admin: boolean;
  try {
    admin = await deps.isPlatformAdmin(session, env);
  } catch {
    const error = formatCatalogMessage(OBS_SLO_UNAVAILABLE, {
      reason: "the platform-admin check failed",
    });
    return jsonResponse(500, { error, code: OBS_SLO_UNAVAILABLE });
  }
  if (!admin) {
    try {
      await deps.audit(env, {
        ...auditBase,
        decision: "deny" as const,
        outcome: "failed" as const,
        errorCode: "OTEL_SLO_FORBIDDEN",
      });
    } catch {
      /* denial attribution is best-effort; the deny stands */
    }
    const error = formatCatalogMessage(OBS_SLO_FORBIDDEN);
    return jsonResponse(403, { error, code: OBS_SLO_FORBIDDEN });
  }

  // Audit-before-allow: the read is served only when its audit
  // record lands; an audit failure fails closed with 500.
  const audited = await deps
    .audit(env, { ...auditBase, decision: "allow" as const, outcome: "succeeded" as const })
    .catch(() => false);
  if (!audited) {
    const error = formatCatalogMessage(OBS_SLO_UNAVAILABLE, {
      reason: "the audit record could not be written",
    });
    return jsonResponse(500, { error, code: OBS_SLO_UNAVAILABLE });
  }

  const commercial = deps.commercial(env);
  if (!commercial) {
    const error = formatCatalogMessage(OBS_SLO_UNAVAILABLE, {
      reason: "the commercial store is unavailable",
    });
    return jsonResponse(500, { error, code: OBS_SLO_UNAVAILABLE });
  }
  const recorder = deps.recorder(env);
  if (!recorder) {
    const error = formatCatalogMessage(OBS_SLO_UNAVAILABLE, {
      reason: "the metrics recorder is unavailable",
    });
    return jsonResponse(500, { error, code: OBS_SLO_UNAVAILABLE });
  }

  const tenantId = url.searchParams.get("tenantId")?.trim() || "primary";
  const thresholds = await resolveReadThresholds(commercial, tenantId);
  const evaluation = recorder.evaluateAndRecordSlo(thresholds);
  return jsonResponse(200, {
    tenantId,
    evaluatedAtMs: Date.now(),
    sample: {
      totalRequests: evaluation.totalRequests,
      failedRequests: evaluation.failedRequests,
      latencySamples: evaluation.latencySamples,
    },
    uptime: {
      status: sloStatus(evaluation.uptime.withinSlo, evaluation.uptime.target),
      value: evaluation.uptime.value,
      target: evaluation.uptime.target,
    },
    p95Latency: {
      status: sloStatus(evaluation.p95Latency.withinSlo, evaluation.p95Latency.targetMs),
      valueMs: evaluation.p95Latency.valueMs,
      targetMs: evaluation.p95Latency.targetMs,
    },
  });
}
