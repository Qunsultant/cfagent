/**
 * Issue #5082 (S2, observability program #5080) — the OTel
 * metrics config: the metrics signal exporter, the metrics
 * settings (export interval, free-tier limits, health/SLO
 * thresholds), and the metrics ingestion route.
 *
 * TDD Red first: the resolvers
 * (resolveOtelMetricsSettings in src/config/otelModes.ts) do
 * not exist yet, so this file fails at import.
 *
 * Design (recorded in the PR body):
 * - The metrics settings are config values, resolved run >
 *   session > user > env > file > builtin (the same five-level
 *   mechanism as S1). The file (config/otel.json) carries the
 *   operational defaults; the builtin safe defaults apply only
 *   when the file is missing or a value is invalid.
 * - Invalid fails closed to the SAFE default with a coded
 *   OBS-1001 message and no fall-through (the otelModes
 *   contract). The safe defaults are the low-volume ones: a
 *   5-minute export interval (few writes), the real free-tier
 *   limits (100k writes/day, 10k read queries/day), a 5%
 *   max failure rate, a 70% SLO max pct.
 * - The metrics exporter resolves through the existing
 *   resolveOtelSignalExporter("metrics", ...) — S2 flips the
 *   file default from "none" to "otlp" (the live signal now).
 *   Traces stay "none" (S3 not built yet).
 */
import { describe, it, expect } from "vitest";
import {
  OTEL_FILE_CONFIG,
  otelSignalExporterDefault,
  resolveOtelMetricsSettings,
  resolveOtelSignalExporter,
  type OtelScopeLevels,
} from "../src/config/otelModes";

/** Levels carrying only a file value (the config-file default). */
function fileLevels(file: unknown): OtelScopeLevels {
  return { file };
}

describe("OTel metrics exporter — resolveOtelSignalExporter(\"metrics\", ...)", () => {
  it("metrics defaults to otlp (the live signal in S2) from the file", () => {
    expect(otelSignalExporterDefault("metrics")).toBe("otlp");
    expect(otelSignalExporterDefault("logs")).toBe("otlp");
    expect(otelSignalExporterDefault("traces")).toBe("otlp");
  });

  it("resolves the metrics exporter from the file value", () => {
    const r = resolveOtelSignalExporter("metrics", { file: "otlp" });
    expect(r.exporter).toBe("otlp");
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("file");
  });

  it("env overrides the file value for the metrics exporter", () => {
    expect(
      resolveOtelSignalExporter("metrics", { env: "none", file: "otlp" }).exporter,
    ).toBe("none");
    expect(
      resolveOtelSignalExporter("metrics", { env: "console", file: "otlp" }).exporter,
    ).toBe("console");
  });

  it("an unrecognized metrics exporter fails closed to none with invalid=true", () => {
    const r = resolveOtelSignalExporter("metrics", { env: "kafka", file: "otlp" });
    expect(r.exporter).toBe("none");
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("env");
  });
});

