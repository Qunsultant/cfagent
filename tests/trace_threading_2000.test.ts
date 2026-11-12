/**
 * Phase 5 Slice 3 (issue #2000) — trace threading through
 * workflow steps, migrated to the engine path (#4192 cutover).
 *
 * What this file pins now: the run's trace threads through
 * the ENGINE path — the dispatch's announce hop, the
 * adapter's per-unit step hops (execute-screen / store-shard
 * / deliver-shard), and the finalize's projection hops
 * (project-shard / project-final) all land under the one
 * traceparent the command carried, and the collation's
 * stageTransitions carry the six engine stages.
 *
 * Retired with the child-workflow flow (no replacement):
 * - the parent flow's fan-out steps (fan-out-batch-N hops):
 *   the engine owns fan-out now and emits no fan-out hop.
 *   The intent — "the run's steps emit under its
 *   traceparent" — survives as the engine's step hops below.
 * - the fan-out seam handing a CHILD command the parent's
 *   traceparent: there are no child workflows anymore. The
 *   intent — "the traceparent reaches the unit that runs the
 *   screen" — survives as the analyze step's request: the
 *   command's traceparent rides the job definition into the
 *   analyze step's agent request (the #2860 two-hop
 *   threading), asserted here behaviorally via the runner's
 *   captured request.
 * - per-step mesh hops from the child flow: the engine
 *   publishes stage transitions instead (readable via the
 *   collation's stageTransitions); the only mesh hops on the
 *   engine path are the dispatch/adapter/finalize hops above.
 *
 * The recordWorkflowTraceHop contract tests and the
 * shardCommandFor propagation test are untouched in intent:
 * the recorder still backs the engine path's traceHop, and
 * shardCommandFor (now in screenerCollation.ts) still builds
 * the shard command the adapter's analyze step derives its
 * request from.
 */
