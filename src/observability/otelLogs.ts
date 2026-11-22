/**
 * Issue #5081 (S1, observability program #5080) — the OTel
 * logging glue: the thin OTLP/HTTP exporter, the LoggerProvider,
 * the OTel-backed structured-log sink, and the per-domain gate.
 *
 * The OTel SDK is the library (LoggerProvider +
 * Batch/SimpleLogRecordProcessor from @opentelemetry/sdk-logs).
 * The exporter is thin glue over the OFFICIAL serializer
 * (JsonLogsSerializer from @opentelemetry/otlp-transformer): it
 * serializes ReadableLogRecords to OTLP/JSON and hands the bytes
 * to an injected transport.
 *
 * Why not the stock OTLPLogExporter
 * (@opentelemetry/exporter-logs-otlp-http)? It has no public
 * transport injection, so it cannot route to the same-Worker
 * ingestion route: a real HTTP POST to the Worker's own domain
 * returns Cloudflare 522 in production (the AGENTS.md
 * self-fetch rule — HTTP probes of own endpoints originate from
 * a Durable Object). The transport here is an injected function;
 * the Worker composition root injects the in-process ingestion
 * handler, and the ingestion route stays a real HTTP endpoint
 * for external OTLP senders. The payload IS OTLP/HTTP (JSON):
 * the exporter speaks OTLP/HTTP; only the transport to the
 * same-Worker route is an in-process call to the route handler.
 *
 * Why not @pydantic/otel-cf-workers? It is traces-only (no
 * LoggerProvider / sdk-logs), and its @opentelemetry/core 2.x
 * conflicts with the logs stack's core 3.x. S3 (tracing) will
 * evaluate it then.
 *
 * The gate is the AOP aspect: a single gate module at the domain
 * boundary. Domain code calls through it; it does NOT contain
 * scattered if(enabled) checks. When a domain is off, the gate
 * no-ops (nothing emitted, nothing exported, no cost).
 *
 * The structured logger's level vocabulary today is
 * info/warn/error; the config level vocabulary is the full
 * ALL/ERROR/DEBUG/INFO/WARN/TRACE/OFF. The filter maps the
 * logger's levels onto the OTel severity scale, so TRACE/DEBUG/
 * ALL admit everything the logger emits today; debug/trace emit
 * methods land when a domain needs them.
 */

import { SeverityNumber, type Logger } from "@opentelemetry/api";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer";
import { ExportResultCode } from "@opentelemetry/core";
import type { OtelBackendSettings, OtelDestination, OtelDomain, OtelExporterKind, OtelLevel } from "../config/otelModes";
import { effectiveOtelDomainSwitches } from "../config/otelModes";
import type { OtelRuntimeOverrideRecord } from "../config/otelConfigPort";
import { OBS_EXPORT_FAILED, OBS_SINK_DEGRADED, formatCatalogMessage } from "./otelMessages";
import { otelServiceResource } from "./otelResource";
import type { ObservabilityEvent, ObservabilityLevel, ObservabilitySink } from "./observabilityPorts";

/** One domain's resolved switch values (enabled + level + sampling). */
export interface OtelDomainSwitches {
  enabled: boolean;
  level: OtelLevel;
  samplingRatio: number;
}

/** The resolved OTel logging configuration the provider/gate consume. */
export interface OtelLoggingConfig {
  masterEnabled: boolean;
  logsExporter: OtelExporterKind;
  domains: Record<OtelDomain, OtelDomainSwitches>;
  /** Issue #5138 — one switch per destination (resolved, all ON by default). */
  destinations: Record<OtelDestination, boolean>;
  /** Issue #5164 (S10) — the Grafana Cloud backend settings (resolved, OFF by default). */
  backend: OtelBackendSettings;
}

/**
 * The OTLP/HTTP transport: hands the serialized OTLP/JSON body
 * to its destination and reports the HTTP-style status. The
 * Worker composition root injects the in-process ingestion
 * handler; tests inject a recording transport; an external
 * sender would inject a fetch POST.
 */
export type OtelTransport = (
  body: Uint8Array,
  contentType: string,
) => Promise<{ status: number }>;

/** The component that owns the J1–J7 domain's logs. */
export const OTEL_J1J7_COMPONENT = "job-pipeline" as const;

/**
 * Maps a structured-log component to its OTel domain. The J1–J7
 * components (job-pipeline and its sub-components) map to j1j7;
 * every other component maps to the platform domain (OFF by
 * default). This is the ONE place the mapping lives.
 */
export function domainForComponent(component: string | null | undefined): OtelDomain {
  if (!component) return "platform";
  if (component === OTEL_J1J7_COMPONENT || component.startsWith(`${OTEL_J1J7_COMPONENT}:`)) {
    return "j1j7";
  }
  return "platform";
}

/** Maps a structured-logger level to its OTel severity number. */
export function otelSeverityForLevel(level: ObservabilityLevel): SeverityNumber {
  if (level === "error") return SeverityNumber.ERROR;
  if (level === "warn") return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}

