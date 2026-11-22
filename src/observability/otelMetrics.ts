/**
 * Issue #5082 (S2, observability program #5080) — the OTel
 * metrics glue: the thin OTLP/HTTP metrics exporter, the
 * MeterProvider, the per-domain metrics gate, and the metric →
 * Analytics Engine event conversion.
 *
 * The OTel SDK is the library (MeterProvider +
 * PeriodicExportingMetricReader from @opentelemetry/sdk-metrics).
 * The exporter is thin glue over the OFFICIAL serializer
 * (JsonMetricsSerializer from @opentelemetry/otlp-transformer):
 * it serializes ResourceMetrics to OTLP/JSON and hands the
 * bytes to an injected transport (the in-process ingestion
 * handler → R2 archive), the same transport pattern S1 built
 * for logs.
 *
 * Why not the stock OTLPMetricExporter
 * (@opentelemetry/exporter-metrics-otlp-http)? It has no public
 * transport injection, so it cannot route to the same-Worker
 * ingestion route: a real HTTP POST to the Worker's own domain
 * returns Cloudflare 522 in production (the AGENTS.md
 * self-fetch rule — see otelLogs.ts). The transport here is an
 * injected function; the Worker composition root injects the
 * in-process ingestion handler, and the ingestion route stays a
 * real HTTP endpoint for external OTLP senders.
 *
 * The same export ALSO lands in Analytics Engine (the store):
 * each aggregated metric series becomes one ObservabilityEvent
 * (type `metric.<name>`) written through the EXISTING
 * createObservabilitySink / Analytics Engine adapter. No new
 * store, no second metrics backend. The export is the SDK's
 * AGGREGATED data (counters summed, histograms bucketed), so
 * one AE datapoint is written per metric series per export —
 * never one per event. That aggregation is what keeps the
 * free tier (100k AE writes/day) reachable.
 *
 * Free-tier guard: the exporter counts AE writes in the
 * current UTC day against the configured daily write limit
 * (default 100k, a config value). When the limit is reached,
 * further AE writes for the day are dropped with ONE coded
 * OBS-1007 message (not one per drop). The OTLP/R2 archive
 * path is not guarded (R2 has no per-row quota).
 *
 * The gate is the AOP aspect for metrics: master + metrics
 * exporter + domain enabled. The log level/sampling do NOT
 * apply to metrics (a counter sampled at record time is a
 * corrupted count); the metrics volume controls are the
 * export interval (config) and the free-tier guard.
 */
