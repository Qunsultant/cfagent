/**
 * Issue #2808 (S3, observability program #5080) — the OTel
 * tracing glue: the thin OTLP/HTTP span exporter, the
 * TracerProvider, the per-domain traces gate, and the span →
 * Analytics Engine event conversion.
 *
 * The OTel SDK is the library (TracerProvider +
 * Batch/SimpleSpanProcessor from @opentelemetry/sdk-trace
 * 3.1.1 — the 3.x trace SDK, on the same core/resources
 * 3.1.1 line as the S1 logs and S2 metrics stacks). The
 * 2.x sdk-trace-base line is NOT used: its peer range
 * (@opentelemetry/api <1.10.0) conflicts with the repo's api
 * ^1.10.0, and its core 2.x conflicts with the logs stack's
 * core 3.x (the S1 otelLogs.ts note already flagged this for
 * the pydantic package; the same conflict rules out
 * sdk-trace-base 2.12.0 here).
 *
 * The exporter is thin glue over the OFFICIAL serializer
 * (JsonTraceSerializer from @opentelemetry/otlp-transformer):
 * it serializes ReadableSpans to OTLP/JSON and hands the
 * bytes to an injected transport (the in-process ingestion
 * handler → R2 archive), the same transport pattern S1 built
 * for logs and S2 built for metrics.
 *
 * Why not the stock OTLPSpanExporter
 * (@opentelemetry/exporter-trace-otlp-http)? It has no public
 * transport injection, so it cannot route to the same-Worker
 * ingestion route: a real HTTP POST to the Worker's own domain
 * returns Cloudflare 522 in production (the AGENTS.md
 * self-fetch rule — see otelLogs.ts). The transport here is an
 * injected function; the Worker composition root injects the
 * in-process ingestion handler, and the ingestion route stays a
 * real HTTP endpoint for external OTLP senders.
 *
 * The same export ALSO lands in Analytics Engine (the store):
 * each finished span becomes one ObservabilityEvent (type
 * `span.<name>`) written through the EXISTING
 * createObservabilitySink / Analytics Engine adapter. No new
 * store, no second traces backend. A span is one datapoint
 * per span per export (spans are not aggregated like metrics)
 * — the free-tier guard is what keeps the free tier
 * reachable.
 *
 * Free-tier guard: the exporter counts AE writes in the
 * current UTC day against the configured daily write limit
 * (default 100k, a config value). When the limit is reached,
 * further AE writes for the day are dropped with ONE coded
 * OBS-1013 message (not one per drop). The OTLP/R2 archive
 * path is not guarded (R2 has no per-row quota).
 *
 * The gate is the AOP aspect for traces: master + traces
 * exporter + domain enabled + domain level + sampling. The
 * level for spans is OFF-means-no-spans (spans carry no
 * severity; any other level admits them); sampling is the
 * standard probabilistic OTel sampling at span start.
 */
