/**
 * Issue #6179 — the UX manual options screen bypasses the OTel observers:
 * the sync dispatch (`dispatchScreenViaEngine`) builds a bare
 * JobPipelineControl with no runSettledObserver and no journal, so a
 * UX-triggered options run settles and is recorded but emits no
 * `job.run.settled` event (no log, no metric, no trace). The fix wires
 * the observers in via a shared helper (the "same helper, later slice"
 * the ScheduledAgent host comment promises) plus an optional `otel`
 * seam on OptionsScreenEngineDeps.
 *
 * TDD Red first: src/observability/otelJobPipelineObservers.ts does
 * not exist yet, so this file fails at import.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { ensureOtelContextManager } from "../src/observability/otelTraces";

ensureOtelContextManager();
import type { SqlStorage } from "../src/orm";
import {
  createOtelJobPipelineObservers,
  createOtelJobPipelineObserverDeps,
  getOtelJobPipelineObservers,
  type OtelJobPipelineObservers,
} from "../src/observability/otelJobPipelineObservers";
import { createStructuredLogger, type StructuredLogger } from "../src/observability/structuredLogger";
import type {
  ObservabilityEvent,
  ObservabilitySink,
} from "../src/observability/observabilityPorts";
import type { JobRunSettledInfo, JobStepJournal } from "../src/services/jobPipelineEngine";
import {
  optionsEngineStoresFromSql,
  optionsScreenJobId,
  runOptionsScreenViaEngine,
} from "../src/workflows/optionsScreenEngine";
import {
  memoryStageClaims,
  type OptionsStagePort,
} from "../src/workflows/optionsScreenWorkflow";
import { OPTIONS_PIPELINE_STAGES, type OptionsPipelineStage } from "../src/workflows/stageRuntimeIds";
import type { StageClaimStore } from "../src/workflows/stageReportConsumer";

/** A sink that records every event it receives (tests/otel_job_pipeline_5081 idiom). */
function recordingSink() {
  const events: ObservabilityEvent[] = [];
  const sink: ObservabilitySink = {
    write: (event) => {
      events.push(event);
    },
    writeBatch: (list) => {
      for (const event of list) events.push(event);
    },
  };
  return { sink, events };
}

function testLogger(eventsSink: ObservabilitySink): StructuredLogger {
  return createStructuredLogger(eventsSink, {
    tenantId: "tenant-a",
    actorId: "actor-1",
    agentId: "pipeline",
    component: "job-pipeline",
    traceId: "a".repeat(32),
    nowMs: () => 1_791_158_400_000,
  });
}

/** A recorder that records every call it receives (tests/otel_job_pipeline_metrics_5082 idiom). */
function recordingRecorder() {
  const settled: JobRunSettledInfo[] = [];
  const steps: Array<{ name: string; status: string; durationMs: number }> = [];
  const recorder = {
    recordJobRunSettled: (info: JobRunSettledInfo) => {
      settled.push(info);
    },
    recordJobStageStep: (name: string, status: string, durationMs: number) => {
      steps.push({ name, status, durationMs });
    },
  };
  return { recorder, settled, steps };
}

/** A tracer backed by an InMemorySpanExporter (tests/otel_job_pipeline_traces_2808 idiom). */
function testTracer() {
  const mem = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: mem })],
  });
  return { tracer: provider.getTracer("test"), mem, provider };
}

function fakeDeps(isEnabled: () => boolean = () => true) {
  const { sink, events } = recordingSink();
  const logger = testLogger(sink);
  const { recorder, settled, steps } = recordingRecorder();
  const { tracer, mem, provider } = testTracer();
  return {
    deps: {
      logging: { logger, isEnabled },
      metrics: { recorder, isEnabled },
      tracing: { tracer, isEnabled },
    },
    events,
    settled,
    steps,
    mem,
    provider,
  };
}

const completedInfo: JobRunSettledInfo = {
  jobId: "options-screen:test:1",
  runId: "run-1",
  trigger: "manual",
  state: "completed",
};

