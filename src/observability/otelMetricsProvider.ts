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
 * Resolution (the otelModes port): run > session > user >
 * runtime > config-file > built-in safe default. The runtime
 * level (S7, #5086) is the platform admin's override from the
 * config port (D1 otel_config_overrides, read through the
 * override cache): the config resolver consults the cache at
 * init, the domain gate consults it per event, and
 * isDomainEnabled consults it per call (kicking off a
 * TTL-guarded background refresh). The master / exporter /
 * settings switches are read at init, so a flip there applies
 * at the next init; a domain on/off flip applies on the next
 * event. The store sink's destinations flip per write (see
 * createObservabilityPorts).
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
  effectiveOtelDomainSwitches,
  otelSdkDisabled,
  resolveOtelBackendSettings,
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
import { createOtelBackendAudit, createOtelBackendFanOutTransport } from "./otelBackend";
import {
  cachedOtelRuntimeOverrides,
  otelConfigD1FromEnv,
  otelRuntimeLevelByEnvName,
  refreshOtelRuntimeOverrideCache,
} from "../config/otelConfigPort";
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
    // S7 (#5086): the runtime level from the override cache.
    runtime: otelRuntimeLevelByEnvName(cachedOtelRuntimeOverrides(), envName),
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
  // Issue #5164 (S10) — the Grafana Cloud backend settings
  // (enabled + request timeout + service name + protocol +
  // endpoint + instance ID), resolved through the same
  // mechanism. OFF by default: telemetry stays on the
  // free-tier path until the owner sets the one Grafana
  // Worker secret (GRAFANA_CLOUD_API_KEY) and flips the
  // switch. The endpoint + instance ID are config values,
  // not secrets (owner direction 2026-11-22).
  const backendFile = OTEL_FILE_CONFIG.backend;
  const backend = resolveOtelBackendSettings({
    enabled: levelsFor("OTEL_BACKEND_ENABLED", backendFile?.enabled),
    requestTimeoutMs: levelsFor(
      "OTEL_BACKEND_REQUEST_TIMEOUT_MS",
      backendFile?.requestTimeoutMs,
    ),
    serviceName: levelsFor("OTEL_SERVICE_NAME", backendFile?.serviceName),
    protocol: levelsFor("OTEL_EXPORTER_OTLP_PROTOCOL", backendFile?.protocol),
    endpoint: levelsFor("OTEL_BACKEND_ENDPOINT", backendFile?.endpoint),
    instanceId: levelsFor("OTEL_BACKEND_INSTANCE_ID", backendFile?.instanceId),
  }).settings;
  return { masterEnabled, metricsExporter, domains, destinations, settings, backend };
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
  // record must not re-enter the OTel pipeline). S7 (#5086):
  // no explicit destinations — the sink resolves them per
  // write from env/file + the runtime override cache.
  const ingestionLog = createOtelIngestionLog(
    createStructuredLogger(createObservabilitySink(env), { component: "otel-ingestion" }),
  );
  const archiveTransport: OtelTransport = async (body) => {
    const result = await handleOtelMetricsIngestion({ body, blobStore, log: ingestionLog });
    return { status: result.status };
  };
  // Issue #5164 (S10) — the Grafana Cloud backend leg: the
  // archive transport above runs first (its status is what the
  // exporter sees); the backend POST runs second, best-effort.
  // A backend failure is named once per UTC day per signal
  // (coded message through the ingestion log's error channel +
  // one audit event) and never fails the export.
  const transport = createOtelBackendFanOutTransport({
    signal: "metrics",
    env: env as unknown as Record<string, unknown>,
    settings: config.backend,
    archive: archiveTransport,
    onError: (message) => ingestionLog.error(message),
    audit: createOtelBackendAudit(env),
    getRuntimeOverrides: () => cachedOtelRuntimeOverrides(),
  });
  // The Analytics Engine sink (the store): the metrics export
  // writes one event per series through the EXISTING sink.
  // S7 (#5086): no explicit destinations (per-write runtime
  // resolution, as above).
  const storeSink = createObservabilitySink(env);
  const { provider, meter } = createOtelMeterProvider({
    config,
    transport,
    sink: storeSink,
  });
  const gate = createOtelMetricsGate(config, {
    getRuntimeOverrides: () => cachedOtelRuntimeOverrides(),
  });
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
      // S7 (#5086): stale-while-revalidate — kick off a
      // TTL-guarded cache refresh, then read the cache as it
      // stands. The domain on/off flip applies per call; the
      // master switch is init-time.
      void refreshOtelRuntimeOverrideCache(otelConfigD1FromEnv(env));
      if (!config.masterEnabled) return false;
      const base = config.domains[domain];
      if (!base) return false;
      return effectiveOtelDomainSwitches(domain, base, cachedOtelRuntimeOverrides()).enabled;
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
