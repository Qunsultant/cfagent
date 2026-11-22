/**
 * Issue #5081 (S1, observability program #5080) — the OTel
 * composition root: builds the OTel logging stack from env.
 *
 * This is the ONE place that turns env + the config file into a
 * live OTel LoggerProvider, sink, and gate. Domain code never
 * builds an OTel provider itself; hosts call createOtelLogging
 * once and pass the handle to the observers.
 *
 * Resolution (the otelModes port): run > session > user >
 * runtime > config-file > built-in safe default. The runtime
 * level (S7, #5086) is the platform admin's override from the
 * config port (D1 otel_config_overrides, read through the
 * override cache): resolveOtelLoggingConfig consults the cache
 * at init, the domain gate consults it per event, and
 * isDomainEnabled consults it per call (kicking off a
 * TTL-guarded background refresh, so a flip propagates to a
 * long-lived isolate). The master / exporter / batch switches
 * are read at init, so a flip there applies at the next init;
 * a domain on/off, level, or sampling flip applies on the
 * next event. The base sink's destinations flip per write
 * (see createObservabilityPorts).
 *
 * The transport is the in-process ingestion handler: the OTel
 * exporter hands OTLP/JSON to handleOtelLogsIngestion, which
 * writes one JSONL object per batch to R2 (REPORTS_BUCKET,
 * otel-archive/ prefix) or falls back to console when R2 is
 * unbound. No HTTP self-fetch (the 522 rule), no Collector, no
 * SigNoz, no D1 for telemetry.
 *
 * The J1–J7 observers' logger writes to a FAN-OUT sink: the
 * base sink (Analytics Engine / console, as today) AND the OTel
 * sink (gated by domain). The J1–J7 logs therefore appear in
 * the normal observability stream AND in the OTel archive. The
 * fan-out never throws (the structured logger's contract).
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
  resolveOtelSignalExporter,
  type OtelDestination,
  type OtelDomain,
  type OtelScopeLevels,
} from "../config/otelModes";
import { createOtelBackendAudit, createOtelBackendFanOutTransport } from "./otelBackend";
import {
  cachedOtelRuntimeOverrides,
  otelConfigD1FromEnv,
  otelRuntimeLevel,
  otelRuntimeLevelByEnvName,
  refreshOtelRuntimeOverrideCache,
} from "../config/otelConfigPort";
import {
  createOtelDomainGate,
  createOtelLoggerProvider,
  createOtelObservabilitySink,
  type OtelLoggingConfig,
  type OtelTransport,
} from "./otelLogs";
import { createOtelIngestionLog, handleOtelLogsIngestion } from "./otelIngestion";
import { createBlobStore } from "../services/blobStoreR2Adapter";
import { createStructuredLogger, type StructuredLogger } from "./structuredLogger";
import { createObservabilitySink } from "./createObservabilityPorts";
import type { ObservabilitySink } from "./observabilityPorts";

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
 * Resolves the full OTel logging config from env + the config
 * file. OTEL_SDK_DISABLED=true (the standard kill switch)
 * forces the master OFF regardless of OTEL_ENABLED.
 */
export function resolveOtelLoggingConfig(
  env: Record<string, unknown>,
  scoped?: { run?: unknown; session?: unknown; user?: unknown },
): OtelLoggingConfig {
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
  const logsExporter = resolveOtelSignalExporter(
    "logs",
    levelsFor("OTEL_LOGS_EXPORTER", OTEL_FILE_CONFIG.logsExporter),
  ).exporter;
  const domains = {} as Record<OtelDomain, OtelLoggingConfig["domains"][OtelDomain]>;
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
  // over the config-file value, built-in safe default OFF). The R2 switch
  // gates the OTel transport below; the AE/console switches gate the base
  // sink (createObservabilitySink) that the host passes the resolved values to.
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
  return { masterEnabled, logsExporter, domains, destinations, backend };
}

/** A sink that fans out to every sink in order, never throwing. */
export function createFanOutSink(sinks: readonly ObservabilitySink[]): ObservabilitySink {
  return {
    write: (event) => {
      for (const sink of sinks) {
        try {
          const result = sink.write(event);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch(() => {
              // A sink's async failure never fails the log call.
            });
          }
        } catch {
          // A sink's sync failure never fails the log call.
        }
      }
    },
    writeBatch: (events) => {
      for (const event of events) {
        for (const sink of sinks) {
          try {
            const result = sink.write(event);
            if (result && typeof (result as Promise<void>).catch === "function") {
              (result as Promise<void>).catch(() => undefined);
            }
          } catch {
            // Never throws.
          }
        }
      }
    },
  };
}

