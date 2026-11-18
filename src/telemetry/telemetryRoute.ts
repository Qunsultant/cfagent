/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — pure, testable handlers for the telemetry routes.
 * The Worker route in src/server.ts only wires real
 * dependencies into these functions; every decision below is
 * covered by tests/telemetry_routes.test.ts.
 *
 * Decision order (same shape as the slice-1 chain routes):
 * unauthenticated → 401; wrong method → 405; unbound store →
 * 503 (the handler itself returns it, so the contract is
 * pinned without a Worker test); governance routes require a
 * wired session (403) and platform-admin membership (403).
 *
 * Reads are tenant-scoped from IAAA resolution — never from
 * caller input (the slice-4 MCP rule). Decision actors come
 * from the session (githubLogin, else internalUserId); the
 * engine still enforces its human-actor rules, so a blank or
 * system actor fails closed even if the route wiring changes.
 *
 * Routes:
 *  - GET /api/telemetry/summary — any signed-in user. D1
 *    metrics (all five dimensions) + active calibrated notes
 *    + live breaker health (consumed from #1745's registry
 *    snapshots, via an injected dep) + retrieval stats
 *    (folded #1740 retrieval.completed envelopes, via an
 *    injected dep).
 *  - GET /api/telemetry/decisions — any signed-in user.
 *  - POST /api/telemetry/decisions/:id/decide|apply|supersede|expire
 *    — platform-admin only. Decide takes { verdict }.
 *  - POST /api/telemetry/reconcile — platform-admin only.
 *    Imports scored track-record ideas into D1, bounded
 *    (default 500/call); repeat calls converge because
 *    already-recorded outcomes are skipped, and the report
 *    names the deferred remainder.
 */
import type { BreakerSnapshot } from "../breakers/breakerPorts";
import type { MessageEnvelope } from "../messaging/messagingPorts";
import {
  CalibrationError,
  TelemetryCalibrationEngine,
  type CalibrationDecisionRow,
  type CalibrationDecisionStatus,
  type MetricSlice,
  type TelemetryStore,
} from "./telemetryPorts";
import type { RetrievalStatsSnapshot } from "./retrievalStats";
import type { EnrichmentQualitySummary } from "../enrichment/enrichmentPorts";
import {
  realizationsFromTrackRecord,
  type TrackRecordIdeaInput,
} from "./telemetryProjection";

export interface TelemetryRouteSession {
  githubLogin?: string;
  internalUserId?: string;
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
}

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

function unbound(): Response {
  return Response.json(
    { error: "Telemetry unavailable: AgentDB is not bound." },
    { status: 503 },
  );
}

function forbidden(detail: string): Response {
  return Response.json({ error: `Forbidden: ${detail}` }, { status: 403 });
}

function calibrationErrorResponse(err: unknown): Response {
  if (err instanceof CalibrationError) {
    return Response.json(
      { error: err.message },
      { status: err.code === "not-found" ? 404 : 400 },
    );
  }
  return Response.json({ error: "Telemetry operation unavailable." }, { status: 500 });
}

function requireWiredAdmin(
  session: TelemetryRouteSession | null,
  isPlatformAdmin: boolean,
  detail: string,
): Response | null {
  if (!session) return unauthorized();
  if (!session.internalUserId) return forbidden(`${detail} requires a wired session.`);
  if (!isPlatformAdmin) {
    return forbidden(`${detail} requires platform-admin membership.`);
  }
  return null;
}

function actorOf(session: TelemetryRouteSession): string {
  return session.githubLogin ?? session.internalUserId ?? "";
}

export interface TelemetrySummaryRouteDeps {
  session: TelemetryRouteSession | null;
  method: string;
  tenantId: string;
  store: TelemetryStore | null;
  breakerSnapshots: () => BreakerSnapshot[];
  retrievalStats: () => RetrievalStatsSnapshot;
  /** #1741: gateway stats, when the caller wires the gateway port. Absent => no `gateway` field. */
  gatewayStats?: () => import("../gateway/gatewayPorts").GatewayStatsSnapshot;
  /** #1888: enrichment quality, when the caller wires the enrichment
   *  status read. Absent or null => no `enrichment` field. */
  enrichmentStats?: () => EnrichmentQualitySummary | null;
}

