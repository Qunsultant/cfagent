/**
 * Issue #5138 (S1 extension, observability program #5080) — the
 * destination switches: Analytics Engine, R2, and console each
 * individually on/off, plus Workers Logs documented as the
 * deploy-time observability.enabled switch.
 *
 * TDD Red first: the resolver (resolveOtelDestinationEnabled),
 * the NoopObservabilitySink, and the destinations field on
 * OtelLoggingConfig do not exist yet, so this file fails at
 * import.
 *
 * Design (recorded in the issue body):
 * - One switch per destination, resolved through the existing
 *   PAYMENTS_FLOW_MODE pattern (run > session > user > env >
 *   config-file > built-in safe default OFF). Invalid fails
 *   closed to OFF with a coded OBS-1001 message, no fall-through.
 * - Config-file defaults are all ON (preserving the current
 *   behavior: AE when bound, R2 when bound, console as fallback).
 * - createObservabilitySink respects them: AE off -> do not
 *   write to it (fall back to console only if console is on; if
 *   both off, the event is dropped — logging never fails the
 *   caller).
 * - The OTel transport respects the R2 switch: R2 off -> the
 *   transport passes a null blob store, so ingestion falls back
 *   to the structured log (never an R2 write).
 * - Workers Logs is deploy-time only (wrangler.jsonc
 *   observability.enabled); the Worker cannot flip the
 *   Cloudflare platform log pipeline at runtime — documented,
 *   never pretended as a runtime switch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OTEL_DESTINATIONS,
  OTEL_FILE_CONFIG,
  otelDestinationEnabledDefault,
  resolveOtelDestinationEnabled,
  type OtelDestination,
} from "../src/config/otelModes";
import { createObservabilitySink } from "../src/observability/createObservabilityPorts";
import { type ObservabilityEvent } from "../src/observability/observabilityPorts";
import {
  createOtelLogging,
  resolveOtelLoggingConfig,
} from "../src/observability/otelProvider";

/** A complete ObservabilityEvent for the sink tests. */
function makeEvent(overrides: Partial<ObservabilityEvent> = {}): ObservabilityEvent {
  return {
    type: "job.run.settled",
    level: "info",
    operation: "job.run.settled",
    tenantId: null,
    actorId: null,
    agentId: null,
    component: "job-pipeline",
    runId: "run-1",
    sessionRef: null,
    traceId: "a".repeat(32),
    timestampMs: 1794920000000,
    timestampIso: new Date(1794920000000).toISOString(),
    fields: {},
    ...overrides,
  };
}

/** A fake Analytics Engine dataset that records writeDataPoint calls. */
function fakeDataset() {
  return { writeDataPoint: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveOtelDestinationEnabled — the destination resolver", () => {
  it("resolves the file defaults when env is empty (r2 OFF, Analytics Engine OFF, console ON)", () => {
    for (const destination of OTEL_DESTINATIONS) {
      const r = resolveOtelDestinationEnabled(destination, {
        file: OTEL_FILE_CONFIG.destinations[destination],
      });
      expect(r.enabled).toBe(destination === "console" ? true : false);
      expect(r.invalid).toBe(false);
      expect(r.source).toBe("file");
    }
  });

  it("the config file carries r2 OFF, Analytics Engine OFF, console ON", () => {
    expect(OTEL_FILE_CONFIG.destinations).toEqual({
      analyticsEngine: false,
      r2: false,
      console: true,
    });
    expect(otelDestinationEnabledDefault("analyticsEngine")).toBe(false);
    expect(otelDestinationEnabledDefault("r2")).toBe(false);
    expect(otelDestinationEnabledDefault("console")).toBe(true);
  });

  it("env overrides the file (env false beats file true)", () => {
    const r = resolveOtelDestinationEnabled("r2", { env: "false", file: true });
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("env");
  });

  it("env true beats a file false", () => {
    const r = resolveOtelDestinationEnabled("console", { env: "true", file: false });
    expect(r.enabled).toBe(true);
    expect(r.source).toBe("env");
  });

  it("an invalid env value fails closed to OFF with invalid=true and no fall-through", () => {
    const r = resolveOtelDestinationEnabled("analyticsEngine", {
      env: "banana",
      file: true,
    });
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("env");
  });

  it("a blank env falls through to the file", () => {
    const r = resolveOtelDestinationEnabled("r2", { env: "   ", file: false });
    expect(r.enabled).toBe(false);
    expect(r.source).toBe("file");
  });

  it("all blank resolves to the built-in safe default OFF", () => {
    const r = resolveOtelDestinationEnabled("console", {});
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("builtin");
  });

  it("accepts the boolean spellings true/1/on/enabled and false/0/off/disabled", () => {
    for (const v of ["true", "1", "on", "enabled", "TRUE", " On "]) {
      expect(resolveOtelDestinationEnabled("r2", { env: v }).enabled).toBe(true);
    }
    for (const v of ["false", "0", "no", "off", "disabled", "FALSE", " Off "]) {
      expect(resolveOtelDestinationEnabled("r2", { env: v }).enabled).toBe(false);
    }
  });

  it("a non-string non-boolean value is invalid and fails closed to OFF", () => {
    const r = resolveOtelDestinationEnabled("r2", { env: 1 });
    expect(r.enabled).toBe(false);
    expect(r.invalid).toBe(true);
  });

  it("a native boolean from the config file resolves directly", () => {
    expect(resolveOtelDestinationEnabled("r2", { file: true }).enabled).toBe(true);
    expect(resolveOtelDestinationEnabled("r2", { file: false }).enabled).toBe(false);
  });

  it("run beats env (the first non-blank level wins)", () => {
    const r = resolveOtelDestinationEnabled("r2", {
      run: "false",
      env: "true",
      file: true,
    });
    expect(r.enabled).toBe(false);
    expect(r.source).toBe("run");
  });
});

