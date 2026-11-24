/**
 * Issue #2808 (S3, observability program #5080) — the J1–J7
 * span observers: the run-settled observer (one `job.run.settled`
 * span per terminally settled run) and the stage-step journal
 * (one `job.stage.step` span per stage step), wired through
 * the engine's EXISTING observer seams — no engine internals
 * are touched.
 *
 * These observers MIRROR the S1 logging observers
 * (otelJobPipeline.ts) and the S2 metrics observers
 * (otelJobPipelineMetrics.ts) but record SPANS through the
 * OTel tracer instead of logging or recording metrics. The
 * logging and metrics paths are untouched: the traces
 * run-settled observer is CHAINED after the metrics observer
 * and the traces journal WRAPS the metrics journal — each is
 * guarded, so one observer's failure never blocks the others.
 *
 * Both observers are best-effort (they can never fail, retry,
 * or duplicate the run's own records) and both check the
 * per-domain gate first: when the j1j7 domain is OFF they
 * no-op. The journal still runs the step when OFF (emitting
 * nothing), and the step's error is always rethrown.
 *
 * Seam honesty (recorded in the PR body): the engine's journal
 * seam carries no run context (JobStepJournal.do receives only
 * the step name) and the run-settled info carries no duration
 * or traceparent — so a step span is a root span (one trace
 * per step) and the run span is a zero-duration marker at the
 * settle moment. Linking a run's steps into one trace needs a
 * run-context seam in the engine (a later slice, not S3).
 * Nested steps DO nest: the journal sets each step span as
 * the active OTel context for the step's execution, so a step
 * that calls the journal again records a child span.
 *
 * TDD Red first: the module
 * (src/observability/otelJobPipelineTraces.ts) does not exist
 * yet, so this file fails at import.
 */
import { describe, it, expect, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { TracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {
  createOtelJobPipelineTracesRunSettledObserver,
  createOtelJobPipelineTracesStepJournal,
  type OtelJobPipelineTracesObserverDeps,
} from "../src/observability/otelJobPipelineTraces";
import { identityJobStepJournal } from "../src/services/jobPipelineEngine";
import { ensureOtelContextManager } from "../src/observability/otelTraces";

// The OTel API ships with a no-op context manager; the
// AsyncLocalStorage manager is what makes nested journal calls
// record child spans (see otelTraces.ts). Register it once
// for this file before any span is created.
ensureOtelContextManager();

/** A tracer backed by an InMemorySpanExporter, so tests can read the finished spans. */
function testTracer() {
  const mem = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: mem })],
  });
  return { tracer: provider.getTracer("test"), mem, provider };
}

function deps(overrides: Partial<OtelJobPipelineTracesObserverDeps> = {}) {
  const { tracer, mem, provider } = testTracer();
  const base: OtelJobPipelineTracesObserverDeps = {
    tracer,
    isEnabled: () => true,
    nowMs: () => Date.parse("2026-11-17T12:00:00Z"),
  };
  return { deps: { ...base, ...overrides }, mem, provider };
}