export interface TelemetrySummaryBody {
  tenantId: string;
  realizations: { total: number };
  metrics: Record<"byThesis" | "byAgent" | "byStructure" | "byRegime" | "byMonth", MetricSlice[]>;
  activeCalibrations: Array<{
    actorKey: string;
    promptKey: string;
    note: string;
    appliedAtMs: number | null;
  }>;
  breakerHealth: BreakerSnapshot[];
  retrieval: RetrievalStatsSnapshot;
  /** #1741: present only when the gatewayStats dep is provided. */
  gateway?: import("../gateway/gatewayPorts").GatewayStatsSnapshot;
  /** #1888: present only when the enrichmentStats dep provides a summary. */
  enrichment?: EnrichmentQualitySummary;
}

export async function handleTelemetrySummaryRoute(
  deps: TelemetrySummaryRouteDeps,
): Promise<Response> {
  if (!deps.session) return unauthorized();
  if (deps.method !== "GET") return methodNotAllowed();
  if (!deps.store) return unbound();
  try {
    const store = deps.store;
    const [rows, byThesis, byAgent, byStructure, byRegime, byMonth, applied] =
      await Promise.all([
        store.queryRealizations(deps.tenantId, {}),
        store.metrics(deps.tenantId, "thesis"),
        store.metrics(deps.tenantId, "agent"),
        store.metrics(deps.tenantId, "structure"),
        store.metrics(deps.tenantId, "regime"),
        store.metrics(deps.tenantId, "month"),
        store.listDecisions(deps.tenantId, { status: "applied" }),
      ]);
    const enrichment = deps.enrichmentStats ? deps.enrichmentStats() : null;
    const body: TelemetrySummaryBody = {
      tenantId: deps.tenantId,
      realizations: { total: rows.length },
      metrics: { byThesis, byAgent, byStructure, byRegime, byMonth },
      activeCalibrations: applied.map((d) => ({
        actorKey: d.actorKey,
        promptKey: d.promptKey,
        note: d.calibrationNote,
        appliedAtMs: d.appliedAtMs ?? null,
      })),
      breakerHealth: deps.breakerSnapshots(),
      retrieval: deps.retrievalStats(),
      ...(deps.gatewayStats ? { gateway: deps.gatewayStats() } : {}),
      ...(enrichment ? { enrichment } : {}),
    };
    return Response.json(body);
  } catch {
    return Response.json({ error: "Telemetry summary unavailable." }, { status: 500 });
  }
}

export interface TelemetryDecisionsRouteDeps {
  session: TelemetryRouteSession | null;
  method: string;
  tenantId: string;
  store: TelemetryStore | null;
  status?: string;
  actorKey?: string;
  promptKey?: string;
}

const DECISION_STATUSES: CalibrationDecisionStatus[] = [
  "proposed",
  "approved",
  "rejected",
  "applied",
  "superseded",
  "expired",
];

export async function handleTelemetryDecisionsRoute(
  deps: TelemetryDecisionsRouteDeps,
): Promise<Response> {
  if (!deps.session) return unauthorized();
  if (deps.method !== "GET") return methodNotAllowed();
  if (!deps.store) return unbound();
  if (
    deps.status !== undefined &&
    !(DECISION_STATUSES as string[]).includes(deps.status)
  ) {
    return Response.json({ error: "Unknown decision status." }, { status: 400 });
  }
  try {
    const rows = await deps.store.listDecisions(deps.tenantId, {
      status: deps.status as CalibrationDecisionStatus | undefined,
      actorKey: deps.actorKey,
      promptKey: deps.promptKey,
    });
    return Response.json({ count: rows.length, decisions: rows });
  } catch {
    return Response.json({ error: "Telemetry decisions unavailable." }, { status: 500 });
  }
}

export interface TelemetryDecisionActionRouteDeps {
  session: TelemetryRouteSession | null;
  method: string;
  isPlatformAdmin: boolean;
  tenantId: string;
  store: TelemetryStore | null;
  decisionId: string;
  action: "decide" | "apply" | "supersede" | "expire";
  verdict?: string;
  engine?: TelemetryCalibrationEngine;
  /**
   * Issue #1743 — stream sink for calibration envelopes
   * (calibration_applied on apply; calibration_proposed when a
   * propose path runs). Best-effort: the engine swallows emit
   * failures, so the stream never blocks the decision.
   */
  emit?: (envelope: MessageEnvelope) => void | Promise<void>;
}

