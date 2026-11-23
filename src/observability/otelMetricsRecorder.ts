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
 *   slo.api.uptime (Gauge, 1=within SLO / 0=breached) — the
 *     #3515 S5 uptime SLO: the share of recorded API requests
 *     not failing (status < 500) vs the tenant's configured
 *     uptime target, evaluated when the SLO read endpoint asks.
 *   slo.api.p95_latency (Gauge, 1=within SLO / 0=breached) —
 *     the #3515 S5 P95 API latency SLO: the 95th percentile of
 *     recorded API request durations vs the tenant's configured
 *     max, evaluated when the SLO read endpoint asks.
 *
 * The API SLOs (#5425) ride the same recorder and the same
 * metric+threshold shape, but their measurement differs from
 * the resource SLO: there is no prober and no background job —
 * uptime is measured from the recorder's own API request counts
 * (parallel to evaluatePipelineHealth's run counts), and P95 is
 * computed from a bounded in-memory sample of raw durations
 * (the exported histogram series keep only sum/count/min/max,
 * so P95 cannot be reconstructed from AE). The evaluation
 * trigger is the SLO read endpoint (GET /api/otel/v1/slo) —
 * evaluateAndRecordSlo is called by a real read path, never
 * left dangling like the health evaluation was before S5.
 * A threshold that is null (unconfigured) is not evaluated and
 * claims nothing: its gauge is skipped, and the read reports
 * "unconfigured". No observations yet reports "no-data".
 * Recording never fails the request; evaluation never throws.
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
import type { ApiRequestDimensions } from "./observabilityPorts";
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

/** The API uptime evaluation (a metric + a config threshold). */
export interface UptimeSloEvaluation {
  /** Share of requests not failing (status < 500); null with no requests yet. */
  uptime: number | null;
  /** Null with no requests yet (no signal is not compliance). */
  withinSlo: boolean | null;
}

/**
 * The uptime SLO as a metric + a config threshold: the share of
 * recorded API requests not failing vs the configured target
 * ratio. The target is a FLOOR, so within SLO is `>=` (unlike
 * the resource SLO's ceiling `<`): meeting the target counts.
 * No requests yet is neither within nor breached (null verdict).
 * An invalid target fails closed to never-within (any measured
 * uptime is reported, but no compliance is claimed).
 */
export function evaluateUptimeSlo(input: {
  total: number;
  failed: number;
  targetRatio: number;
}): UptimeSloEvaluation {
  if (input.total <= 0) return { uptime: null, withinSlo: null };
  const uptime = (input.total - input.failed) / input.total;
  const target = input.targetRatio;
  if (!Number.isFinite(target) || target <= 0 || target > 1) {
    return { uptime, withinSlo: false };
  }
  return { uptime, withinSlo: uptime >= target };
}

/** The API P95 latency evaluation (a metric + a config threshold). */
export interface P95LatencySloEvaluation {
  /** 95th percentile of the recorded durations (ms); null with no samples yet. */
  p95Ms: number | null;
  /** Null with no samples yet (no signal is not compliance). */
  withinSlo: boolean | null;
}

/**
 * Nearest-rank 95th percentile over raw durations (ms).
 * Sorts a copy, takes the ceil(0.95 * n)-th value (1-based).
 * Empty sample is null. The sample is the recorder's bounded
 * in-memory window — P95 is computed from raw observations,
 * never reconstructed from exported histogram aggregates.
 */
export function percentile95(samples: readonly number[]): number | null {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}

/**
 * The P95 latency SLO as a metric + a config threshold: the
 * 95th percentile of recorded API request durations vs the
 * configured max. The max is a CEILING, so within SLO is `<=`.
 * No samples yet is neither within nor breached (null verdict).
 * An invalid max fails closed to never-within.
 */
export function evaluateP95LatencySlo(input: {
  samples: readonly number[];
  maxMs: number;
}): P95LatencySloEvaluation {
  const p95Ms = percentile95(input.samples);
  if (p95Ms === null) return { p95Ms: null, withinSlo: null };
  const max = input.maxMs;
  if (!Number.isFinite(max) || max <= 0) {
    return { p95Ms, withinSlo: false };
  }
  return { p95Ms, withinSlo: p95Ms <= max };
}

/** The tenant's configured API SLO thresholds (null = unconfigured). */
export interface ApiSloThresholds {
  uptimeTargetRatio: number | null;
  p95LatencyMaxMs: number | null;
}

/** The two API SLO evaluations, as the read endpoint reports them. */
export interface ApiSloEvaluation {
  uptime: { value: number | null; withinSlo: boolean | null; target: number | null };
  p95Latency: { valueMs: number | null; withinSlo: boolean | null; targetMs: number | null };
  totalRequests: number;
  failedRequests: number;
  latencySamples: number;
}

/** The API request counts the uptime evaluation reads. */
export interface ApiRequestCounts {
  total: number;
  failed: number;
  latencySamples: number;
}

/**
 * The bounded latency sample for the P95: the oldest durations
 * drop once the window is full, so one isolate's memory stays
 * bounded however many requests it serves. Counts stay exact —
 * only the percentile window is bounded.
 */
export const API_REQUEST_LATENCY_SAMPLE_CAP = 10_000;

/**
 * Issue #6172: one bounded API latency sample — the duration
 * plus the SLO cuts of the request's validated context, when
 * the request carried one. An undimensioned observation stores
 * just the duration (the pre-#6172 shape). The per-dimension
 * evaluation (#6174) reads these samples; the aggregate
 * evaluation reads only the durations, unchanged.
 */
export type ApiRequestSample = {
  durationMs: number;
} & ApiRequestDimensions;

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
  /** Issue #5425 (#3515 S5): record one API request (status + duration) for the API SLOs. */
  recordApiRequest(observation: {
    status: number;
    durationMs: number;
    /** Issue #6172: the SLO cuts of the request's validated context, when carried. */
    dimensions?: ApiRequestDimensions;
  }): void;
  /**
   * Issue #5425 (#3515 S5): evaluate both API SLOs against the
   * tenant's thresholds and record the gauges (1=within /
   * 0=breached). A null threshold is not evaluated and its gauge
   * is skipped. Called by the SLO read endpoint — the real
   * evaluation trigger. Returns the evaluation.
   */
  evaluateAndRecordSlo(thresholds: ApiSloThresholds): ApiSloEvaluation;
  /** The API request counts the uptime evaluation reads (for tests / the read path). */
  apiRequestCounts(): ApiRequestCounts;
  /**
   * Issue #6172: the bounded dimensioned latency samples (the
   * per-dimension evaluation's input, #6174). A readonly view
   * of the same window the P95 reads — callers must not mutate
   * it. Undimensioned samples carry only durationMs.
   */
  apiRequestSamples(): readonly ApiRequestSample[];
  /** The last API SLO evaluation, or null before any evaluation. */
  lastApiSlo(): ApiSloEvaluation | null;
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
  let uptimeSloGauge: Gauge | null = null;
  let p95LatencySloGauge: Gauge | null = null;
  let totalRuns = 0;
  let failedRuns = 0;
  let lastSloEvaluation: ResourceSloEvaluation | null = null;
  // Issue #5425 (#3515 S5): the API SLO state — exact counts
  // plus the bounded latency sample the P95 reads. Per-isolate,
  // like the run counts above: each isolate evaluates the
  // requests it served.
  let totalApiRequests = 0;
  let failedApiRequests = 0;
  const apiLatencySamples: ApiRequestSample[] = [];
  let lastApiSloEvaluation: ApiSloEvaluation | null = null;

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
  const getUptimeSloGauge = (): Gauge | null => {
    if (uptimeSloGauge) return uptimeSloGauge;
    try {
      uptimeSloGauge = meter.createGauge("slo.api.uptime", {
        description: "API uptime SLO (1=within SLO, 0=breached)",
        unit: "1",
      });
    } catch {
      uptimeSloGauge = null;
    }
    return uptimeSloGauge;
  };
  const getP95LatencySloGauge = (): Gauge | null => {
    if (p95LatencySloGauge) return p95LatencySloGauge;
    try {
      p95LatencySloGauge = meter.createGauge("slo.api.p95_latency", {
        description: "API P95 latency SLO (1=within SLO, 0=breached)",
        unit: "1",
      });
    } catch {
      p95LatencySloGauge = null;
    }
    return p95LatencySloGauge;
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

  const recordApiRequest = (observation: {
    status: number;
    durationMs: number;
    dimensions?: ApiRequestDimensions;
  }): void => {
    try {
      if (!enabled()) return;
      totalApiRequests += 1;
      if (observation.status >= 500) failedApiRequests += 1;
      if (Number.isFinite(observation.durationMs)) {
        // Issue #6172: store the duration with the observation's
        // SLO cuts (when carried) — only the keys the observation
        // actually carried, so an undimensioned sample stays a
        // bare { durationMs }.
        apiLatencySamples.push({
          durationMs: observation.durationMs,
          ...(observation.dimensions ?? {}),
        });
        while (apiLatencySamples.length > API_REQUEST_LATENCY_SAMPLE_CAP) {
          apiLatencySamples.shift();
        }
      }
    } catch {
      // Best-effort: recording never fails the request.
    }
  };

  const evaluateAndRecordSlo = (thresholds: ApiSloThresholds): ApiSloEvaluation => {
    const uptimeValue =
      totalApiRequests > 0 ? (totalApiRequests - failedApiRequests) / totalApiRequests : null;
    // The aggregate P95 reads only the durations — the
    // dimensions ride alongside, never into the percentile.
    const durations = apiLatencySamples.map((s) => s.durationMs);
    const p95Value = percentile95(durations);
    const uptimeEvaluation =
      thresholds.uptimeTargetRatio === null
        ? { uptime: uptimeValue, withinSlo: null as boolean | null }
        : evaluateUptimeSlo({
            total: totalApiRequests,
            failed: failedApiRequests,
            targetRatio: thresholds.uptimeTargetRatio,
          });
    const p95Evaluation =
      thresholds.p95LatencyMaxMs === null
        ? { p95Ms: p95Value, withinSlo: null as boolean | null }
        : evaluateP95LatencySlo({ samples: durations, maxMs: thresholds.p95LatencyMaxMs });
    const evaluation: ApiSloEvaluation = {
      uptime: {
        value: uptimeEvaluation.uptime,
        withinSlo: uptimeEvaluation.withinSlo,
        target: thresholds.uptimeTargetRatio,
      },
      p95Latency: {
        valueMs: p95Evaluation.p95Ms,
        withinSlo: p95Evaluation.withinSlo,
        targetMs: thresholds.p95LatencyMaxMs,
      },
      totalRequests: totalApiRequests,
      failedRequests: failedApiRequests,
      latencySamples: apiLatencySamples.length,
    };
    lastApiSloEvaluation = evaluation;
    try {
      if (!enabled()) return evaluation;
      // A null verdict (unconfigured threshold, or no signal
      // yet) records no gauge: absence is first-class, never a
      // fabricated 1 or 0.
      if (evaluation.uptime.withinSlo !== null) {
        getUptimeSloGauge()?.record(evaluation.uptime.withinSlo ? 1 : 0, {});
      }
      if (evaluation.p95Latency.withinSlo !== null) {
        getP95LatencySloGauge()?.record(evaluation.p95Latency.withinSlo ? 1 : 0, {});
      }
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
    recordApiRequest,
    evaluateAndRecordSlo,
    apiRequestCounts: () => ({
      total: totalApiRequests,
      failed: failedApiRequests,
      latencySamples: apiLatencySamples.length,
    }),
    apiRequestSamples: () => apiLatencySamples,
    lastApiSlo: () => lastApiSloEvaluation,
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
