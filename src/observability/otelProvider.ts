/**
 * Issue #5081 (S1, observability program #5080) — the OTel
 * composition root: builds the OTel logging stack from env.
 *
 * This is the ONE place that turns env + the config file into a
 * live OTel LoggerProvider, sink, and gate. Domain code never
 * builds an OTel provider itself; hosts call createOtelLogging
 * once and pass the handle to the observers.
 *
 * Resolution (the otelModes port): run > session > user > env >
 * config-file > built-in safe default. In production today only
 * env + the config file are settable (the run/session/user
 * carriers are populated by no production caller yet — the same
 * boundary as the payments resolvers). A runtime flip WITHOUT a
 * redeploy (switches stored in KV/D1, read at runtime, managed
 * through an admin UI) is a LATER slice (S7 config + S8
 * dashboard); this composition root is the port the runtime
 * store will replace (the env/config-file source) without
 * touching domain code.
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
  otelSdkDisabled,
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
  return { masterEnabled, logsExporter, domains, destinations };
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
    const result = await handleOtelLogsIngestion({ body, blobStore, log: ingestionLog });
    return { status: result.status };
  };
  const { provider, logger } = createOtelLoggerProvider({
    config,
    transport,
    processor: "batch",
    batch: {
      maxBatchSize: OTEL_FILE_CONFIG.batch.maxBatchSize,
      scheduledDelayMs: OTEL_FILE_CONFIG.batch.scheduledDelayMs,
      maxQueueSize: OTEL_FILE_CONFIG.batch.maxQueueSize,
    },
  });
  const gate = createOtelDomainGate(config);
  const live = config.masterEnabled && config.logsExporter !== "none";
  const sink = live ? createOtelObservabilitySink({ logger, gate }) : null;
  return {
    config,
    sink,
    gate,
    isDomainEnabled: (domain: OtelDomain) => {
      if (!config.masterEnabled) return false;
      return config.domains[domain]?.enabled ?? false;
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
  const base = createObservabilitySink(env, {
    analyticsEngine: otel.config.destinations.analyticsEngine,
    console: otel.config.destinations.console,
  });
  const sinks: ObservabilitySink[] = [base];
  if (otel.sink) sinks.push(otel.sink);
  return createStructuredLogger(createFanOutSink(sinks), {
    component: "job-pipeline",
  });
}
