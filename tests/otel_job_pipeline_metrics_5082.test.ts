/**
 * Issue #5082 (S2, observability program #5080) — the J1–J7
 * metrics observers: the run-settled observer (records
 * job.runs) and the stage-step journal (records job.stage.steps
 * + job.stage.step.duration), wired through the engine's
 * EXISTING observer seams — no engine internals are touched.
 *
 * TDD Red first: the module
 * (src/observability/otelJobPipelineMetrics.ts) does not exist
 * yet, so this file fails at import.
 *
 * Design (recorded in the PR body):
 * - These observers MIRROR the S1 logging observers
 *   (otelJobPipeline.ts) but record METRICS through the one
 *   recorder instead of logging. The logging path is untouched:
 *   the metrics observer is CHAINED after the logging observer
 *   (chainRunSettledObservers) and the metrics journal WRAPS
 *   the logging journal — each is guarded, so one observer's
 *   failure never blocks the others.
 * - Both observers are best-effort (they can never fail, retry,
 *   or duplicate the run's own records) and both check the
 *   per-domain gate first: when the j1j7 domain is OFF they
 *   no-op. The journal still runs the step when OFF (emitting
 *   nothing), and the step's error is always rethrown.
 * - The run-settled observer flushes the metrics batch
 *   promptly (fire-and-forget, never awaited) so the export
 *   does not wait for the periodic interval.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createOtelJobPipelineMetricsRunSettledObserver,
  createOtelJobPipelineMetricsStepJournal,
} from "../src/observability/otelJobPipelineMetrics";
import { identityJobStepJournal } from "../src/services/jobPipelineEngine";
import type { OtelMetricsRecorder } from "../src/observability/otelMetricsRecorder";

/** A recorder that records every call it receives. */
function recordingRecorder() {
  const settled: Array<Parameters<OtelMetricsRecorder["recordJobRunSettled"]>[0]> = [];
  const steps: Array<Parameters<OtelMetricsRecorder["recordJobStageStep"]>[0]> = [];
  const recorder = {
    recordJobRunSettled: (info: Parameters<OtelMetricsRecorder["recordJobRunSettled"]>[0]) => {
      settled.push(info);
    },
    recordJobStageStep: (...args: Parameters<OtelMetricsRecorder["recordJobStageStep"]>) => {
      steps.push(args);
    },
    recordQuotaCharge: () => undefined,
    recordResourceRollup: () => undefined,
    evaluateAndRecordPipelineHealth: () => ({ healthy: true, failureRate: 0 }),
    runCounts: () => ({ total: settled.length, failed: 0 }),
    lastSlo: () => null,
    flush: async () => undefined,
  } as unknown as OtelMetricsRecorder;
  return { recorder, settled, steps };
}