import type { Meter } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  DataPointType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { JsonMetricsSerializer } from "@opentelemetry/otlp-transformer";
import type { OtelDestination, OtelDomain, OtelExporterKind } from "../config/otelModes";
import { effectiveOtelDomainSwitches } from "../config/otelModes";
import type { OtelRuntimeOverrideRecord } from "../config/otelConfigPort";
import type { OtelDomainSwitches } from "./otelLogs";
import { domainForComponent } from "./otelLogs";
import {
  OBS_METRICS_EXPORT_FAILED,
  OBS_METRICS_FREE_TIER_GUARD,
  formatCatalogMessage,
} from "./otelMessages";
import { otelServiceResource } from "./otelResource";
import {
  newTraceContext,
  timestampIsoFor,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "./observabilityPorts";

/** Re-exported so the metrics stack shares the one settings shape. */
export type { OtelMetricsSettings } from "../config/otelModes";
import type { OtelBackendSettings, OtelMetricsSettings } from "../config/otelModes";

/** The resolved OTel metrics configuration the provider/gate consume. */
export interface OtelMetricsConfig {
  masterEnabled: boolean;
  metricsExporter: OtelExporterKind;
  domains: Record<OtelDomain, OtelDomainSwitches>;
  /** Issue #5138 — one switch per destination (resolved, all ON by default). */
  destinations: Record<OtelDestination, boolean>;
  /** Issue #5082 (S2) — the metrics settings (export interval, free-tier limits, thresholds). */
  settings: OtelMetricsSettings;
  /** Issue #5164 (S10) — the Grafana Cloud backend settings (resolved, OFF by default). */
  backend: OtelBackendSettings;
}

/**
 * The OTLP/HTTP transport: hands the serialized OTLP/JSON body
 * to its destination and reports the HTTP-style status. The
 * Worker composition root injects the in-process ingestion
 * handler; tests inject a recording transport; an external
 * sender would inject a fetch POST. (The same transport type
 * S1 defines for logs — re-exported here so the metrics stack
 * does not depend on the logs module.)
 */
export type OtelTransport = (
  body: Uint8Array,
  contentType: string,
) => Promise<{ status: number }>;

/**
 * The per-domain gate (the AOP aspect) for metrics. Returns
 * true only when the master is ON, the metrics exporter is not
 * "none", and the component's domain is enabled. The log
 * level/sampling do not apply to metrics (see the module doc).
 */
/**
 * The per-domain gate (the AOP aspect). S7 (#5086): the
 * optional runtime accessor lets the gate consult the runtime
 * override cache per event — a domain on/off flip applies on
 * the next event, with no redeploy. Without the accessor the
 * gate reads the init-time config only.
 */
export function createOtelMetricsGate(
  config: OtelMetricsConfig,
  opts?: { getRuntimeOverrides?: () => Record<string, OtelRuntimeOverrideRecord> },
): (component: string) => boolean {
  return (component: string): boolean => {
    if (!config.masterEnabled) return false;
    if (config.metricsExporter === "none") return false;
    const domain = domainForComponent(component);
    const base = config.domains[domain];
    if (!base) return false;
    const switches = opts?.getRuntimeOverrides
      ? effectiveOtelDomainSwitches(domain, base, opts.getRuntimeOverrides())
      : base;
    if (!switches.enabled) return false;
    return true;
  };
}

/** One aggregated metric series, extracted from an OTel export. */
export interface OtelMetricSeries {
  name: string;
  description: string;
  unit: string;
  kind: "counter" | "histogram" | "gauge";
  /** The counter sum, the histogram sum, or the gauge value. */
  value: number;
  /** The histogram observation count (histograms only). */
  count?: number;
  /** The histogram min (histograms only). */
  min?: number;
  /** The histogram max (histograms only). */
  max?: number;
  labels: Record<string, string | number | boolean>;
  timestampMs: number;
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
 * Converts one aggregated metric series into the ONE
 * Analytics Engine event for it. The event type is
 * `metric.<name>`; the operation is the metric name; the
 * labels ride in `fields` (whitelisted scalars only — the
 * same discipline as the log events). For a counter/gauge the
 * value rides in `count`; for a histogram the sum rides in
 * `durationMs` and the observation count in `count`, with
 * min/max in `fields`. A series with an empty name converts
 * to null (never writes a nameless metric). The tenant rides
 * the `tenant_id`/`tenantId` label when present (the AE
 * index dimension); otherwise it is null (the adapter maps
 * it to "none").
 */
export function metricEventForSeries(series: OtelMetricSeries): ObservabilityEvent | null {
  if (!series.name) return null;
  const timestampMs = Number.isFinite(series.timestampMs) ? series.timestampMs : Date.now();
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(series.labels ?? {})) {
    fields[key] = value;
  }
  if (series.kind === "histogram") {
    if (typeof series.min === "number") fields.min = series.min;
    if (typeof series.max === "number") fields.max = series.max;
  }
  fields.kind = series.kind;
  fields.unit = series.unit;
  if (series.description) fields.description = series.description;
  const tenantId =
    typeof series.labels?.tenant_id === "string"
      ? series.labels.tenant_id
      : typeof series.labels?.tenantId === "string"
        ? series.labels.tenantId
        : null;
  const event: ObservabilityEvent = {
    type: `metric.${series.name}`,
    level: "info",
    operation: series.name,
    tenantId,
    actorId: null,
    agentId: null,
    component: "otel-metrics",
    runId: null,
    sessionRef: null,
    traceId: newTraceContext().traceId,
    timestampMs,
    timestampIso: timestampIsoFor(timestampMs),
    fields,
  };
  if (series.kind === "histogram") {
    event.durationMs = series.value;
    if (typeof series.count === "number") event.count = series.count;
  } else {
    event.count = series.value;
  }
  return event;
}

/** An HrTime ([seconds, nanos]) as epoch milliseconds. */
function hrTimeToMs(hrTime: readonly [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

/** The UTC calendar day (YYYY-MM-DD) of an instant. */
function utcDayOf(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Extracts the aggregated metric series from an OTel
 * ResourceMetrics export (one series per metric × attribute
 * set). A series with no data points is skipped.
 */
export function extractMetricSeries(metrics: ResourceMetrics): OtelMetricSeries[] {
  const series: OtelMetricSeries[] = [];
  for (const scopeMetrics of metrics.scopeMetrics ?? []) {
    for (const metric of scopeMetrics.metrics ?? []) {
      const name = metric.descriptor?.name ?? "";
      if (!name) continue;
      const description = metric.descriptor?.description ?? "";
      const unit = metric.descriptor?.unit ?? "1";
      for (const point of metric.dataPoints ?? []) {
        const labels: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(point.attributes ?? {})) {
          labels[key] = attributeValue(value);
        }
        const timestampMs = hrTimeToMs(point.endTime);
        if (metric.dataPointType === DataPointType.HISTOGRAM) {
          const value = point.value as { count: number; sum: number; min: number; max: number };
          series.push({
            name,
            description,
            unit,
            kind: "histogram",
            value: typeof value.sum === "number" ? value.sum : 0,
            count: typeof value.count === "number" ? value.count : 0,
            min: typeof value.min === "number" ? value.min : undefined,
            max: typeof value.max === "number" ? value.max : undefined,
            labels,
            timestampMs,
          });
        } else if (metric.dataPointType === DataPointType.GAUGE) {
          const value = point.value as number;
          series.push({
            name,
            description,
            unit,
            kind: "gauge",
            value: typeof value === "number" ? value : 0,
            labels,
            timestampMs,
          });
        } else {
          // SUM (counter / up-down counter / observable counter):
          // the aggregated value is the sum.
          const value = point.value as number;
          series.push({
            name,
            description,
            unit,
            kind: "counter",
            value: typeof value === "number" ? value : 0,
            count: typeof value === "number" ? value : 0,
            labels,
            timestampMs,
          });
        }
      }
    }
  }
  return series;
}

export interface OtlpHttpMetricExporterOptions {
  /** The injected OTLP/HTTP transport (in-process ingestion handler in production). */
  transport: OtelTransport;
  /** The Analytics Engine sink (the store) — one event per series per export. */
  sink: ObservabilitySink;
  /** The configured daily AE write limit (0 = no AE writes; the R2 path still runs). */
  freeTierDailyWriteLimit: number;
  /** Receives coded OBS-1006 / OBS-1007 messages. */
  onError?: (message: string) => void;
  /** The clock (defaults to Date.now); injectable for tests. */
  nowMs?: () => number;
}

/**
 * The thin OTLP/HTTP metrics exporter: the official
 * JsonMetricsSerializer turns ResourceMetrics into OTLP/JSON
 * and the injected transport delivers the bytes (the R2
 * archive path); the same aggregated series are written to
 * the Analytics Engine sink (the store), one event per series
 * per export, subject to the free-tier daily-write guard.
 * Failures are reported with the coded OBS-1006 message and
 * never thrown (the exporter's contract is best-effort). The
 * guard drops AE writes with ONE coded OBS-1007 message per
 * day (not one per drop).
 */
export function createOtlpHttpMetricExporter(
  options: OtlpHttpMetricExporterOptions,
): PushMetricExporter {
  const { transport, sink, onError } = options;
  const nowMs = options.nowMs ?? (() => Date.now());
  const limit =
    Number.isFinite(options.freeTierDailyWriteLimit) && options.freeTierDailyWriteLimit >= 0
      ? Math.floor(options.freeTierDailyWriteLimit)
      : 100000;
  let guardDay = "";
  let guardWrites = 0;
  let guardFired = false;

  /** Writes one series to AE unless the day's guard has tripped. */
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
          formatCatalogMessage(OBS_METRICS_FREE_TIER_GUARD, { limit, day }),
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
      metrics: ResourceMetrics,
      resultCallback: (result: { code: ExportResultCode }) => void,
    ): void {
      // The Analytics Engine store path (one event per series).
      try {
        for (const series of extractMetricSeries(metrics)) {
          const event = metricEventForSeries(series);
          if (!event) continue;
          writeToStore(event);
        }
      } catch (error) {
        onError?.(
          formatCatalogMessage(OBS_METRICS_EXPORT_FAILED, { detail: `Metric series extraction failed: ${error instanceof Error ? error.message : String(error)}` }),
        );
      }
      // The OTLP/HTTP archive path.
      let body: Uint8Array | undefined;
      try {
        body = JsonMetricsSerializer.serializeRequest(metrics);
      } catch (error) {
        const message = formatCatalogMessage(OBS_METRICS_EXPORT_FAILED, { detail: `OTLP metrics serialization failed: ${error instanceof Error ? error.message : String(error)}` });
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
            const message = formatCatalogMessage(OBS_METRICS_EXPORT_FAILED, { detail: `OTLP metrics export rejected with HTTP status ${status}` });
            onError?.(message);
            resultCallback({ code: ExportResultCode.FAILED });
          }
        })
        .catch((error: unknown) => {
          const message = formatCatalogMessage(OBS_METRICS_EXPORT_FAILED, { detail: `OTLP metrics export failed: ${error instanceof Error ? error.message : String(error)}` });
          onError?.(message);
          resultCallback({ code: ExportResultCode.FAILED });
        });
    },
    async forceFlush(): Promise<void> {
      // Nothing buffered in the exporter itself; the reader owns the batch.
    },
    async shutdown(): Promise<void> {
      // Nothing pending: each export is delivered (or failed) on its own promise.
    },
  };
}