import { describe, expect, it } from "vitest";
import { InMemoryMeshTraceStore } from "../src/data/inMemoryMeshTraceAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import {
  assembleMeshTrace,
  deterministicSpanId,
  recordWorkflowTraceHop,
} from "../src/observability/meshTrace";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  shardCommandFor,
  type ScreenerWorkflowDeps,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import type {
  ParentScreenReportInput,
  WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

const TRACE_ID = "a".repeat(32);
const PARENT_SPAN = "b".repeat(16);
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN}-01`;
const NOW_MS = 1760000000000;

function parentCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-2000-trace",
    type: "run-screen",
    source: "test",
    trigger: "manual",
    userLogin: "octocat",
    shards: [{ shardId: "s1" }],
    role: "parent",
    tenantId: "tenant-test",
    traceparent: TRACEPARENT,
    deliver: true,
    ...overrides,
  };
}

describe("recordWorkflowTraceHop contract (slice 3 regression set)", () => {
  it("a step hop lands under the run's traceparent, deterministic span", async () => {
    const store = new InMemoryMeshTraceStore();
    await recordWorkflowTraceHop(
      store,
      {
        traceparent: TRACEPARENT,
        jobId: "job-1",
        tenantId: "tenant-test",
        userLogin: "octocat",
      },
      { kind: "workflow-step", operation: "execute-screen" },
    );
    const hops = await store.hopsFor(TRACE_ID);
    expect(hops).toHaveLength(1);
    expect(hops[0].traceId).toBe(TRACE_ID);
    expect(hops[0].parentSpanId).toBe(PARENT_SPAN);
    expect(hops[0].spanId).toBe(deterministicSpanId("job-1:execute-screen"));
    expect(hops[0].kind).toBe("workflow-step");
    expect(hops[0].operation).toBe("execute-screen");
    expect(hops[0].caller).toBe("octocat");
    expect(hops[0].agent).toBe("ScreenerScreenWorkflow");
    expect(hops[0].jobId).toBe("job-1");
  });

  it("a step without a traceparent records nothing and never throws", async () => {
    const store = new InMemoryMeshTraceStore();
    await expect(
      recordWorkflowTraceHop(
        store,
        { jobId: "job-1", userLogin: "octocat" },
        { kind: "workflow-step", operation: "execute-screen" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      recordWorkflowTraceHop(
        store,
        { traceparent: "not-a-traceparent", jobId: "job-1", userLogin: "octocat" },
        { kind: "workflow-step", operation: "execute-screen" },
      ),
    ).resolves.toBeUndefined();
    expect(await store.hopsFor(TRACE_ID)).toHaveLength(0);
  });

  it("a hop round-trips: record → hopsFor(traceId)", async () => {
    const store = new InMemoryMeshTraceStore();
    await recordWorkflowTraceHop(
      store,
      {
        traceparent: TRACEPARENT,
        jobId: "job-1",
        userLogin: "octocat",
      },
      { kind: "workflow-step", operation: "store-shard" },
    );
    await recordWorkflowTraceHop(
      store,
      {
        traceparent: TRACEPARENT,
        jobId: "job-1",
        userLogin: "octocat",
      },
      { kind: "projection", operation: "project-shard" },
    );
    const hops = await store.hopsFor(TRACE_ID);
    expect(hops.map((h) => h.operation).sort()).toEqual([
      "project-shard",
      "store-shard",
    ]);
    expect(await store.hopsFor("c".repeat(32))).toHaveLength(0);
  });
});

describe("shard command traceparent propagation", () => {
  it("shardCommandFor carries the parent's traceparent to the child", () => {
    const child = shardCommandFor(parentCommand(), { shardId: "s1" });
    expect(child.traceparent).toBe(TRACEPARENT);
    expect(child.jobId).toBe("job-2000-trace:shard:s1");
    expect(child.role).toBe("shard");
    expect(child.parentJobId).toBe("job-2000-trace");
  });
});

describe("adapter step emission (engine path, slice 3)", () => {
  interface EngineTraceHarness {
    traceStore: InMemoryMeshTraceStore;
    shardStore: InMemoryShardJobAdapter;
    parentStored: ParentScreenReportInput[];
    seenRequests: unknown[];
    stored: unknown[];
    delivered: unknown[];
    deps: ScreenerWorkflowDeps;
  }

  function makeHarness(
    runScreen?: ScreenerWorkflowDeps["screenRunner"]["runScreen"],
  ): EngineTraceHarness {
    const traceStore = new InMemoryMeshTraceStore();
    const shardStore = new InMemoryShardJobAdapter();
    const parentStored: ParentScreenReportInput[] = [];
    const seenRequests: unknown[] = [];
    const stored: unknown[] = [];
    const delivered: unknown[] = [];
    const deps: ScreenerWorkflowDeps = {
      screenRunner: {
        runScreen:
          runScreen ??
          (async (req) => {
            seenRequests.push(req);
            return {
              success: true,
              timestamp: "2026-11-02T00:00:00.000Z",
              totalScanned: 1,
              expectedCount: 1,
              matchedCount: 1,
              full: { marker: "full-result" },
            } satisfies ShardScreenResult;
          }),
      },
      shardStore,
      storeReport: async (payload) => {
        stored.push(payload);
      },
      deliverOutcome: async (payload) => {
        delivered.push(payload);
      },
      storeParentReport: async (input) => {
        parentStored.push(input);
        return { stored: true, reportId: "parent-1" };
      },
      nowMs: () => NOW_MS,
      // The production wiring (screenerWorkflow.ts buildDeps)
      // is this same helper over the env-resolved store.
      traceHop: (command, event) => recordWorkflowTraceHop(traceStore, command, event),
    };
    return { traceStore, shardStore, parentStored, seenRequests, stored, delivered, deps };
  }

  async function runAdapterWithTrace(
    harness: EngineTraceHarness,
    command: WorkflowJobCommand,
  ) {
    const adapter = new InMemoryWorkflowAdapter(harness.deps);
    const handle = await adapter.start(command);
    const hops = await harness.traceStore.hopsFor(TRACE_ID);
    return { handle, hops, harness };
  }

  it("the engine's step hops land under the run's traceparent", async () => {
    const { handle, hops } = await runAdapterWithTrace(makeHarness(), parentCommand());
    expect(handle.status).toBe("complete");
    // #4192: no fan-out hop — the engine owns fan-out. The
    // hops the engine path emits for one shard: the
    // dispatch's announce, the adapter's analyze/store/
    // deliver steps, and the finalize's per-shard + final
    // projections.
    expect(hops.map((h) => `${h.kind}:${h.operation}`)).toEqual([
      "workflow-step:announce",
      "workflow-step:execute-screen",
      "workflow-step:store-shard",
      "workflow-step:deliver-shard",
      "projection:project-shard",
      "projection:project-final",
    ]);
    for (const hop of hops) {
      expect(hop.traceId).toBe(TRACE_ID);
      expect(hop.parentSpanId).toBe(PARENT_SPAN);
      expect(hop.caller).toBe("octocat");
      expect(hop.agent).toBe("ScreenerScreenWorkflow");
      expect(hop.jobId).toBe("job-2000-trace");
    }
  });

  it("the analyze seam hands the step the parent's traceparent", async () => {
    // #4192: no child command is created — the traceparent
    // threads command → job definition → analyze step's
    // agent request instead. The runner's captured request
    // is the behavioral proof the seam carried it.
    const h = makeHarness();
    const { hops } = await runAdapterWithTrace(h, parentCommand());
    expect(h.seenRequests).toHaveLength(1);
    expect(h.seenRequests[0]).toMatchObject({ traceparent: TRACEPARENT });
    // The same trace id covers the seam and the step hop:
    // the execute-screen hop joins the run's trace.
    expect(hops.find((hop) => hop.operation === "execute-screen")?.traceId).toBe(TRACE_ID);
  });

  it("existing emissions are untouched on the engine path: announce + project-final, six stages on the collation", async () => {
    const h = makeHarness();
    const { handle, hops } = await runAdapterWithTrace(h, parentCommand());
    expect(handle.status).toBe("complete");
    expect(hops.map((hop) => hop.operation)).toEqual([
      "announce",
      "execute-screen",
      "store-shard",
      "deliver-shard",
      "project-shard",
      "project-final",
    ]);
    const collation = h.parentStored[0]?.collation;
    expect(collation?.lifecycle).toBe("ReportGenerated");
    // The engine publishes stage transitions instead of
    // per-step mesh hops: all six stages completed.
    expect(collation?.stageTransitions).toEqual([
      { stage: "feed", outcome: "completed", atMs: NOW_MS },
      { stage: "gather", outcome: "completed", atMs: NOW_MS },
      { stage: "analysis", outcome: "completed", atMs: NOW_MS },
      { stage: "store", outcome: "completed", atMs: NOW_MS },
      { stage: "serve", outcome: "completed", atMs: NOW_MS },
      { stage: "deliver", outcome: "completed", atMs: NOW_MS },
    ]);
    // The parent row carries the collation as resultJson.
    const parentRow = await h.shardStore.latestJob("tenant-test", "job-2000-trace", "job-2000-trace");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
  });

  it("one trace id across turn → dispatch → steps → projection → assembly", async () => {
    const h = makeHarness();
    // The traced turn that dispatched this run: the
    // adapter records no entry hop itself (no turn /
    // workflow-start leg lives on the engine path), so the
    // test seeds the turn hop the chat port records — the
    // assembly then covers the whole chain.
    await h.traceStore.record({
      traceId: TRACE_ID,
      spanId: "c".repeat(16),
      kind: "turn",
      operation: "chat.turn",
      timestampMs: NOW_MS - 1000,
      tenantId: "tenant-test",
      caller: "octocat",
      agent: "orchestrator",
      jobId: "job-2000-trace",
    });
    const { hops } = await runAdapterWithTrace(h, parentCommand());
    const rows = await h.shardStore.listJobsForChain("tenant-test", "job-2000-trace");
    expect(rows.length).toBeGreaterThan(0);
    const assembly = assembleMeshTrace(TRACE_ID, hops, rows);
    expect(assembly.complete).toBe(true);
    expect(assembly.breaks).toEqual([]);
    expect(assembly.jobIds).toContain("job-2000-trace");
    expect(assembly.hops.some((hop) => hop.kind === "turn")).toBe(true);
    expect(assembly.hops.some((hop) => hop.kind === "workflow-step")).toBe(true);
    expect(assembly.hops.some((hop) => hop.kind === "projection")).toBe(true);
    for (const hop of assembly.hops) {
      expect(hop.traceId).toBe(TRACE_ID);
    }
  });

  it("a run with no entry hop assembles honestly partial, with the break named", async () => {
    // The adapter legs alone carry no entry hop, so the
    // read surface must say so — never fabricate the link.
    const h = makeHarness();
    const { hops } = await runAdapterWithTrace(h, parentCommand());
    const rows = await h.shardStore.listJobsForChain("tenant-test", "job-2000-trace");
    const assembly = assembleMeshTrace(TRACE_ID, hops, rows);
    expect(assembly.complete).toBe(false);
    expect(assembly.breaks.some((b) => b.includes("entry hop missing"))).toBe(true);
  });

  it("a command without a traceparent records no hops but the run still completes", async () => {
    const h = makeHarness();
    const command = parentCommand();
    delete command.traceparent;
    const { handle, hops } = await runAdapterWithTrace(h, command);
    expect(handle.status).toBe("complete");
    expect(hops).toEqual([]);
    expect(h.parentStored[0]?.collation.lifecycle).toBe("ReportGenerated");
  });

  it("a failed screen emits no step hops after announce — the failure is the Failed collation + failed analysis stage", async () => {
    // #4192: a market failure throws at analysis, so the
    // unit never stores/delivers and never traces those
    // steps; the attempt record is the Failed collation +
    // the failed leg rows, with announce + projection hops
    // still joining the trace.
    const h = makeHarness(async (req) => ({
      success: false,
      timestamp: "2026-11-02T00:00:00.000Z",
      totalScanned: 0,
      expectedCount: 1,
      matchedCount: 0,
      error: "no quotes",
      ...(req.universe ? { universe: req.universe } : {}),
    }));
    const { handle, hops } = await runAdapterWithTrace(h, parentCommand());
    expect(handle.status).toBe("complete");
    expect(hops.map((hop) => hop.operation)).toEqual([
      "announce",
      "project-shard",
      "project-final",
    ]);
    expect(h.stored).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
    const collation = h.parentStored[0]?.collation;
    expect(collation?.lifecycle).toBe("Failed");
    expect(collation?.shards[0]?.error).toMatch(/no quotes/);
    expect(collation?.stageTransitions).toEqual([
      { stage: "feed", outcome: "completed", atMs: NOW_MS },
      { stage: "gather", outcome: "completed", atMs: NOW_MS },
      { stage: "analysis", outcome: "failed", atMs: NOW_MS },
    ]);
  });

  it("deliver=false skips the deliver hop (and the delivery)", async () => {
    const h = makeHarness();
    const { hops } = await runAdapterWithTrace(h, parentCommand({ deliver: false }));
    expect(hops.map((hop) => hop.operation)).toEqual([
      "announce",
      "execute-screen",
      "store-shard",
      "project-shard",
      "project-final",
    ]);
    expect(h.delivered).toHaveLength(0);
    expect(h.stored).toHaveLength(1);
  });
});