/** The minimum OTel severity number a config level admits. */
function severityThresholdForLevel(level: OtelLevel): number {
  switch (level) {
    case "ALL":
      return 0;
    case "TRACE":
      return SeverityNumber.TRACE;
    case "DEBUG":
      return SeverityNumber.DEBUG;
    case "INFO":
      return SeverityNumber.INFO;
    case "WARN":
      return SeverityNumber.WARN;
    case "ERROR":
      return SeverityNumber.ERROR;
    case "OFF":
      return Number.POSITIVE_INFINITY;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * The per-domain gate (the AOP aspect). Returns true only when
 * the event's domain is enabled, the event's severity meets the
 * domain's level, and the event passes the domain's sampling.
 * The master switch and the logs-exporter switch gate
 * everything. The `random` source is injectable so sampling is
 * deterministic in tests (defaults to Math.random).
 */
/**
 * The per-domain gate (the AOP aspect). S7 (#5086): the
 * optional runtime accessor lets the gate consult the runtime
 * override cache per event — a domain on/off, level, or
 * sampling flip applies on the next event, with no redeploy.
 * Without the accessor the gate reads the init-time config
 * only (the pre-S7 behavior).
 */
export function createOtelDomainGate(
  config: OtelLoggingConfig,
  random: () => number = Math.random,
  opts?: { getRuntimeOverrides?: () => Record<string, OtelRuntimeOverrideRecord> },
): (event: ObservabilityEvent) => boolean {
  return (event: ObservabilityEvent): boolean => {
    if (!config.masterEnabled) return false;
    if (config.logsExporter === "none") return false;
    const domain = domainForComponent(event.component);
    const base = config.domains[domain];
    if (!base) return false;
    const switches = opts?.getRuntimeOverrides
      ? effectiveOtelDomainSwitches(domain, base, opts.getRuntimeOverrides())
      : base;
    if (!switches.enabled) return false;
    const severity = otelSeverityForLevel(event.level);
    if (severity < severityThresholdForLevel(switches.level)) return false;
    if (switches.samplingRatio <= 0) return false;
    if (switches.samplingRatio >= 1) return true;
    return random() < switches.samplingRatio;
  };
}

/**
 * The thin OTLP/HTTP log exporter: the official JsonLogsSerializer
 * turns ReadableLogRecords into OTLP/JSON, and the injected
 * transport delivers the bytes. Failures are reported with the
 * coded OBS-1002 message and never thrown (the exporter's
 * contract is best-effort).
 */
export function createOtlpHttpLogExporter(
  transport: OtelTransport,
  onError?: (message: string) => void,
): LogRecordExporter {
  return {
    export(logs: ReadableLogRecord[], resultCallback: (result: { code: ExportResultCode }) => void): void {
      let body: Uint8Array | undefined;
      try {
        body = JsonLogsSerializer.serializeRequest(logs);
      } catch (error) {
        const message = formatCatalogMessage(OBS_EXPORT_FAILED, { detail: `OTLP serialization failed: ${error instanceof Error ? error.message : String(error)}` });
        onError?.(message);
        resultCallback({ code: ExportResultCode.FAILED });
        return;
      }
      if (!body || body.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      transport(body, "application/json")
        .then(({ status }) => {
          if (status >= 200 && status < 300) {
            resultCallback({ code: ExportResultCode.SUCCESS });
          } else {
            const message = formatCatalogMessage(OBS_EXPORT_FAILED, { detail: `OTLP export rejected with HTTP status ${status}` });
            onError?.(message);
            resultCallback({ code: ExportResultCode.FAILED });
          }
        })
        .catch((error: unknown) => {
          const message = formatCatalogMessage(OBS_EXPORT_FAILED, { detail: `OTLP export failed: ${error instanceof Error ? error.message : String(error)}` });
          onError?.(message);
          resultCallback({ code: ExportResultCode.FAILED });
        });
    },
    async shutdown(): Promise<void> {
      // Nothing pending: each export is delivered (or failed) on its own promise.
    },
    async forceFlush(): Promise<void> {
      // Nothing buffered in the exporter itself; the processor owns the batch.
    },
  };
}

export interface OtelLoggerProviderOptions {
  config: OtelLoggingConfig;
  transport: OtelTransport;
  /** "batch" (production: amortized R2 writes) or "simple" (tests: synchronous, deterministic). */
  processor?: "batch" | "simple";
  /** Batch processor tuning (only used when processor is "batch"). */
  batch?: { maxBatchSize?: number; scheduledDelayMs?: number; maxQueueSize?: number };
  /** Receives coded OBS-1002 messages on export failure. */
  onError?: (message: string) => void;
  /** The logger name the provider hands out. */
  loggerName?: string;
}

/**
 * Builds the OTel LoggerProvider for S1 logging. When the master
 * is OFF or the logs exporter is "none", the provider is built
 * with NO processors: emit() is a no-op, nothing is exported,
 * no cost. Otherwise the provider carries one processor (batch
 * in production, simple in tests) over the thin OTLP/HTTP
 * exporter. The caller owns the provider lifecycle (forceFlush
 * at run/settle boundaries, shutdown at isolate teardown).
 * Issue #5164 (S10): the provider carries the service resource
 * (`service.name` from the resolved backend.serviceName), so
 * every serialized log payload names the service — the archive
 * AND Grafana both get it, because the resource is stamped in
 * the builder, before the fan-out transport.
 */
export function createOtelLoggerProvider(options: OtelLoggerProviderOptions): {
  provider: LoggerProvider;
  logger: Logger;
} {
  const { config, transport, onError } = options;
  const resource = otelServiceResource(config.backend.serviceName);
  const live = config.masterEnabled && config.logsExporter !== "none";
  if (!live) {
    const provider = new LoggerProvider({ resource });
    return { provider, logger: provider.getLogger(options.loggerName ?? "cfagent") };
  }
  const exporter = createOtlpHttpLogExporter(transport, onError);
  // OTel JS 3.x: both processors take an OPTIONS object carrying
  // the exporter (not the exporter as a bare first argument).
  const processor =
    options.processor === "simple"
      ? new SimpleLogRecordProcessor({ exporter })
      : new BatchLogRecordProcessor({
          exporter,
          maxExportBatchSize: options.batch?.maxBatchSize ?? 100,
          scheduledDelayMillis: options.batch?.scheduledDelayMs ?? 1000,
          maxQueueSize: options.batch?.maxQueueSize ?? 1000,
        });
  const provider = new LoggerProvider({ processors: [processor], resource });
  return { provider, logger: provider.getLogger(options.loggerName ?? "cfagent") };
}

/** Flattens a structured-log field value into an OTel attribute value. */
function attributeValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * Converts one structured-log event into an OTel log record and
 * emits it through the OTel Logger. The body is the event type
 * (the coded event name); the attributes carry the 7 mandatory
 * attributes plus the event's fields (flattened, redacted by the
 * structured logger's sink contract upstream — this sink never
 * re-introduces a sensitive value it was not handed).
 */
export function otelLogRecordForEvent(event: ObservabilityEvent): {
  severityNumber: SeverityNumber;
  severityText: string;
  body: string;
  attributes: Record<string, string | number | boolean>;
  timestamp: [number, number];
} {
  const timestampMs = Number.isFinite(event.timestampMs) ? event.timestampMs : Date.now();
  const attributes: Record<string, string | number | boolean> = {};
  if (event.traceId) attributes.traceId = event.traceId;
  if (event.spanId) attributes.spanId = event.spanId;
  if (event.tenantId) attributes.tenantId = event.tenantId;
  if (event.actorId) attributes.actorId = event.actorId;
  if (event.agentId) attributes.agentId = event.agentId;
  if (event.component) attributes.component = event.component;
  if (event.runId) attributes.runId = event.runId;
  if (event.sessionRef) attributes.sessionRef = event.sessionRef;
  if (event.errorCode) attributes.errorCode = event.errorCode;
  if (event.operation) attributes.operation = event.operation;
  if (typeof event.durationMs === "number") attributes.durationMs = event.durationMs;
  if (typeof event.count === "number") attributes.count = event.count;
  for (const [key, value] of Object.entries(event.fields ?? {})) {
    if (key in attributes) continue;
    attributes[key] = attributeValue(value);
  }
  const seconds = Math.floor(timestampMs / 1000);
  const nanos = (timestampMs - seconds * 1000) * 1_000_000;
  return {
    severityNumber: otelSeverityForLevel(event.level),
    severityText: event.level.toUpperCase(),
    body: event.type,
    attributes,
    timestamp: [seconds, nanos],
  };
}

/**
 * The OTel-backed structured-log sink: the bridge from the ONE
 * structured logger into OTel. The gate decides per event; a
 * gated-out event is dropped (never exported). The sink never
 * throws (the structured logger's never-fail contract): an emit
 * failure is reported with the coded OBS-1005 message and
 * swallowed.
 */
export function createOtelObservabilitySink(deps: {
  logger: Logger;
  gate: (event: ObservabilityEvent) => boolean;
  onError?: (message: string) => void;
}): ObservabilitySink {
  const { logger, gate, onError } = deps;
  const write = (event: ObservabilityEvent): void => {
    try {
      if (!gate(event)) return;
      const record = otelLogRecordForEvent(event);
      logger.emit({
        severityNumber: record.severityNumber,
        severityText: record.severityText,
        body: record.body,
        attributes: record.attributes,
        timestamp: record.timestamp,
      });
    } catch (error) {
      const message = formatCatalogMessage(OBS_SINK_DEGRADED, { eventType: event.type, error: error instanceof Error ? error.message : String(error) });
      onError?.(message);
    }
  };
  return {
    write,
    writeBatch: (events: readonly ObservabilityEvent[]): void => {
      for (const event of events) write(event);
    },
  };
}
