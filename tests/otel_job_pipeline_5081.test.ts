/**
 * Issue #5081 (S1, observability program #5080) — the J1–J7
 * domain instrumentation: the job-pipeline observers.
 *
 * TDD Red first: the module (src/observability/otelJobPipeline.ts)
 * does not exist yet, so this file fails at import.
 *
 * The J1–J7 stack (Epic #3533) is instrumented through the
 * engine's EXISTING observer seams — no engine internals are
 * touched:
 * - runSettledObserver (JobPipelineDeps, #3530 slice B): the
 *   engine's one terminal-recording point, invoked once per
 *   terminally settled run (completed/failed/cancelled) for every
 *   trigger class. The OTel observer emits `job.run.settled`.
 * - journal (JobStepJournal.do): wraps each stage step's
 *   execution. The OTel journal emits `job.stage.step.started` /
 *   `job.stage.step.completed` / `job.stage.step.failed` with the
 *   step duration.
 *
 * Both observers are best-effort (they can never fail, retry, or
 * duplicate the run's own records) and both check the per-domain
 * gate first: when the j1j7 domain is OFF they no-op. The
 * observers CHAIN with any existing observer/journal (the
 * ScheduledAgent host already sets runSettledObserver to the
 * feed-run observer; the workflow host already sets the journal
 * to the workflow-step journal) — they never replace one.
 *
 * Wired on the ScheduledAgent host only in S1 (the pipeline
 * owner, createScheduledAgentPipelineControl). The workflow /
 * options / in-memory hosts are not yet wired — same helper,
 * later slice (recorded in the PR body).
 */
import { describe, it, expect, vi } from "vitest";
import { SeverityNumber } from "@opentelemetry/api";
import {
  createOtelJobPipelineRunSettledObserver,
  createOtelJobStepJournal,
  chainRunSettledObservers,
  type OtelJobPipelineObserverDeps,
} from "../src/observability/otelJobPipeline";
import { createStructuredLogger, type StructuredLogger } from "../src/observability/structuredLogger";
import type {
  ObservabilityEvent,
  ObservabilitySink,
} from "../src/observability/observabilityPorts";
import type { JobRunSettledInfo } from "../src/services/jobPipelineEngine";
import type { JobStepJournal } from "../src/services/jobPipelineEngine";
import {
  createOtelLoggerProvider,
  createOtelObservabilitySink,
  createOtelDomainGate,
  type OtelLoggingConfig,
  type OtelTransport,
} from "../src/observability/otelLogs";
import { OTEL_BACKEND_SETTINGS_BUILTIN } from "../src/config/otelModes";

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

function observerDeps(
  logger: StructuredLogger,
  isEnabled: () => boolean = () => true,
): OtelJobPipelineObserverDeps {
  return { logger, isEnabled };
}

describe("createOtelJobPipelineRunSettledObserver — job.run.settled", () => {
  it("emits a job.run.settled log for a completed run (info)", async () => {
    const { sink, events } = recordingSink();
    const observer = createOtelJobPipelineRunSettledObserver(
      observerDeps(testLogger(sink)),
    );
    const info: JobRunSettledInfo = {
      jobId: "yahoo-nasdaq100",
      runId: "run-1",
      trigger: "scheduled",
      state: "completed",
    };
    await observer(info);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("job.run.settled");
    expect(events[0].level).toBe("info");
    expect(events[0].fields?.jobId).toBe("yahoo-nasdaq100");
    expect(events[0].fields?.runId).toBe("run-1");
    expect(events[0].fields?.trigger).toBe("scheduled");
    expect(events[0].fields?.state).toBe("completed");
  });

  it("emits at error level for a failed run, carrying the error", async () => {
    const { sink, events } = recordingSink();
    const observer = createOtelJobPipelineRunSettledObserver(
      observerDeps(testLogger(sink)),
    );
    await observer({
      jobId: "yahoo-nasdaq100",
      runId: "run-2",
      trigger: "manual",
      state: "failed",
      error: "FEED_DEADLINE_EXCEEDED",
    });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("error");
    expect(events[0].fields?.state).toBe("failed");
    expect(events[0].fields?.error).toBe("FEED_DEADLINE_EXCEEDED");
  });

  it("emits at warn level for a cancelled run", async () => {
    const { sink, events } = recordingSink();
    const observer = createOtelJobPipelineRunSettledObserver(
      observerDeps(testLogger(sink)),
    );
    await observer({
      jobId: "yahoo-nasdaq100",
      runId: "run-3",
      trigger: "manual",
      state: "cancelled",
    });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("warn");
  });

  it("no-ops (emits nothing) when the j1j7 domain is OFF", async () => {
    const { sink, events } = recordingSink();
    const observer = createOtelJobPipelineRunSettledObserver(
      observerDeps(testLogger(sink), () => false),
    );
    await observer({
      jobId: "yahoo-nasdaq100",
      runId: "run-4",
      trigger: "manual",
      state: "completed",
    });
    expect(events).toHaveLength(0);
  });

  it("never throws (best-effort): a logger failure cannot fail the run", async () => {
    const throwingSink: ObservabilitySink = {
      write: () => {
        throw new Error("sink down");
      },
    };
    const observer = createOtelJobPipelineRunSettledObserver(
      observerDeps(testLogger(throwingSink)),
    );
    await expect(
      observer({ jobId: "j", runId: "r", trigger: "manual", state: "completed" }),
    ).resolves.toBeUndefined();
  });
});