describe("createOtelJobPipelineMetricsRunSettledObserver — the run-settled metric", () => {
  it("records one job.runs metric per terminally settled run", async () => {
    const { recorder, settled } = recordingRecorder();
    const observer = createOtelJobPipelineMetricsRunSettledObserver({
      recorder,
      isEnabled: () => true,
    });
    await observer({ jobId: "feed", runId: "run-1", trigger: "cron", state: "completed" });
    await observer({ jobId: "feed", runId: "run-2", trigger: "cron", state: "failed", error: "x" });
    await observer({ jobId: "feed", runId: "run-3", trigger: "manual", state: "cancelled" });
    expect(settled).toHaveLength(3);
    expect(settled[0]).toEqual({ jobId: "feed", runId: "run-1", trigger: "cron", state: "completed" });
    expect(settled[1].state).toBe("failed");
    expect(settled[2].state).toBe("cancelled");
  });

  it("no-ops when the j1j7 domain is OFF (nothing recorded)", async () => {
    const { recorder, settled } = recordingRecorder();
    const observer = createOtelJobPipelineMetricsRunSettledObserver({
      recorder,
      isEnabled: () => false,
    });
    await observer({ jobId: "feed", runId: "run-1", trigger: "cron", state: "completed" });
    expect(settled).toHaveLength(0);
  });

  it("flushes the metrics batch promptly (fire-and-forget) after a run settles", async () => {
    const { recorder } = recordingRecorder();
    const flush = vi.fn(async () => undefined);
    const observer = createOtelJobPipelineMetricsRunSettledObserver({
      recorder,
      isEnabled: () => true,
      flush,
    });
    await observer({ jobId: "feed", runId: "run-1", trigger: "cron", state: "completed" });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("never throws when the recorder throws (best-effort: metrics never fail the run)", async () => {
    const throwingRecorder = {
      recordJobRunSettled: () => {
        throw new Error("recorder down");
      },
    } as unknown as OtelMetricsRecorder;
    const observer = createOtelJobPipelineMetricsRunSettledObserver({
      recorder: throwingRecorder,
      isEnabled: () => true,
    });
    await expect(
      observer({ jobId: "feed", runId: "run-1", trigger: "cron", state: "completed" }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the flush rejects (best-effort)", async () => {
    const { recorder } = recordingRecorder();
    const observer = createOtelJobPipelineMetricsRunSettledObserver({
      recorder,
      isEnabled: () => true,
      flush: async () => {
        throw new Error("flush down");
      },
    });
    await expect(
      observer({ jobId: "feed", runId: "run-1", trigger: "cron", state: "completed" }),
    ).resolves.toBeUndefined();
  });
});

describe("createOtelJobPipelineMetricsStepJournal — the step count + duration metrics", () => {
  it("records a completed step (count + duration) and returns the step's value", async () => {
    const { recorder, steps } = recordingRecorder();
    const journal = createOtelJobPipelineMetricsStepJournal({
      recorder,
      isEnabled: () => true,
      nowMs: (() => {
        let t = 1000;
        return () => (t += 250);
      })(),
    });
    const result = await journal.do("feed", async () => "ok");
    expect(result).toBe("ok");
    expect(steps).toHaveLength(1);
    expect(steps[0][0]).toBe("feed");
    expect(steps[0][1]).toBe("completed");
    expect(steps[0][2]).toBe(250);
  });

  it("records a failed step (count + duration) and rethrows the step's error", async () => {
    const { recorder, steps } = recordingRecorder();
    const journal = createOtelJobPipelineMetricsStepJournal({
      recorder,
      isEnabled: () => true,
      nowMs: (() => {
        let t = 1000;
        return () => (t += 100);
      })(),
    });
    await expect(journal.do("enrich", async () => {
      throw new Error("step boom");
    })).rejects.toThrow("step boom");
    expect(steps).toHaveLength(1);
    expect(steps[0][0]).toBe("enrich");
    expect(steps[0][1]).toBe("failed");
    expect(steps[0][2]).toBe(100);
  });

  it("still runs the step when the domain is OFF, recording nothing", async () => {
    const { recorder, steps } = recordingRecorder();
    const journal = createOtelJobPipelineMetricsStepJournal({
      recorder,
      isEnabled: () => false,
    });
    const result = await journal.do("feed", async () => "ok");
    expect(result).toBe("ok");
    expect(steps).toHaveLength(0);
  });

  it("delegates to the inner journal (the logging journal) and records around it", async () => {
    const { recorder, steps } = recordingRecorder();
    const innerCalls: string[] = [];
    const inner = {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        innerCalls.push(name);
        return fn();
      },
    };
    const journal = createOtelJobPipelineMetricsStepJournal({
      recorder,
      isEnabled: () => true,
      inner,
      nowMs: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
    });
    await journal.do("feed", async () => "ok");
    expect(innerCalls).toEqual(["feed"]);
    expect(steps).toHaveLength(1);
  });

  it("defaults to the identity journal when no inner journal is given", async () => {
    const { recorder, steps } = recordingRecorder();
    const journal = createOtelJobPipelineMetricsStepJournal({
      recorder,
      isEnabled: () => true,
    });
    expect(identityJobStepJournal).toBeDefined();
    const result = await journal.do("feed", async () => 42);
    expect(result).toBe(42);
    expect(steps).toHaveLength(1);
  });
});
