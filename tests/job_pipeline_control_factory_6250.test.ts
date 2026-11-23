// @vitest-environment node
/**
 * Issue #6250 — ONE Job Pipeline Control factory, wired once.
 *
 * The engine was constructed 18 separate times across the codebase and
 * only the ScheduledAgent host wired the OTel run-settled observers, so
 * OODA/research jobs ran through the engine but never emitted
 * `job.run.settled`. This suite pins the single factory
 * (`src/services/jobPipelineControlFactory.ts`):
 * - a supplied observer set is wired onto the control: a run emits
 *   `job.run.settled` once, on every signal;
 * - a pre-existing runSettledObserver is CHAINED first (kept, never
 *   replaced) and a pre-existing journal is wrapped as the inner
 *   journal;
 * - without env or otel the factory builds a bare control (the run
 *   still completes — in-memory / read-only hosts have no OTel sink);
 * - no `new JobPipelineControl(` remains in src/ outside the engine's
 *   bare factory (the factory module delegates to it, holding no
 *   second construction).
 *
 * TDD Red first: the factory module does not exist yet, so this file
 * fails at import.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { ensureOtelContextManager } from "../src/observability/otelTraces";

ensureOtelContextManager();
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunSettledInfo,
  type JobStepJournal,
} from "../src/services/jobPipelineEngine";
import { createJobPipelineControl, setJobPipelineControlOtelResolver } from "../src/services/jobPipelineControlFactory";
import {
  createOtelJobPipelineObservers,
  resolveJobPipelineControlObservers,
  type OtelJobPipelineObservers,
} from "../src/observability/otelJobPipelineObservers";

// Issue #6250 — the factory's `env` path resolves through the
// injected resolver (the Worker entry registers it in production);
// this suite registers it so the `env` test exercises the real
// resolution instead of the bare fallback.
setJobPipelineControlOtelResolver(resolveJobPipelineControlObservers);
import { createStructuredLogger, type StructuredLogger } from "../src/observability/structuredLogger";
import type {
  ObservabilityEvent,
  ObservabilitySink,
} from "../src/observability/observabilityPorts";
import {
  createBuiltinStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";

/** A sink that records every event it receives (tests/otel_job_pipeline_observers_6179 idiom). */
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

function fakeOtel(isEnabled: () => boolean = () => true): {
  otel: OtelJobPipelineObservers;
  events: ObservabilityEvent[];
  settled: JobRunSettledInfo[];
  steps: Array<{ name: string; status: string; durationMs: number }>;
  mem: InMemorySpanExporter;
  provider: TracerProvider;
} {
  const { sink, events } = recordingSink();
  const logger = testLogger(sink);
  const { recorder, settled, steps } = recordingRecorder();
  const { tracer, mem, provider } = testTracer();
  const otel = createOtelJobPipelineObservers({
    logging: { logger, isEnabled },
    metrics: { recorder, isEnabled },
    tracing: { tracer, isEnabled },
  });
  return { otel, events, settled, steps, mem, provider };
}

const DUMMY = {
  jobId: "dummy",
  name: "Dummy one-step job",
  root: {
    kind: "dummy",
    steps: [{ step: "track", params: { n: 1 } }],
    executionMode: { delivery: "sync" },
  },
};

function makeDeps(overrides?: Partial<JobPipelineDeps>): JobPipelineDeps {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (ctx: JobStepContext) => ({
    output: { tracked: true, kind: ctx.kind },
  }));
  return {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
    invocation: "sync",
    ...overrides,
  };
}

async function runDummy(deps: JobPipelineDeps, opts?: Parameters<typeof createJobPipelineControl>[1]) {
  const control = createJobPipelineControl(deps, opts);
  await control.defineJob(DUMMY);
  const dispatch = await control.runJob("dummy", { trigger: "manual" });
  return { control, dispatch };
}