export interface OtelLoggingHandle {
  config: OtelLoggingConfig;
  /** The OTel sink (gated); null when the master is OFF or the logs exporter is none. */
  sink: ObservabilitySink | null;
  /** The per-domain gate (the AOP aspect). */
  gate: (event: Parameters<ReturnType<typeof createOtelDomainGate>>[0]) => boolean;
  /** True only when the named domain is ON (master + domain switch). */
  isDomainEnabled: (domain: OtelDomain) => boolean;
  /** Flushes the OTel batch (call at run/settle boundaries). */
  flush: () => Promise<void>;
  /** Shuts the OTel provider down (isolate teardown). */
  shutdown: () => Promise<void>;
}

/**
 * Builds the OTel logging stack from env. Call once per host
 * (the host caches the handle with its control). The provider
 * uses the batch processor (amortized R2 writes) and flushes
 * explicitly at run/settle boundaries via handle.flush().
 */
export function createOtelLogging(env: Env): OtelLoggingHandle {
  const config = resolveOtelLoggingConfig(env as unknown as Record<string, unknown>);
  // Issue #5138 — R2 off means no R2 write: the transport passes a
  // null blob store, so ingestion falls back to the structured log
  // (which itself respects the console switch through the base sink).
  const blobStore = config.destinations.r2 ? createBlobStore(env) : null;
  // The ingestion fallback writes through the structured logger
  // over the BASE sink only (never the OTel sink — a fallback
  // record must not re-enter the OTel pipeline). S7 (#5086):
  // no explicit destinations — the sink resolves them per
  // write from env/file + the runtime override cache, so a
  // destination flip applies without a redeploy.
  const ingestionLog = createOtelIngestionLog(
    createStructuredLogger(createObservabilitySink(env), { component: "otel-ingestion" }),
  );
  const archiveTransport: OtelTransport = async (body) => {
    const result = await handleOtelLogsIngestion({ body, blobStore, log: ingestionLog });
    return { status: result.status };
  };
  // Issue #5164 (S10) — the Grafana Cloud backend leg: the
  // archive transport above runs first (its status is what the
  // exporter sees); the backend POST runs second, best-effort.
  // A backend failure is named once per UTC day per signal
  // (coded message through the ingestion log's error channel +
  // one audit event) and never fails the export.
  const transport = createOtelBackendFanOutTransport({
    signal: "logs",
    env: env as unknown as Record<string, unknown>,
    settings: config.backend,
    archive: archiveTransport,
    onError: (message) => ingestionLog.error(message),
    audit: createOtelBackendAudit(env),
    getRuntimeOverrides: () => cachedOtelRuntimeOverrides(),
  });
  // S7 (#5086): the batch settings resolve through the runtime
  // cache (a flip applies at the next provider init).
  const runtimeOverrides = cachedOtelRuntimeOverrides();
  const batchNumber = (key: string, fallback: number): number => {
    const value = otelRuntimeLevel(runtimeOverrides, key);
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const { provider, logger } = createOtelLoggerProvider({
    config,
    transport,
    processor: "batch",
    batch: {
      maxBatchSize: batchNumber("batch.maxBatchSize", OTEL_FILE_CONFIG.batch.maxBatchSize),
      scheduledDelayMs: batchNumber("batch.scheduledDelayMs", OTEL_FILE_CONFIG.batch.scheduledDelayMs),
      maxQueueSize: batchNumber("batch.maxQueueSize", OTEL_FILE_CONFIG.batch.maxQueueSize),
    },
  });
  const gate = createOtelDomainGate(config, undefined, {
    getRuntimeOverrides: () => cachedOtelRuntimeOverrides(),
  });
  const live = config.masterEnabled && config.logsExporter !== "none";
  const sink = live ? createOtelObservabilitySink({ logger, gate }) : null;
  return {
    config,
    sink,
    gate,
    isDomainEnabled: (domain: OtelDomain) => {
      // S7 (#5086): stale-while-revalidate — kick off a
      // TTL-guarded cache refresh so a flip propagates to
      // this (possibly long-lived) isolate, then read the
      // cache as it stands. The domain on/off flip applies
      // per call; the master switch is init-time.
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

/**
 * Builds the structured logger the J1–J7 observers log through:
 * component "job-pipeline", writing to the fan-out of the base
 * sink (Analytics Engine / console) and the OTel sink (gated).
 * When OTel is off, the logger writes to the base sink only.
 */
export function createOtelJobPipelineLogger(env: Env, otel: OtelLoggingHandle): StructuredLogger {
  // S7 (#5086): no explicit destinations — the base sink
  // resolves them per write from env/file + the runtime
  // override cache, so a destination flip applies without a
  // redeploy (the handle's init-time config.destinations is
  // used for the R2 transport switch only).
  const base = createObservabilitySink(env);
  const sinks: ObservabilitySink[] = [base];
  if (otel.sink) sinks.push(otel.sink);
  return createStructuredLogger(createFanOutSink(sinks), {
    component: "job-pipeline",
  });
}
