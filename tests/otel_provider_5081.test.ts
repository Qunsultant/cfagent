/**
 * Issue #5081 (S1, observability program #5080) — the OTel
 * composition root: resolving the config from env + file and
 * building the logging stack.
 *
 * Pins the wiring: the kill switch, the env-over-file
 * precedence, the per-domain defaults (j1j7 ON, others OFF),
 * the fan-out sink (base + OTel), and the domain predicate.
 * The in-process transport (OTLP -> ingestion -> R2) is pinned
 * by the ingestion tests and the end-to-end test in
 * otel_job_pipeline_5081.test.ts; this file pins the
 * composition root's own decisions.
 */
import { describe, it, expect } from "vitest";
import {
  createFanOutSink,
  createOtelLogging,
  resolveOtelLoggingConfig,
} from "../src/observability/otelProvider";
import type { ObservabilityEvent, ObservabilitySink } from "../src/observability/observabilityPorts";

describe("resolveOtelLoggingConfig — env + file", () => {
  it("resolves the file defaults when env is empty (master ON, logs=otlp, j1j7 ON)", () => {
    const config = resolveOtelLoggingConfig({});
    expect(config.masterEnabled).toBe(true);
    expect(config.logsExporter).toBe("otlp");
    expect(config.domains.j1j7.enabled).toBe(true);
    expect(config.domains.j1j7.level).toBe("INFO");
    expect(config.domains.j1j7.samplingRatio).toBe(1);
    for (const domain of ["stock-copilot", "iaaa", "mcp-a2a", "scheduler", "payments", "market-data", "platform"] as const) {
      expect(config.domains[domain].enabled).toBe(false);
    }
  });

  it("OTEL_SDK_DISABLED=true forces the master OFF regardless of OTEL_ENABLED", () => {
    const config = resolveOtelLoggingConfig({ OTEL_SDK_DISABLED: "true", OTEL_ENABLED: "true" });
    expect(config.masterEnabled).toBe(false);
  });

  it("env overrides the file (master off, logs=console, j1j7 off)", () => {
    const config = resolveOtelLoggingConfig({
      OTEL_ENABLED: "false",
      OTEL_LOGS_EXPORTER: "console",
      OTEL_DOMAIN_J1J7_ENABLED: "false",
    });
    expect(config.masterEnabled).toBe(false);
    expect(config.logsExporter).toBe("console");
    expect(config.domains.j1j7.enabled).toBe(false);
  });

  it("an invalid env value fails closed (master OFF, logs=none, domain OFF)", () => {
    const config = resolveOtelLoggingConfig({
      OTEL_ENABLED: "maybe",
      OTEL_LOGS_EXPORTER: "kafka",
      OTEL_DOMAIN_J1J7_ENABLED: "yes-please",
    });
    expect(config.masterEnabled).toBe(false);
    expect(config.logsExporter).toBe("none");
    expect(config.domains.j1j7.enabled).toBe(false);
  });

  it("a per-domain level + sampling resolve from env", () => {
    const config = resolveOtelLoggingConfig({
      OTEL_DOMAIN_J1J7_LEVEL: "ERROR",
      OTEL_DOMAIN_J1J7_SAMPLING: "0.5",
    });
    expect(config.domains.j1j7.level).toBe("ERROR");
    expect(config.domains.j1j7.samplingRatio).toBe(0.5);
  });
});

describe("createOtelLogging — the handle", () => {
  it("reports j1j7 enabled and the other domains disabled by default", () => {
    const handle = createOtelLogging({} as never);
    expect(handle.isDomainEnabled("j1j7")).toBe(true);
    expect(handle.isDomainEnabled("payments")).toBe(false);
    expect(handle.sink).not.toBeNull();
  });

  it("has no sink when the master is OFF (nothing to emit into)", async () => {
    const handle = createOtelLogging({ OTEL_ENABLED: "false" } as never);
    expect(handle.isDomainEnabled("j1j7")).toBe(false);
    expect(handle.sink).toBeNull();
    await handle.shutdown();
  });

  it("has no sink when the logs exporter is none", async () => {
    const handle = createOtelLogging({ OTEL_LOGS_EXPORTER: "none" } as never);
    expect(handle.sink).toBeNull();
    await handle.shutdown();
  });

  it("flush and shutdown resolve (the provider lifecycle)", async () => {
    const handle = createOtelLogging({} as never);
    await expect(handle.flush()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe("createFanOutSink — base + OTel", () => {
  it("writes to every sink in order", () => {
    const seen: string[][] = [];
    const mk = (name: string): ObservabilitySink => ({
      write: (event) => {
        seen.push([name, event.type]);
      },
      writeBatch: (events) => {
        for (const event of events) seen.push([name, event.type]);
      },
    });
    const fanOut = createFanOutSink([mk("base"), mk("otel")]);
    fanOut.write({ type: "job.run.settled" } as ObservabilityEvent);
    expect(seen).toEqual([
      ["base", "job.run.settled"],
      ["otel", "job.run.settled"],
    ]);
  });

  it("never throws when a sink throws", () => {
    const throwing: ObservabilitySink = {
      write: () => {
        throw new Error("sink down");
      },
      writeBatch: () => {
        throw new Error("sink down");
      },
    };
    const seen: string[] = [];
    const good: ObservabilitySink = {
      write: (event) => {
        seen.push(event.type);
      },
      writeBatch: (events) => {
        for (const event of events) seen.push(event.type);
      },
    };
    const fanOut = createFanOutSink([throwing, good]);
    expect(() => fanOut.write({ type: "job.run.settled" } as ObservabilityEvent)).not.toThrow();
    expect(seen).toEqual(["job.run.settled"]);
  });
});