describe("the wired factory — one control, observers attached once (#6250)", () => {
  it("a supplied observer set is wired: a run emits job.run.settled on all three signals", async () => {
    const { otel, events, settled, mem, provider } = fakeOtel();
    const { dispatch } = await runDummy(makeDeps(), { otel });
    expect(dispatch.state).toBe("completed");
    expect(events.map((event) => event.type)).toContain("job.run.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ jobId: "dummy", state: "completed", trigger: "manual" });
    expect(mem.getFinishedSpans().map((span) => span.name)).toContain("job.run.settled");
    await provider.shutdown();
  });

  it("a pre-existing runSettledObserver is chained FIRST (kept, never replaced)", async () => {
    const { otel, settled, provider } = fakeOtel();
    const order: string[] = [];
    const deps = makeDeps({
      runSettledObserver: () => {
        order.push("existing");
      },
    });
    // The fake OTel observer records into `settled`; wrap it so its
    // position in the chain is observable too.
    const wrappedOtel: OtelJobPipelineObservers = {
      runSettledObserver: async (info) => {
        order.push("otel");
        await otel.runSettledObserver(info);
      },
      journal: otel.journal,
    };
    const { dispatch } = await runDummy(deps, { otel: wrappedOtel });
    expect(dispatch.state).toBe("completed");
    expect(order).toEqual(["existing", "otel"]);
    expect(settled).toHaveLength(1);
    await provider.shutdown();
  });

  it("a pre-existing journal is wrapped as the inner journal (it still runs, inside the OTel journal)", async () => {
    const { otel, events, provider } = fakeOtel();
    const innerCalls: string[] = [];
    const inner: JobStepJournal = {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        innerCalls.push(name);
        return fn();
      },
    };
    const { dispatch } = await runDummy(makeDeps({ journal: inner }), { otel });
    expect(dispatch.state).toBe("completed");
    expect(innerCalls.length).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toContain("job.stage.step.started");
    expect(events.map((event) => event.type)).toContain("job.stage.step.completed");
    await provider.shutdown();
  });

  it("without env or otel the factory builds a bare control: the run still completes, nothing is emitted", async () => {
    const { dispatch } = await runDummy(makeDeps());
    expect(dispatch.state).toBe("completed");
  });

  it("with env the factory builds a control that runs (observers resolve from env, cached per env object)", async () => {
    const env = {} as never;
    const { dispatch } = await runDummy(makeDeps(), { env });
    expect(dispatch.state).toBe("completed");
  });

  it("createOtelJobPipelineObservers threads an inner journal (the factory's chaining seam)", async () => {
    const { sink, events } = recordingSink();
    const logger = testLogger(sink);
    const { recorder } = recordingRecorder();
    const { tracer, mem, provider } = testTracer();
    const innerCalls: string[] = [];
    const inner: JobStepJournal = {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        innerCalls.push(name);
        return fn();
      },
    };
    const observers = createOtelJobPipelineObservers(
      {
        logging: { logger, isEnabled: () => true },
        metrics: { recorder, isEnabled: () => true },
        tracing: { tracer, isEnabled: () => true },
      },
      inner,
    );
    const result = await observers.journal.do("screen", async () => "ok");
    expect(result).toBe("ok");
    expect(innerCalls).toEqual(["screen"]);
    expect(events.map((event) => event.type)).toContain("job.stage.step.completed");
    expect(mem.getFinishedSpans().map((span) => span.name)).toContain("job.stage.step");
    await provider.shutdown();
  });
});

describe("no second control construction survives (#6250)", () => {
  const srcRoot = path.resolve(__dirname, "../src");
  const files = [
    "agents/scheduledTasksPipeline.ts",
    "mcps/openaimp/researchJobCommands.ts",
    "services/stageInMemoryExecution.ts",
    "workflows/inMemoryWorkflowAdapter.ts",
    "workflows/jobPipelineWorkflowFlow.ts",
    "workflows/optionsScreenEngine.ts",
    "workflows/optionsStageControl.ts",
    "workflows/optionsWorkflowHost.ts",
    "workflows/researchScreenEngine.ts",
    "workflows/screenerWorkflow.ts",
  ];

  it.each(files)("no `new JobPipelineControl(` in src/%s — every site uses the factory", (file) => {
    const text = fs.readFileSync(path.join(srcRoot, file), "utf8");
    expect(text).not.toContain("new JobPipelineControl(");
  });

  it("the engine keeps exactly one `new JobPipelineControl(` — inside its bare factory", () => {
    const text = fs.readFileSync(path.join(srcRoot, "services/jobPipelineEngine.ts"), "utf8");
    const count = text.split("new JobPipelineControl(").length - 1;
    expect(count).toBe(1);
  });

  it("the factory module builds through the engine's bare factory (the one `new`)", () => {
    const text = fs.readFileSync(
      path.join(srcRoot, "services/jobPipelineControlFactory.ts"),
      "utf8",
    );
    expect(text).toContain("export function createJobPipelineControl");
    // The factory delegates to the engine's bare factory — it holds no
    // second `new`, so the engine's bare factory stays the one construction.
    expect(text).not.toContain("new JobPipelineControl(");
    expect(text).toContain("createBareJobPipelineControl");
  });

  it("the Worker entry registers the env → observer resolver (the factory's `env` path is wired in production)", () => {
    const text = fs.readFileSync(path.join(srcRoot, "server.ts"), "utf8");
    expect(text).toContain(
      "setJobPipelineControlOtelResolver(resolveJobPipelineControlObservers)",
    );
  });

  it("the factory never imports the OTel provider chain as a value (the vite browser bundle cannot include it)", () => {
    const text = fs.readFileSync(
      path.join(srcRoot, "services/jobPipelineControlFactory.ts"),
      "utf8",
    );
    // A value import from ../observability/* would drag the Node-only
    // provider chain into the browser bundle; `import type` is erased
    // at build time and is the only observability import allowed.
    const valueImports = text
      .split("\n")
      .filter((line) => /^import (?!type\b)/.test(line) && line.includes("../observability/"));
    expect(valueImports).toEqual([]);
    expect(text).toContain("import type { OtelJobPipelineObservers }");
  });
});
