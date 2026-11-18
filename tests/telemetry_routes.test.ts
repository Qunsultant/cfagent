/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — TDD red-first.
 *
 * Pins the pure route handlers: auth/method/admin/binding
 * decision order, summary composition (D1 metrics + applied
 * notes + injected breaker snapshots + retrieval stats),
 * decision actions through the governed engine, and the
 * bounded, convergent reconcile import.
 */
import { describe, it, expect } from "vitest";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import {
  CALIBRATION_PROPOSER,
  TelemetryCalibrationEngine,
  type CalibrationDecisionRow,
  type TelemetryStore,
  type ThesisRealizationInput,
} from "../src/telemetry/telemetryPorts";
import {
  handleTelemetryDecisionActionRoute,
  handleTelemetryDecisionsRoute,
  handleTelemetryReconcileRoute,
  handleTelemetrySummaryRoute,
  type TelemetryRouteSession,
} from "../src/telemetry/telemetryRoute";

const ADMIN: TelemetryRouteSession = { githubLogin: "owner:alice", internalUserId: "user-1" };
const SIGNED_IN: TelemetryRouteSession = { githubLogin: "owner:bob", internalUserId: "user-2" };
const UNWIRED: TelemetryRouteSession = { githubLogin: "owner:carol" };

function realization(outcomeId: string, correct: boolean): ThesisRealizationInput {
  return {
    tenantId: "primary",
    outcomeId,
    thesis: "condor-bias",
    agentKey: "research",
    structure: "iron-condor",
    regime: "high-iv",
    symbol: "NVDA",
    runId: "run-1",
    reportId: null,
    chainId: null,
    predictedDirection: "up",
    realizedDirection: correct ? "up" : "down",
    directionCorrect: correct,
    falsified: !correct,
    invalidated: false,
    pnlEstimatePerUnit: null,
    rMultiple: null,
    evaluatedAtMs: 1_760_000_000_000,
  };
}

