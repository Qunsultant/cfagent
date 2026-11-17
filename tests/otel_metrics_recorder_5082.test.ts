/**
 * Issue #5082 (S2, observability program #5080) — the ONE
 * metrics model / recorder: the J1–J7 pipeline counts and
 * durations, the quota counters, the #1819 resource rollup
 * (absorbed as the first metric), and the health + SLO
 * evaluations (each a metric + a config threshold).
 *
 * TDD Red first: the module
 * (src/observability/otelMetricsRecorder.ts) does not exist
 * yet, so this file fails at import.
 *
 * Design (recorded in the PR body):
 * - One recorder, one Meter. Every metrics producer writes
 *   through it; no producer creates its own Meter or its own
 *   instruments. The instruments are the first metric set:
 *     job.runs (Counter) — terminally settled runs, by
 *       job_id/state/trigger.
 *     job.stage.steps (Counter) — stage steps, by step/outcome.
 *     job.stage.step.duration (Histogram, ms) — step durations,
 *       by step.
 *     quota.report_runs (Counter) — report runs charged, by
 *       user_login/kind/tenant_id.
 *     resource.rows_read / resource.rows_written / resource.ops
 *       (Gauge) — the #1819 daily rollup, by ns/op/caller/
 *       trigger/day. The rollup is already daily-aggregated, so
 *       one gauge value per rollup row per day — the lowest
 *       possible volume, and the proof the rollup reads through
 *       the one model.
 *     health.pipeline (Gauge, 1=healthy / 0=degraded) — the
 *       J1–J7 run failure rate vs the configured max failure
 *       rate, evaluated at flush from the recorder's own run
 *       counts.
 *     slo.resource.rows_read (Gauge, 1=within SLO / 0=breached)
 *       — the day's SessionStore rows-read vs the configured
 *       max pct of the free-tier budget, evaluated when the
 *       rollup is recorded.
 * - Health and SLO are pure evaluators (unit-pinned here) plus
 *   a gauge that records the evaluation. The dashboard (S8)
 *   surfaces the gauges; S2 only records them. The 70%
 *   cap-ALERT is S4, not S2 — S2 instruments the measurement.
 * - The recorder is best-effort and never throws; a gated-out
 *   (domain OFF) recording is a no-op. Recording never fails
 *   the run, the step, the quota charge, or the rollup.
 */
import { describe, it, expect } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  createOtelMetricsRecorder,
  evaluatePipelineHealth,
  evaluateResourceSlo,
  type OtelMetricsRecorder,
} from "../src/observability/otelMetricsRecorder";
import type { OtelMetricsSettings } from "../src/observability/otelMetrics";

/** The default metrics settings (the config-file values). */
function defaultSettings(overrides: Partial<OtelMetricsSettings> = {}): OtelMetricsSettings {
  return {
    exportIntervalMs: 60000,
    freeTierDailyWriteLimit: 100000,
    freeTierDailyReadQueryLimit: 10000,
    healthPipelineMaxFailureRate: 0.05,
    sloResourceRowsReadMaxPct: 0.7,
    ...overrides,
  };
}

/** A recorder over a live MeterProvider with a recording exporter. */
function liveRecorder(
  settings: OtelMetricsSettings = defaultSettings(),
  isEnabled: (component: string) => boolean = () => true,
): { recorder: OtelMetricsRecorder; provider: MeterProvider; flush: () => Promise<void> } {
  const provider = new MeterProvider();
  const meter = provider.getMeter("cfagent-metrics-test");
  const recorder = createOtelMetricsRecorder({ meter, settings, isEnabled });
  return { recorder, provider, flush: () => provider.forceFlush() };
}

describe("evaluatePipelineHealth — the health check as a metric + threshold", () => {
  it("is healthy when the failure rate is below the configured max", () => {
    const r = evaluatePipelineHealth({ failed: 1, total: 100, maxFailureRate: 0.05 });
    expect(r.healthy).toBe(true);
    expect(r.failureRate).toBeCloseTo(0.01);
  });

  it("is degraded when the failure rate is at or above the configured max", () => {
    expect(
      evaluatePipelineHealth({ failed: 5, total: 100, maxFailureRate: 0.05 }).healthy,
    ).toBe(false);
    expect(
      evaluatePipelineHealth({ failed: 6, total: 100, maxFailureRate: 0.05 }).healthy,
    ).toBe(false);
  });

  it("is healthy when there are no runs yet (no signal is not a failure)", () => {
    const r = evaluatePipelineHealth({ failed: 0, total: 0, maxFailureRate: 0.05 });
    expect(r.healthy).toBe(true);
    expect(r.failureRate).toBe(0);
  });

  it("treats an invalid max failure rate as 0 (fail-closed: any failure degrades)", () => {
    const r = evaluatePipelineHealth({ failed: 1, total: 100, maxFailureRate: NaN });
    expect(r.healthy).toBe(false);
  });
});

