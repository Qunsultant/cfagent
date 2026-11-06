/**
 * Issue #2860 (15-factor re-audit, Factor 14 Telemetry) — funnel
 * trace_id carried from the workflow traceparent, plus metrics
 * aggregation for stock modules.
 *
 * Remediation, in two halves:
 *  1. Trace correlation: funnelTraceIdForRun returns the workflow
 *     traceparent's trace-id when the run carries one, so a run's
 *     started/completed/failed lines correlate with the workflow's
 *     own hops by trace_id (no separate correlation map). The
 *     traceparent threads command → shardScreenRequest →
 *     toAgentRequest → ScreenerRunRequest → runScreen, where one
 *     traceId serves the whole run (lock refusal included).
 *  2. Metrics aggregation: the funnel's events fold into the
 *     screen-run accumulator (src/telemetry/screenRunStats.ts) at
 *     the logScreenRunEvent join point — counts + durations by
 *     (trigger, universe), failures by classification — with the
 *     retrieval-stats loss semantics (per-isolate; durable home is
 *     #1743's Analytics Engine pipeline, a named follow-up).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  funnelTraceIdForRun,
  logScreenRunEvent,
} from "../src/workflows/screenRunAspects";
import { shardScreenRequest } from "../src/workflows/screenerWorkflowFlow";
import {
  ingestScreenRunEvent,
  screenRunStatsSnapshot,
  __resetScreenRunStats,
} from "../src/telemetry/screenRunStats";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function command(over: Record<string, unknown> = {}) {
  return {
    jobId: "job-1",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "shard",
    shards: [],
    ...over,
  } as any;
}

describe("funnelTraceIdForRun (#2860 Factor 14)", () => {
  it("returns the workflow traceparent's trace-id when the run carries one", () => {
    expect(funnelTraceIdForRun(TRACEPARENT)).toBe(TRACE_ID);
  });

  it("mints a fresh UUID when the traceparent is absent", () => {
    const a = funnelTraceIdForRun(undefined);
    const b = funnelTraceIdForRun(undefined);
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  it("mints a fresh UUID when the traceparent is malformed (never a partial id)", () => {
    for (const bad of [
      "not-a-traceparent",
      `01-${TRACE_ID}-00f067aa0ba902b7-01`,
      `00-00000000000000000000000000000000-00f067aa0ba902b7-01`,
      `00-${TRACE_ID}-0000000000000000-01`,
      `00-short-00f067aa0ba902b7-01`,
      "",
    ]) {
      expect(funnelTraceIdForRun(bad)).toMatch(UUID_V4);
    }
  });
});

describe("traceparent threading (#2860 Factor 14)", () => {
  it("shardScreenRequest carries the command's traceparent", () => {
    const req = shardScreenRequest(command({ traceparent: TRACEPARENT }));
    expect(req.traceparent).toBe(TRACEPARENT);
  });

  it("shardScreenRequest omits traceparent when the command carries none", () => {
    const req = shardScreenRequest(command());
    expect(req).not.toHaveProperty("traceparent");
  });

  it("the adapter maps the shard request's traceparent onto the agent request", () => {
    // toAgentRequest is module-private; the wiring is pinned by
    // source inspection, the repo's established pattern for a
    // hop with no exported seam (cf. screen_run_lock_1993.test.ts).
    const src = readFileSync("src/workflows/screenerWorkflow.ts", "utf8");
    const fn = src.slice(src.indexOf("function toAgentRequest"));
    expect(fn).toContain("...(req.traceparent ? { traceparent: req.traceparent } : {})");
  });

  it("runScreen derives one funnel trace_id from the request traceparent", () => {
    const agentSrc = readFileSync("src/agents/screener-agent.ts", "utf8");
    const start = agentSrc.indexOf("async runScreen(req: ScreenerRunRequest)");
    const end = agentSrc.indexOf("private async runScreenInner", start);
    const run = agentSrc.slice(start, end);
    expect(run).toContain("const traceId = funnelTraceIdForRun(req.traceparent);");
    expect(run).not.toContain("crypto.randomUUID()");
  });
});

describe("screen-run metrics aggregation (#2860 Factor 14)", () => {
  beforeEach(() => {
    __resetScreenRunStats();
  });
  afterEach(() => {
    __resetScreenRunStats();
    vi.restoreAllMocks();
  });

  it("folds started/completed/failed counts + durations by (trigger, universe)", () => {
    expect(ingestScreenRunEvent({ event: "screen.started", trigger: "manual", universe: "TECH" })).toBe(true);
    expect(ingestScreenRunEvent({ event: "screen.completed", trigger: "manual", universe: "TECH", durationMs: 120 })).toBe(true);
    expect(ingestScreenRunEvent({ event: "screen.started", trigger: "scheduled", universe: "TECH" })).toBe(true);
    expect(ingestScreenRunEvent({ event: "screen.failed", trigger: "scheduled", universe: "TECH", durationMs: 30, classification: "provider" })).toBe(true);
    const snap = screenRunStatsSnapshot();
    expect(snap.totalStarted).toBe(2);
    expect(snap.totalCompleted).toBe(1);
    expect(snap.totalFailed).toBe(1);
    expect(snap.totalDurationMs).toBe(150);
    const manual = snap.buckets.find((b) => b.trigger === "manual" && b.universe === "TECH")!;
    expect(manual.started).toBe(1);
    expect(manual.completed).toBe(1);
    expect(manual.failed).toBe(0);
    expect(manual.totalDurationMs).toBe(120);
    expect(manual.durationSamples).toBe(1);
    const scheduled = snap.buckets.find((b) => b.trigger === "scheduled")!;
    expect(scheduled.failed).toBe(1);
    expect(scheduled.failedByClassification).toEqual({ provider: 1 });
  });

  it("counts failures by classification across runs", () => {
    ingestScreenRunEvent({ event: "screen.failed", trigger: "manual", universe: "TECH", classification: "auth" });
    ingestScreenRunEvent({ event: "screen.failed", trigger: "manual", universe: "TECH", classification: "auth" });
    ingestScreenRunEvent({ event: "screen.failed", trigger: "manual", universe: "TECH", classification: "retryable" });
    const bucket = screenRunStatsSnapshot().buckets[0];
    expect(bucket.failed).toBe(3);
    expect(bucket.failedByClassification).toEqual({ auth: 2, retryable: 1 });
  });

  it("rejects malformed events without changing state", () => {
    expect(ingestScreenRunEvent({ event: "screen.unknown" as any, trigger: "manual", universe: "TECH" })).toBe(false);
    expect(ingestScreenRunEvent({ event: "screen.completed", trigger: "manual", universe: "TECH", durationMs: "fast" as any })).toBe(false);
    expect(ingestScreenRunEvent(null as any)).toBe(false);
    expect(screenRunStatsSnapshot().totalStarted).toBe(0);
    expect(screenRunStatsSnapshot().buckets).toEqual([]);
  });

  it("the funnel folds every logged event exactly once (runScreen + chain share the join point)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    logScreenRunEvent({ event: "screen.started", trigger: "manual", universe: "TECH", traceId: TRACE_ID });
    logScreenRunEvent({ event: "screen.completed", trigger: "manual", universe: "TECH", traceId: TRACE_ID, success: true, matchedCount: 2, durationMs: 50 });
    logScreenRunEvent({ event: "screen.failed", trigger: "manual", universe: "TECH", traceId: TRACE_ID, classification: "provider", error: "down", durationMs: 10 });
    const snap = screenRunStatsSnapshot();
    expect(snap.totalStarted).toBe(1);
    expect(snap.totalCompleted).toBe(1);
    expect(snap.totalFailed).toBe(1);
    expect(snap.totalDurationMs).toBe(60);
    expect(snap.buckets).toHaveLength(1);
    expect(snap.buckets[0].failedByClassification).toEqual({ provider: 1 });
  });

  it("reset drops the accumulator", () => {
    ingestScreenRunEvent({ event: "screen.started", trigger: "manual", universe: "TECH" });
    __resetScreenRunStats();
    expect(screenRunStatsSnapshot()).toEqual({
      totalStarted: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalDurationMs: 0,
      buckets: [],
    });
  });
});