describe("createObservabilitySink — destination switches", () => {
  it("AE on + bound writes to Analytics Engine, not console", async () => {
    const dataset = fakeDataset();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sink = createObservabilitySink({
      OBSERVABILITY: dataset,
      OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "true",
    });
    await sink.write(makeEvent());
    expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it("AE off + bound falls back to console (no AE write)", async () => {
    const dataset = fakeDataset();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sink = createObservabilitySink({
      OBSERVABILITY: dataset,
      OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "false",
    });
    await sink.write(makeEvent());
    expect(dataset.writeDataPoint).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("AE on + unbound falls back to console (the existing degradation)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sink = createObservabilitySink({});
    await sink.write(makeEvent());
    expect(info).toHaveBeenCalledTimes(1);
    // S7 (#5086): the sink is now a runtime-delegating wrapper
    // (destinations resolve per write from env/file + the
    // override cache), so the class is no longer the console
    // sink — the BEHAVIOUR (the event reached console) is the
    // assertion, not the class.
  });

  it("AE off + unbound + console on falls back to console", async () => {
    const dataset = fakeDataset();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sink = createObservabilitySink({
      OBSERVABILITY: dataset,
      OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "false",
    });
    await sink.write(makeEvent());
    expect(dataset.writeDataPoint).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("AE off + console off drops the event (no-op sink, never throws)", async () => {
    const dataset = fakeDataset();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sink = createObservabilitySink({
      OBSERVABILITY: dataset,
      OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "false",
      OTEL_DESTINATION_CONSOLE_ENABLED: "false",
    });
    // S7 (#5086): the sink is now a runtime-delegating wrapper
    // (see the note above); the drop is asserted by behaviour —
    // nothing reaches AE or console and nothing throws.
    expect(() => sink.write(makeEvent())).not.toThrow();
    expect(() => sink.writeBatch([makeEvent()])).not.toThrow();
    expect(dataset.writeDataPoint).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("AE on + bound + console off still writes to Analytics Engine", async () => {
    const dataset = fakeDataset();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sink = createObservabilitySink({
      OBSERVABILITY: dataset,
      OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "true",
      OTEL_DESTINATION_CONSOLE_ENABLED: "false",
    });
    await sink.write(makeEvent());
    expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it("an invalid AE env value fails closed to OFF (console fallback)", async () => {
    const dataset = fakeDataset();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const sink = createObservabilitySink({
      OBSERVABILITY: dataset,
      OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "banana",
    });
    await sink.write(makeEvent());
    expect(dataset.writeDataPoint).not.toHaveBeenCalled();
    // The invalid value also logs the coded OBS-1001 warning to
    // console (the structured logger's base sink), so console.info
    // is called twice — once for the warning, once for the event.
    // The event must be among the calls (the fallback reached it).
    expect(info).toHaveBeenCalled();
    expect(
      info.mock.calls.some((c) => String(c[0]).includes('"type":"job.run.settled"')),
    ).toBe(true);
  });

  it("explicitly resolved destinations override env/file", async () => {
    const dataset = fakeDataset();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // Env says AE on, but the resolved destinations say AE off.
    const sink = createObservabilitySink(
      { OBSERVABILITY: dataset, OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "true" },
      { analyticsEngine: false, console: true },
    );
    await sink.write(makeEvent());
    expect(dataset.writeDataPoint).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("resolveOtelLoggingConfig — destinations", () => {
  it("resolves the file defaults (r2 OFF, Analytics Engine OFF) when env is empty", () => {
    const config = resolveOtelLoggingConfig({});
    expect(config.destinations).toEqual({
      analyticsEngine: false,
      r2: false,
      console: true,
    });
  });

  it("env overrides the file per destination", () => {
    const config = resolveOtelLoggingConfig({
      OTEL_DESTINATION_R2_ENABLED: "false",
      OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED: "false",
    });
    expect(config.destinations.r2).toBe(false);
    expect(config.destinations.analyticsEngine).toBe(false);
    expect(config.destinations.console).toBe(true);
  });

  it("an invalid destination env value fails closed to OFF", () => {
    const config = resolveOtelLoggingConfig({ OTEL_DESTINATION_R2_ENABLED: "banana" });
    expect(config.destinations.r2).toBe(false);
    expect(config.destinations.analyticsEngine).toBe(false);
    expect(config.destinations.console).toBe(true);
  });
});

describe("createOtelLogging — the R2 transport respects the R2 switch", () => {
  it("R2 off: emitting a j1j7 log and flushing writes NOTHING to R2", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const handle = createOtelLogging({
      REPORTS_BUCKET: { put },
      OTEL_DESTINATION_R2_ENABLED: "false",
    } as never);
    expect(handle.sink).not.toBeNull();
    handle.sink!.write(makeEvent());
    await handle.flush();
    expect(put).not.toHaveBeenCalled();
    await handle.shutdown();
  });

  it("R2 on: emitting a j1j7 log and flushing writes one OTLP object to R2", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const handle = createOtelLogging({
      REPORTS_BUCKET: { put },
      OTEL_DESTINATION_R2_ENABLED: "true",
    } as never);
    expect(handle.sink).not.toBeNull();
    handle.sink!.write(makeEvent());
    await handle.flush();
    expect(put).toHaveBeenCalledTimes(1);
    const key = put.mock.calls[0][0] as string;
    expect(key.startsWith("otel-archive/")).toBe(true);
    await handle.shutdown();
  });
});
