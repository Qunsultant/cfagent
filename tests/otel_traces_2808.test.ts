/**
 * Issue #2808 (S3, observability program #5080) — the OTel
 * tracing glue: the thin OTLP/HTTP span exporter, the
 * TracerProvider, the per-domain traces gate, the span →
 * Analytics Engine event conversion, and the free-tier write
 * guard.
 *
 * TDD Red first: the module (src/observability/otelTraces.ts)
 * does not exist yet, so this file fails at import.
 *
 * Design (recorded in the PR body):
 * - The OTel SDK is the library (TracerProvider +
 *   Batch/SimpleSpanProcessor from @opentelemetry/sdk-trace
 *   3.1.1 — the 3.x trace SDK, on the same core/resources
 *   3.1.1 line as the S1 logs and S2 metrics stacks; the
 *   2.x sdk-trace-base line is NOT used: its peer range
 *   (@opentelemetry/api <1.10.0) conflicts with the repo's
 *   api ^1.10.0 and its core 2.x conflicts with the logs
 *   stack's core 3.x).
 * - The exporter is thin glue over the OFFICIAL serializer
 *   (JsonTraceSerializer from @opentelemetry/otlp-transformer):
 *   it serializes ReadableSpans to OTLP/JSON and hands the
 *   bytes to an injected transport (the in-process ingestion
 *   handler → R2 archive), the same transport pattern S1
 *   built for logs and S2 built for metrics.
 * - The same export ALSO lands in Analytics Engine (the
 *   store): each finished span becomes one ObservabilityEvent
 *   (type `span.<name>`) written through the EXISTING
 *   createObservabilitySink / Analytics Engine adapter. No new
 *   store, no second traces backend. A span is one datapoint
 *   per span per export (spans are not aggregated like
 *   metrics) — the free-tier guard is what keeps the free
 *   tier reachable.
 * - Free-tier guard: the exporter counts AE writes in the
 *   current UTC day against the configured daily write limit
 *   (default 100k, a config value). When the limit is reached,
 *   further AE writes for the day are dropped with ONE coded
 *   OBS-1013 message (not one per drop). The OTLP/R2 archive
 *   path is not guarded (R2 has no per-row quota).
 * - The gate is the AOP aspect for traces: master + traces
 *   exporter + domain enabled + domain level + sampling.
 *   The level for spans is OFF-means-no-spans (spans carry
 *   no severity; any other level admits them); sampling is
 *   the standard probabilistic OTel sampling at span start.
 * - The stock OTLPSpanExporter
 *   (@opentelemetry/exporter-trace-otlp-http) is NOT used: it
 *   has no public transport injection, so it cannot route to
 *   the same-Worker ingestion route (the 522 self-fetch rule
 *   — see otelLogs.ts). The transport here is an injected
 *   function; the Worker composition root injects the in-process
 *   ingestion handler, and the ingestion route stays a real
 *   HTTP endpoint for external OTLP senders.
 */
import { describe, it, expect, vi } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { TracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {
  createOtelTracesGate,
  createOtelTracerProvider,
  createOtlpHttpSpanExporter,
  spanEventForReadableSpan,
  type OtelTracesConfig,
  type OtelTransport,
} from "../src/observability/otelTraces";
import {
  OBS_TRACES_EXPORT_FAILED,
  OBS_TRACES_FREE_TIER_GUARD,
} from "../src/observability/otelMessages";
import type { ObservabilitySink } from "../src/observability/observabilityPorts";

/** A config where the master is ON, traces exporter is otlp, and j1j7 is ON. */
function j1j7OnConfig(overrides: Partial<OtelTracesConfig> = {}): OtelTracesConfig {
  return {
    masterEnabled: true,
    tracesExporter: "otlp",
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
    settings: { freeTierDailyWriteLimit: 100000 },
    // Issue #5164 (S10) — the backend OFF (the file default).
    backend: { enabled: false, requestTimeoutMs: 10000 },
    ...overrides,
  };
}

/** A transport that records every OTLP/HTTP body it is handed. */
function recordingTransport(status = 202) {
  const bodies: Uint8Array[] = [];
  const contentTypes: string[] = [];
  const transport: OtelTransport = async (body, contentType) => {
    bodies.push(body);
    contentTypes.push(contentType);
    return { status };
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

/** One finished span, captured from a real TracerProvider + InMemorySpanExporter. */
function finishedSpan(name = "job.stage.step", attributes: Record<string, unknown> = {}) {
  const mem = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: mem })],
  });
  const tracer = provider.getTracer("test");
  const span = tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes: { component: "job-pipeline", ...attributes },
  });
  span.end();
  const spans = mem.getFinishedSpans();
  return { spans, provider };
}

