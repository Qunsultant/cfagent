/**
 * Issue #5082 (S2, observability program #5080) — the OTel
 * metrics glue: the thin OTLP/HTTP metrics exporter, the
 * MeterProvider, the per-domain metrics gate, the metric →
 * Analytics Engine event conversion, and the free-tier write
 * guard.
 *
 * TDD Red first: the module (src/observability/otelMetrics.ts)
 * does not exist yet, so this file fails at import.
 *
 * Design (recorded in the PR body):
 * - The OTel SDK is the library (MeterProvider +
 *   PeriodicExportingMetricReader from @opentelemetry/sdk-metrics).
 *   The exporter is thin glue over the OFFICIAL serializer
 *   (JsonMetricsSerializer from @opentelemetry/otlp-transformer):
 *   it serializes ResourceMetrics to OTLP/JSON and hands the
 *   bytes to an injected transport (the in-process ingestion
 *   handler → R2 archive), the same transport pattern S1 built
 *   for logs.
 * - The same export ALSO lands in Analytics Engine (the store):
 *   each aggregated metric series becomes one ObservabilityEvent
 *   (type `metric.<name>`) written through the EXISTING
 *   createObservabilitySink / Analytics Engine adapter. No new
 *   store, no second metrics backend. The export is the SDK's
 *   AGGREGATED data (counters summed, histograms bucketed), so
 *   one AE datapoint is written per metric series per export —
 *   never one per event. That aggregation is what keeps the
 *   free tier (100k AE writes/day) reachable.
 * - Free-tier guard: the exporter counts AE writes in the
 *   current UTC day against the configured daily write limit
 *   (default 100k, a config value). When the limit is reached,
 *   further AE writes for the day are dropped with ONE coded
 *   OBS-1007 message (not one per drop). The OTLP/R2 archive
 *   path is not guarded (R2 has no per-row quota).
 * - The gate is the AOP aspect for metrics: master + metrics
 *   exporter + domain enabled. The log level/sampling do NOT
 *   apply to metrics (a counter sampled at record time is a
 *   corrupted count); the metrics volume controls are the
 *   export interval (config) and the free-tier guard.
 * - The stock OTLPMetricExporter
 *   (@opentelemetry/exporter-metrics-otlp-http) is NOT used: it
 *   has no public transport injection, so it cannot route to
 *   the same-Worker ingestion route (the 522 self-fetch rule —
 *   see otelLogs.ts). The transport here is an injected
 *   function; the Worker composition root injects the in-process
 *   ingestion handler, and the ingestion route stays a real
 *   HTTP endpoint for external OTLP senders.
 */
import { describe, it, expect, vi } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  createOtelMetricsGate,
  createOtelMeterProvider,
  createOtlpHttpMetricExporter,
  metricEventForSeries,
  type OtelMetricsConfig,
  type OtelTransport,
} from "../src/observability/otelMetrics";
import {
  OBS_METRICS_EXPORT_FAILED,
  OBS_METRICS_FREE_TIER_GUARD,
} from "../src/observability/otelMessages";
import type { ObservabilitySink } from "../src/observability/observabilityPorts";

/** A config where the master is ON, metrics exporter is otlp, and j1j7 is ON. */
function j1j7OnConfig(overrides: Partial<OtelMetricsConfig> = {}): OtelMetricsConfig {
  return {
    masterEnabled: true,
    metricsExporter: "otlp",
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
    destinations: { analyticsEngine: true, r2: true, console: true },
    settings: {
      exportIntervalMs: 60000,
      freeTierDailyWriteLimit: 100000,
      freeTierDailyReadQueryLimit: 10000,
      healthPipelineMaxFailureRate: 0.05,
      sloResourceRowsReadMaxPct: 0.7,
    },
    // Issue #5164 (S10) — the backend OFF (the file default).
    backend: { enabled: false, requestTimeoutMs: 10000 },
    ...overrides,
  };
}

/** A transport that records every OTLP/HTTP body it is handed. */
function recordingTransport() {
  const bodies: Uint8Array[] = [];
  const contentTypes: string[] = [];
  const transport: OtelTransport = async (body, contentType) => {
    bodies.push(body);
    contentTypes.push(contentType);
    return { status: 202 };
  };
  return { transport, bodies, contentTypes };
}

