/**
 * Issue #5082 (S2, observability program #5080) — the OTel
 * metrics composition root: builds the OTel metrics stack
 * from env.
 *
 * This is the ONE place that turns env + the config file into
 * a live OTel MeterProvider, recorder, and gate. Domain code
 * never builds an OTel provider itself; hosts call
 * createOtelMetrics once and pass the handle to the observers.
 *
 * Resolution (the otelModes port): run > session > user > env >
 * config-file > built-in safe default. In production today only
 * env + the config file are settable (the run/session/user
 * carriers are populated by no production caller yet — the same
 * boundary as the logging composition root). A runtime flip
 * WITHOUT a redeploy (switches stored in KV/D1, read at
 * runtime, managed through an admin UI) is a LATER slice (S7
 * config + S8 dashboard); this composition root is the port
 * the runtime store will replace (the env/config-file source)
 * without touching domain code.
 *
 * The transport is the in-process ingestion handler: the OTel
 * exporter hands OTLP/JSON to handleOtelMetricsIngestion,
 * which writes one JSONL object per batch to R2
 * (REPORTS_BUCKET, otel-archive/ prefix) or falls back to
 * console when R2 is unbound. No HTTP self-fetch (the 522
 * rule), no Collector, no SigNoz, no D1 for telemetry.
 *
 * The same export ALSO lands in Analytics Engine (the store)
 * through the EXISTING createObservabilitySink / Analytics
 * Engine adapter — one event per metric series per export,
 * subject to the free-tier daily-write guard. No new store.
 */
import type { Env } from "../types";
import {
  OTEL_DESTINATIONS,
  OTEL_DOMAINS,
  OTEL_FILE_CONFIG,
  otelSdkDisabled,
  resolveOtelDestinationEnabled,
  resolveOtelDomainEnabled,
  resolveOtelDomainLevel,
  resolveOtelDomainSampling,
  resolveOtelMaster,
  resolveOtelMetricsSettings,
  resolveOtelSignalExporter,
  type OtelDestination,
  type OtelDomain,
  type OtelScopeLevels,
} from "../config/otelModes";
import {
  createOtelMeterProvider,
  createOtelMetricsGate,
  type OtelMetricsConfig,
  type OtelTransport,
} from "./otelMetrics";
import {
  createOtelMetricsRecorder,
  type OtelMetricsRecorder,
} from "./otelMetricsRecorder";
import { createOtelIngestionLog, handleOtelMetricsIngestion } from "./otelIngestion";
import { createBlobStore } from "../services/blobStoreR2Adapter";
import { createStructuredLogger } from "./structuredLogger";
import { createObservabilitySink } from "./createObservabilityPorts";

/** The env-var names for one domain's switches. */
function domainEnvNames(domain: OtelDomain): { enabled: string; level: string; sampling: string } {
  const upper = domain.toUpperCase().replace(/-/g, "_");
  return {
    enabled: `OTEL_DOMAIN_${upper}_ENABLED`,
    level: `OTEL_DOMAIN_${upper}_LEVEL`,
    sampling: `OTEL_DOMAIN_${upper}_SAMPLING`,
  };
}

/** Reads one env var by name from the Worker env (uniform across domains). */
function envVar(env: Record<string, unknown>, name: string): unknown {
  return env[name];
}

/**
 * Resolves the full OTel metrics config from env + the config
 * file. OTEL_SDK_DISABLED=true (the standard kill switch)
 * forces the master OFF regardless of OTEL_ENABLED.
 */