describe("OTel metrics settings — resolveOtelMetricsSettings", () => {
  it("resolves the file defaults (the operational values in config/otel.json)", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: fileLevels(OTEL_FILE_CONFIG.metrics.exportIntervalMs),
      freeTierDailyWriteLimit: fileLevels(OTEL_FILE_CONFIG.metrics.freeTier.dailyWriteLimit),
      freeTierDailyReadQueryLimit: fileLevels(
        OTEL_FILE_CONFIG.metrics.freeTier.dailyReadQueryLimit,
      ),
      healthPipelineMaxFailureRate: fileLevels(
        OTEL_FILE_CONFIG.metrics.health.pipelineMaxFailureRate,
      ),
      sloResourceRowsReadMaxPct: fileLevels(OTEL_FILE_CONFIG.metrics.slo.resourceRowsReadMaxPct),
    });
    expect(r.settings.exportIntervalMs).toBe(60000);
    expect(r.settings.freeTierDailyWriteLimit).toBe(100000);
    expect(r.settings.freeTierDailyReadQueryLimit).toBe(10000);
    expect(r.settings.healthPipelineMaxFailureRate).toBe(0.05);
    expect(r.settings.sloResourceRowsReadMaxPct).toBe(0.7);
    expect(r.invalid).toBe(false);
  });

  it("env overrides the file value for the export interval", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: { env: "30000", file: 60000 },
      freeTierDailyWriteLimit: fileLevels(100000),
      freeTierDailyReadQueryLimit: fileLevels(10000),
      healthPipelineMaxFailureRate: fileLevels(0.05),
      sloResourceRowsReadMaxPct: fileLevels(0.7),
    });
    expect(r.settings.exportIntervalMs).toBe(30000);
  });

  it("an unrecognized export interval fails closed to the safe 5-minute default", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: { env: "banana", file: 60000 },
      freeTierDailyWriteLimit: fileLevels(100000),
      freeTierDailyReadQueryLimit: fileLevels(10000),
      healthPipelineMaxFailureRate: fileLevels(0.05),
      sloResourceRowsReadMaxPct: fileLevels(0.7),
    });
    expect(r.settings.exportIntervalMs).toBe(300000);
    expect(r.invalid).toBe(true);
  });

  it("a non-positive export interval fails closed to the safe default", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: { env: "0", file: 60000 },
      freeTierDailyWriteLimit: fileLevels(100000),
      freeTierDailyReadQueryLimit: fileLevels(10000),
      healthPipelineMaxFailureRate: fileLevels(0.05),
      sloResourceRowsReadMaxPct: fileLevels(0.7),
    });
    expect(r.settings.exportIntervalMs).toBe(300000);
    expect(r.invalid).toBe(true);
  });

  it("an out-of-range failure rate (above 1) fails closed to the safe 5% default", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: fileLevels(60000),
      freeTierDailyWriteLimit: fileLevels(100000),
      freeTierDailyReadQueryLimit: fileLevels(10000),
      healthPipelineMaxFailureRate: { env: "1.5", file: 0.05 },
      sloResourceRowsReadMaxPct: fileLevels(0.7),
    });
    expect(r.settings.healthPipelineMaxFailureRate).toBe(0.05);
    expect(r.invalid).toBe(true);
  });

  it("an out-of-range SLO pct (above 1) fails closed to the safe 70% default", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: fileLevels(60000),
      freeTierDailyWriteLimit: fileLevels(100000),
      freeTierDailyReadQueryLimit: fileLevels(10000),
      healthPipelineMaxFailureRate: fileLevels(0.05),
      sloResourceRowsReadMaxPct: { env: "2", file: 0.7 },
    });
    expect(r.settings.sloResourceRowsReadMaxPct).toBe(0.7);
    expect(r.invalid).toBe(true);
  });

  it("a negative free-tier write limit fails closed to the real 100k limit", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: fileLevels(60000),
      freeTierDailyWriteLimit: { env: "-5", file: 100000 },
      freeTierDailyReadQueryLimit: fileLevels(10000),
      healthPipelineMaxFailureRate: fileLevels(0.05),
      sloResourceRowsReadMaxPct: fileLevels(0.7),
    });
    expect(r.settings.freeTierDailyWriteLimit).toBe(100000);
    expect(r.invalid).toBe(true);
  });

  it("blank levels fall through to the file, and a missing file falls back to the safe defaults", () => {
    const r = resolveOtelMetricsSettings({
      exportIntervalMs: {},
      freeTierDailyWriteLimit: {},
      freeTierDailyReadQueryLimit: {},
      healthPipelineMaxFailureRate: {},
      sloResourceRowsReadMaxPct: {},
    });
    expect(r.settings.exportIntervalMs).toBe(300000);
    expect(r.settings.freeTierDailyWriteLimit).toBe(100000);
    expect(r.settings.freeTierDailyReadQueryLimit).toBe(10000);
    expect(r.settings.healthPipelineMaxFailureRate).toBe(0.05);
    expect(r.settings.sloResourceRowsReadMaxPct).toBe(0.7);
    expect(r.invalid).toBe(false);
  });
});

describe("OTel metrics ingestion route — the config-file route", () => {
  it("the file carries the metrics ingestion route (POST /api/otel/v1/metrics)", () => {
    expect(OTEL_FILE_CONFIG.ingestion.metricsRoute).toBe("/api/otel/v1/metrics");
    expect(OTEL_FILE_CONFIG.ingestion.route).toBe("/api/otel/v1/logs");
  });

  it("the file carries the metrics section (export interval, free-tier limits, health, SLO)", () => {
    expect(OTEL_FILE_CONFIG.metrics.exportIntervalMs).toBe(60000);
    expect(OTEL_FILE_CONFIG.metrics.freeTier.dailyWriteLimit).toBe(100000);
    expect(OTEL_FILE_CONFIG.metrics.freeTier.dailyReadQueryLimit).toBe(10000);
    expect(OTEL_FILE_CONFIG.metrics.health.pipelineMaxFailureRate).toBe(0.05);
    expect(OTEL_FILE_CONFIG.metrics.slo.resourceRowsReadMaxPct).toBe(0.7);
  });
});
