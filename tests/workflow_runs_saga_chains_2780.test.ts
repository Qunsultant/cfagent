/**
 * Issue #2780 — Workflow Runs saga chains: saga runs (projection chains
 * with jobKey "saga") appear in GET /api/workflow-runs with stages from
 * their audit rows, owner-scoped to the session user, with the
 * projection row's submitted stage as the fallback when the audit
 * mapping yields nothing.
 *
 * TDD red: runFromSagaChain, buildSagaChainRuns, and the handler seams
 * do not exist yet — this file fails at import until implemented.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { runFromSagaChain } from "../src/services/workflowRuns";
import {
  buildSagaChainRuns,
  handleWorkflowRunsRoutes,
} from "../src/agents/routes/workflowRuns";
import { sagaWorkflowRunsLink } from "../src/client/GoalScreenPanel";

type AuditRow = Record<string, unknown>;

function auditRow(
  type: string,
  sagaId: string,
  userLogin: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): AuditRow {
  return {
    type,
    payload: {
      sagaId,
      runRequestId: sagaId,
      tenantId: "primary",
      userLogin,
      family: "goal",
      rail: "stripe",
      ...extra,
    },
    created_at: createdAt,
  };
}

const ALICE_STARTED = auditRow("saga.started", "saga-A", "alice", "2026-11-02T03:08:00.000Z", {
  disclosure: "If this screen had failed, you would have received a one-time replacement-run credit.",
});
const ALICE_PAYMENT = auditRow("saga.payment_started", "saga-A", "alice", "2026-11-02T03:08:05.000Z");
const ALICE_SCREEN = auditRow(
  "saga.screen_completed",
  "saga-A",
  "alice",
  "2026-11-02T03:10:00.000Z",
  { apiKey: "should-be-redacted" },
);
const ALICE_JOURNEY = auditRow("saga.journey_prompted", "saga-A", "alice", "2026-11-02T03:11:00.000Z");
const ALICE_ROWS = [ALICE_STARTED, ALICE_PAYMENT, ALICE_SCREEN, ALICE_JOURNEY];

const PROJECTION_A = {
  tenantId: "primary",
  workspaceId: "primary",
  chainId: "saga-A",
  jobKey: "saga",
  version: 1,
  status: "submitted" as const,
  stage: "payment",
  capabilityId: "saga",
  detail: "Saga submitted; payment leg starting.",
  resultJson: JSON.stringify({ sagaId: "saga-A", runRequestId: "saga-A", statusUrl: "/api/saga/saga-A/status" }),
  createdAtMs: Date.parse("2026-11-02T03:08:00.000Z"),
  updatedAtMs: Date.parse("2026-11-02T03:08:00.000Z"),
  provenanceWriter: "saga-entry-route",
  provenanceSourceDo: "saga",
  provenanceSourceVersion: "1",
};

describe("runFromSagaChain", () => {
  it("maps audit stages in order with goal family, unknown trigger, and owner attribution", () => {
    const run = runFromSagaChain({
      sagaId: "saga-A",
      jobs: [
        { stage: "saga", status: "submitted", detail: "saga.started" },
        { stage: "payment", status: "submitted", detail: "payment started" },
        { stage: "screen", status: "completed", detail: "screen completed" },
      ],
      projection: PROJECTION_A,
      triggeredBy: "alice",
      started: { family: "goal", rail: "stripe", runRequestId: "saga-A" },
    });
    expect(run).not.toBeNull();
    expect(run!.id).toBe("saga-A");
    expect(run!.runId).toBe("saga-A");
    expect(run!.family).toBe("goal");
    expect(run!.source).toBe("job-chain");
    expect(run!.title).toContain("Saga");
    // Trigger is never guessed: audit payloads carry no trigger field.
    expect(run!.trigger).toBe("unknown");
    expect(run!.triggerDetail).toBe("Not recorded by the source");
    expect(run!.triggeredBy).toBe("alice");
    expect(run!.status).toBe("running");
    expect(run!.startedAt).toBe("2026-11-02T03:08:00.000Z");
    expect(run!.finishedAt).toBeNull();
    expect(run!.stageCount).toBe(3);
    expect(run!.completedStages).toBe(1);
    expect(run!.failedStages).toBe(0);
    expect(run!.stages.map((s) => s.stage)).toEqual(["saga", "payment", "screen"]);
  });

  it("completes on a SUCCESS ended code with finishedAt and outcomeCode output", () => {
    const run = runFromSagaChain({
      sagaId: "saga-B",
      jobs: [
        { stage: "saga", status: "submitted", detail: "saga.started", updatedAtMs: Date.parse("2026-11-02T03:08:00.000Z") },
        { stage: "done", status: "completed", detail: "SUCCESS_TRADE_SETTLED", updatedAtMs: Date.parse("2026-11-02T04:00:00.000Z") },
      ],
      projection: null,
      triggeredBy: "alice",
      endedCode: "SUCCESS_TRADE_SETTLED",
      endedAtMs: Date.parse("2026-11-02T04:00:00.000Z"),
      started: { family: "goal", runRequestId: "saga-B" },
    });
    expect(run!.status).toBe("completed");
    expect(run!.finishedAt).toBe("2026-11-02T04:00:00.000Z");
    expect(run!.durationMs).toBeGreaterThan(0);
    expect((run!.outputs as Record<string, unknown>).outcomeCode).toBe("SUCCESS_TRADE_SETTLED");
    expect(run!.error).toBeNull();
  });

  it("fails on a non-SUCCESS ended code with the code as the error", () => {
    const run = runFromSagaChain({
      sagaId: "saga-B",
      jobs: [{ stage: "done", status: "failed", detail: "GATE_DENIED" }],
      projection: null,
      triggeredBy: "alice",
      endedCode: "GATE_DENIED",
      endedAtMs: Date.parse("2026-11-02T04:00:00.000Z"),
    });
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("GATE_DENIED");
  });

  it("fails on a failed stage even without an ended row", () => {
    const run = runFromSagaChain({
      sagaId: "saga-C",
      jobs: [
        { stage: "saga", status: "submitted", detail: "saga.started" },
        { stage: "screen", status: "failed", detail: "screen failed" },
      ],
      projection: null,
      triggeredBy: "alice",
    });
    expect(run!.status).toBe("failed");
  });

  it("falls back to the projection submitted stage when the audit mapping yields nothing", () => {
    const run = runFromSagaChain({
      sagaId: "saga-D",
      jobs: [],
      projection: PROJECTION_A,
      triggeredBy: "alice",
    });
    expect(run).not.toBeNull();
    expect(run!.stageCount).toBe(1);
    expect(run!.stages[0].stage).toBe("payment");
    expect(run!.stages[0].status).toBe("submitted");
    expect(run!.stages[0].detail).toBe("Saga submitted; payment leg starting.");
  });

  it("returns null when there are no stages and no projection", () => {
    const run = runFromSagaChain({
      sagaId: "saga-E",
      jobs: [],
      projection: null,
      triggeredBy: "alice",
    });
    expect(run).toBeNull();
  });

  it("redacts secret-shaped keys in stage outputs and never invents trade intent inputs", () => {
    const run = runFromSagaChain({
      sagaId: "saga-A",
      jobs: [
        {
          stage: "screen",
          status: "completed",
          detail: "screen completed",
          resultJson: { sagaId: "saga-A", apiKey: "should-be-redacted", matched: 3 },
        },
      ],
      projection: null,
      triggeredBy: "alice",
      started: { family: "goal", rail: "stripe", runRequestId: "saga-A" },
    });
    const output = run!.stages[0].output as Record<string, unknown>;
    expect(output.apiKey).toBe("[redacted]");
    expect(output.matched).toBe(3);
    const inputs = run!.inputs as Record<string, unknown>;
    expect(inputs.family).toBe("goal");
    expect(inputs.rail).toBe("stripe");
    expect(inputs).not.toHaveProperty("tradeIntent");
    expect(inputs).not.toHaveProperty("screenerCommand");
  });
});

describe("buildSagaChainRuns", () => {
  it("lists only the session user's chains with stages from their audit rows", () => {
    const bobRow = auditRow("saga.started", "saga-bob", "bob", "2026-11-02T03:09:00.000Z");
    const runs = buildSagaChainRuns({
      auditRows: [...ALICE_ROWS, bobRow],
      projections: new Map([["saga-A", PROJECTION_A]]),
      userLogin: "alice",
    });
    expect(runs.map((r) => r.id)).toEqual(["saga-A"]);
    expect(runs[0].stages.map((s) => s.stage)).toEqual(["saga", "payment", "screen", "journey"]);
    expect(runs[0].triggeredBy).toBe("alice");
  });

  it("skips a chain whose audit rows map to nothing and which has no projection", () => {
    const weird = auditRow("saga.some_future_type", "saga-weird", "alice", "2026-11-02T03:12:00.000Z");
    const runs = buildSagaChainRuns({
      auditRows: [weird],
      projections: new Map(),
      userLogin: "alice",
    });
    expect(runs).toEqual([]);
  });

  it("shows the projection submitted stage for a chain whose audit rows map to nothing", () => {
    const weird = auditRow("saga.some_future_type", "saga-weird", "alice", "2026-11-02T03:12:00.000Z");
    const runs = buildSagaChainRuns({
      auditRows: [weird],
      projections: new Map([
        [
          "saga-weird",
          { ...PROJECTION_A, chainId: "saga-weird", resultJson: JSON.stringify({ sagaId: "saga-weird" }) },
        ],
      ]),
      userLogin: "alice",
    });
    expect(runs.map((r) => r.id)).toEqual(["saga-weird"]);
    expect(runs[0].stageCount).toBe(1);
    expect(runs[0].stages[0].stage).toBe("payment");
  });

  it("ignores non-saga projection rows passed for a chain", () => {
    const runs = buildSagaChainRuns({
      auditRows: ALICE_ROWS,
      projections: new Map([
        ["saga-A", { ...PROJECTION_A, jobKey: "not-saga" }],
      ]),
      userLogin: "alice",
    });
    expect(runs.map((r) => r.id)).toEqual(["saga-A"]);
    // Without a saga projection row, startedAt falls back to the earliest audit row.
    expect(runs[0].startedAt).toBe("2026-11-02T03:08:00.000Z");
  });
});

function fakeAuditStub(rows: AuditRow[] | Error) {
  return {
    fetch: async () => {
      if (rows instanceof Error) throw rows;
      return Response.json({ events: rows });
    },
  };
}

function handlerCtx(overrides: Record<string, unknown> = {}) {
  const sql = new MockSqlStorage();
  return {
    ctx: {
      ensureTables: () => sql,
      userLogin: "alice",
      env: {},
      ...overrides,
    } as never,
    sql,
  };
}

function getRequest(path = "/api/workflow-runs"): Request {
  return new Request(`https://agent.internal${path}`, { method: "GET" });
}

describe("handleWorkflowRunsRoutes saga merge", () => {
  it("merges saga runs into the list, newest first, within the limit", async () => {
    const { ctx } = handlerCtx({
      sagaAuditStub: fakeAuditStub(ALICE_ROWS),
      sagaProjectionReader: { listJobsForChain: async () => [PROJECTION_A] },
      sagaTenantId: "primary",
    });
    const res = await handleWorkflowRunsRoutes(getRequest(), new URL("https://agent.internal/api/workflow-runs"), "/api/workflow-runs", "session-1", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as { runs: Array<{ id: string }>; storeErrors?: Record<string, string> };
    expect(body.runs.map((r) => r.id)).toContain("saga-A");
    expect(body.storeErrors?.saga).toBeUndefined();
    expect(body.storeErrors?.sagaProjection).toBeUndefined();
  });

  it("names a saga audit failure in storeErrors without hiding other runs", async () => {
    const { ctx, sql } = handlerCtx({
      sagaAuditStub: fakeAuditStub(new Error("audit boom")),
    });
    sql.exec(
      "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "job-1",
      "session-1",
      "http.request",
      "Stock screen",
      "completed",
      JSON.stringify({ method: "POST", pathAndQuery: "/etrade/screen" }),
      null,
      null,
      "2026-11-02T02:00:00.000Z",
      "2026-11-02T02:00:00.000Z",
      "2026-11-02T02:00:00.000Z",
      "2026-11-02T02:01:00.000Z",
      null,
      "main",
      null,
      null,
      "generate",
      "chain-1",
    );
    const res = await handleWorkflowRunsRoutes(getRequest(), new URL("https://agent.internal/api/workflow-runs"), "/api/workflow-runs", "session-1", ctx);
    const body = (await res!.json()) as { runs: Array<{ id: string }>; storeErrors?: Record<string, string> };
    expect(body.storeErrors?.saga).toContain("audit boom");
    expect(body.runs.map((r) => r.id)).toContain("chain-1");
    expect(body.runs.map((r) => r.id)).not.toContain("saga-A");
  });

  it("names an unbound ORCHESTRATOR_AGENT in storeErrors without hiding other runs", async () => {
    const { ctx } = handlerCtx({ env: {} });
    const res = await handleWorkflowRunsRoutes(getRequest(), new URL("https://agent.internal/api/workflow-runs"), "/api/workflow-runs", "session-1", ctx);
    const body = (await res!.json()) as { storeErrors?: Record<string, string> };
    expect(body.storeErrors?.saga).toContain("ORCHESTRATOR_AGENT is not bound");
  });

  it("keeps a saga chain listed from audit when its projection read fails", async () => {
    const { ctx } = handlerCtx({
      sagaAuditStub: fakeAuditStub(ALICE_ROWS),
      sagaProjectionReader: {
        listJobsForChain: async () => {
          throw new Error("d1 down");
        },
      },
      sagaTenantId: "primary",
    });
    const res = await handleWorkflowRunsRoutes(getRequest(), new URL("https://agent.internal/api/workflow-runs"), "/api/workflow-runs", "session-1", ctx);
    const body = (await res!.json()) as { runs: Array<{ id: string }>; storeErrors?: Record<string, string> };
    expect(body.runs.map((r) => r.id)).toContain("saga-A");
    expect(body.storeErrors?.sagaProjection).toContain("d1 down");
  });

  it("skips saga reads entirely when no env is passed", async () => {
    const sql = new MockSqlStorage();
    const ctx = { ensureTables: () => sql, userLogin: "alice" } as never;
    const res = await handleWorkflowRunsRoutes(getRequest(), new URL("https://agent.internal/api/workflow-runs"), "/api/workflow-runs", "session-1", ctx);
    const body = (await res!.json()) as { storeErrors?: Record<string, string> };
    expect(body.storeErrors?.saga).toBeUndefined();
  });
});

describe("saga link resolves to a listed run", () => {
  it("the panel link target and the read surface agree on the saga id", () => {
    expect(sagaWorkflowRunsLink("saga-A")).toBe("?tab=workflow-runs&run=saga-A");
    const runs = buildSagaChainRuns({
      auditRows: ALICE_ROWS,
      projections: new Map([["saga-A", PROJECTION_A]]),
      userLogin: "alice",
    });
    expect(runs.map((r) => r.id)).toContain("saga-A");
  });
});