/** A sink that records every event it is handed. */
function recordingSink() {
  const events: Array<Parameters<ObservabilitySink["write"]>[0]> = [];
  const sink: ObservabilitySink = {
    write: (event) => {
      events.push(event);
    },
    writeBatch: (evts) => {
      for (const e of evts) events.push(e);
    },
  };
  return { sink, events };
}

describe("createOtelMetricsGate — the AOP gate for metrics", () => {
  it("passes a j1j7 component when the master is ON, the metrics exporter is otlp, and j1j7 is ON", () => {
    const gate = createOtelMetricsGate(j1j7OnConfig());
    expect(gate("job-pipeline")).toBe(true);
    expect(gate("job-pipeline:feed")).toBe(true);
  });

  it("no-ops (false) for a domain that is OFF", () => {
    const gate = createOtelMetricsGate(j1j7OnConfig());
    expect(gate("payments")).toBe(false);
    expect(gate("something-else")).toBe(false);
  });

  it("no-ops when the master is OFF, even for j1j7", () => {
    const gate = createOtelMetricsGate(j1j7OnConfig({ masterEnabled: false }));
    expect(gate("job-pipeline")).toBe(false);
  });

  it("no-ops when the metrics exporter is none, even for j1j7", () => {
    const gate = createOtelMetricsGate(j1j7OnConfig({ metricsExporter: "none" }));
    expect(gate("job-pipeline")).toBe(false);
  });
});