describe("createOtelTracesGate — the AOP gate for traces", () => {
  it("passes a j1j7 component when the master is ON, the traces exporter is otlp, and j1j7 is ON", () => {
    const gate = createOtelTracesGate(j1j7OnConfig());
    expect(gate("job-pipeline")).toBe(true);
  });

  it("blocks everything when the master is OFF", () => {
    const gate = createOtelTracesGate(j1j7OnConfig({ masterEnabled: false }));
    expect(gate("job-pipeline")).toBe(false);
  });

  it("blocks everything when the traces exporter is none", () => {
    const gate = createOtelTracesGate(j1j7OnConfig({ tracesExporter: "none" }));
    expect(gate("job-pipeline")).toBe(false);
  });

  it("blocks a domain that is OFF", () => {
    const config = j1j7OnConfig();
    config.domains.j1j7.enabled = false;
    const gate = createOtelTracesGate(config);
    expect(gate("job-pipeline")).toBe(false);
  });

  it("blocks a domain whose level is OFF (spans carry no severity; OFF means no spans)", () => {
    const config = j1j7OnConfig();
    config.domains.j1j7.level = "OFF";
    const gate = createOtelTracesGate(config);
    expect(gate("job-pipeline")).toBe(false);
  });

  it("admits a domain whose level is ERROR (any non-OFF level admits spans)", () => {
    const config = j1j7OnConfig();
    config.domains.j1j7.level = "ERROR";
    const gate = createOtelTracesGate(config);
    expect(gate("job-pipeline")).toBe(true);
  });

  it("blocks a non-j1j7 component (platform domain OFF by default)", () => {
    const gate = createOtelTracesGate(j1j7OnConfig());
    expect(gate("something-else")).toBe(false);
  });

  it("applies sampling deterministically with an injected random source", () => {
    const config = j1j7OnConfig();
    config.domains.j1j7.samplingRatio = 0.5;
    expect(createOtelTracesGate(config, () => 0.49)("job-pipeline")).toBe(true);
    expect(createOtelTracesGate(config, () => 0.5)("job-pipeline")).toBe(false);
    expect(createOtelTracesGate(config, () => 0.99)("job-pipeline")).toBe(false);
  });

  it("blocks when the sampling ratio is 0", () => {
    const config = j1j7OnConfig();
    config.domains.j1j7.samplingRatio = 0;
    const gate = createOtelTracesGate(config);
    expect(gate("job-pipeline")).toBe(false);
  });
});

