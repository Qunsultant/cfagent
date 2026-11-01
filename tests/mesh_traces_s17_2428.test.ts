/**
 * Issue #2428 (Agent Mesh S17, #2225 G13a) — unified traces: one
 * trace spine across doors, workflows, and agents.
 *
 * The mesh trace id IS the W3C trace id (#1743): minted or
 * continued at ingress, carried through the chat turn context,
 * the mesh door calls, the async-job queue, workflow start
 * params, workflow step events, the A2A edge, and projection /
 * ledger writes — additive fields only. These pins drive the
 * REAL S8 chat port path (InMemoryWorkflowAdapter running the
 * real parent/shard flows, fakes only at the binding seams, per
 * the programme acceptance rule) and assert ONE trace id across
 * turn → workflow start → workflow steps → shard projection →
 * read-surface assembly; that an A2A call's trace reaches its
 * ledger attribution; and that the read surface reports a
 * deliberately broken chain as partial with the break named.
 */
import { describe, expect, it } from "vitest";
import {
  nlqStockScreenPort,
  type NlqPortsContext,
} from "../src/agents/orchestrator/nlqPorts";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { InMemoryMeshTraceStore } from "../src/data/inMemoryMeshTraceAdapter";
import {
  MESH_TRACE_HOP_KINDS,
  type MeshTraceHop,
} from "../src/data/meshTracePorts";
import {
  assembleMeshTrace,
  traceIdOfTraceparent,
} from "../src/observability/meshTrace";
import {
  formatTraceparent,
  newTraceContext,
} from "../src/observability/observabilityPorts";
import type {
  ScreenerWorkflowDeps,
  ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import { recordWorkflowTraceHop } from "../src/observability/meshTrace";
import type {
  WorkflowJobCommand,
  WorkflowPort,
} from "../src/workflows/workflowPorts";
import { MockSqlStorage } from "./mock-sql";

/* ------------------------------------------------------------------ */
/* The S8-path harness (mirrors tests/mesh_g2_chat_screen_workflow)    */
/* ------------------------------------------------------------------ */

const LOGIN = "alice";

function fullResult(universe: string) {
  return {
    timestamp: new Date().toISOString(),
    trigger: "manual",
    provider: "etrade",
    universe,
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 2,
    opportunities: [
      { symbol: "NVDA", companyName: "NVIDIA", lastPrice: 190, changePercent: 2.1 },
      { symbol: "AMD", companyName: "AMD", lastPrice: 160, changePercent: 1.2 },
    ],
    allStocks: [
      { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, changePercent: 2.1, source: "etrade" },
      { symbol: "AMD", companyName: "AMD", sector: "Technology", lastPrice: 160, changePercent: 1.2, source: "etrade" },
    ],
    discoveryMessage: `Discovered listings for ${universe}`,
    filterSummary: "minPrice >= 10",
    rejections: [{ symbol: "XYZ", reason: "below min price" }],
    pdfKey: `screener/${universe}/report.pdf`,
    userLogin: LOGIN,
  };
}

interface Harness {
  ctx: NlqPortsContext;
  traceStore: InMemoryMeshTraceStore;
  shardStore: InMemoryShardJobAdapter;
  startedCommands: WorkflowJobCommand[];
  traceparent: string;
  traceId: string;
}

function makeHarness(): Harness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const traceStore = new InMemoryMeshTraceStore();
  const startedCommands: WorkflowJobCommand[] = [];
  const trace = newTraceContext();
  const traceparent = formatTraceparent(trace);

  const reportCtx = {
    env: {},
    ensureTables: () => sql,
  } as unknown as ReportDispatchContext;

  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        const full = fullResult(req.universe ?? "TECH");
        const summary: ShardScreenResult = {
          success: full.success,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: full.totalScanned,
          expectedCount: full.totalScanned,
          matchedCount: full.matchedCount,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full,
        };
        return summary;
      },
    },
    shardStore,
    storeReport: async (payload) => {
      await persistScreenerReportCanonical(
        reportCtx,
        payload as Parameters<typeof persistScreenerReportCanonical>[1],
      );
    },
    deliverOutcome: async () => {},
    nowMs: () => Date.now(),
    // The production wiring (screenerWorkflow.ts buildDeps) is
    // this same helper over the env-resolved store.
    traceHop: (command, event) => recordWorkflowTraceHop(traceStore, command, event),
  };
  const adapter = new InMemoryWorkflowAdapter(deps);
  const recordingPort: WorkflowPort = {
    start: async (command) => {
      startedCommands.push(command);
      return adapter.start(command);
    },
    status: (workflowId) => adapter.status(workflowId),
  };

  const ctx: NlqPortsContext = {
    schedule: async () => ({}),
    scheduleEvery: async () => ({}),
    cancelSchedule: async () => true,
    listSchedules: async () => [],
    getScreenerAgent: () => {
      throw new Error("direct ScreenerAgent path must not be used when the workflow port is available");
    },
    getSocialBriefStore: () => null,
    env: {} as NlqPortsContext["env"],
    ensureTables: () => sql as never,
    workflowPort: recordingPort,
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    // S17 seams: the turn's traceparent + the hop store.
    traceparent: () => traceparent,
    traceStore,
  };
  return { ctx, traceStore, shardStore, startedCommands, traceparent, traceId: trace.traceId };
}

