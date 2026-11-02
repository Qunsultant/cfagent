/**
 * Phase 5 Slice 3 (issue #2000) — the trace surfacing route.
 *
 * GET /api/traces?traceId= : the read surface for the mesh
 * trace spine. Pure-handler tests (mirroring the jobs/history
 * handler split): the handler decides status codes and shape;
 * server wiring supplies auth, tenancy, and the reader.
 *
 * Decision order: 401 (no session) → 405 (non-GET) → 400
 * (missing/malformed traceId) → 503 (store unbound) → 404
 * (no hops survive the tenant filter) → 200 (assembly).
 *
 * Tenancy mirrors the existing MCP read surface
 * (traceForMcp): hops recorded under a DIFFERENT tenant are
 * excluded before assembly; a hop whose tenant is null — an
 * ingress boundary with no scope — stays visible, since it
 * carries no tenant material.
 */
import { describe, expect, it } from "vitest";
import type { MeshTraceHop } from "../src/data/meshTracePorts";
import {
  createTraceReader,
  handleMeshTraceRoute,
} from "../src/data/meshTraceRoute";
import { assembleMeshTrace } from "../src/observability/meshTrace";

const TRACE_ID = "a".repeat(32);
const OTHER_TRACE = "c".repeat(32);

function hop(overrides: Partial<MeshTraceHop> = {}): MeshTraceHop {
  return {
    traceId: TRACE_ID,
    spanId: "d".repeat(16),
    kind: "workflow-step",
    operation: "execute-screen",
    timestampMs: 1760000000000,
    tenantId: "tenant-test",
    caller: "octocat",
    agent: "ScreenerScreenWorkflow",
    jobId: "job-1",
    ...overrides,
  };
}

describe("handleMeshTraceRoute decisions", () => {
  const assembly = assembleMeshTrace(TRACE_ID, [hop()], []);

  it("401 without a session, without touching the reader", async () => {
    let read = false;
    const res = await handleMeshTraceRoute({
      session: null,
      method: "GET",
      traceId: TRACE_ID,
      readTrace: async () => {
        read = true;
        return assembly;
      },
    });
    expect(res.status).toBe(401);
    expect(read).toBe(false);
  });

  it("405 for a non-GET method", async () => {
    const res = await handleMeshTraceRoute({
      session: {},
      method: "POST",
      traceId: TRACE_ID,
      readTrace: async () => assembly,
    });
    expect(res.status).toBe(405);
  });

  it("400 for a missing or malformed traceId, never normalized into a lookup", async () => {
    for (const bad of ["", "xyz", "A".repeat(32), "a".repeat(31), "a".repeat(33)]) {
      const res = await handleMeshTraceRoute({
        session: {},
        method: "GET",
        traceId: bad,
        readTrace: async () => {
          throw new Error("reader must not run for a malformed id");
        },
      });
      expect(res.status).toBe(400);
    }
  });

  it("503 when the reader reports the store unbound", async () => {
    const res = await handleMeshTraceRoute({
      session: {},
      method: "GET",
      traceId: TRACE_ID,
      readTrace: async () => null,
    });
    expect(res.status).toBe(503);
  });

  it("404 when no hops survive (unknown trace, or another tenant's trace)", async () => {
    const empty = assembleMeshTrace(OTHER_TRACE, [], []);
    const res = await handleMeshTraceRoute({
      session: {},
      method: "GET",
      traceId: OTHER_TRACE,
      readTrace: async () => empty,
    });
    expect(res.status).toBe(404);
  });

  it("200 with the assembly: traceId, complete, hops, breaks, jobIds", async () => {
    const res = await handleMeshTraceRoute({
      session: {},
      method: "GET",
      traceId: TRACE_ID,
      readTrace: async () => assembly,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.traceId).toBe(TRACE_ID);
    expect(body.complete).toBe(false); // workflow-step hop alone: entry hop missing, break named
    expect(body.breaks).toEqual([
      "entry hop missing: no ingress/turn/door/a2a hop recorded for this trace",
    ]);
    expect(body.jobIds).toEqual(["job-1"]);
    expect((body.hops as Array<Record<string, unknown>>).map((h) => h.operation)).toEqual([
      "execute-screen",
    ]);
  });
});

describe("createTraceReader", () => {
  it("null when AGENT_DB is unbound (isolate-local hops are never served as a trace)", async () => {
    const read = createTraceReader({}, "tenant-test");
    await expect(read(TRACE_ID)).resolves.toBeNull();
  });

  it("excludes another tenant's hops, keeps null-tenant hops (the MCP rule)", async () => {
    const read = createTraceReader(
      { AGENT_DB: {} },
      "tenant-test",
      {
        readHops: async () => [
          hop({ spanId: "1".repeat(16), tenantId: "tenant-test" }),
          hop({ spanId: "2".repeat(16), tenantId: "tenant-other" }),
          hop({ spanId: "3".repeat(16), tenantId: null }),
        ],
        readJobs: async () => [],
      },
    );
    const assembly = await read(TRACE_ID);
    expect(assembly).not.toBeNull();
    expect(assembly!.hops.map((h) => h.spanId).sort()).toEqual([
      "1".repeat(16),
      "3".repeat(16),
    ]);
  });

  it("folds projection rows for the trace's jobIds into the assembly", async () => {
    const row = {
      chainId: "job-1",
      jobKey: "job-1",
      stage: "feed",
      status: "completed",
      version: 1,
      updatedAtMs: 1760000001000,
      tenantId: "tenant-test",
      provenanceSourceDo: "ScreenerWorkflow",
    };
    const read = createTraceReader(
      { AGENT_DB: {} },
      "tenant-test",
      {
        readHops: async () => [hop()],
        readJobs: async (_tenantId, chainId) =>
          chainId === "job-1" ? [row as never] : [],
      },
    );
    const assembly = await read(TRACE_ID);
    expect(assembly).not.toBeNull();
    expect(assembly!.hops.some((h) => h.kind === "projection")).toBe(true);
  });

  it("a failing job read degrades to no rows, never a throw", async () => {
    const read = createTraceReader(
      { AGENT_DB: {} },
      "tenant-test",
      {
        readHops: async () => [hop()],
        readJobs: async () => {
          throw new Error("store down");
        },
      },
    );
    const assembly = await read(TRACE_ID);
    expect(assembly).not.toBeNull();
    expect(assembly!.hops.map((h) => h.operation)).toEqual(["execute-screen"]);
  });
});
