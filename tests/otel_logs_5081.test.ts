/**
 * Issue #5081 (S1, observability program #5080) — the OTel
 * logging glue: the thin OTLP/HTTP exporter, the LoggerProvider,
 * the OTel-backed structured-log sink, and the per-domain gate.
 *
 * TDD Red first: the modules (src/observability/otelLogs.ts,
 * src/observability/otelMessages.ts) do not exist yet, so this
 * file fails at import.
 *
 * Design (recorded in the PR body):
 * - The OTel SDK is the library (LoggerProvider +
 *   Batch/SimpleLogRecordProcessor from @opentelemetry/sdk-logs).
 *   The exporter is thin glue over the OFFICIAL serializer
 *   (JsonLogsSerializer from @opentelemetry/otlp-transformer):
 *   it serializes ReadableLogRecords to OTLP/JSON and hands the
 *   bytes to an injected transport.
 * - The stock OTLPLogExporter (@opentelemetry/exporter-logs-otlp-http)
 *   is NOT used: it has no public transport injection, so it
 *   cannot route to the same-Worker ingestion route (a real HTTP
 *   POST to the Worker's own domain returns Cloudflare 522 in
 *   production — the AGENTS.md self-fetch rule). The transport
 *   here is an injected function; the Worker composition root
 *   injects the in-process ingestion handler, and the ingestion
 *   route stays a real HTTP endpoint for external OTLP senders.
 * - @pydantic/otel-cf-workers is NOT used: it is traces-only
 *   (no LoggerProvider / sdk-logs), and its @opentelemetry/core
 *   2.x conflicts with the logs stack's core 3.x. S3 (tracing)
 *   will evaluate it then.
 * - The gate is the AOP aspect: a single gate module at the
 *   domain boundary. Domain code calls through it; it does NOT
 *   contain scattered if(enabled) checks. When a domain is off,
 *   the gate no-ops (nothing emitted, nothing exported).
 */
import { describe, it, expect, vi } from "vitest";
import { SeverityNumber } from "@opentelemetry/api";
import {
  createOtelLoggerProvider,
  createOtelObservabilitySink,
  createOtelDomainGate,
  domainForComponent,
  otelSeverityForLevel,
  type OtelTransport,
  type OtelLoggingConfig,
} from "../src/observability/otelLogs";
import { OBS_EXPORT_FAILED, OBS_SINK_DEGRADED } from "../src/observability/otelMessages";
import { createStructuredLogger } from "../src/observability/structuredLogger";
import type {
  ObservabilityEvent,
  ObservabilitySink,
} from "../src/observability/observabilityPorts";