/* ------------------------------------------------------------------ */
/* Acceptance: ONE trace id across the whole chat screen path          */
/* ------------------------------------------------------------------ */

describe("issue #2428 — one trace across the chat screen path", () => {
  it("turn → workflow start → steps → projection → assembly share one trace id", async () => {
    const h = makeHarness();
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({
      filters: { universe: "NASDAQ100", minPrice: 10 } as never,
      userLogin: LOGIN,
    });
    expect(result.success).toBe(true);

    // The workflow command carries the turn's traceparent (the
    // #1743 field, finally producer-stamped).
    expect(h.startedCommands).toHaveLength(1);
    const command = h.startedCommands[0];
    expect(command.traceparent).toBe(h.traceparent);
    expect(traceIdOfTraceparent(command.traceparent)).toBe(h.traceId);

    // Hops were recorded under that one trace id: workflow start
    // (the port), workflow steps (the real flows), projection.
    const hops = await h.traceStore.hopsFor(h.traceId);
    const kinds = hops.map((hop) => hop.kind);
    expect(kinds).toContain("workflow-start");
    expect(kinds).toContain("workflow-step");
    expect(kinds).toContain("projection");
    for (const hop of hops) {
      expect(hop.traceId).toBe(h.traceId);
    }
    const start = hops.find((hop) => hop.kind === "workflow-start");
    expect(start?.jobId).toBe(command.jobId);
    expect(start?.caller).toBe(LOGIN);

    // The read surface assembles the same trace: ordered hops,
    // the projection rows joined by jobId, no breaks.
    const rows = await h.shardStore.listJobsForChain(command.tenantId ?? "", command.jobId);
    expect(rows.length).toBeGreaterThan(0);
    const assembly = assembleMeshTrace(h.traceId, hops, rows);
    expect(assembly.complete).toBe(true);
    expect(assembly.breaks).toEqual([]);
    expect(assembly.jobIds).toContain(command.jobId);
    const times = assembly.hops.map((hop) => hop.timestampMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(assembly.hops.some((hop) => hop.kind === "projection")).toBe(true);
  });

  it("a command without a traceparent records no step hops (the recorded break, not a fabricated link)", async () => {
    const h = makeHarness();
    const ctx: NlqPortsContext = { ...h.ctx, traceparent: undefined, traceStore: h.traceStore };
    const port = nlqStockScreenPort(ctx);
    const result = await port.runScreen({
      filters: { universe: "NASDAQ100", minPrice: 10 } as never,
      userLogin: LOGIN,
    });
    expect(result.success).toBe(true);
    expect(h.startedCommands[0].traceparent).toBeUndefined();
    const all = await h.traceStore.hopsFor(h.traceId);
    expect(all).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Assembly: broken chains are honestly partial                        */
/* ------------------------------------------------------------------ */

describe("issue #2428 — trace assembly honesty", () => {
  const base: MeshTraceHop = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    kind: "turn",
    operation: "chat.turn",
    timestampMs: 1_000,
  };

  it("reports a deliberately broken chain as partial with the breaks named", () => {
    const hops: MeshTraceHop[] = [
      base,
      { ...base, spanId: "c".repeat(16), kind: "workflow-start", operation: "screener.start", timestampMs: 2_000, jobId: "screener:chat:TECH:x:1" },
    ];
    const assembly = assembleMeshTrace(base.traceId, hops, []);
    expect(assembly.complete).toBe(false);
    expect(assembly.breaks.some((b) => b.includes("workflow-step"))).toBe(true);
    expect(assembly.breaks.some((b) => b.includes("projection"))).toBe(true);
  });

  it("an unknown trace assembles empty and incomplete, never fabricated", () => {
    const assembly = assembleMeshTrace("d".repeat(32), [], []);
    expect(assembly.complete).toBe(false);
    expect(assembly.hops).toEqual([]);
    expect(assembly.breaks.length).toBeGreaterThan(0);
  });

  it("hop recording is idempotent on (traceId, spanId) — durable replay converges", async () => {
    const store = new InMemoryMeshTraceStore();
    await store.record(base);
    await store.record({ ...base, operation: "chat.turn.replayed" });
    const hops = await store.hopsFor(base.traceId);
    expect(hops).toHaveLength(1);
    expect(hops[0].operation).toBe("chat.turn");
  });
});

/* ------------------------------------------------------------------ */
/* A2A: the trace reaches the ledger attribution                      */
/* ------------------------------------------------------------------ */

describe("issue #2428 — A2A trace propagation", () => {
  it("the edge continues the caller's traceparent, records the a2a hop with S16 attribution, and hands the trace to the agent", async () => {
    const { handleA2A } = await import("../src/a2a/index");
    const { meshTraceStoreForEnv } = await import("../src/data/createMeshTracePorts");
    const seen: unknown[] = [];
    const env = {
      A2A_TOKEN_PAYMENTS: "per-agent-secret",
      PAYMENTS_AGENT: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          handleA2A: async (body: unknown, origin: string, attribution: unknown, traceparent?: string) => {
            seen.push({ body, origin, attribution, traceparent });
            return { text: "ok", data: { ok: true } };
          },
        }),
      },
    } as never;
    const trace = newTraceContext();
    const traceparent = formatTraceparent(trace);
    const res = await handleA2A(
      new Request("https://example.com/a2a/payments", {
        method: "POST",
        headers: {
          authorization: "Bearer per-agent-secret",
          traceparent,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/send", params: { operation: "payments.budget_check" } }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const call = seen[0] as { attribution: { caller: string }; traceparent?: string };
    expect(call.traceparent).toBe(traceparent);
    expect(call.attribution.caller).toBe("a2a-credential:payments");

    const hops = await meshTraceStoreForEnv(env as never).hopsFor(trace.traceId);
    const a2aHop = hops.find((hop) => hop.kind === "a2a");
    expect(a2aHop).toBeDefined();
    expect(a2aHop?.caller).toBe("a2a-credential:payments");
    expect(a2aHop?.agent).toBe("payments");
  });

  it("the payments dispatch threads the trace id into the process request beside the caller", async () => {
    const { dispatchPaymentsA2A } = await import("../src/agents/payments/a2aDispatch");
    const seen: Array<Record<string, unknown>> = [];
    const trace = newTraceContext();
    const result = await dispatchPaymentsA2A(
      {} as never,
      {
        operation: "payments.process",
        agentId: "orchestrator",
        op: "nlq.execute",
        amountCents: 25,
        idempotencyKey: "trace-test-1",
        paymentProof: "proof",
      },
      {
        executor: {
          budgetCheck: async () => ({ allowed: true }),
          todaySpent: async () => 0,
          listPayments: async () => [],
          processPaidRequest: async (req: Record<string, unknown>) => {
            seen.push(req);
            return { id: "pay_1" };
          },
        } as never,
        attribution: { surface: "payments", caller: "a2a-credential:payments", credential: "per-agent" } as never,
        traceparent: formatTraceparent(trace),
      },
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toBe("a2a-credential:payments");
    expect(seen[0].traceId).toBe(trace.traceId);
  });
});

/* ------------------------------------------------------------------ */
/* Read surface: agentdb.trace.get                                     */
/* ------------------------------------------------------------------ */

describe("issue #2428 — agentdb.trace.get read surface", () => {
  it("assembles a trace from the hop store + job history, tenant-scoped", async () => {
    const { traceForMcp } = await import("../src/mcps/openaimp/agentDbReadCommands");
    const traceStore = new InMemoryMeshTraceStore();
    const trace = newTraceContext();
    const jobId = "screener:chat:NASDAQ100:2026-10-30T00:00:00.000Z:abcd1234";
    const hop = (partial: Partial<MeshTraceHop>): MeshTraceHop => ({
      traceId: trace.traceId,
      spanId: "e".repeat(16),
      kind: "turn",
      operation: "chat.turn",
      timestampMs: 1_000,
      tenantId: "tenant-1",
      ...partial,
    });
    await traceStore.record(hop({}));
    await traceStore.record(hop({ spanId: "f".repeat(16), kind: "workflow-start", operation: "screener.start", timestampMs: 2_000, jobId, caller: LOGIN }));
    await traceStore.record(hop({ spanId: "1".repeat(16), kind: "workflow-step", operation: "execute-screen", timestampMs: 3_000, jobId }));
    await traceStore.record(hop({ spanId: "2".repeat(16), kind: "projection", operation: "project-shard", timestampMs: 4_000, jobId }));

    const result = await traceForMcp({} as never, trace.traceId, {
      tenantId: "tenant-1",
      readHops: (id) => traceStore.hopsFor(id),
      readJobs: async () => [],
    });
    expect(result.traceId).toBe(trace.traceId);
    expect(result.complete).toBe(true);
    expect(result.hops.map((h) => h.kind)).toEqual(["turn", "workflow-start", "workflow-step", "projection"]);
    expect(result.jobIds).toContain(jobId);
  });

  it("hides hops recorded under another tenant (tenancy at the repository boundary)", async () => {
    const { traceForMcp } = await import("../src/mcps/openaimp/agentDbReadCommands");
    const traceStore = new InMemoryMeshTraceStore();
    const trace = newTraceContext();
    await traceStore.record({
      traceId: trace.traceId,
      spanId: "e".repeat(16),
      kind: "turn",
      operation: "chat.turn",
      timestampMs: 1_000,
      tenantId: "tenant-2",
    });
    const result = await traceForMcp({} as never, trace.traceId, {
      tenantId: "tenant-1",
      readHops: (id) => traceStore.hopsFor(id),
      readJobs: async () => [],
    });
    expect(result.hops).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it("is registered in the catalog with exactly one read scope", async () => {
    const { McpToolFactory } = await import("../src/mcps/openaimp/commands");
    const { MCP_TOOL_SCOPES } = await import("../src/mcps/openaimp/mcpPermissionPorts");
    const names = McpToolFactory.getAllTools().map((t) => t.name);
    expect(names).toContain("agentdb.trace.get");
    expect(MCP_TOOL_SCOPES["agentdb.trace.get"]).toBe("mcp:read");
  });
});

/* ------------------------------------------------------------------ */
/* Registry + migration pins                                           */
/* ------------------------------------------------------------------ */

describe("issue #2428 — registry spine + migration pins", () => {
  it("the registry spine record covers every hop kind and names its breaks", async () => {
    const { MESH_TRACE_SPINE, MESH_REGISTRY } = await import("../src/agents/registry");
    expect(MESH_REGISTRY.traceSpine).toBe(MESH_TRACE_SPINE);
    const carried = MESH_TRACE_SPINE.filter((e) => e.status === "carried").map((e) => e.hop);
    for (const kind of MESH_TRACE_HOP_KINDS) {
      expect(carried, kind).toContain(kind);
    }
    const breaks = MESH_TRACE_SPINE.filter((e) => e.status === "break");
    expect(breaks.length).toBeGreaterThanOrEqual(3);
    for (const b of breaks) {
      expect(b.consequence && b.consequence.length).toBeGreaterThan(20);
    }
  });

  it("migration 0023 is registered and creates the hop table (0030 is last since #2656 Phase 2.1, after #2548)", async () => {
    const {
      ALL_MIGRATIONS,
      MIGRATION_0023_AGENT_MESH_TRACE_HOPS,
      MIGRATION_0024_AGENT_MESH_EVAL_RESULTS,
      MIGRATION_0025_AGENT_MESH_PROPOSALS,
      MIGRATION_0026_TENANT_AUTO_REFRESH,
      MIGRATION_0028_TENANT_PROVIDERS,
      MIGRATION_0029_PROOF_REDEMPTIONS,
      MIGRATION_0030_BILLING_CUSTOMERS,
    } = await import(
      "../src/data/migrationRunner"
    );
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0023_AGENT_MESH_TRACE_HOPS);
    // S18 (#2439) appended migration 0024 (eval results) after 0023;
    // S19 (#2460) appended migration 0025 (mesh proposals) after 0024;
    // #2481 appended migration 0026 (tenant auto-refresh) after 0025.
    // Slice 1 of the provider/broker programme appends migration 0027
    // (tenant data-provider / broker columns) after 0026.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0024_AGENT_MESH_EVAL_RESULTS);
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0025_AGENT_MESH_PROPOSALS);
    // #2547 appended migration 0027 (price catalogue approval) after 0026.
    // Slice 1 of the provider/broker programme appends migration 0028
    // (tenant data-provider / broker columns) after 0027.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0028_TENANT_PROVIDERS);
    // #2548 appended migration 0029 (proof redemptions) after 0028.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0029_PROOF_REDEMPTIONS);
    // #2656 (Phase 2.1) appends migration 0030 (billing customers) after 0029.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0030_BILLING_CUSTOMERS);
    expect(ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]).toBe(MIGRATION_0030_BILLING_CUSTOMERS);
    expect(MIGRATION_0023_AGENT_MESH_TRACE_HOPS.version).toBe(23);
    expect(MIGRATION_0023_AGENT_MESH_TRACE_HOPS.sql).toContain("agent_mesh_trace_hops");
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("the agentdb-read family records the new command", async () => {
    const { getToolFamily } = await import("../src/agents/registry");
    const family = getToolFamily("agentdb-read-mcp-commands");
    expect(family?.commands).toContain("agentdb.trace.get");
  });
});