describe("spanEventForReadableSpan — one span becomes one Analytics Engine event", () => {
  it("converts a finished span to a span.<name> event with the span identity and duration", async () => {
    const { spans, provider } = finishedSpan("job.stage.step", {
      step: "feed",
      tenant_id: "tenant-1",
    });
    expect(spans).toHaveLength(1);
    const event = spanEventForReadableSpan(spans[0]);
    await provider.shutdown();
    expect(event).not.toBeNull();
    expect(event!.type).toBe("span.job.stage.step");
    expect(event!.operation).toBe("job.stage.step");
    expect(event!.component).toBe("job-pipeline");
    expect(event!.tenantId).toBe("tenant-1");
    expect(event!.traceId).toBe(spans[0].spanContext().traceId);
    expect(event!.spanId).toBe(spans[0].spanContext().spanId);
    expect(event!.level).toBe("info");
    expect(typeof event!.durationMs).toBe("number");
    expect(event!.durationMs).toBeGreaterThanOrEqual(0);
    expect(event!.fields.step).toBe("feed");
  });

  it("maps an ERROR span to level error and carries the status message", async () => {
    const mem = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: mem })],
    });
    const tracer = provider.getTracer("test");
    const span = tracer.startSpan("job.stage.step", {
      attributes: { component: "job-pipeline", step: "enrich" },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
    span.end();
    const spans = mem.getFinishedSpans();
    const event = spanEventForReadableSpan(spans[0]);
    await provider.shutdown();
    expect(event).not.toBeNull();
    expect(event!.level).toBe("error");
    expect(event!.fields.statusMessage).toBe("boom");
  });

  it("carries the parent span id for a child span", async () => {
    const mem = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: mem })],
    });
    const tracer = provider.getTracer("test");
    const parent = tracer.startSpan("job.run.settled", {
      attributes: { component: "job-pipeline" },
    });
    const { context, trace } = await import("@opentelemetry/api");
    const child = tracer.startSpan(
      "job.stage.step",
      { attributes: { component: "job-pipeline", step: "feed" } },
      trace.setSpan(context.active(), parent),
    );
    child.end();
    parent.end();
    const spans = mem.getFinishedSpans();
    await provider.shutdown();
    const childSpan = spans.find((s) => s.name === "job.stage.step")!;
    const parentSpan = spans.find((s) => s.name === "job.run.settled")!;
    const event = spanEventForReadableSpan(childSpan);
    expect(event).not.toBeNull();
    expect(event!.spanId).toBe(childSpan.spanContext().spanId);
    expect(event!.fields.parentSpanId).toBe(parentSpan.spanContext().spanId);
  });

  it("returns null for a span with an empty name (never writes a nameless span)", async () => {
    const { spans, provider } = finishedSpan("");
    expect(spans).toHaveLength(1);
    const event = spanEventForReadableSpan(spans[0]);
    await provider.shutdown();
    expect(event).toBeNull();
  });
});