export interface OtelMeterProviderOptions {
  config: OtelMetricsConfig;
  transport: OtelTransport;
  /** The Analytics Engine sink (the store). */
  sink: ObservabilitySink;
  /** Receives coded OBS-1006 / OBS-1007 messages on export/guard events. */
  onError?: (message: string) => void;
  /** The meter name the provider hands out. */
  meterName?: string;
  /** The clock for the free-tier guard's day tracking (defaults to Date.now). */
  nowMs?: () => number;
}

/**
 * Builds the OTel MeterProvider for S2 metrics. When the master
 * is OFF or the metrics exporter is "none", the provider is
 * built with NO readers: recording is a no-op, nothing is
 * exported, no cost. Otherwise the provider carries one
 * PeriodicExportingMetricReader over the thin OTLP/HTTP
 * exporter, exporting on the configured interval (and on
 * forceFlush at run/settle boundaries). The caller owns the
 * provider lifecycle (forceFlush at run/settle boundaries,
 * shutdown at isolate teardown). Issue #5164 (S10): the
 * provider carries the service resource (`service.name` from
 * the resolved backend.serviceName), so every serialized
 * metric payload names the service.
 */
export function createOtelMeterProvider(options: OtelMeterProviderOptions): {
  provider: MeterProvider;
  meter: Meter;
} {
  const { config, transport, sink, onError } = options;
  const resource = otelServiceResource(config.backend.serviceName);
  const live = config.masterEnabled && config.metricsExporter !== "none";
  if (!live) {
    const provider = new MeterProvider({ resource });
    return { provider, meter: provider.getMeter(options.meterName ?? "cfagent") };
  }
  const exporter = createOtlpHttpMetricExporter({
    transport,
    sink,
    freeTierDailyWriteLimit: config.settings.freeTierDailyWriteLimit,
    onError,
    nowMs: options.nowMs,
  });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: config.settings.exportIntervalMs,
  });
  const provider = new MeterProvider({ readers: [reader], resource });
  return { provider, meter: provider.getMeter(options.meterName ?? "cfagent") };
}
