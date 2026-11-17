/**
 * Issue #5082 (S2, observability program #5080) — the ONE
 * metrics model / recorder: the J1–J7 pipeline counts and
 * durations, the quota counters, the #1819 resource rollup
 * (absorbed as the first metric), and the health + SLO
 * evaluations (each a metric + a config threshold).
 *
 * One recorder, one Meter. Every metrics producer writes
 * through it; no producer creates its own Meter or its own
 * instruments. The instruments are the first metric set:
 *   job.runs (Counter) — terminally settled runs, by
 *     job_id/state/trigger.
 *   job.stage.steps (Counter) — stage steps, by step/outcome.
 *   job.stage.step.duration (Histogram, ms) — step durations,
 *     by step.
 *   quota.report_runs (Counter) — report runs charged, by
 *     user_login/kind/tenant_id.
 *   resource.rows_read / resource.rows_written / resource.ops
 *     (Gauge) — the #1819 daily rollup, by ns/op/caller/
 *     trigger/day. The rollup is already daily-aggregated, so
 *     one gauge value per rollup row per day — the lowest
 *     possible volume, and the proof the rollup reads through
 *     the one model.
 *   health.pipeline (Gauge, 1=healthy / 0=degraded) — the
 *     J1–J7 run failure rate vs the configured max failure
 *     rate, evaluated at flush from the recorder's own run
 *     counts.
 *   slo.resource.rows_read (Gauge, 1=within SLO / 0=breached)
 *     — the day's SessionStore rows-read vs the configured
 *     max pct of the free-tier budget, evaluated when the
 *     rollup is recorded.
 *
 * Health and SLO are pure evaluators (unit-pinned) plus a
 * gauge that records the evaluation. The dashboard (S8)
 * surfaces the gauges; S2 only records them. The 70%
 * cap-ALERT is S4, not S2 — S2 instruments the measurement.
 *
 * The recorder is best-effort and never throws; a gated-out
 * (domain OFF) recording is a no-op. Recording never fails
 * the run, the step, the quota charge, or the rollup.
 */
import type { Counter, Gauge, Histogram, Meter } from "@opentelemetry/api";
import type { OtelMetricsSettings } from "./otelMetrics";
import type { JobRunSettledInfo } from "../services/jobPipelineEngine";
import { FREE_TIER_BUDGETS, type DailyRollupRow } from "../telemetry/resourceRollup";

/** The J1–J7 component the recorder gates on (the OTel gate maps it to j1j7). */
export const OTEL_METRICS_J1J7_COMPONENT = "job-pipeline" as const;

/** The run counts the health evaluation reads. */
export interface OtelRunCounts {
  total: number;
  failed: number;
}

/** The health evaluation (a metric + a config threshold). */
export interface PipelineHealthEvaluation {
  healthy: boolean;
  failureRate: number;
}

/**
 * The health check as a metric + a config threshold: the J1–J7
 * run failure rate vs the configured max failure rate. Healthy
 * when the rate is strictly below the max; at or above the max
 * is degraded. No runs yet is healthy (no signal is not a
 * failure). An invalid max rate fails closed to 0 (any failure
 * degrades).
 */
export function evaluatePipelineHealth(input: {
  failed: number;
  total: number;
  maxFailureRate: number;
}): PipelineHealthEvaluation {
  const max = Number.isFinite(input.maxFailureRate) ? input.maxFailureRate : 0;
  if (input.total <= 0) return { healthy: true, failureRate: 0 };
  const failureRate = input.failed / input.total;
  return { healthy: failureRate < max, failureRate };
}

/** The SLO evaluation (a metric + a config threshold). */
export interface ResourceSloEvaluation {
  withinSlo: boolean;
  pct: number;
}

/**
 * The SLO as a metric + a config threshold: the day's
 * SessionStore rows-read vs the configured max pct of the
 * free-tier rows-read budget. Within SLO when the pct is
 * strictly below the max; at or above the max is breached.
 * An invalid max pct fails closed to 0 (any usage breaches).
 */
export function evaluateResourceSlo(input: {
  rowsRead: number;
  budget: number;
  maxPct: number;
}): ResourceSloEvaluation {
  const max = Number.isFinite(input.maxPct) ? input.maxPct : 0;
  const budget = Number.isFinite(input.budget) && input.budget > 0 ? input.budget : 1;
  const pct = input.rowsRead / budget;
  return { withinSlo: pct < max, pct };
}

