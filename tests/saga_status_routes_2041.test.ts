/**
 * Issue #2041 S4 — saga status route (gap G-JOB-SURFACE).
 *
 * TDD: written before the route module. GET /api/saga/:sagaId/status
 * returns the panel's {jobs} shape (stage rows derived from saga
 * audit rows + live instance status/output), so the EXISTING
 * statusUrl pollers consume it unchanged — no new panel, no new
 * polling system. Owner-scoped: a saga with no audit rows for the
 * session user is 404 (no cross-user leak). The status route is
 * NOT flag-gated: a read path for one's own sagas must survive a
 * flag flip. The projection row (D1 shard jobs, chainId = sagaId)
 * makes the saga discoverable via /api/jobs/history?chainId=; it
 * is visibility-only — the audit row is the durable record.
 */
import { describe, expect, it } from "vitest";
import {
  handleSagaStatusRoutes,
  mapSagaAuditToJobs,
  recordSagaProjectionRow,
  type SagaStatusBinding,
  type SagaStatusStore,
} from "../src/agents/routes/sagaStatus";

function auditRow(
  type: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    agent: "saga",
    payload: {
      sagaId: "saga-1",
      runRequestId: "run-1",
      userLogin: "u1login",
      ...over,
    },
    created_at: "2026-10-31T00:00:00.000Z",
  };
}

/**
 * Fake SEARCH_AGENT stub: serves audit rows for the agent=saga
 * read (the audit API accepts agent without type, so the status
 * route does ONE read and filters by sagaId + session user).
 */