describe("createOtelJobPipelineTracesStepJournal — one span per stage step", () => {
  it("records a span per step with the step name, duration, and OK status", async () => {
    const { deps: d, mem, provider } = deps({ nowMs: (() => { let t = 1000; return () => (t += 50); })() });
    const journal = createOtelJobPipelineTracesStepJournal(d);
    const result = await journal.do("feed", async () => "done");
    expect(result).toBe("done");
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("job.stage.step");
    expect(spans[0].attributes.step).toBe("feed");
    expect(spans[0].attributes.component).toBe("job-pipeline");
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    expect(spans[0].duration[0]).toBe(0);
    // 50ms of clock time, in nanoseconds.
    expect(spans[0].duration[1]).toBe(50_000_000);
  });

  it("records an ERROR span and rethrows the step error", async () => {
    const { deps: d, mem, provider } = deps();
    const journal = createOtelJobPipelineTracesStepJournal(d);
    await expect(journal.do("enrich", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].attributes.step).toBe("enrich");
  });

  it("nests a step that calls the journal again as a child span", async () => {
    const { deps: d, mem, provider } = deps();
    const journal = createOtelJobPipelineTracesStepJournal(d);
    await journal.do("feed", async () => {
      await journal.do("feed.fetch", async () => "inner");
      return "outer";
    });
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(2);
    const outer = spans.find((s) => s.attributes.step === "feed")!;
    const inner = spans.find((s) => s.attributes.step === "feed.fetch")!;
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it("runs the step with no span when the domain is OFF", async () => {
    const { deps: d, mem, provider } = deps({ isEnabled: () => false });
    const journal = createOtelJobPipelineTracesStepJournal(d);
    const result = await journal.do("feed", async () => "done");
    expect(result).toBe("done");
    await provider.shutdown();
    expect(mem.getFinishedSpans()).toHaveLength(0);
  });

  it("delegates to the inner journal when one is given", async () => {
    const innerDo = vi.fn(async (_name: string, fn: () => Promise<string>) => fn());
    const { deps: d, mem, provider } = deps();
    const journal = createOtelJobPipelineTracesStepJournal({
      ...d,
      inner: { do: innerDo },
    });
    await journal.do("feed", async () => "done");
    // Read the finished spans BEFORE shutting the provider
    // down: InMemorySpanExporter.shutdown() (reached via
    // provider.shutdown()) clears its recorded spans.
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(innerDo).toHaveBeenCalledTimes(1);
    expect(spans).toHaveLength(1);
  });

  it("defaults to the identity journal when no inner journal is given", async () => {
    const { deps: d, mem, provider } = deps();
    const journal = createOtelJobPipelineTracesStepJournal(d);
    await journal.do("feed", async () => "done");
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
  });
});

describe("createOtelJobPipelineTracesRunSettledObserver — one span per settled run", () => {
  it("records a job.run.settled span with the run ids, trigger, and state", async () => {
    const { deps: d, mem, provider } = deps();
    const observer = createOtelJobPipelineTracesRunSettledObserver(d);
    await observer({
      jobId: "job-1",
      runId: "run-1",
      trigger: "scheduled",
      state: "completed",
    });
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("job.run.settled");
    expect(spans[0].attributes.jobId).toBe("job-1");
    expect(spans[0].attributes.runId).toBe("run-1");
    expect(spans[0].attributes.trigger).toBe("scheduled");
    expect(spans[0].attributes.state).toBe("completed");
    expect(spans[0].attributes.component).toBe("job-pipeline");
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it("records an ERROR span for a failed run, carrying the error", async () => {
    const { deps: d, mem, provider } = deps();
    const observer = createOtelJobPipelineTracesRunSettledObserver(d);
    await observer({
      jobId: "job-1",
      runId: "run-1",
      trigger: "manual",
      state: "failed",
      error: "feed timed out",
    });
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].attributes.error).toBe("feed timed out");
  });

  it("records a cancelled run without an error status", async () => {
    const { deps: d, mem, provider } = deps();
    const observer = createOtelJobPipelineTracesRunSettledObserver(d);
    await observer({
      jobId: "job-1",
      runId: "run-1",
      trigger: "scheduled",
      state: "cancelled",
    });
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records no span when the domain is OFF", async () => {
    const { deps: d, mem, provider } = deps({ isEnabled: () => false });
    const observer = createOtelJobPipelineTracesRunSettledObserver(d);
    await observer({
      jobId: "job-1",
      runId: "run-1",
      trigger: "scheduled",
      state: "completed",
    });
    // Read the finished spans BEFORE shutting the provider
    // down: InMemorySpanExporter.shutdown() (reached via
    // provider.shutdown()) clears its recorded spans.
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(0);
  });

  it("invokes the flush (fire-and-forget) after a run settles", async () => {
    const flush = vi.fn(async () => undefined);
    const { deps: d, mem, provider } = deps({ flush });
    const observer = createOtelJobPipelineTracesRunSettledObserver(d);
    await observer({
      jobId: "job-1",
      runId: "run-1",
      trigger: "scheduled",
      state: "completed",
    });
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(spans).toHaveLength(1);
  });

  it("never fails when the flush rejects", async () => {
    const flush = vi.fn(async () => {
      throw new Error("flush down");
    });
    const { deps: d, mem, provider } = deps({ flush });
    const observer = createOtelJobPipelineTracesRunSettledObserver(d);
    await expect(
      observer({ jobId: "job-1", runId: "run-1", trigger: "scheduled", state: "completed" }),
    ).resolves.toBeUndefined();
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
  });
});

describe("#6466 — step spans carry the run id as a first-class field", () => {
  it("records runId + jobId attributes when the journal is given run context", async () => {
    const { deps: d, mem, provider } = deps();
    const journal = createOtelJobPipelineTracesStepJournal(d);
    await journal.do("step:run-6466:feed:0:-:-", async () => "done", {
      runId: "run-6466",
      jobId: "research:run-6466",
    });
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes.runId).toBe("run-6466");
    expect(spans[0].attributes.jobId).toBe("research:run-6466");
    expect(spans[0].attributes.step).toBe("step:run-6466:feed:0:-:-");
  });

  it("records no runId attribute when no run context is given", async () => {
    const { deps: d, mem, provider } = deps();
    const journal = createOtelJobPipelineTracesStepJournal(d);
    await journal.do("step:run-6466:feed:0:-:-", async () => "done");
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes.runId).toBeUndefined();
  });
});