export interface OtelMetricsRecorderDeps {
  /** The OTel Meter (from the MeterProvider). */
  meter: Meter;
  /** The metrics settings (the thresholds the health/SLO evaluations read). */
  settings: OtelMetricsSettings;
  /** The per-domain gate: true only when the recording domain is ON. */
  isEnabled: (component: string) => boolean;
  /** Optional flush, invoked (fire-and-forget, never awaited) after a run settles. */
  flush?: () => Promise<void>;
}

export interface OtelMetricsRecorder {
  recordJobRunSettled(info: JobRunSettledInfo): void;
  recordJobStageStep(step: string, outcome: "completed" | "failed", durationMs: number): void;
  recordQuotaCharge(charge: { userLogin: string; kind: string; tenantId: string }): void;
  recordResourceRollup(rows: readonly DailyRollupRow[]): void;
  evaluateAndRecordPipelineHealth(): PipelineHealthEvaluation;
  /** The run counts the health evaluation reads (for tests / the flush path). */
  runCounts(): OtelRunCounts;
  /** The last SLO evaluation, or null before any rollup was recorded. */
  lastSlo(): ResourceSloEvaluation | null;
  flush(): Promise<void>;
}

/**
 * Builds the one metrics recorder over a Meter. Instruments
 * are created lazily on first use (a Meter that throws on
 * creation leaves the recorder usable — the recording is
 * swallowed, never thrown). The run counts and the last SLO
 * evaluation are kept in memory for the health/SLO gauges.
 */