function fakeAuditStub(rows: Record<string, unknown>[]) {
  const requestedUrls: string[] = [];
  return {
    requestedUrls,
    stub: {
      async fetch(req: Request): Promise<Response> {
        requestedUrls.push(req.url);
        return new Response(JSON.stringify({ events: rows }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  };
}

function fakeBinding(status: { status: string; output?: unknown } | null) {
  const gets: string[] = [];
  const binding: SagaStatusBinding = {
    async get(id: string) {
      gets.push(id);
      if (status === null) throw new Error("instance not found");
      return {
        status: async () => status,
      };
    },
  };
  return { binding, gets };
}

function statusUrl(sagaId: string) {
  return new URL(`https://agent.internal/api/saga/${sagaId}/status`);
}

describe("mapSagaAuditToJobs (S4, #2041)", () => {
  it("maps saga audit rows to panel {jobs} stage rows in audit order", () => {
    const jobs = mapSagaAuditToJobs([
      auditRow("saga.started"),
      auditRow("saga.payment_started"),
      auditRow("saga.screen_completed"),
      auditRow("saga.journey_decided", {
        decision: "approved",
        decidingSurface: "panel",
      }),
      auditRow("saga.trade_proposed", {
        orderId: "order-1",
        tradeWorkflowId: "trade-wf-1",
      }),
      auditRow("saga.ended", { outcomeCode: "SUCCESS_SAGA_TRADE_SETTLED" }),
    ]);
    expect(jobs.map((j) => j.stage)).toEqual([
      "saga",
      "payment",
      "screen",
      "journey",
      "trade",
      "done",
    ]);
    const trade = jobs.find((j) => j.stage === "trade");
    expect(trade?.detail).toContain("order-1");
    const done = jobs.find((j) => j.stage === "done");
    expect(done?.status).toBe("completed");
    expect(done?.detail).toContain("SUCCESS_SAGA_TRADE_SETTLED");
  });

  it("a FAILURE ended row maps to failed, not completed", () => {
    const jobs = mapSagaAuditToJobs([
      auditRow("saga.started"),
      auditRow("saga.ended", { outcomeCode: "FAILURE_SAGA_TRADE_LEG_FAILED" }),
    ]);
    expect(jobs.find((j) => j.stage === "done")?.status).toBe("failed");
  });

  it("ignores rows for other sagas", () => {
    const jobs = mapSagaAuditToJobs(
      [
        auditRow("saga.started"),
        auditRow("saga.started", { sagaId: "saga-other" }),
      ],
      "saga-1",
    );
    expect(jobs).toHaveLength(1);
  });
});

describe("recordSagaProjectionRow (S4, #2041)", () => {
  it("writes one submitted projection row keyed by the saga id", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const store = {
      async recordJob(row: Record<string, unknown>) {
        rows.push(row);
      },
    } as unknown as SagaStatusStore;
    await recordSagaProjectionRow(store, {
      sagaId: "saga-1",
      runRequestId: "run-1",
      tenantId: "tenant-1",
      statusUrl: "/api/saga/saga-1/status",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chainId: "saga-1",
      jobKey: "saga",
      status: "submitted",
      stage: "payment",
    });
    // resultJson is the store's capped JSON string, not an object.
    const resultJson = JSON.parse(rows[0].resultJson as string) as Record<
      string,
      unknown
    >;
    expect(resultJson.statusUrl).toBe("/api/saga/saga-1/status");
    expect(resultJson.sagaId).toBe("saga-1");
  });
});

describe("handleSagaStatusRoutes (S4, #2041)", () => {
  it("returns null for non-matching paths", async () => {
    const res = await handleSagaStatusRoutes(
      new Request("https://agent.internal/api/saga", { method: "GET" }),
      new URL("https://agent.internal/api/saga"),
      "/api/saga",
      {},
      "u1login",
    );
    expect(res).toBeNull();
  });

  it("401 without a session login", async () => {
    const { stub } = fakeAuditStub({});
    const res = await handleSagaStatusRoutes(
      new Request(statusUrl("saga-1"), { method: "GET" }),
      statusUrl("saga-1"),
      "/api/saga/saga-1/status",
      {},
      null,
      { auditStub: stub },
    );
    expect(res?.status).toBe(401);
  });

  it("404 when no saga audit rows exist for the session user", async () => {
    const { stub } = fakeAuditStub([]);
    const res = await handleSagaStatusRoutes(
      new Request(statusUrl("saga-1"), { method: "GET" }),
      statusUrl("saga-1"),
      "/api/saga/saga-1/status",
      {},
      "u1login",
      { auditStub: stub },
    );
    expect(res?.status).toBe(404);
  });

  it("404 for a foreign saga (rows exist, but for another user)", async () => {
    const { stub } = fakeAuditStub([
      auditRow("saga.started", { userLogin: "someone-else" }),
    ]);
    const res = await handleSagaStatusRoutes(
      new Request(statusUrl("saga-1"), { method: "GET" }),
      statusUrl("saga-1"),
      "/api/saga/saga-1/status",
      {},
      "u1login",
      { auditStub: stub },
    );
    expect(res?.status).toBe(404);
  });

  it("200 with {jobs} rows + live instance status, and it is NOT flag-gated", async () => {
    const { stub, requestedUrls } = fakeAuditStub([
      auditRow("saga.started"),
      auditRow("saga.trade_proposed", {
        orderId: "order-1",
        tradeWorkflowId: "trade-wf-1",
      }),
    ]);
    const { binding } = fakeBinding({
      status: "running",
      output: undefined,
    });
    const res = await handleSagaStatusRoutes(
      new Request(statusUrl("saga-1"), { method: "GET" }),
      statusUrl("saga-1"),
      "/api/saga/saga-1/status",
      // Flag OFF on purpose: the read path must survive a flip.
      { FEATURE_FLAGS: JSON.stringify({ monetization: false }) },
      "u1login",
      { auditStub: stub, sagaBinding: binding },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    const jobs = body.jobs as Array<Record<string, unknown>>;
    expect(jobs.map((j) => j.stage)).toContain("trade");
    expect(body.instanceStatus).toBe("running");
    expect(body.tradeWorkflowId).toBe("trade-wf-1");
    // One agent-scoped read (never another agent's rows).
    expect(requestedUrls).toHaveLength(1);
    expect(new URL(requestedUrls[0]).searchParams.get("agent")).toBe("saga");
  });

  it("an ended instance surfaces its terminal output code", async () => {
    const { stub } = fakeAuditStub([
      auditRow("saga.started"),
      auditRow("saga.ended", { outcomeCode: "SUCCESS_SAGA_TRADE_SETTLED" }),
    ]);
    const { binding } = fakeBinding({
      status: "complete",
      output: { status: "trade_settled", code: "SUCCESS_SAGA_TRADE_SETTLED" },
    });
    const res = await handleSagaStatusRoutes(
      new Request(statusUrl("saga-1"), { method: "GET" }),
      statusUrl("saga-1"),
      "/api/saga/saga-1/status",
      {},
      "u1login",
      { auditStub: stub, sagaBinding: binding },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.instanceStatus).toBe("complete");
    expect(body.outcomeCode).toBe("SUCCESS_SAGA_TRADE_SETTLED");
  });
});