describe("createOtelJobPipelineObservers — the shared observer helper (#6179)", () => {
  it("returns a runSettledObserver function and a journal with do", () => {
    const { deps } = fakeDeps();
    const observers = createOtelJobPipelineObservers(deps);
    expect(typeof observers.runSettledObserver).toBe("function");
    expect(typeof observers.journal.do).toBe("function");
  });

  it("the observer emits all three signals for a completed run", async () => {
    const { deps, events, settled, mem, provider } = fakeDeps();
    const observers = createOtelJobPipelineObservers(deps);
    await observers.runSettledObserver(completedInfo);
    expect(events.map((event) => event.type)).toContain("job.run.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.jobId).toBe("options-screen:test:1");
    const spans = mem.getFinishedSpans();
    expect(spans.map((span) => span.name)).toContain("job.run.settled");
    await provider.shutdown();
  });

  it("the observer emits at error level with an ERROR span for a failed run, carrying the error", async () => {
    const { deps, events, settled, mem, provider } = fakeDeps();
    const observers = createOtelJobPipelineObservers(deps);
    await observers.runSettledObserver({
      ...completedInfo,
      state: "failed",
      error: "boom at screen",
    });
    const log = events.find((event) => event.type === "job.run.settled");
    expect(log?.level).toBe("error");
    expect(log?.fields?.state).toBe("failed");
    expect(log?.fields?.error).toBe("boom at screen");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.state).toBe("failed");
    const span = mem.getFinishedSpans().find((s) => s.name === "job.run.settled");
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    await provider.shutdown();
  });

  it("the observer no-ops (emits nothing) when the domain is OFF", async () => {
    const { deps, events, settled, mem, provider } = fakeDeps(() => false);
    const observers = createOtelJobPipelineObservers(deps);
    await observers.runSettledObserver(completedInfo);
    expect(events).toHaveLength(0);
    expect(settled).toHaveLength(0);
    expect(mem.getFinishedSpans()).toHaveLength(0);
    await provider.shutdown();
  });

  it("the observer never throws when a signal fails (best-effort)", async () => {
    const { deps, provider } = fakeDeps();
    const throwingLogger = {
      info: () => {
        throw new Error("logger boom");
      },
      warn: () => {
        throw new Error("logger boom");
      },
      error: () => {
        throw new Error("logger boom");
      },
    } as unknown as StructuredLogger;
    const observers = createOtelJobPipelineObservers({
      ...deps,
      logging: { logger: throwingLogger, isEnabled: () => true },
    });
    await expect(observers.runSettledObserver(completedInfo)).resolves.toBeUndefined();
    await provider.shutdown();
  });

  it("the journal wraps a step: emits step events, records the metric + span, returns the result", async () => {
    const { deps, events, steps, mem, provider } = fakeDeps();
    const observers = createOtelJobPipelineObservers(deps);
    const result = await observers.journal.do("screen", async () => "ok");
    expect(result).toBe("ok");
    expect(events.map((event) => event.type)).toContain("job.stage.step.started");
    expect(events.map((event) => event.type)).toContain("job.stage.step.completed");
    expect(steps.map((step) => step.status)).toContain("completed");
    const span = mem.getFinishedSpans().find((s) => s.name === "job.stage.step");
    expect(span).toBeDefined();
    await provider.shutdown();
  });

  it("the journal emits step failed and rethrows the step error", async () => {
    const { deps, events, steps, mem, provider } = fakeDeps();
    const observers = createOtelJobPipelineObservers(deps);
    await expect(
      observers.journal.do("screen", async () => {
        throw new Error("step boom");
      }),
    ).rejects.toThrow("step boom");
    expect(events.map((event) => event.type)).toContain("job.stage.step.failed");
    expect(steps.map((step) => step.status)).toContain("failed");
    const span = mem.getFinishedSpans().find((s) => s.name === "job.stage.step");
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    await provider.shutdown();
  });

  it("the journal still runs the step (emitting nothing) when the domain is OFF", async () => {
    const { deps, events, steps, mem, provider } = fakeDeps(() => false);
    const observers = createOtelJobPipelineObservers(deps);
    const result = await observers.journal.do("screen", async () => "ok");
    expect(result).toBe("ok");
    expect(events).toHaveLength(0);
    expect(steps).toHaveLength(0);
    expect(mem.getFinishedSpans()).toHaveLength(0);
    await provider.shutdown();
  });
});

describe("createOtelJobPipelineObserverDeps — build the deps from env (#6179)", () => {
  it("resolves the file defaults when env is empty (j1j7 ON)", () => {
    const deps = createOtelJobPipelineObserverDeps({} as never);
    expect(deps.logging.isEnabled()).toBe(true);
    expect(deps.metrics.isEnabled()).toBe(true);
    expect(deps.tracing.isEnabled()).toBe(true);
  });

  it("getOtelJobPipelineObservers caches one observer set per env object", () => {
    const env = {} as never;
    const first = getOtelJobPipelineObservers(env);
    const second = getOtelJobPipelineObservers(env);
    expect(second).toBe(first);
    const other = getOtelJobPipelineObservers({} as never);
    expect(other).not.toBe(first);
  });
});