export function createOtelMetricsRecorder(deps: OtelMetricsRecorderDeps): OtelMetricsRecorder {
  const { meter, settings, isEnabled } = deps;
  let runsCounter: Counter | null = null;
  let stepsCounter: Counter | null = null;
  let stepDurationHistogram: Histogram | null = null;
  let quotaCounter: Counter | null = null;
  let rowsReadGauge: Gauge | null = null;
  let rowsWrittenGauge: Gauge | null = null;
  let opsGauge: Gauge | null = null;
  let healthGauge: Gauge | null = null;
  let sloGauge: Gauge | null = null;
  let totalRuns = 0;
  let failedRuns = 0;
  let lastSloEvaluation: ResourceSloEvaluation | null = null;

  const getRunsCounter = (): Counter | null => {
    if (runsCounter) return runsCounter;
    try {
      runsCounter = meter.createCounter("job.runs", {
        description: "Terminally settled J1-J7 runs",
        unit: "1",
      });
    } catch {
      runsCounter = null;
    }
    return runsCounter;
  };
  const getStepsCounter = (): Counter | null => {
    if (stepsCounter) return stepsCounter;
    try {
      stepsCounter = meter.createCounter("job.stage.steps", {
        description: "J1-J7 stage steps",
        unit: "1",
      });
    } catch {
      stepsCounter = null;
    }
    return stepsCounter;
  };
  const getStepDurationHistogram = (): Histogram | null => {
    if (stepDurationHistogram) return stepDurationHistogram;
    try {
      stepDurationHistogram = meter.createHistogram("job.stage.step.duration", {
        description: "J1-J7 stage step durations",
        unit: "ms",
      });
    } catch {
      stepDurationHistogram = null;
    }
    return stepDurationHistogram;
  };
  const getQuotaCounter = (): Counter | null => {
    if (quotaCounter) return quotaCounter;
    try {
      quotaCounter = meter.createCounter("quota.report_runs", {
        description: "Report runs charged against the per-user quota",
        unit: "1",
      });
    } catch {
      quotaCounter = null;
    }
    return quotaCounter;
  };
  const getRowsReadGauge = (): Gauge | null => {
    if (rowsReadGauge) return rowsReadGauge;
    try {
      rowsReadGauge = meter.createGauge("resource.rows_read", {
        description: "SessionStore rows read (daily rollup)",
        unit: "1",
      });
    } catch {
      rowsReadGauge = null;
    }
    return rowsReadGauge;
  };
  const getRowsWrittenGauge = (): Gauge | null => {
    if (rowsWrittenGauge) return rowsWrittenGauge;
    try {
      rowsWrittenGauge = meter.createGauge("resource.rows_written", {
        description: "SessionStore rows written (daily rollup)",
        unit: "1",
      });
    } catch {
      rowsWrittenGauge = null;
    }
    return rowsWrittenGauge;
  };
  const getOpsGauge = (): Gauge | null => {
    if (opsGauge) return opsGauge;
    try {
      opsGauge = meter.createGauge("resource.ops", {
        description: "SessionStore store ops (daily rollup)",
        unit: "1",
      });
    } catch {
      opsGauge = null;
    }
    return opsGauge;
  };
  const getHealthGauge = (): Gauge | null => {
    if (healthGauge) return healthGauge;
    try {
      healthGauge = meter.createGauge("health.pipeline", {
        description: "J1-J7 pipeline health (1=healthy, 0=degraded)",
        unit: "1",
      });
    } catch {
      healthGauge = null;
    }
    return healthGauge;
  };
  const getSloGauge = (): Gauge | null => {
    if (sloGauge) return sloGauge;
    try {
      sloGauge = meter.createGauge("slo.resource.rows_read", {
        description: "SessionStore rows-read SLO (1=within SLO, 0=breached)",
        unit: "1",
      });
    } catch {
      sloGauge = null;
    }
    return sloGauge;
  };

  /** True only when the recording domain is ON (a gate throw is a no-op). */
  const enabled = (): boolean => {
    try {
      return isEnabled(OTEL_METRICS_J1J7_COMPONENT);
    } catch {
      return false;
    }
  };

  const recordJobRunSettled = (info: JobRunSettledInfo): void => {
    try {
      if (!enabled()) return;
      totalRuns += 1;
      if (info.state === "failed") failedRuns += 1;
      getRunsCounter()?.add(1, {
        job_id: info.jobId,
        state: info.state,
        trigger: info.trigger,
      });
      if (deps.flush) {
        deps.flush().catch(() => {
          // Best-effort: a flush failure never fails the run.
        });
      }
    } catch {
      // Best-effort: recording never fails the run.
    }
  };

  const recordJobStageStep = (
    step: string,
    outcome: "completed" | "failed",
    durationMs: number,
  ): void => {
    try {
      if (!enabled()) return;
      getStepsCounter()?.add(1, { step, outcome });
      if (Number.isFinite(durationMs)) {
        getStepDurationHistogram()?.record(durationMs, { step });
      }
    } catch {
      // Best-effort: recording never fails the step.
    }
  };

  const recordQuotaCharge = (charge: {
    userLogin: string;
    kind: string;
    tenantId: string;
  }): void => {
    try {
      if (!enabled()) return;
      getQuotaCounter()?.add(1, {
        user_login: charge.userLogin,
        kind: charge.kind,
        tenant_id: charge.tenantId,
      });
    } catch {
      // Best-effort: recording never fails the charge.
    }
  };

  const recordResourceRollup = (rows: readonly DailyRollupRow[]): void => {
    try {
      if (!enabled()) return;
      if (!rows || rows.length === 0) return;
      let dayRowsRead = 0;
      let day = "";
      for (const row of rows) {
        if (!day) day = row.day;
        dayRowsRead += row.rowsRead;
        const labels = {
          ns: row.ns,
          op: row.op,
          caller: row.caller,
          trigger: row.trigger,
          day: row.day,
        };
        getRowsReadGauge()?.record(row.rowsRead, labels);
        getRowsWrittenGauge()?.record(row.rowsWritten, labels);
        getOpsGauge()?.record(row.ops, labels);
      }
      // The SLO is evaluated on the day's GRAND total (all
      // rows), not per row — the budget is a daily budget.
      const evaluation = evaluateResourceSlo({
        rowsRead: dayRowsRead,
        budget: FREE_TIER_BUDGETS.rowsRead,
        maxPct: settings.sloResourceRowsReadMaxPct,
      });
      lastSloEvaluation = evaluation;
      getSloGauge()?.record(evaluation.withinSlo ? 1 : 0, { day });
    } catch {
      // Best-effort: recording never fails the rollup.
    }
  };

  const evaluateAndRecordPipelineHealth = (): PipelineHealthEvaluation => {
    const evaluation = evaluatePipelineHealth({
      failed: failedRuns,
      total: totalRuns,
      maxFailureRate: settings.healthPipelineMaxFailureRate,
    });
    try {
      if (!enabled()) return evaluation;
      getHealthGauge()?.record(evaluation.healthy ? 1 : 0, {});
    } catch {
      // Best-effort: recording never fails the evaluation.
    }
    return evaluation;
  };

  return {
    recordJobRunSettled,
    recordJobStageStep,
    recordQuotaCharge,
    recordResourceRollup,
    evaluateAndRecordPipelineHealth,
    runCounts: () => ({ total: totalRuns, failed: failedRuns }),
    lastSlo: () => lastSloEvaluation,
    flush: async () => {
      try {
        await deps.flush?.();
      } catch {
        // Best-effort.
      }
    },
  };
}