/** A config where the master is ON, logs exporter is otlp, and j1j7 is ON. */
function j1j7OnConfig(overrides: Partial<OtelLoggingConfig> = {}): OtelLoggingConfig {
  return {
    masterEnabled: true,
    logsExporter: "otlp",
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
    // Issue #5138 — all destinations ON (the file defaults).
    destinations: { analyticsEngine: true, r2: true, console: true },
    // Issue #5164 (S10) — the backend OFF (the file default).
    backend: {
      enabled: false,
      requestTimeoutMs: 10000,
      serviceName: "ai-search-agent",
      protocol: "http/json",
      endpoint: "",
      instanceId: "",
    },
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

describe("domainForComponent — the component-to-domain map", () => {
  it("maps the job-pipeline components to the j1j7 domain", () => {
    expect(domainForComponent("job-pipeline")).toBe("j1j7");
    expect(domainForComponent("job-pipeline:feed")).toBe("j1j7");
    expect(domainForComponent("job-pipeline:enrich")).toBe("j1j7");
  });

  it("maps any other component to the platform domain (OFF by default)", () => {
    expect(domainForComponent("config/paymentsFlowModes")).toBe("platform");
    expect(domainForComponent("screener-agent")).toBe("platform");
    expect(domainForComponent("")).toBe("platform");
  });
});

describe("otelSeverityForLevel — the level-to-severity map", () => {
  it("maps the structured-logger levels to OTel severity numbers", () => {
    expect(otelSeverityForLevel("info")).toBe(SeverityNumber.INFO);
    expect(otelSeverityForLevel("warn")).toBe(SeverityNumber.WARN);
    expect(otelSeverityForLevel("error")).toBe(SeverityNumber.ERROR);
  });
});

describe("createOtelDomainGate — the AOP gate", () => {
  it("passes a j1j7 event when the domain is ON and the level admits it", () => {
    const gate = createOtelDomainGate(j1j7OnConfig(), () => 0.5);
    const event = {
      level: "info",
      component: "job-pipeline",
      type: "job.run.settled",
    } as unknown as ObservabilityEvent;
    expect(gate(event)).toBe(true);
  });

  it("no-ops (false) for a domain that is OFF", () => {
    const gate = createOtelDomainGate(j1j7OnConfig(), () => 0.5);
    const event = {
      level: "info",
      component: "screener-agent",
      type: "screener.completed",
    } as unknown as ObservabilityEvent;
    expect(gate(event)).toBe(false);
  });

  it("no-ops when the master is OFF, even for j1j7", () => {
    const gate = createOtelDomainGate(j1j7OnConfig({ masterEnabled: false }), () => 0.5);
    const event = {
      level: "info",
      component: "job-pipeline",
      type: "job.run.settled",
    } as unknown as ObservabilityEvent;
    expect(gate(event)).toBe(false);
  });

  it("no-ops when the logs exporter is none, even for j1j7", () => {
    const gate = createOtelDomainGate(j1j7OnConfig({ logsExporter: "none" }), () => 0.5);
    const event = {
      level: "info",
      component: "job-pipeline",
      type: "job.run.settled",
    } as unknown as ObservabilityEvent;
    expect(gate(event)).toBe(false);
  });

  it("applies the per-domain level: INFO admits info/warn/error, ERROR admits only error", () => {
    const infoGate = createOtelDomainGate(
      j1j7OnConfig({ domains: { j1j7: { enabled: true, level: "INFO", samplingRatio: 1 } } as OtelLoggingConfig["domains"] }),
      () => 0.5,
    );
    const infoEvent = { level: "info", component: "job-pipeline" } as unknown as ObservabilityEvent;
    const errorEvent = { level: "error", component: "job-pipeline" } as unknown as ObservabilityEvent;
    expect(infoGate(infoEvent)).toBe(true);
    expect(infoGate(errorEvent)).toBe(true);

    const errorGate = createOtelDomainGate(
      j1j7OnConfig({ domains: { j1j7: { enabled: true, level: "ERROR", samplingRatio: 1 } } as OtelLoggingConfig["domains"] }),
      () => 0.5,
    );
    expect(errorGate(infoEvent)).toBe(false);
    expect(errorGate(errorEvent)).toBe(true);
  });

  it("level OFF admits nothing for that domain", () => {
    const gate = createOtelDomainGate(
      j1j7OnConfig({ domains: { j1j7: { enabled: true, level: "OFF", samplingRatio: 1 } } as OtelLoggingConfig["domains"] }),
      () => 0.5,
    );
    const event = { level: "error", component: "job-pipeline" } as unknown as ObservabilityEvent;
    expect(gate(event)).toBe(false);
  });

  it("applies sampling: a ratio of 0 admits nothing, 1 admits everything", () => {
    const zero = createOtelDomainGate(
      j1j7OnConfig({ domains: { j1j7: { enabled: true, level: "INFO", samplingRatio: 0 } } as OtelLoggingConfig["domains"] }),
      () => 0.5,
    );
    const event = { level: "info", component: "job-pipeline" } as unknown as ObservabilityEvent;
    expect(zero(event)).toBe(false);

    const all = createOtelDomainGate(
      j1j7OnConfig({ domains: { j1j7: { enabled: true, level: "INFO", samplingRatio: 1 } } as OtelLoggingConfig["domains"] }),
      () => 0.99,
    );
    expect(all(event)).toBe(true);
  });

  it("sampling uses the injected random source (deterministic in tests)", () => {
    const gate = createOtelDomainGate(
      j1j7OnConfig({ domains: { j1j7: { enabled: true, level: "INFO", samplingRatio: 0.5 } } as OtelLoggingConfig["domains"] }),
      () => 0.6,
    );
    const event = { level: "info", component: "job-pipeline" } as unknown as ObservabilityEvent;
    expect(gate(event)).toBe(false);
  });
});

describe("createOtelLoggerProvider — the OTel SDK + thin OTLP/HTTP exporter", () => {
  it("exports an emitted log record as OTLP/JSON via the transport", async () => {
    const { transport, bodies, contentTypes } = recordingTransport();
    const { provider, logger } = createOtelLoggerProvider({
      config: j1j7OnConfig(),
      transport,
      processor: "simple",
    });
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "job.run.settled",
      attributes: { jobId: "yahoo-nasdaq100", runId: "run-1", state: "completed" },
    });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies.length).toBe(1);
    expect(contentTypes[0]).toBe("application/json");
    const text = new TextDecoder().decode(bodies[0]);
    const payload = JSON.parse(text);
    // OTLP/JSON ExportLogsServiceRequest shape.
    expect(payload.resourceLogs).toBeDefined();
    const logRecord =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.body.stringValue).toBe("job.run.settled");
    expect(logRecord.severityNumber).toBe(SeverityNumber.INFO);
    const attrs = Object.fromEntries(
      (logRecord.attributes ?? []).map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(attrs.jobId).toBe("yahoo-nasdaq100");
    expect(attrs.runId).toBe("run-1");
  });

  it("reports a transport failure with the coded OBS-1002 message and does not throw", async () => {
    const onError = vi.fn();
    const failingTransport: OtelTransport = async () => {
      throw new Error("r2 down");
    };
    const { provider, logger } = createOtelLoggerProvider({
      config: j1j7OnConfig(),
      transport: failingTransport,
      processor: "simple",
      onError,
    });
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      body: "job.run.settled",
      attributes: {},
    });
    await provider.forceFlush();
    await provider.shutdown();
    expect(onError).toHaveBeenCalled();
    const call = onError.mock.calls[0][0] as string;
    expect(call).toContain(OBS_EXPORT_FAILED);
  });

  it("builds a no-op provider when the master is OFF (nothing emitted, nothing exported)", async () => {
    const { transport, bodies } = recordingTransport();
    const { provider, logger } = createOtelLoggerProvider({
      config: j1j7OnConfig({ masterEnabled: false }),
      transport,
      processor: "simple",
    });
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "job.run.settled",
      attributes: {},
    });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies.length).toBe(0);
  });
});