describe("chainRunSettledObservers — the existing observer is kept", () => {
  it("runs every observer in order, even when one throws", async () => {
    const seen: string[] = [];
    const first = async () => {
      seen.push("first");
      throw new Error("first down");
    };
    const second = async () => {
      seen.push("second");
    };
    const chained = chainRunSettledObservers(first, second, undefined);
    await chained({ jobId: "j", runId: "r", trigger: "manual", state: "completed" });
    expect(seen).toEqual(["first", "second"]);
  });

  it("skips undefined observers", async () => {
    const seen: string[] = [];
    const chained = chainRunSettledObservers(undefined, async () => {
      seen.push("only");
    });
    await chained({ jobId: "j", runId: "r", trigger: "manual", state: "completed" });
    expect(seen).toEqual(["only"]);
  });
});

describe("createOtelJobStepJournal — stage step start/complete/fail", () => {
  it("logs step started + completed with the duration, and returns the step result", async () => {
    const { sink, events } = recordingSink();
    const nowMs = vi.fn();
    nowMs.mockReturnValueOnce(1000).mockReturnValueOnce(1250);
    const journal = createOtelJobStepJournal({
      ...observerDeps(testLogger(sink)),
      nowMs,
    });
    const result = await journal.do("feed", async () => "hand-off");
    expect(result).toBe("hand-off");
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("job.stage.step.started");
    expect(events[0].fields?.step).toBe("feed");
    expect(events[1].type).toBe("job.stage.step.completed");
    expect(events[1].fields?.step).toBe("feed");
    expect(events[1].fields?.durationMs).toBe(250);
  });

  it("logs step failed at error level and rethrows the step error", async () => {
    const { sink, events } = recordingSink();
    const journal = createOtelJobStepJournal({
      ...observerDeps(testLogger(sink)),
      nowMs: () => 1000,
    });
    await expect(
      journal.do("enrich", async () => {
        throw new Error("enrich blew up");
      }),
    ).rejects.toThrow("enrich blew up");
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("job.stage.step.failed");
    expect(events[1].level).toBe("error");
    expect(events[1].fields?.error).toBe("enrich blew up");
  });

  it("delegates to the inner journal (the workflow-step journal is kept)", async () => {
    const { sink, events } = recordingSink();
    const innerCalls: string[] = [];
    const inner: JobStepJournal = {
      do: async (name, fn) => {
        innerCalls.push(name);
        return fn();
      },
    };
    const journal = createOtelJobStepJournal({
      ...observerDeps(testLogger(sink)),
      inner,
      nowMs: () => 1000,
    });
    await journal.do("analyze", async () => 42);
    expect(innerCalls).toEqual(["analyze"]);
    expect(events).toHaveLength(2);
  });

  it("no-ops (emits nothing, still runs the step) when the j1j7 domain is OFF", async () => {
    const { sink, events } = recordingSink();
    const journal = createOtelJobStepJournal({
      ...observerDeps(testLogger(sink), () => false),
      nowMs: () => 1000,
    });
    const result = await journal.do("generate", async () => "ok");
    expect(result).toBe("ok");
    expect(events).toHaveLength(0);
  });
});

describe("J1–J7 observers end-to-end — observer → OTel sink → OTLP/HTTP transport", () => {
  it("a settled run reaches the transport as an OTLP log record", async () => {
    const bodies: Uint8Array[] = [];
    const transport: OtelTransport = async (body) => {
      bodies.push(body);
      return { status: 202 };
    };
    const config: OtelLoggingConfig = {
      masterEnabled: true,
      logsExporter: "otlp",
      domains: {
        j1j7: { enabled: true, level: "INFO", samplingRatio: 1 },
        "stock-copilot": { enabled: false, level: "INFO", samplingRatio: 1 },
        iaaa: { enabled: false, level: "INFO", samplingRatio: 1 },
        "mcp-a2a": { enabled: false, level: "INFO", samplingRatio: 1 },
        scheduler: { enabled: false, level: "INFO", samplingRatio: 1 },
        payments: { enabled: false, level: "INFO", samplingRatio: 1 },
        "market-data": { enabled: false, level: "INFO", samplingRatio: 1 },
        platform: { enabled: false, level: "INFO", samplingRatio: 1 },
      },
      // Issue #5138 — all destinations ON (the file defaults).
      destinations: { analyticsEngine: true, r2: true, console: true },
      // Issue #5164 — the backend is a required field (resolved by the
      // config port); the builtin default is OFF, so this end-to-end
      // test keeps its fake transport and exercises the OTel sink path.
      backend: OTEL_BACKEND_SETTINGS_BUILTIN,
    };
    const { provider, logger } = createOtelLoggerProvider({
      config,
      transport,
      processor: "simple",
    });
    const gate = createOtelDomainGate(config, () => 0.5);
    const otelSink = createOtelObservabilitySink({ logger, gate });
    const structured = createStructuredLogger(otelSink, {
      component: "job-pipeline",
      nowMs: () => 1_791_158_400_000,
    });
    const observer = createOtelJobPipelineRunSettledObserver({
      logger: structured,
      isEnabled: () => true,
    });
    await observer({
      jobId: "yahoo-nasdaq100",
      runId: "run-9",
      trigger: "scheduled",
      state: "completed",
    });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies.length).toBe(1);
    const payload = JSON.parse(new TextDecoder().decode(bodies[0]));
    const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.body.stringValue).toBe("job.run.settled");
    expect(logRecord.severityNumber).toBe(SeverityNumber.INFO);
    const attrs = Object.fromEntries(
      (logRecord.attributes ?? []).map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(attrs.jobId).toBe("yahoo-nasdaq100");
    expect(attrs.runId).toBe("run-9");
  });
});