import type { Tracer } from "@opentelemetry/api";
import { SpanStatusCode, context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { OtelDestination, OtelDomain, OtelExporterKind } from "../config/otelModes";
import { effectiveOtelDomainSwitches } from "../config/otelModes";
import type { OtelBackendSettings, OtelTracesSettings } from "../config/otelModes";
import type { OtelRuntimeOverrideRecord } from "../config/otelConfigPort";
import type { OtelDomainSwitches } from "./otelLogs";
import { domainForComponent } from "./otelLogs";
import {
  OBS_TRACES_EXPORT_FAILED,
  OBS_TRACES_FREE_TIER_GUARD,
  formatCatalogMessage,
} from "./otelMessages";
import { otelServiceResource } from "./otelResource";
import {
  newTraceContext,
  timestampIsoFor,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "./observabilityPorts";

/** The resolved OTel traces configuration the provider/gate consume. */
export interface OtelTracesConfig {
  masterEnabled: boolean;
  tracesExporter: OtelExporterKind;
  domains: Record<OtelDomain, OtelDomainSwitches>;
  /** Issue #5138 — one switch per destination (resolved, all ON by default). */
  destinations: Record<OtelDestination, boolean>;
  /** Issue #2808 (S3) — the traces settings (free-tier daily write limit). */
  settings: OtelTracesSettings;
  /** Issue #5164 (S10) — the Grafana Cloud backend settings (resolved, OFF by default). */
  backend: OtelBackendSettings;
}

/**
 * The OTLP/HTTP transport: hands the serialized OTLP/JSON body
 * to its destination and reports the HTTP-style status. The
 * Worker composition root injects the in-process ingestion
 * handler; tests inject a recording transport; an external
 * sender would inject a fetch POST. (The same transport type
 * S1 defines for logs — re-exported here so the traces stack
 * does not depend on the logs module.)
 */
export type OtelTransport = (
  body: Uint8Array,
  contentType: string,
) => Promise<{ status: number }>;

/**
 * The per-domain gate (the AOP aspect) for traces. Returns
 * true only when the master is ON, the traces exporter is not
 * "none", the component's domain is enabled, the domain's
 * level is not OFF, and the span passes the domain's
 * sampling. The level for spans is OFF-means-no-spans (spans
 * carry no severity; any other level admits them). The
 * `random` source is injectable so sampling is deterministic
 * in tests (defaults to Math.random).
 */
/**
 * The per-domain gate (the AOP aspect). S7 (#5086): the
 * optional runtime accessor lets the gate consult the runtime
 * override cache per event — a domain on/off, level, or
 * sampling flip applies on the next event, with no redeploy.
 * Without the accessor the gate reads the init-time config
 * only.
 */
export function createOtelTracesGate(
  config: OtelTracesConfig,
  random: () => number = Math.random,
  opts?: { getRuntimeOverrides?: () => Record<string, OtelRuntimeOverrideRecord> },
): (component: string) => boolean {
  return (component: string): boolean => {
    if (!config.masterEnabled) return false;
    if (config.tracesExporter === "none") return false;
    const domain = domainForComponent(component);
    const base = config.domains[domain];
    if (!base) return false;
    const switches = opts?.getRuntimeOverrides
      ? effectiveOtelDomainSwitches(domain, base, opts.getRuntimeOverrides())
      : base;
    if (!switches.enabled) return false;
    if (switches.level === "OFF") return false;
    if (switches.samplingRatio <= 0) return false;
    if (switches.samplingRatio >= 1) return true;
    return random() < switches.samplingRatio;
  };
}

/** An HrTime ([seconds, nanos]) as epoch milliseconds. */
function hrTimeToMs(hrTime: readonly [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

/** Flattens an OTel attribute value into a stream-safe scalar. */
function attributeValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * Converts one finished OTel span into the ONE Analytics
 * Engine event for it. The event type is `span.<name>`; the
 * operation is the span name; the duration rides in
 * `durationMs`; the trace/span/parent-span ids ride the
 * event's trace fields; the span's attributes ride in
 * `fields` (whitelisted scalars only — the same discipline as
 * the log events). An ERROR span maps to level "error" (so it
 * surfaces); OK/UNSET map to "info". A span with an empty name
 * converts to null (never writes a nameless span). The tenant
 * rides the `tenant_id`/`tenantId` attribute when present
 * (the AE index dimension); otherwise it is null (the adapter
 * maps it to "none").
 */
export function spanEventForReadableSpan(span: ReadableSpan): ObservabilityEvent | null {
  if (!span.name) return null;
  const ctx = span.spanContext();
  const status = span.status ?? { code: SpanStatusCode.UNSET };
  const level = status.code === SpanStatusCode.ERROR ? "error" : "info";
  const endTimeMs = hrTimeToMs(span.endTime);
  const durationMs = hrTimeToMs(span.duration);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.attributes ?? {})) {
    fields[key] = attributeValue(value);
  }
  fields.statusCode = status.code;
  if (typeof status.message === "string" && status.message) {
    fields.statusMessage = status.message;
  }
  if (span.parentSpanContext?.spanId) {
    fields.parentSpanId = span.parentSpanContext.spanId;
  }
  fields.kind = span.kind;
  if (Array.isArray(span.events) && span.events.length > 0) {
    fields.eventCount = span.events.length;
  }
  const tenantId =
    typeof span.attributes?.tenant_id === "string"
      ? span.attributes.tenant_id
      : typeof span.attributes?.tenantId === "string"
        ? span.attributes.tenantId
        : null;
  const component =
    typeof span.attributes?.component === "string" ? span.attributes.component : "otel-traces";
  const event: ObservabilityEvent = {
    type: `span.${span.name}`,
    level,
    operation: span.name,
    tenantId,
    actorId:
      typeof span.attributes?.actor_id === "string"
        ? span.attributes.actor_id
        : typeof span.attributes?.actorId === "string"
          ? span.attributes.actorId
          : null,
    agentId:
      typeof span.attributes?.agent_id === "string"
        ? span.attributes.agent_id
        : typeof span.attributes?.agentId === "string"
          ? span.attributes.agentId
          : null,
    component,
    runId:
      typeof span.attributes?.runId === "string" ? span.attributes.runId : null,
    sessionRef: null,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    timestampMs: endTimeMs,
    timestampIso: timestampIsoFor(endTimeMs),
    durationMs,
    fields,
  };
  return event;
}

/** The UTC calendar day (YYYY-MM-DD) of an instant. */
function utcDayOf(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export interface OtlpHttpSpanExporterOptions {
  /** The injected OTLP/HTTP transport (in-process ingestion handler in production). */
  transport: OtelTransport;
  /** The Analytics Engine sink (the store) — one event per span per export. */
  sink: ObservabilitySink;
  /** The configured daily AE write limit (0 = no AE writes; the R2 path still runs). */
  freeTierDailyWriteLimit: number;
  /** Receives coded OBS-1012 / OBS-1013 messages. */
  onError?: (message: string) => void;
  /** The clock (defaults to Date.now); injectable for tests. */
  nowMs?: () => number;
}

/**
 * The thin OTLP/HTTP span exporter: the official
 * JsonTraceSerializer turns ReadableSpans into OTLP/JSON and
 * the injected transport delivers the bytes (the R2 archive
 * path); the same finished spans are written to the Analytics
 * Engine sink (the store), one event per span per export,
 * subject to the free-tier daily-write guard. Failures are
 * reported with the coded OBS-1012 message and never thrown
 * (the exporter's contract is best-effort). The guard drops
 * AE writes with ONE coded OBS-1013 message per day (not one
 * per drop).
 */
export function createOtlpHttpSpanExporter(
  options: OtlpHttpSpanExporterOptions,
): SpanExporter {
  const { transport, sink, onError } = options;
  const nowMs = options.nowMs ?? (() => Date.now());
  const limit =
    Number.isFinite(options.freeTierDailyWriteLimit) && options.freeTierDailyWriteLimit >= 0
      ? Math.floor(options.freeTierDailyWriteLimit)
      : 100000;
  let guardDay = "";
  let guardWrites = 0;
  let guardFired = false;

  /** Writes one span to AE unless the day's guard has tripped. */
  const writeToStore = (event: ObservabilityEvent): void => {
    const day = utcDayOf(nowMs());
    if (day !== guardDay) {
      guardDay = day;
      guardWrites = 0;
      guardFired = false;
    }
    if (guardWrites >= limit) {
      if (!guardFired) {
        guardFired = true;
        onError?.(
          formatCatalogMessage(OBS_TRACES_FREE_TIER_GUARD, { limit, day }),
        );
      }
      return;
    }
    try {
      const result = sink.write(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {
          // A sink's async failure never fails the export.
        });
      }
      guardWrites += 1;
    } catch {
      // A sink's sync failure never fails the export.
    }
  };

  return {
    export(
      spans: ReadableSpan[],
      resultCallback: (result: { code: ExportResultCode }) => void,
    ): void {
      // The Analytics Engine store path (one event per span).
      try {
        for (const span of spans) {
          const event = spanEventForReadableSpan(span);
          if (!event) continue;
          writeToStore(event);
        }
      } catch (error) {
        onError?.(
          formatCatalogMessage(OBS_TRACES_EXPORT_FAILED, { detail: `Span event conversion failed: ${error instanceof Error ? error.message : String(error)}` }),
        );
      }
      // The OTLP/HTTP archive path. An empty batch exports
      // nothing: no serialization, no transport call.
      if (spans.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      let body: Uint8Array | undefined;
      try {
        body = JsonTraceSerializer.serializeRequest(spans);
      } catch (error) {
        const message = formatCatalogMessage(OBS_TRACES_EXPORT_FAILED, { detail: `OTLP traces serialization failed: ${error instanceof Error ? error.message : String(error)}` });
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
            const message = formatCatalogMessage(OBS_TRACES_EXPORT_FAILED, { detail: `OTLP traces export rejected with HTTP status ${status}` });
            onError?.(message);
            resultCallback({ code: ExportResultCode.FAILED });
          }
        })
        .catch((error: unknown) => {
          const message = formatCatalogMessage(OBS_TRACES_EXPORT_FAILED, { detail: `OTLP traces export failed: ${error instanceof Error ? error.message : String(error)}` });
          onError?.(message);
          resultCallback({ code: ExportResultCode.FAILED });
        });
    },
    async forceFlush(): Promise<void> {
      // Nothing buffered in the exporter itself; the processor owns the batch.
    },
    async shutdown(): Promise<void> {
      // Nothing pending: each export is delivered (or failed) on its own promise.
    },
  };
}

export interface OtelTracerProviderOptions {
  config: OtelTracesConfig;
  transport: OtelTransport;
  /** The Analytics Engine sink (the store). */
  sink: ObservabilitySink;
  /** "batch" (production: amortized R2 writes) or "simple" (tests: synchronous, deterministic). */
  processor?: "batch" | "simple";
  /** Batch processor tuning (only used when processor is "batch"). */
  batch?: { maxExportBatchSize?: number; scheduledDelayMillis?: number; maxQueueSize?: number };
  /** Receives coded OBS-1012 / OBS-1013 messages on export/guard events. */
  onError?: (message: string) => void;
  /** The tracer name the provider hands out. */
  tracerName?: string;
  /** The clock for the free-tier guard's day tracking (defaults to Date.now). */
  nowMs?: () => number;
}

/**
 * Registers the OTel context manager that makes span
 * nesting work. The OTel API ships with a NO-OP context
 * manager: `context.with` does nothing and `context.active()`
 * always returns the root, so a step that calls the journal
 * again would record a second ROOT span instead of a child.
 * The AsyncLocalStorage manager (from
 * @opentelemetry/context-async-hooks) propagates the active
 * span through async boundaries, so nested journal calls
 * record child spans of the enclosing step — and concurrent
 * runs on the same journal keep their own active span (each
 * async execution context carries its own). The Worker
 * supports it: wrangler.jsonc enables `nodejs_compat`, and
 * the codebase already uses AsyncLocalStorage
 * (src/aspects/transactionAspect.ts).
 *
 * Registration is idempotent (module-level guard): the
 * composition root calls this once per host, and calling it
 * again is a no-op. It must run BEFORE any span is created
 * for nesting to work.
 */
let otelContextManagerRegistered = false;
export function ensureOtelContextManager(): void {
  if (otelContextManagerRegistered) return;
  otelContextManagerRegistered = true;
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
}

/**
 * Builds the OTel TracerProvider for S3 tracing. When the
 * master is OFF or the traces exporter is "none", the provider
 * is built with NO processors: startSpan still returns a
 * span, but it is non-recording — nothing is exported, no
 * cost. Otherwise the provider carries one processor (batch
 * in production, simple in tests) over the thin OTLP/HTTP
 * span exporter. The caller owns the provider lifecycle
 * (forceFlush at run/settle boundaries, shutdown at isolate
 * teardown). Issue #5164 (S10): the provider carries the
 * service resource (`service.name` from the resolved
 * backend.serviceName), so every serialized span payload
 * names the service.
 */
export function createOtelTracerProvider(options: OtelTracerProviderOptions): {
  provider: TracerProvider;
  tracer: Tracer;
} {
  const { config, transport, sink, onError } = options;
  const resource = otelServiceResource(config.backend.serviceName);
  const live = config.masterEnabled && config.tracesExporter !== "none";
  if (!live) {
    const provider = new TracerProvider({ resource });
    return { provider, tracer: provider.getTracer(options.tracerName ?? "cfagent") };
  }
  const exporter = createOtlpHttpSpanExporter({
    transport,
    sink,
    freeTierDailyWriteLimit: config.settings.freeTierDailyWriteLimit,
    onError,
    nowMs: options.nowMs,
  });
  // OTel JS 3.x: both processors take an OPTIONS object carrying
  // the exporter (not the exporter as a bare first argument).
  const processor =
    options.processor === "simple"
      ? new SimpleSpanProcessor({ exporter })
      : new BatchSpanProcessor({
          exporter,
          maxExportBatchSize: options.batch?.maxExportBatchSize ?? 100,
          scheduledDelayMillis: options.batch?.scheduledDelayMillis ?? 1000,
          maxQueueSize: options.batch?.maxQueueSize ?? 1000,
        });
  const provider = new TracerProvider({ spanProcessors: [processor], resource });
  return { provider, tracer: provider.getTracer(options.tracerName ?? "cfagent") };
}

/** Re-exported so the traces stack shares the one settings shape. */
export type { OtelTracesSettings } from "../config/otelModes";

/** The trace id for a span event's trace (a fresh trace when none is carried). */
export function newSpanTraceId(): string {
  return newTraceContext().traceId;
}