describe("createOtelObservabilitySink — the structured-logger → OTel bridge", () => {
  it("converts a structured-log event into an OTel log record (severity, body, attributes)", async () => {
    const { transport, bodies } = recordingTransport();
    const { provider, logger } = createOtelLoggerProvider({
      config: j1j7OnConfig(),
      transport,
      processor: "simple",
    });
    const gate = createOtelDomainGate(j1j7OnConfig(), () => 0.5);
    const sink: ObservabilitySink = createOtelObservabilitySink({ logger, gate });
    const structured = createStructuredLogger(sink, {
      tenantId: "tenant-a",
      actorId: "actor-1",
      agentId: "pipeline",
      component: "job-pipeline",
      traceId: "a".repeat(32),
      nowMs: () => 1_791_158_400_000,
    });
    structured.info("job.run.settled", { jobId: "yahoo-nasdaq100", runId: "run-1" });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies.length).toBe(1);
    const payload = JSON.parse(new TextDecoder().decode(bodies[0]));
    const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.body.stringValue).toBe("job.run.settled");
    expect(logRecord.severityNumber).toBe(SeverityNumber.INFO);
    const attrs = Object.fromEntries(
      (logRecord.attributes ?? []).map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(attrs.component).toBe("job-pipeline");
    expect(attrs.tenantId).toBe("tenant-a");
    expect(attrs.traceId).toBe("a".repeat(32));
  });

  it("drops (does not export) an event whose domain is OFF — the gate no-ops", async () => {
    const { transport, bodies } = recordingTransport();
    const { provider, logger } = createOtelLoggerProvider({
      config: j1j7OnConfig(),
      transport,
      processor: "simple",
    });
    const gate = createOtelDomainGate(j1j7OnConfig(), () => 0.5);
    const sink: ObservabilitySink = createOtelObservabilitySink({ logger, gate });
    const structured = createStructuredLogger(sink, {
      tenantId: "tenant-a",
      actorId: "actor-1",
      agentId: "screener",
      component: "screener-agent",
      traceId: "a".repeat(32),
      nowMs: () => 1_791_158_400_000,
    });
    structured.info("screener.completed", { count: 3 });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies.length).toBe(0);
  });

  it("never throws on a sink failure (the logger's never-fail contract)", async () => {
    const { provider, logger } = createOtelLoggerProvider({
      config: j1j7OnConfig(),
      transport: async () => {
        throw new Error("boom");
      },
      processor: "simple",
    });
    const gate = createOtelDomainGate(j1j7OnConfig(), () => 0.5);
    const sink: ObservabilitySink = createOtelObservabilitySink({ logger, gate });
    const structured = createStructuredLogger(sink, {
      component: "job-pipeline",
      nowMs: () => 1_791_158_400_000,
    });
    expect(() => structured.info("job.run.settled", {})).not.toThrow();
    await provider.forceFlush();
    await provider.shutdown();
  });
});

describe("OTel coded messages", () => {
  it("names the OBS codes used by the exporter and the sink", () => {
    expect(OBS_EXPORT_FAILED).toBe("OBS-1002");
    expect(OBS_SINK_DEGRADED).toBe("OBS-1005");
  });
});