describe("createOtlpHttpSpanExporter — the thin OTLP/HTTP span exporter", () => {
  it("exports spans to the transport as OTLP/JSON and writes one AE event per span", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const onError = vi.fn();
    const exporter = createOtlpHttpSpanExporter({
      transport,
      sink,
      freeTierDailyWriteLimit: 100000,
      onError,
    });
    const { spans, provider } = finishedSpan("job.stage.step", { step: "feed" });
    await new Promise<void>((resolve) => {
      exporter.export(spans, (result) => {
        expect(result.code).toBe(0); // ExportResultCode.SUCCESS
        resolve();
      });
    });
    await provider.shutdown();
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(new TextDecoder().decode(bodies[0]));
    expect(parsed.resourceSpans).toBeDefined();
    expect(parsed.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("job.stage.step");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("span.job.stage.step");
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports OBS-1012 and FAILED when the transport rejects", async () => {
    const { transport } = recordingTransport(500);
    const { sink } = recordingSink();
    const onError = vi.fn();
    const exporter = createOtlpHttpSpanExporter({
      transport,
      sink,
      freeTierDailyWriteLimit: 100000,
      onError,
    });
    const { spans, provider } = finishedSpan("job.stage.step");
    await new Promise<void>((resolve) => {
      exporter.export(spans, (result) => {
        expect(result.code).toBe(1); // ExportResultCode.FAILED
        resolve();
      });
    });
    await provider.shutdown();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain(OBS_TRACES_EXPORT_FAILED);
  });

  it("reports OBS-1012 and FAILED when the transport throws", async () => {
    const failing: OtelTransport = async () => {
      throw new Error("network down");
    };
    const { sink } = recordingSink();
    const onError = vi.fn();
    const exporter = createOtlpHttpSpanExporter({
      transport: failing,
      sink,
      freeTierDailyWriteLimit: 100000,
      onError,
    });
    const { spans, provider } = finishedSpan("job.stage.step");
    await new Promise<void>((resolve) => {
      exporter.export(spans, (result) => {
        expect(result.code).toBe(1);
        resolve();
      });
    });
    await provider.shutdown();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain(OBS_TRACES_EXPORT_FAILED);
  });

  it("succeeds without calling the transport for an empty span list", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const exporter = createOtlpHttpSpanExporter({
      transport,
      sink,
      freeTierDailyWriteLimit: 100000,
    });
    await new Promise<void>((resolve) => {
      exporter.export([], (result) => {
        expect(result.code).toBe(0);
        resolve();
      });
    });
    expect(bodies).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("drops AE writes past the daily limit with exactly one OBS-1013 per day (R2 path unaffected)", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const onError = vi.fn();
    const nowMs = vi.fn(() => Date.parse("2026-11-17T12:00:00Z"));
    const exporter = createOtlpHttpSpanExporter({
      transport,
      sink,
      freeTierDailyWriteLimit: 1,
      onError,
      nowMs,
    });
    const { spans: spans1, provider: provider1 } = finishedSpan("job.stage.step", { step: "feed" });
    const { spans: spans2, provider: provider2 } = finishedSpan("job.stage.step", { step: "enrich" });
    const { spans: spans3, provider: provider3 } = finishedSpan("job.stage.step", { step: "analyze" });
    const exportOnce = (list: typeof spans1) =>
      new Promise<void>((resolve) => {
        exporter.export(list, () => resolve());
      });
    await exportOnce(spans1);
    await exportOnce(spans2);
    await exportOnce(spans3);
    await provider1.shutdown();
    await provider2.shutdown();
    await provider3.shutdown();
    // All three batches reached R2 (the transport), but only the first span reached AE.
    expect(bodies).toHaveLength(3);
    expect(events).toHaveLength(1);
    const guardCalls = onError.mock.calls.filter((c) => String(c[0]).includes(OBS_TRACES_FREE_TIER_GUARD));
    expect(guardCalls).toHaveLength(1);
  });

  it("resets the guard on a new UTC day", async () => {
    const { transport } = recordingTransport();
    const { sink, events } = recordingSink();
    const onError = vi.fn();
    let day = Date.parse("2026-11-17T12:00:00Z");
    const nowMs = vi.fn(() => day);
    const exporter = createOtlpHttpSpanExporter({
      transport,
      sink,
      freeTierDailyWriteLimit: 1,
      onError,
      nowMs,
    });
    const { spans: spans1, provider: provider1 } = finishedSpan("job.stage.step", { step: "feed" });
    await new Promise<void>((resolve) => {
      exporter.export(spans1, () => resolve());
    });
    await provider1.shutdown();
    expect(events).toHaveLength(1);
    // Next day: the guard resets and the write lands again.
    day = Date.parse("2026-11-18T12:00:00Z");
    const { spans: spans2, provider: provider2 } = finishedSpan("job.stage.step", { step: "enrich" });
    await new Promise<void>((resolve) => {
      exporter.export(spans2, () => resolve());
    });
    await provider2.shutdown();
    expect(events).toHaveLength(2);
  });

  it("writes nothing to AE when the daily limit is 0 (R2 path still runs)", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const exporter = createOtlpHttpSpanExporter({
      transport,
      sink,
      freeTierDailyWriteLimit: 0,
    });
    const { spans, provider } = finishedSpan("job.stage.step");
    await new Promise<void>((resolve) => {
      exporter.export(spans, () => resolve());
    });
    await provider.shutdown();
    expect(bodies).toHaveLength(1);
    expect(events).toHaveLength(0);
  });
});

describe("createOtelTracerProvider — the TracerProvider", () => {
  it("builds a live provider that exports spans through the transport when ON", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const { provider, tracer } = createOtelTracerProvider({
      config: j1j7OnConfig(),
      transport,
      sink,
      processor: "simple",
    });
    const span = tracer.startSpan("job.stage.step", {
      attributes: { component: "job-pipeline", step: "feed" },
    });
    span.end();
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(new TextDecoder().decode(bodies[0]));
    expect(parsed.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("job.stage.step");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("span.job.stage.step");
  });

  it("builds a no-op provider (no transport calls) when the master is OFF", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const { provider, tracer } = createOtelTracerProvider({
      config: j1j7OnConfig({ masterEnabled: false }),
      transport,
      sink,
      processor: "simple",
    });
    const span = tracer.startSpan("job.stage.step", {
      attributes: { component: "job-pipeline", step: "feed" },
    });
    span.end();
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("builds a no-op provider (no transport calls) when the traces exporter is none", async () => {
    const { transport, bodies } = recordingTransport();
    const { sink, events } = recordingSink();
    const { provider, tracer } = createOtelTracerProvider({
      config: j1j7OnConfig({ tracesExporter: "none" }),
      transport,
      sink,
      processor: "simple",
    });
    const span = tracer.startSpan("job.stage.step", {
      attributes: { component: "job-pipeline", step: "feed" },
    });
    span.end();
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