/** The node:sqlite DO-storage double (tests/options_screen_engine_4068 idiom). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function stubPorts(order: string[] = [], failStage?: string): {
  ports: Record<OptionsPipelineStage, OptionsStagePort>;
  calls: string[];
} {
  const calls: string[] = [];
  const ports = {} as Record<OptionsPipelineStage, OptionsStagePort>;
  for (const stageId of OPTIONS_PIPELINE_STAGES) {
    ports[stageId] = {
      execute: async (input) => {
        calls.push(`execute:${stageId}`);
        order.push(stageId);
        if (failStage === stageId) {
          throw new Error(`boom at ${stageId}`);
        }
        return { stage: stageId, inputArtifactKeys: input.artifactKeys };
      },
      persist: async (_input, output) => {
        calls.push(`persist:${stageId}`);
        return [`options:${stageId}:${(output as { stage: string }).stage}`];
      },
    };
  }
  return { ports, calls };
}

function claimsWith(preclaimed: string[] = []): StageClaimStore {
  const claimed = new Set(preclaimed);
  return {
    has: (key) => claimed.has(key),
    add: (key) => {
      claimed.add(key);
    },
    delete: (key) => {
      claimed.delete(key);
    },
  };
}

const REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "options-engine-test" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

function recordingOtel(): { otel: OtelJobPipelineObservers; settled: JobRunSettledInfo[]; journalSteps: string[] } {
  const settled: JobRunSettledInfo[] = [];
  const journalSteps: string[] = [];
  const journal: JobStepJournal = {
    do: async (name, fn) => {
      journalSteps.push(name);
      return fn();
    },
  };
  return {
    otel: {
      runSettledObserver: async (info: JobRunSettledInfo) => {
        settled.push(info);
      },
      journal,
    },
    settled,
    journalSteps,
  };
}

describe("runOptionsScreenViaEngine with the otel seam (#6179)", () => {
  it("a wired screen calls the settle observer exactly once on completion", async () => {
    const runId = "options-engine-otel:1";
    const { ports } = stubPorts();
    const { otel, settled, journalSteps } = recordingOtel();
    const outcome = await runOptionsScreenViaEngine(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: claimsWith(),
        queue: { send: async () => undefined },
        warn: () => undefined,
        otel,
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.jobId).toBe(optionsScreenJobId(runId));
    expect(settled[0]?.state).toBe("completed");
    expect(settled[0]?.trigger).toBe("manual");
    expect(journalSteps.length).toBeGreaterThan(0);
  });

  it("an unwired screen completes identically and never calls an observer", async () => {
    const runId = "options-engine-otel:2";
    const order: string[] = [];
    const { ports } = stubPorts(order);
    const outcome = await runOptionsScreenViaEngine(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: claimsWith(),
        queue: { send: async () => undefined },
        warn: () => undefined,
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(outcome.runId).toBe(runId);
    expect(order).toEqual([...OPTIONS_PIPELINE_STAGES]);
  });

  it("a wired failed screen calls the observer once with state failed and the same outcome", async () => {
    const runId = "options-engine-otel:3";
    const { ports } = stubPorts([], "screen");
    const { otel, settled } = recordingOtel();
    const outcome = await runOptionsScreenViaEngine(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: claimsWith(),
        queue: { send: async () => undefined },
        warn: () => undefined,
        otel,
      },
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.failedStage).toBe("screen");
    expect(outcome.reason).toBe("boom at screen");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.state).toBe("failed");
    expect(settled[0]?.jobId).toBe(optionsScreenJobId(runId));
  });

  it("a wired screen writes exactly one ledger row for its run id (no duplicates)", async () => {
    const runId = "options-engine-otel:4";
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const { ports } = stubPorts();
    const { otel, settled } = recordingOtel();
    const outcome = await runOptionsScreenViaEngine(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: claimsWith(),
        queue: { send: async () => undefined },
        warn: () => undefined,
        engineStores,
        otel,
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(settled).toHaveLength(1);
    const jobId = optionsScreenJobId(runId);
    const latest = await engineStores.runRecorder.latestRun(jobId);
    // The ledger's outcome vocabulary is success/failure (not the
    // engine's completed/failed): one row, success, for this run id.
    expect(latest?.outcome).toBe("success");
    expect(latest?.jobId).toBe(jobId);
  });
});