export function resolveOtelMetricsConfig(
  env: Record<string, unknown>,
  scoped?: { run?: unknown; session?: unknown; user?: unknown },
): OtelMetricsConfig {
  const levelsFor = (envName: string, fileValue: unknown): OtelScopeLevels => ({
    run: scoped?.run,
    session: scoped?.session,
    user: scoped?.user,
    env: envVar(env, envName),
    file: fileValue,
  });
  const master = resolveOtelMaster(levelsFor("OTEL_ENABLED", OTEL_FILE_CONFIG.enabled));
  const masterEnabled = otelSdkDisabled(envVar(env, "OTEL_SDK_DISABLED")) ? false : master.enabled;
  const metricsExporter = resolveOtelSignalExporter(
    "metrics",
    levelsFor("OTEL_METRICS_EXPORTER", OTEL_FILE_CONFIG.metricsExporter),
  ).exporter;
  const domains = {} as Record<OtelDomain, OtelMetricsConfig["domains"][OtelDomain]>;
  for (const domain of OTEL_DOMAINS) {
    const names = domainEnvNames(domain);
    const file = OTEL_FILE_CONFIG.domains[domain];
    domains[domain] = {
      enabled: resolveOtelDomainEnabled(domain, levelsFor(names.enabled, file?.enabled)).enabled,
      level: resolveOtelDomainLevel(domain, levelsFor(names.level, file?.level)).level,
      samplingRatio: resolveOtelDomainSampling(
        domain,
        levelsFor(names.sampling, file?.samplingRatio),
      ).ratio,
    };
  }
  // Issue #5138 — one switch per destination (env OTEL_DESTINATION_<NAME>_ENABLED
  // over the config-file value, built-in safe default OFF).
  const destinations = {} as Record<OtelDestination, boolean>;
  for (const destination of OTEL_DESTINATIONS) {
    const envName =
      destination === "analyticsEngine"
        ? "OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED"
        : destination === "r2"
          ? "OTEL_DESTINATION_R2_ENABLED"
          : "OTEL_DESTINATION_CONSOLE_ENABLED";
    destinations[destination] = resolveOtelDestinationEnabled(
      destination,
      levelsFor(envName, OTEL_FILE_CONFIG.destinations[destination]),
    ).enabled;
  }
  // Issue #5082 (S2) — the metrics settings (export interval,
  // free-tier limits, health/SLO thresholds), resolved through
  // the same five-level mechanism.
  const metricsFile = OTEL_FILE_CONFIG.metrics;
  const settings = resolveOtelMetricsSettings({
    exportIntervalMs: levelsFor(
      "OTEL_METRICS_EXPORT_INTERVAL_MS",
      metricsFile?.exportIntervalMs,
    ),
    freeTierDailyWriteLimit: levelsFor(
      "OTEL_METRICS_FREE_TIER_DAILY_WRITE_LIMIT",
      metricsFile?.freeTier?.dailyWriteLimit,
    ),
    freeTierDailyReadQueryLimit: levelsFor(
      "OTEL_METRICS_FREE_TIER_DAILY_READ_QUERY_LIMIT",
      metricsFile?.freeTier?.dailyReadQueryLimit,
    ),
    healthPipelineMaxFailureRate: levelsFor(
      "OTEL_METRICS_HEALTH_PIPELINE_MAX_FAILURE_RATE",
      metricsFile?.health?.pipelineMaxFailureRate,
    ),
    sloResourceRowsReadMaxPct: levelsFor(
      "OTEL_METRICS_SLO_RESOURCE_ROWS_READ_MAX_PCT",
      metricsFile?.slo?.resourceRowsReadMaxPct,
    ),
  }).settings;
  return { masterEnabled, metricsExporter, domains, destinations, settings };
}

export interface OtelMetricsHandle {
  config: OtelMetricsConfig;
  /** The one metrics recorder (the model every producer writes through). */
  recorder: OtelMetricsRecorder;
  /** The per-domain gate (the AOP aspect). */
  gate: (component: string) => boolean;
  /** True only when the named domain is ON (master + domain switch). */
  isDomainEnabled: (domain: OtelDomain) => boolean;
  /** Flushes the metrics batch (call at run/settle boundaries). */
  flush: () => Promise<void>;
  /** Shuts the OTel provider down (isolate teardown). */
  shutdown: () => Promise<void>;
}

/**
 * Builds the OTel metrics stack from env. Call once per host
 * (the host caches the handle with its control). The provider
 * uses the periodic reader (the configured export interval)
 * and flushes explicitly at run/settle boundaries via
 * handle.flush().
 */
export function createOtelMetrics(env: Env): OtelMetricsHandle {
  const config = resolveOtelMetricsConfig(env as unknown as Record<string, unknown>);
  // Issue #5138 — R2 off means no R2 write: the transport passes a
  // null blob store, so ingestion falls back to the structured log
  // (which itself respects the console switch through the base sink).
  const blobStore = config.destinations.r2 ? createBlobStore(env) : null;
  // The ingestion fallback writes through the structured logger
  // over the BASE sink only (never the OTel sink — a fallback
  // record must not re-enter the OTel pipeline). The base sink
  // receives the resolved AE/console destinations (full scope).
  const ingestionLog = createOtelIngestionLog(
    createStructuredLogger(
      createObservabilitySink(env, {
        analyticsEngine: config.destinations.analyticsEngine,
        console: config.destinations.console,
      }),
      { component: "otel-ingestion" },
    ),
  );
  const transport: OtelTransport = async (body) => {
    const result = await handleOtelMetricsIngestion({ body, blobStore, log: ingestionLog });
    return { status: result.status };
  };
  // The Analytics Engine sink (the store): the metrics export
  // writes one event per series through the EXISTING sink.
  const storeSink = createObservabilitySink(env, {
    analyticsEngine: config.destinations.analyticsEngine,
    console: config.destinations.console,
  });
  const { provider, meter } = createOtelMeterProvider({
    config,
    transport,
    sink: storeSink,
  });
  const gate = createOtelMetricsGate(config);
  const recorder = createOtelMetricsRecorder({
    meter,
    settings: config.settings,
    isEnabled: (component: string) => gate(component),
    flush: () => provider.forceFlush(),
  });
  return {
    config,
    recorder,
    gate,
    isDomainEnabled: (domain: OtelDomain) => {
      if (!config.masterEnabled) return false;
      return config.domains[domain]?.enabled ?? false;
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