export async function handleTelemetryDecisionActionRoute(
  deps: TelemetryDecisionActionRouteDeps,
): Promise<Response> {
  const gate = requireWiredAdmin(
    deps.session,
    deps.isPlatformAdmin,
    "telemetry decision actions",
  );
  if (gate) return gate;
  if (deps.method !== "POST") return methodNotAllowed();
  if (!deps.store) return unbound();
  if (!deps.decisionId) {
    return Response.json({ error: "decisionId is required." }, { status: 400 });
  }
  const engine =
    deps.engine ??
    new TelemetryCalibrationEngine(
      deps.store,
      deps.emit ? { emit: deps.emit } : {},
    );
  const actor = actorOf(deps.session!);
  try {
    let row: CalibrationDecisionRow;
    switch (deps.action) {
      case "decide":
        if (deps.verdict !== "approved" && deps.verdict !== "rejected") {
          return Response.json(
            { error: "verdict must be approved or rejected." },
            { status: 400 },
          );
        }
        row = await engine.decideCalibration(
          deps.tenantId,
          deps.decisionId,
          deps.verdict,
          actor,
        );
        break;
      case "apply":
        row = await engine.applyCalibration(deps.tenantId, deps.decisionId, actor);
        break;
      case "supersede":
        row = await engine.supersedeCalibration(deps.tenantId, deps.decisionId, actor);
        break;
      case "expire":
        row = await engine.expireCalibration(deps.tenantId, deps.decisionId, actor);
        break;
    }
    return Response.json({ decision: row });
  } catch (err) {
    return calibrationErrorResponse(err);
  }
}

export interface TelemetryReconcileRouteDeps {
  session: TelemetryRouteSession | null;
  method: string;
  isPlatformAdmin: boolean;
  tenantId: string;
  store: TelemetryStore | null;
  loadTrackRecord: () => Promise<{ ideas: TrackRecordIdeaInput[] }>;
  /** #5059: the calibration engine the post-import proposal pass uses.
   *  Composed from the store when absent. */
  engine?: TelemetryCalibrationEngine;
  /** Whose track record was imported (the research:<login> instance). */
  userLogin: string;
  limit?: number;
}

export interface TelemetryReconcileReport {
  userLogin: string;
  total: number;
  alreadyRecorded: number;
  imported: number;
  deferred: number;
  pendingSkipped: number;
  /** #5059: calibration proposals created from the freshly imported
   *  realizations (the table's content consumer). */
  calibrationsCreated?: number;
  /** #5059: why the proposal pass failed, when it did. The import
   *  already landed; this is reported, never thrown. */
  calibrationError?: string | null;
}

export async function handleTelemetryReconcileRoute(
  deps: TelemetryReconcileRouteDeps,
): Promise<Response> {
  const gate = requireWiredAdmin(
    deps.session,
    deps.isPlatformAdmin,
    "telemetry reconciliation",
  );
  if (gate) return gate;
  if (deps.method !== "POST") return methodNotAllowed();
  if (!deps.store) return unbound();
  try {
    const { ideas } = await deps.loadTrackRecord();
    const rows = realizationsFromTrackRecord(ideas, deps.tenantId);
    const pendingSkipped = ideas.length - rows.length;
    const existing = new Set(
      (await deps.store.queryRealizations(deps.tenantId, {})).map((r) => r.outcomeId),
    );
    const candidates = rows.filter((r) => !existing.has(r.outcomeId));
    const alreadyRecorded = rows.length - candidates.length;
    const limit = deps.limit ?? 500;
    const batch = candidates.slice(0, limit);
    const result = await deps.store.recordRealizations(batch);
    // Issue #5059 (AG-5): the realization rows are consumed for their
    // CONTENT, not just deduped — the calibration engine reads the fresh
    // window and proposes falsification-driven decisions for human review.
    // Best-effort: the import has already landed, so a proposal-pass
    // failure is reported in the response, never thrown.
    let calibrationsCreated = 0;
    let calibrationError: string | null = null;
    try {
      const engine =
        deps.engine ?? new TelemetryCalibrationEngine(deps.store);
      const proposed = await engine.proposeCalibrations(deps.tenantId);
      calibrationsCreated = proposed.created.length;
    } catch (err) {
      calibrationError = err instanceof Error ? err.message : String(err);
    }
    const report: TelemetryReconcileReport = {
      userLogin: deps.userLogin,
      total: rows.length,
      alreadyRecorded,
      imported: result.recorded,
      deferred: candidates.length - result.recorded,
      pendingSkipped,
      calibrationsCreated,
      calibrationError,
    };
    return Response.json(report);
  } catch {
    return Response.json({ error: "Telemetry reconciliation unavailable." }, { status: 500 });
  }
}
