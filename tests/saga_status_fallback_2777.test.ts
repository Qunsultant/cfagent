/**
 * Issue #2777 — saga status route fallback to the projection row.
 *
 * The status route answers from saga audit rows only, so a
 * just-created saga 404s until the workflow instance writes its
 * first audit row. The entry route writes an AgentDB projection
 * row synchronously at start (chainId = sagaId, status
 * submitted); the fallback answers from that row — tenant-scoped
 * exactly as /api/jobs/history reads it (listJobsForChain filters
 * tenantId AND chainId at the SQL layer) — and only when zero
 * audit rows match. Audit rows win the moment they exist.
 */
import { describe, expect, it } from "vitest";
import {
  handleSagaStatusRoutes,
} from "../src/agents/routes/sagaStatus";
import type { ShardJobRow } from "../src/data/shardJobPorts";

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

function fakeAuditStub(rows: Record<string, unknown>[]) {
  return {
    async fetch(): Promise<Response> {
      return new Response(JSON.stringify({ events: rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function projectionRow(over: Partial<ShardJobRow> = {}): ShardJobRow {
  return {
    tenantId: "tenant-1",
    workspaceId: "tenant-1",
    chainId: "saga-1",
    jobKey: "saga",
    version: 1,
    status: "submitted",
    stage: "payment",
    capabilityId: "saga",
    detail: "Saga submitted; payment leg starting.",
    resultJson: JSON.stringify({ sagaId: "saga-1" }),
    createdAtMs: 1761984000000,
    updatedAtMs: 1761984000000,
    provenanceWriter: "saga-entry-route",
    provenanceSourceDo: "saga",
    provenanceSourceVersion: "1",
    ...over,
  };
}

function fakeProjectionReader(
  rows: ShardJobRow[],
  opts: { throws?: boolean } = {},
) {
  const calls: Array<{ tenantId: string; chainId: string }> = [];
  return {
    calls,
    reader: {
      async listJobsForChain(
        tenantId: string,
        chainId: string,
      ): Promise<ShardJobRow[]> {
        calls.push({ tenantId, chainId });
        if (opts.throws) throw new Error("store down");
        return rows;
      },
    },
  };
}

function statusUrl(sagaId: string) {
  return new URL(`https://agent.internal/api/saga/${sagaId}/status`);
}

async function getStatus(
  sagaId: string,
  auditRows: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return handleSagaStatusRoutes(
    new Request(statusUrl(sagaId), { method: "GET" }),
    statusUrl(sagaId),
    `/api/saga/${sagaId}/status`,
    {},
    "u1login",
    { auditStub: fakeAuditStub(auditRows), ...overrides } as never,
  );
}

describe("saga status projection fallback (#2777)", () => {
  it("projection-only saga returns 200 with the submitted stage", async () => {
    const { calls, reader } = fakeProjectionReader([projectionRow()]);
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: reader,
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    const jobs = body.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      stage: "payment",
      status: "submitted",
      detail: "Saga submitted; payment leg starting.",
    });
    // Tenant-scoped exactly as the jobs/history read: the session
    // tenant and the saga chain are both passed to the store.
    expect(calls).toEqual([{ tenantId: "tenant-1", chainId: "saga-1" }]);
  });

  it("404 when neither audit rows nor a projection row exist", async () => {
    const { reader } = fakeProjectionReader([]);
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: reader,
    });
    expect(res?.status).toBe(404);
  });

  it("audit rows win once present; the projection reader is never consulted", async () => {
    const { calls, reader } = fakeProjectionReader([projectionRow()]);
    const res = await getStatus("saga-1", [auditRow("saga.started")], {
      tenantId: "tenant-1",
      projectionReader: reader,
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    const jobs = body.jobs as Array<Record<string, unknown>>;
    expect(jobs.map((j) => j.stage)).toEqual(["saga"]);
    expect(calls).toHaveLength(0);
  });

  it("a projection row for another jobKey is ignored", async () => {
    const { reader } = fakeProjectionReader([
      projectionRow({ jobKey: "goal" }),
    ]);
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: reader,
    });
    expect(res?.status).toBe(404);
  });

  it("a failing projection read degrades to 404, never 503", async () => {
    const { reader } = fakeProjectionReader([], { throws: true });
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: reader,
    });
    expect(res?.status).toBe(404);
  });

  it("no projection reader configured keeps the old 404", async () => {
    const res = await getStatus("saga-1", []);
    expect(res?.status).toBe(404);
  });

  it("the fallback never overrides a foreign saga's 404 with another tenant's row", async () => {
    // The fake enforces tenant scoping the way the D1 adapter
    // does (tenantId AND chainId): a row stored under another
    // tenant is invisible to this session's tenant.
    const tenantScoped = {
      async listJobsForChain(
        tenantId: string,
        chainId: string,
      ): Promise<ShardJobRow[]> {
        if (tenantId !== "tenant-1" || chainId !== "saga-1") return [];
        return [projectionRow()];
      },
    };
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-other",
      projectionReader: tenantScoped,
    });
    expect(res?.status).toBe(404);
  });
});