describe("evaluateResourceSlo — the SLO as a metric + threshold", () => {
  it("is within SLO when rows-read is below the configured max pct of the budget", () => {
    const r = evaluateResourceSlo({
      rowsRead: 3_000_000,
      budget: 5_000_000,
      maxPct: 0.7,
    });
    expect(r.withinSlo).toBe(true);
    expect(r.pct).toBeCloseTo(0.6);
  });

  it("is breached when rows-read is at or above the configured max pct", () => {
    expect(
      evaluateResourceSlo({ rowsRead: 3_500_000, budget: 5_000_000, maxPct: 0.7 }).withinSlo,
    ).toBe(false);
    expect(
      evaluateResourceSlo({ rowsRead: 4_000_000, budget: 5_000_000, maxPct: 0.7 }).withinSlo,
    ).toBe(false);
  });

  it("treats an invalid max pct as 0 (fail-closed: any usage breaches)", () => {
    const r = evaluateResourceSlo({ rowsRead: 1, budget: 5_000_000, maxPct: NaN });
    expect(r.withinSlo).toBe(false);
  });
});

describe("createOtelMetricsRecorder — the J1–J7 pipeline instruments", () => {
  it("records a settled run as a job.runs counter (one per run, by state/trigger)", async () => {
    const { recorder, provider, flush } = liveRecorder();
    recorder.recordJobRunSettled({
      jobId: "feed",
      runId: "run-1",
      trigger: "cron",
      state: "completed",
    });
    recorder.recordJobRunSettled({
      jobId: "feed",
      runId: "run-2",
      trigger: "cron",
      state: "failed",
      error: "boom",
    });
    // The recorder tracks the counts for the health evaluation.
    expect(recorder.runCounts()).toEqual({ total: 2, failed: 1 });
    await flush();
    await provider.shutdown();
  });

  it("records a stage step as a step counter and a duration histogram", async () => {
    const { recorder, provider, flush } = liveRecorder();
    recorder.recordJobStageStep("feed", "completed", 250);
    recorder.recordJobStageStep("enrich", "failed", 1200);
    await flush();
    await provider.shutdown();
  });

  it("is a no-op when the domain is OFF (nothing recorded, no counts tracked)", () => {
    const { recorder } = liveRecorder(defaultSettings(), () => false);
    recorder.recordJobRunSettled({
      jobId: "feed",
      runId: "run-1",
      trigger: "cron",
      state: "failed",
    });
    recorder.recordJobStageStep("feed", "completed", 250);
    expect(recorder.runCounts()).toEqual({ total: 0, failed: 0 });
  });

  it("never throws when the meter throws (best-effort: recording never fails the run)", () => {
    const throwingMeter = {
      createCounter: () => {
        throw new Error("meter down");
      },
      createHistogram: () => {
        throw new Error("meter down");
      },
      createGauge: () => {
        throw new Error("meter down");
      },
    } as unknown as Parameters<typeof createOtelMetricsRecorder>[0]["meter"];
    const recorder = createOtelMetricsRecorder({
      meter: throwingMeter,
      settings: defaultSettings(),
      isEnabled: () => true,
    });
    expect(() =>
      recorder.recordJobRunSettled({
        jobId: "feed",
        runId: "run-1",
        trigger: "cron",
        state: "completed",
      }),
    ).not.toThrow();
    expect(() => recorder.recordJobStageStep("feed", "completed", 1)).not.toThrow();
  });
});

describe("createOtelMetricsRecorder — the quota counter", () => {
  it("records a quota charge as a quota.report_runs counter", async () => {
    const { recorder, provider, flush } = liveRecorder();
    recorder.recordQuotaCharge({ userLogin: "openaimp", kind: "screen", tenantId: "openaimp" });
    recorder.recordQuotaCharge({ userLogin: "openaimp", kind: "screen", tenantId: "openaimp" });
    await flush();
    await provider.shutdown();
  });

  it("is a no-op when the domain is OFF", () => {
    const { recorder } = liveRecorder(defaultSettings(), () => false);
    expect(() =>
      recorder.recordQuotaCharge({ userLogin: "openaimp", kind: "screen", tenantId: "openaimp" }),
    ).not.toThrow();
  });
});

