/**
 * Issue #2808 (S3, observability program #5080) — the OTel
 * traces config resolution: the traces exporter switch and
 * the traces settings (free-tier daily write limit), resolved
 * through the same five-level mechanism as S1/S2.
 *
 * TDD Red first: resolveOtelTracesSettings and the traces
 * settings shape in src/config/otelModes.ts do not exist yet,
 * so this file fails at import.
 */
import { describe, it, expect } from "vitest";
import {
  OTEL_FILE_CONFIG,
  otelSignalExporterDefault,
  resolveOtelSignalExporter,
  resolveOtelTracesSettings,
} from "../src/config/otelModes";

describe("OTel traces exporter — resolveOtelSignalExporter('traces')", () => {
  it("traces defaults to otlp from the file (S3 built it)", () => {
    expect(otelSignalExporterDefault("traces")).toBe("otlp");
    expect(OTEL_FILE_CONFIG.tracesExporter).toBe("otlp");
  });

  it("resolves the traces exporter from the file", () => {
    const r = resolveOtelSignalExporter("traces", { file: "otlp" });
    expect(r.exporter).toBe("otlp");
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("file");
  });

  it("resolves OTEL_TRACES_EXPORTER from env over the file", () => {
    const r = resolveOtelSignalExporter("traces", { env: "console", file: "otlp" });
    expect(r.exporter).toBe("console");
    expect(r.source).toBe("env");
  });

  it("fails closed to none on an unrecognized traces exporter value (OBS-1001)", () => {
    const r = resolveOtelSignalExporter("traces", { env: "bogus", file: "otlp" });
    expect(r.exporter).toBe("none");
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("env");
  });
});

describe("OTel traces settings — resolveOtelTracesSettings", () => {
  it("resolves the file defaults (free-tier daily write limit 100000)", () => {
    const r = resolveOtelTracesSettings({
      freeTierDailyWriteLimit: { file: OTEL_FILE_CONFIG.traces.freeTier.dailyWriteLimit },
    });
    expect(r.settings.freeTierDailyWriteLimit).toBe(100000);
    expect(r.invalid).toBe(false);
  });

  it("resolves an env override over the file", () => {
    const r = resolveOtelTracesSettings({
      freeTierDailyWriteLimit: { env: "5000", file: 100000 },
    });
    expect(r.settings.freeTierDailyWriteLimit).toBe(5000);
    expect(r.invalid).toBe(false);
  });

  it("fails closed to the builtin safe default on an unrecognized value", () => {
    const r = resolveOtelTracesSettings({
      freeTierDailyWriteLimit: { env: "not-a-number", file: 100000 },
    });
    expect(r.settings.freeTierDailyWriteLimit).toBe(100000);
    expect(r.invalid).toBe(true);
  });

  it("accepts 0 (no AE writes; the R2 archive path still runs)", () => {
    const r = resolveOtelTracesSettings({
      freeTierDailyWriteLimit: { env: "0", file: 100000 },
    });
    expect(r.settings.freeTierDailyWriteLimit).toBe(0);
    expect(r.invalid).toBe(false);
  });

  it("fails closed on a negative value", () => {
    const r = resolveOtelTracesSettings({
      freeTierDailyWriteLimit: { env: "-1", file: 100000 },
    });
    expect(r.settings.freeTierDailyWriteLimit).toBe(100000);
    expect(r.invalid).toBe(true);
  });

  it("falls back to the builtin when no level carries a value", () => {
    const r = resolveOtelTracesSettings({ freeTierDailyWriteLimit: {} });
    expect(r.settings.freeTierDailyWriteLimit).toBe(100000);
    expect(r.invalid).toBe(false);
  });
});