describe("metricEventForSeries — one aggregated metric series → one AE event", () => {
  it("converts a counter series into a metric.* event with the value in count", () => {
    const event = metricEventForSeries({
      name: "job.runs",
      description: "Terminally settled runs",
      unit: "1",
      kind: "counter",
      value: 7,
      count: 7,
      labels: { job_id: "feed", state: "completed", trigger: "cron" },
      timestampMs: 1_700_000_000_000,
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("metric.job.runs");
    expect(event!.operation).toBe("job.runs");
    expect(event!.count).toBe(7);
    expect(event!.fields.job_id).toBe("feed");
    expect(event!.fields.state).toBe("completed");
    expect(event!.fields.trigger).toBe("cron");
  });

  it("converts a histogram series into a metric.* event with sum in durationMs and count", () => {
    const event = metricEventForSeries({
      name: "job.stage.step.duration",
      description: "Stage step durations",
      unit: "ms",
      kind: "histogram",
      value: 1234,
      count: 12,
      min: 10,
      max: 400,
      labels: { step: "feed" },
      timestampMs: 1_700_000_000_000,
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("metric.job.stage.step.duration");
    expect(event!.durationMs).toBe(1234);
    expect(event!.count).toBe(12);
    expect(event!.fields.min).toBe(10);
    expect(event!.fields.max).toBe(400);
    expect(event!.fields.step).toBe("feed");
  });

  it("converts a gauge series into a metric.* event with the gauge value in count", () => {
    const event = metricEventForSeries({
      name: "resource.rows_read",
      description: "SessionStore rows read (daily rollup)",
      unit: "1",
      kind: "gauge",
      value: 50000,
      labels: { ns: "SessionStore", op: "get", caller: "login", trigger: "user", day: "2026-11-16" },
      timestampMs: 1_700_000_000_000,
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("metric.resource.rows_read");
    expect(event!.count).toBe(50000);
    expect(event!.fields.ns).toBe("SessionStore");
  });

  it("returns null for a series with an empty name (never writes a nameless metric)", () => {
    const event = metricEventForSeries({
      name: "",
      description: "",
      unit: "1",
      kind: "counter",
      value: 1,
      labels: {},
      timestampMs: 1_700_000_000_000,
    });
    expect(event).toBeNull();
  });
});

describe("createOtelMeterProvider — the OTel SDK + thin OTLP/HTTP metrics exporter", () => {
  it("exports recorded metrics as OTLP/JSON via the transport and as AE events via the sink", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const config = j1j7OnConfig();
    const { provider, meter } = createOtelMeterProvider({ config, transport, sink });
    const counter = meter.createCounter("job.runs", { description: "runs", unit: "1" });
    counter.add(3, { job_id: "feed", state: "completed", trigger: "cron" });
    await provider.forceFlush();
    // The OTLP/JSON body went to the transport (R2 archive path).
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const text = new TextDecoder().decode(bodies[0]);
    expect(text).toContain("job.runs");
    // The same aggregated series landed in Analytics Engine via the sink.
    const runEvents = events.filter((e) => e.type === "metric.job.runs");
    expect(runEvents.length).toBeGreaterThanOrEqual(1);
    expect(runEvents[0].count).toBe(3);
    await provider.shutdown();
  });

  it("builds a no-op provider when the master is OFF (nothing recorded, nothing exported)", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const config = j1j7OnConfig({ masterEnabled: false });
    const { provider, meter } = createOtelMeterProvider({ config, transport, sink });
    const counter = meter.createCounter("job.runs", { description: "runs", unit: "1" });
    counter.add(3, { job_id: "feed", state: "completed", trigger: "cron" });
    await provider.forceFlush();
    expect(bodies.length).toBe(0);
    expect(events.length).toBe(0);
    await provider.shutdown();
  });

  it("builds a no-op provider when the metrics exporter is none", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const config = j1j7OnConfig({ metricsExporter: "none" });
    const { provider, meter } = createOtelMeterProvider({ config, transport, sink });
    const counter = meter.createCounter("job.runs", { description: "runs", unit: "1" });
    counter.add(3, { job_id: "feed", state: "completed", trigger: "cron" });
    await provider.forceFlush();
    expect(bodies.length).toBe(0);
    expect(events.length).toBe(0);
    await provider.shutdown();
  });

  it("reports a transport failure with the coded OBS-1006 message and does not throw", async () => {
    const onError = vi.fn();
    const failingTransport: OtelTransport = async () => ({ status: 500 });
    const { sink } = recordingSink();
    const config = j1j7OnConfig();
    const { provider, meter } = createOtelMeterProvider({
      config,
      transport: failingTransport,
      sink,
      onError,
    });
    const counter = meter.createCounter("job.runs", { description: "runs", unit: "1" });
    counter.add(1, { job_id: "feed", state: "completed", trigger: "cron" });
    await expect(provider.forceFlush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(String(onError.mock.calls[0][0])).toContain(OBS_METRICS_EXPORT_FAILED);
    await provider.shutdown();
  });
});

describe("createOtlpHttpMetricExporter — the free-tier write guard", () => {
  it("drops AE writes once the configured daily write limit is reached, with one coded OBS-1007 message", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const onError = vi.fn();
    const config = j1j7OnConfig();
    // A tiny limit (2 writes/day) so the guard trips in the test.
    config.settings.freeTierDailyWriteLimit = 2;
    const { provider, meter } = createOtelMeterProvider({ config, transport, sink, onError });
    const a = meter.createCounter("metric.a", { description: "a", unit: "1" });
    const b = meter.createCounter("metric.b", { description: "b", unit: "1" });
    const c = meter.createCounter("metric.c", { description: "c", unit: "1" });
    a.add(1);
    b.add(1);
    c.add(1);
    await provider.forceFlush();
    // Only the first 2 series reached Analytics Engine (the guard dropped the 3rd).
    expect(events.length).toBeLessThanOrEqual(2);
    // The guard fired exactly once with the coded message.
    const guardCalls = onError.mock.calls.filter((call) =>
      String(call[0]).includes(OBS_METRICS_FREE_TIER_GUARD),
    );
    expect(guardCalls.length).toBe(1);
    // The OTLP/R2 archive path is NOT guarded (all 3 series archived).
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    await provider.shutdown();
  });

  it("does not guard the OTLP/R2 path: a 0 AE limit still archives to R2", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const config = j1j7OnConfig();
    config.settings.freeTierDailyWriteLimit = 0;
    const { provider, meter } = createOtelMeterProvider({ config, transport, sink });
    const counter = meter.createCounter("job.runs", { description: "runs", unit: "1" });
    counter.add(1, { job_id: "feed", state: "completed", trigger: "cron" });
    await provider.forceFlush();
    expect(events.length).toBe(0);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    await provider.shutdown();
  });
});

describe("createOtelMeterProvider — the provider is a real MeterProvider", () => {
  it("returns a MeterProvider whose meter creates the OTel instruments", () => {
    const { transport } = recordingTransport();
    const { sink } = recordingSink();
    const config = j1j7OnConfig();
    const { provider, meter } = createOtelMeterProvider({ config, transport, sink });
    expect(provider).toBeInstanceOf(MeterProvider);
    expect(typeof meter.createCounter).toBe("function");
    expect(typeof meter.createHistogram).toBe("function");
    expect(typeof meter.createGauge).toBe("function");
  });
});