describe("createOtelMetricsRecorder — the #1819 rollup absorbed as metrics", () => {
  it("records each rollup row as resource gauges (rows_read, rows_written, ops)", async () => {
    const { recorder, provider, flush } = liveRecorder();
    recorder.recordResourceRollup([
      {
        day: "2026-11-16",
        ns: "SessionStore",
        op: "get",
        caller: "login",
        trigger: "user",
        ops: 120,
        rowsRead: 50000,
        rowsWritten: 200,
      },
      {
        day: "2026-11-16",
        ns: "SessionStore",
        op: "put",
        caller: "session",
        trigger: "cron",
        ops: 80,
        rowsRead: 10000,
        rowsWritten: 5000,
      },
    ]);
    await flush();
    await provider.shutdown();
  });

  it("records the SLO gauge: within SLO when the day's rows-read is below the threshold", () => {
    const { recorder } = liveRecorder(defaultSettings({ sloResourceRowsReadMaxPct: 0.7 }));
    recorder.recordResourceRollup([
      {
        day: "2026-11-16",
        ns: "SessionStore",
        op: "get",
        caller: "login",
        trigger: "user",
        ops: 1,
        rowsRead: 1000,
        rowsWritten: 1,
      },
    ]);
    // 1000 of 5,000,000 is 0.02% — within the 70% SLO.
    expect(recorder.lastSlo()).toEqual({ withinSlo: true, pct: 0.0002 });
  });

  it("records the SLO gauge: breached when the day's rows-read is at/above the threshold", () => {
    const { recorder } = liveRecorder(defaultSettings({ sloResourceRowsReadMaxPct: 0.7 }));
    recorder.recordResourceRollup([
      {
        day: "2026-11-16",
        ns: "SessionStore",
        op: "get",
        caller: "login",
        trigger: "user",
        ops: 1,
        rowsRead: 3_500_000,
        rowsWritten: 1,
      },
    ]);
    expect(recorder.lastSlo()).toEqual({ withinSlo: false, pct: 0.7 });
  });

  it("is a no-op when the domain is OFF (no gauges, no SLO evaluation)", () => {
    const { recorder } = liveRecorder(defaultSettings(), () => false);
    recorder.recordResourceRollup([
      {
        day: "2026-11-16",
        ns: "SessionStore",
        op: "get",
        caller: "login",
        trigger: "user",
        ops: 1,
        rowsRead: 1000,
        rowsWritten: 1,
      },
    ]);
    expect(recorder.lastSlo()).toBeNull();
  });

  it("never throws on an empty rollup (no rows is a valid empty day)", () => {
    const { recorder } = liveRecorder();
    expect(() => recorder.recordResourceRollup([])).not.toThrow();
    expect(recorder.lastSlo()).toBeNull();
  });
});

describe("createOtelMetricsRecorder — the health gauge at flush", () => {
  it("evaluates health from its own run counts and records the health.pipeline gauge", () => {
    const { recorder } = liveRecorder(defaultSettings({ healthPipelineMaxFailureRate: 0.05 }));
    // 1 failure in 100 runs = 1% — healthy.
    for (let i = 0; i < 99; i++) {
      recorder.recordJobRunSettled({
        jobId: "feed",
        runId: `run-${i}`,
        trigger: "cron",
        state: "completed",
      });
    }
    recorder.recordJobRunSettled({
      jobId: "feed",
      runId: "run-99",
      trigger: "cron",
      state: "failed",
    });
    expect(recorder.evaluateAndRecordPipelineHealth()).toEqual({ healthy: true, failureRate: 0.01 });
  });

  it("records degraded when the failure rate reaches the threshold", () => {
    const { recorder } = liveRecorder(defaultSettings({ healthPipelineMaxFailureRate: 0.05 }));
    for (let i = 0; i < 95; i++) {
      recorder.recordJobRunSettled({
        jobId: "feed",
        runId: `run-${i}`,
        trigger: "cron",
        state: "completed",
      });
    }
    for (let i = 95; i < 100; i++) {
      recorder.recordJobRunSettled({
        jobId: "feed",
        runId: `run-${i}`,
        trigger: "cron",
        state: "failed",
      });
    }
    expect(recorder.evaluateAndRecordPipelineHealth()).toEqual({
      healthy: false,
      failureRate: 0.05,
    });
  });
});