function decisionRow(overrides: Partial<CalibrationDecisionRow> & { id: string }): CalibrationDecisionRow {
  return {
    tenantId: "primary",
    actorKey: "research",
    promptKey: "thesis:condor-bias",
    dimension: "thesis",
    sliceKey: "condor-bias",
    snapshot: { key: "condor-bias", evaluated: 30, hits: 10, hitRate: 10 / 30, falsificationRate: 20 / 30 },
    falsifyingOutcomeIds: ["a"],
    calibrationNote: "Calibration note: ...",
    proposedBy: CALIBRATION_PROPOSER,
    proposedAtMs: 1000,
    status: "proposed",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

async function seededStore(): Promise<TelemetryStore> {
  const store = new InMemoryTelemetryAdapter();
  const rows: ThesisRealizationInput[] = [];
  for (let i = 0; i < 20; i++) rows.push(realization(`f:${i}`, false));
  for (let i = 0; i < 10; i++) rows.push(realization(`c:${i}`, true));
  await store.recordRealizations(rows);
  return store;
}

describe("telemetry routes (#1742)", () => {
  it("summary: 401/405/503 decision order, then composition", async () => {
    const store = await seededStore();
    const breakerSnapshots = () => [
      {
        providerId: "yahoo",
        state: "open" as const,
        consecutiveFailures: 3,
        totalCalls: 10,
        totalSuccesses: 7,
        totalFailures: 3,
        totalTrips: 1,
        totalFallbacks: 2,
        totalRejected: 0,
        openedAtMs: 5,
        lastFailureAtMs: 6,
      },
    ];
    const retrievalStats = () => ({
      totalRetrievals: 4,
      totalDense: 20,
      totalGraph: 6,
      degradedCount: 1,
      lastCompletedAtMs: 7,
    });
    expect(
      (await handleTelemetrySummaryRoute({
        session: null, method: "GET", tenantId: "primary", store,
        breakerSnapshots, retrievalStats,
      })).status,
    ).toBe(401);
    expect(
      (await handleTelemetrySummaryRoute({
        session: SIGNED_IN, method: "POST", tenantId: "primary", store,
        breakerSnapshots, retrievalStats,
      })).status,
    ).toBe(405);
    expect(
      (await handleTelemetrySummaryRoute({
        session: SIGNED_IN, method: "GET", tenantId: "primary", store: null,
        breakerSnapshots, retrievalStats,
      })).status,
    ).toBe(503);
    const res = await handleTelemetrySummaryRoute({
      session: SIGNED_IN, method: "GET", tenantId: "primary", store,
      breakerSnapshots, retrievalStats,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.realizations.total).toBe(30);
    expect(body.metrics.byThesis[0]).toMatchObject({ key: "condor-bias", evaluated: 30, hits: 10 });
    expect(body.breakerHealth[0]).toMatchObject({ providerId: "yahoo", state: "open", totalTrips: 1 });
    expect(body.retrieval).toMatchObject({ totalRetrievals: 4, degradedCount: 1 });
    expect(body.activeCalibrations).toEqual([]);
  });

  it("decisions list: auth, method, binding, status validation, filters", async () => {
    const store = new InMemoryTelemetryAdapter();
    await store.recordDecision(decisionRow({ id: "d1" }));
    await store.recordDecision(decisionRow({ id: "d2", status: "applied", appliedBy: "owner:alice", appliedAtMs: 2000 }));
    const base = { session: SIGNED_IN, method: "GET", tenantId: "primary", store };
    expect((await handleTelemetryDecisionsRoute({ ...base, session: null })).status).toBe(401);
    expect((await handleTelemetryDecisionsRoute({ ...base, method: "POST" })).status).toBe(405);
    expect((await handleTelemetryDecisionsRoute({ ...base, store: null })).status).toBe(503);
    expect((await handleTelemetryDecisionsRoute({ ...base, status: "bogus" })).status).toBe(400);
    expect(((await (await handleTelemetryDecisionsRoute(base)).json()) as any).count).toBe(2);
    expect(
      ((await (await handleTelemetryDecisionsRoute({ ...base, status: "applied" })).json()) as any).count,
    ).toBe(1);
  });

  it("decision actions: admin gate, verdict validation, engine rules, 404", async () => {
    const store = new InMemoryTelemetryAdapter();
    await store.recordDecision(decisionRow({ id: "d1" }));
    const base = {
      method: "POST", tenantId: "primary", store, decisionId: "d1", action: "decide" as const, verdict: "approved",
    };
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: null, isPlatformAdmin: false })).status).toBe(401);
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: UNWIRED, isPlatformAdmin: true })).status).toBe(403);
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: ADMIN, isPlatformAdmin: false })).status).toBe(403);
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: ADMIN, isPlatformAdmin: true, method: "GET" })).status).toBe(405);
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: ADMIN, isPlatformAdmin: true, store: null })).status).toBe(503);
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: ADMIN, isPlatformAdmin: true, verdict: "maybe" })).status).toBe(400);
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: ADMIN, isPlatformAdmin: true, decisionId: "nope" })).status).toBe(404);
    const approved = await handleTelemetryDecisionActionRoute({ ...base, session: ADMIN, isPlatformAdmin: true });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as any).decision.status).toBe("approved");
    // Second decide on the same decision → 400 rule violation.
    expect((await handleTelemetryDecisionActionRoute({ ...base, session: ADMIN, isPlatformAdmin: true })).status).toBe(400);
    const applied = await handleTelemetryDecisionActionRoute({
      ...base, session: ADMIN, isPlatformAdmin: true, action: "apply", verdict: undefined,
    });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as any).decision.status).toBe("applied");
    const expired = await handleTelemetryDecisionActionRoute({
      ...base, session: ADMIN, isPlatformAdmin: true, action: "expire", verdict: undefined,
    });
    expect(((await expired.json()) as any).decision.status).toBe("expired");
  });

  it("reconcile: admin gate, bounded import, convergent re-runs", async () => {
    const store = new InMemoryTelemetryAdapter();
    const ideas = [
      {
        runId: "run-1", symbol: "NVDA", structure: "iron-condor", thesis: "condor-bias",
        outlook: "bullish", regime: "high-iv",
        evaluation: { directionCorrect: false, evaluatedAt: "2025-10-10T00:00:00.000Z" },
      },
      {
        runId: "run-2", symbol: "AAPL", structure: "spread", thesis: "spread-bias",
        outlook: "bearish", regime: "low-iv",
        evaluation: { directionCorrect: true, evaluatedAt: "2025-10-11T00:00:00.000Z" },
      },
      {
        runId: "run-3", symbol: "MSFT", structure: "spread", thesis: "msft-bias",
        outlook: "bullish", regime: "low-iv",
        evaluation: null,
      },
    ];
    const base = {
      method: "POST", tenantId: "primary", store, isPlatformAdmin: true,
      loadTrackRecord: async () => ({ ideas }),
      userLogin: "owner:alice",
    };
    expect((await handleTelemetryReconcileRoute({ ...base, session: null })).status).toBe(401);
    expect((await handleTelemetryReconcileRoute({ ...base, session: ADMIN, isPlatformAdmin: false })).status).toBe(403);
    expect((await handleTelemetryReconcileRoute({ ...base, session: ADMIN, store: null })).status).toBe(503);
    // Limit 1: imports the first candidate, defers the second.
    const first = await handleTelemetryReconcileRoute({ ...base, session: ADMIN, limit: 1 });
    expect(await first.json()).toEqual({
      userLogin: "owner:alice", total: 2, alreadyRecorded: 0, imported: 1, deferred: 1, pendingSkipped: 1,
      calibrationsCreated: 0, calibrationError: null,
    });
    // Second call converges: imports the deferred candidate.
    const second = await handleTelemetryReconcileRoute({ ...base, session: ADMIN, limit: 1 });
    expect(await second.json()).toEqual({
      userLogin: "owner:alice", total: 2, alreadyRecorded: 1, imported: 1, deferred: 0, pendingSkipped: 1,
      calibrationsCreated: 0, calibrationError: null,
    });
    // Third call: everything already recorded.
    const third = await handleTelemetryReconcileRoute({ ...base, session: ADMIN });
    expect(await third.json()).toEqual({
      userLogin: "owner:alice", total: 2, alreadyRecorded: 2, imported: 0, deferred: 0, pendingSkipped: 1,
      calibrationsCreated: 0, calibrationError: null,
    });
  });

  it("engine plug: applied note resolves through the summary's active list", async () => {
    const store = await seededStore();
    const engine = new TelemetryCalibrationEngine(store);
    const { created } = await engine.proposeCalibrations("primary");
    expect(created).toHaveLength(1);
    await engine.decideCalibration("primary", created[0].id, "approved", "owner:alice");
    await engine.applyCalibration("primary", created[0].id, "owner:alice");
    const res = await handleTelemetrySummaryRoute({
      session: SIGNED_IN, method: "GET", tenantId: "primary", store,
      breakerSnapshots: () => [],
      retrievalStats: () => ({ totalRetrievals: 0, totalDense: 0, totalGraph: 0, degradedCount: 0, lastCompletedAtMs: null }),
    });
    const body = (await res.json()) as any;
    expect(body.activeCalibrations).toHaveLength(1);
    expect(body.activeCalibrations[0].note).toBe(created[0].calibrationNote);
  });
});
