/**
 * Issue #5081 (S1, observability program #5080) + #5138
 * (destination switches) — the port for the OpenTelemetry
 * on/off switches (the five-level mechanism).
 *
 * Five levels, all externalized (config/otel.json + env vars),
 * following the PAYMENTS_FLOW_MODE resolver pattern
 * (src/config/paymentsFlowModes.ts):
 *  1. GLOBAL MASTER — OTEL_ENABLED / OTEL_SDK_DISABLED (the OTel
 *     standard kill switch). Master off = nothing emitted,
 *     nothing exported, no cost.
 *  2. PER-SIGNAL — OTEL_LOGS_EXPORTER / OTEL_METRICS_EXPORTER /
 *     OTEL_TRACES_EXPORTER (otlp | console | none). 'none' turns
 *     that signal off globally. S1 is logs only; the others are
 *     resolved (wired) for S2/S3.
 *  3. PER-DOMAIN — OTEL_DOMAIN_<DOMAIN>_ENABLED / config map
 *     otel.domains.<domain>.enabled. J1-J7 is ON; every other
 *     domain is OFF by default.
 *  4. PER-DOMAIN LEVEL + SAMPLING — the log level
 *     (ALL/ERROR/DEBUG/INFO/WARN/TRACE/OFF) and the sampling
 *     ratio per domain, both config values. Level OFF = that
 *     domain emits nothing.
 *  5. PER-DESTINATION (#5138) — OTEL_DESTINATION_<NAME>_ENABLED /
 *     config map otel.destinations.<name>. One switch per
 *     destination: analyticsEngine (the Analytics Engine sink),
 *     r2 (the OTLP export to R2), console (the console sink).
 *     Each is individually on/off; invalid fails closed to OFF.
 *     The config-file defaults are all ON (preserving the
 *     current behavior); the built-in safe default is OFF.
 *
 * Workers Logs is NOT a level here: it is deploy-time only
 * (wrangler.jsonc observability.enabled). The Worker cannot
 * flip the Cloudflare platform log pipeline at runtime, so no
 * resolver exists for it — see config/otel.json's comment and
 * docs/OBSERVABILITY.md §6.
 *
 * RESOLUTION, in this order: run > session > user > env >
 * config-file > built-in safe default. The config file
 * (config/otel.json) carries the OPERATIONAL defaults (master
 * ON, logs=otlp, j1j7 ON, others OFF); the built-in safe
 * default (used only when the file is missing or a value is
 * invalid) is all OFF / none / 0. The FIRST non-blank level
 * wins; if that value is unrecognized, the resolution FAILS
 * CLOSED to the safe default (invalid=true, source = the
 * winning level) and does NOT fall through to a lower level.
 * Callers must log the coded OBS-1001 message on invalid.
 *
 * Carriers: run = the per-run value on the execution context
 * (set by the execution owner for that run); session / user =
 * the optional scoped carriers on the execution context
 * (populated by the execution-context owner); env = the Worker
 * env var; file = the config-file value. A blank/unset level
 * falls through to the next level.
 *
 * SECURITY — why run is NOT request input (the #1735 guard):
 * these switches govern whether telemetry is emitted and where
 * it goes. A request-supplied run value would let a caller flip
 * their own execution's telemetry off (hiding their actions)
 * or on (flooding the store) — a caller disabling their own
 * enforcement/observation, which the standing guard forbids.
 * The run/session/user carriers are execution-owner-set only;
 * request input is ignored. The same guard applies to the
 * session/user carriers: they are populated by the
 * execution-context owner, never by the request caller.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. The run/session/user carriers are honored
 * in resolution order and unit-pinned, but in production today
 * only env + the config file are settable — the same boundary
 * as #1721/#1722/#1723/#1724/#1727/#1728, whose route-ctx
 * carriers are populated by no production caller yet. A
 * runtime flip WITHOUT a redeploy (switches stored in KV/D1,
 * read by the Worker at runtime, manageable through an admin
 * UI) is a LATER slice (S7 config + S8 dashboard); the config
 * port here is designed so the runtime store can replace the
 * env/config-file source later without touching domain code.
 * The audit-store routing for config-invalid events lands with
 * S5 (the audit slice), which owns the audit store — S1 logs
 * the coded OBS-1001 message and does not write a second audit
 * path (the telemetry taxonomy's one-audit-store rule).
 *
 * Pure module: no Cloudflare imports, no I/O, no network — the
 * port is the resolver, and the OTel composition root consumes
 * it. The resolver is a pure function of its levels: no module
 * state, so two runs resolving different switches can never
 * confuse each other through shared mutable state.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { OBS_CONFIG_INVALID, formatOtelMessage } from "../observability/otelMessages";
import rawOtelConfig from "../../config/otel.json";

/**
 * Issue #5081 — module logger on the S1 structured-logging seam.
 *
 * LAZY (created on first use, never at module top level):
 * src/observability/createObservabilityPorts.ts imports the
 * destination resolver from this module, so this module's
 * top-level evaluation must not call createObservabilitySink —
 * the sink reads OTEL_FILE_CONFIG, a const declared below,
 * which is still in its temporal dead zone during this
 * module's evaluation. A lazy logger keeps the import cycle
 * safe: by the time logInvalid first runs (at runtime, after
 * all modules are loaded), OTEL_FILE_CONFIG is initialized.
 */
let structuredLogCache: ReturnType<typeof createStructuredLogger> | null = null;
function getStructuredLog(): ReturnType<typeof createStructuredLogger> {
  if (!structuredLogCache) {
    structuredLogCache = createStructuredLogger(createObservabilitySink({}), {
      component: "config/otelModes",
    });
  }
  return structuredLogCache;
}

/** The domains OTel can be enabled for, one at a time. */
export type OtelDomain =
  | "j1j7"
  | "stock-copilot"
  | "iaaa"
  | "mcp-a2a"
  | "scheduler"
  | "payments"
  | "market-data"
  | "platform";

export const OTEL_DOMAINS: readonly OtelDomain[] = [
  "j1j7",
  "stock-copilot",
  "iaaa",
  "mcp-a2a",
  "scheduler",
  "payments",
  "market-data",
  "platform",
] as const;

/** The three OTel signals. S1 is logs only; metrics/traces are wired for S2/S3. */
export type OtelSignal = "logs" | "metrics" | "traces";

/** Issue #5138 — the three observability destinations, each individually switchable. */
export type OtelDestination = "analyticsEngine" | "r2" | "console";

export const OTEL_DESTINATIONS: readonly OtelDestination[] = [
  "analyticsEngine",
  "r2",
  "console",
] as const;

/** The env-var name for one destination's switch. */
export function otelDestinationEnvName(destination: OtelDestination): string {
  if (destination === "analyticsEngine") return "OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED";
  if (destination === "r2") return "OTEL_DESTINATION_R2_ENABLED";
  return "OTEL_DESTINATION_CONSOLE_ENABLED";
}

/** The per-signal exporter kinds (the OTel standard env-var values). */
export type OtelExporterKind = "otlp" | "console" | "none";

/** The per-domain log-level vocabulary (the config value). */
export type OtelLevel = "ALL" | "ERROR" | "DEBUG" | "INFO" | "WARN" | "TRACE" | "OFF";

/** One domain's config-file entry (enabled + level + sampling). */
export interface OtelDomainFileConfig {
  enabled: boolean;
  level: OtelLevel;
  samplingRatio: number;
}

/** The config-file shape (config/otel.json). */
export interface OtelFileConfig {
  enabled: boolean;
  logsExporter: OtelExporterKind;
  metricsExporter: OtelExporterKind;
  tracesExporter: OtelExporterKind;
  ingestion: {
    route: string;
    /** Issue #5082 (S2) — the metrics ingestion route. */
    metricsRoute: string;
    r2Prefix: string;
    r2ContentType: string;
  };
  batch: {
    maxBatchSize: number;
    scheduledDelayMs: number;
    maxQueueSize: number;
  };
  domains: Record<OtelDomain, OtelDomainFileConfig>;
  /** Issue #5138 — one switch per destination (all ON in the file). */
  destinations: Record<OtelDestination, boolean>;
  /** Issue #5082 (S2) — the metrics settings (all config values, externalized). */
  metrics: OtelMetricsFileConfig;
  /** Issue #5169 — the archive browser settings (all config values, externalized). */
  archive: OtelArchiveFileConfig;
}

/** One archive section in the config file (config/otel.json). */
export interface OtelArchiveFileConfig {
  pageSize: number;
  maxObjects: number;
}

/** The resolved archive settings (the operational values the archive list consumes). */
export interface OtelArchiveSettings {
  pageSize: number;
  maxObjects: number;
}

/**
 * Issue #5169 — the BUILTIN safe defaults for the archive
 * settings (used only when the file is missing or a value is
 * invalid). These are the LOW-VOLUME defaults: 50 objects per
 * page, 500 max per page — the list route can never return an
 * unbounded list. An invalid value fails closed to these, never
 * to a value that would flood the caller or R2.
 */
export const OTEL_ARCHIVE_SETTINGS_BUILTIN: OtelArchiveSettings = {
  pageSize: 50,
  maxObjects: 500,
} as const;

/** One metrics section in the config file (config/otel.json). */
export interface OtelMetricsFileConfig {
  exportIntervalMs: number;
  freeTier: {
    dailyWriteLimit: number;
    dailyReadQueryLimit: number;
  };
  health: {
    pipelineMaxFailureRate: number;
  };
  slo: {
    resourceRowsReadMaxPct: number;
  };
}

/** The resolved metrics settings (the operational values the metrics stack consumes). */
export interface OtelMetricsSettings {
  exportIntervalMs: number;
  freeTierDailyWriteLimit: number;
  freeTierDailyReadQueryLimit: number;
  healthPipelineMaxFailureRate: number;
  sloResourceRowsReadMaxPct: number;
}

/**
 * Issue #5082 (S2) — the BUILTIN safe defaults for the metrics
 * settings (used only when the file is missing or a value is
 * invalid). These are the LOW-VOLUME defaults: a 5-minute
 * export interval (few writes), the real free-tier limits
 * (100k writes/day, 10k read queries/day), a 5% max failure
 * rate, a 70% SLO max pct. An invalid value fails closed to
 * these, never to a value that would flood the store.
 */
export const OTEL_METRICS_SETTINGS_BUILTIN: OtelMetricsSettings = {
  exportIntervalMs: 300000,
  freeTierDailyWriteLimit: 100000,
  freeTierDailyReadQueryLimit: 10000,
  healthPipelineMaxFailureRate: 0.05,
  sloResourceRowsReadMaxPct: 0.7,
} as const;

/** The parsed config file (the operational defaults). */
export const OTEL_FILE_CONFIG: OtelFileConfig = rawOtelConfig as OtelFileConfig;

/** One level set of the resolution order. Blank/unset falls through. */
export interface OtelScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
  file?: unknown;
}

/** Which level won the resolution, or "builtin" when every level was blank. */
export type OtelResolutionSource = "run" | "session" | "user" | "env" | "file" | "builtin";

/** The coded event emitted when a switch value fails closed. */
export function otelConfigErrorEvent(): string {
  return "otel.config.invalid";
}

function logInvalid(
  switchName: string,
  source: OtelResolutionSource,
  value: unknown,
  fallback: string,
): void {
  getStructuredLog().warn(otelConfigErrorEvent(), {
    message: formatOtelMessage(
      OBS_CONFIG_INVALID,
      `${switchName} unrecognized value at ${source}; failing closed to "${fallback}"`,
    ),
    code: OBS_CONFIG_INVALID,
    switch: switchName,
    level: source,
    raw: typeof value === "string" ? value : undefined,
  });
}

function normalizeBoolean(raw: unknown): boolean | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  // The config file carries native booleans; env vars carry strings.
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  return "invalid";
}

function normalizeExporter(raw: unknown): OtelExporterKind | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "otlp" || normalized === "otlp-http" || normalized === "http") return "otlp";
  if (normalized === "console") return "console";
  if (normalized === "none") return "none";
  return "invalid";
}

function normalizeLevel(raw: unknown): OtelLevel | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toUpperCase();
  if (!normalized) return null;
  if (
    normalized === "ALL" ||
    normalized === "ERROR" ||
    normalized === "DEBUG" ||
    normalized === "INFO" ||
    normalized === "WARN" ||
    normalized === "TRACE" ||
    normalized === "OFF"
  ) {
    return normalized;
  }
  return "invalid";
}

function normalizeSampling(raw: unknown): number | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (typeof raw === "string" && !raw.trim()) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) return "invalid";
  return value;
}

/**
 * Issue #5082 (S2) — normalizes a positive integer (the metrics
 * export interval). Must be a finite integer > 0; a non-positive
 * or non-numeric value is invalid (a 0 interval would spin the
 * exporter without pause and flood the store).
 */
function normalizePositiveInt(raw: unknown): number | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (typeof raw === "string" && !raw.trim()) return null;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return "invalid";
  return value;
}

/**
 * Issue #5082 (S2) — normalizes a non-negative integer (the
 * free-tier daily limits). 0 is valid (it disables that path —
 * a 0 write limit means no Analytics Engine writes, while the
 * OTLP/R2 archive path still runs); a negative or non-numeric
 * value is invalid.
 */
function normalizeNonNegativeInt(raw: unknown): number | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (typeof raw === "string" && !raw.trim()) return null;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return "invalid";
  return value;
}

/**
 * Issue #5082 (S2) — normalizes a ratio in [0, 1] (the health
 * max failure rate, the SLO max pct). A value outside [0, 1]
 * or non-numeric is invalid.
 */
function normalizeRatio(raw: unknown): number | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (typeof raw === "string" && !raw.trim()) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) return "invalid";
  return value;
}

type LevelEntry = [OtelResolutionSource, unknown];
function orderedLevels(levels: OtelScopeLevels): LevelEntry[] {
  return [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
    ["file", levels.file],
  ];
}

/** The config-file default for a domain's enabled flag (j1j7 ON, all others OFF). */
export function otelDomainEnabledDefault(domain: OtelDomain): boolean {
  return OTEL_FILE_CONFIG.domains[domain]?.enabled ?? false;
}

/** The config-file default exporter for a signal (logs=otlp, metrics/traces=none). */
export function otelSignalExporterDefault(signal: OtelSignal): OtelExporterKind {
  if (signal === "logs") return OTEL_FILE_CONFIG.logsExporter;
  if (signal === "metrics") return OTEL_FILE_CONFIG.metricsExporter;
  return OTEL_FILE_CONFIG.tracesExporter;
}

/** Issue #5138 — the config-file default for a destination (all ON in the file). */
export function otelDestinationEnabledDefault(destination: OtelDestination): boolean {
  return OTEL_FILE_CONFIG.destinations[destination] ?? true;
}

export interface ResolvedOtelDestinationEnabled {
  enabled: boolean;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  source: OtelResolutionSource;
}

/**
 * Issue #5138 — resolves one destination's enabled flag over
 * run > session > user > env > file > builtin (OFF). First
 * non-blank level wins; an unrecognized winning value fails
 * closed to OFF with invalid=true and no fall-through.
 */
export function resolveOtelDestinationEnabled(
  destination: OtelDestination,
  levels: OtelScopeLevels,
): ResolvedOtelDestinationEnabled {
  const switchName = otelDestinationEnvName(destination);
  for (const [source, value] of orderedLevels(levels)) {
    const normalized = normalizeBoolean(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      logInvalid(switchName, source, value, "OFF");
      return {
        enabled: false,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        source,
      };
    }
    return {
      enabled: normalized,
      invalid: false,
      raw: typeof value === "string" ? value : undefined,
      source,
    };
  }
  return { enabled: false, invalid: false, raw: undefined, source: "builtin" };
}

export interface ResolvedOtelMaster {
  enabled: boolean;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  source: OtelResolutionSource;
}

/**
 * Resolves the OTel global master over run > session > user >
 * env > file > builtin (OFF). First non-blank level wins; an
 * unrecognized winning value fails closed to OFF with
 * invalid=true and no fall-through to lower levels.
 */
export function resolveOtelMaster(levels: OtelScopeLevels): ResolvedOtelMaster {
  for (const [source, value] of orderedLevels(levels)) {
    const normalized = normalizeBoolean(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      logInvalid("OTEL_ENABLED", source, value, "OFF");
      return {
        enabled: false,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        source,
      };
    }
    return {
      enabled: normalized,
      invalid: false,
      raw: typeof value === "string" ? value : undefined,
      source,
    };
  }
  return { enabled: false, invalid: false, raw: undefined, source: "builtin" };
}

export interface ResolvedOtelSignalExporter {
  exporter: OtelExporterKind;
  invalid: boolean;
  raw?: string;
  source: OtelResolutionSource;
}

/**
 * Resolves one signal's exporter over run > session > user >
 * env > file > builtin (none). First non-blank level wins; an
 * unrecognized winning value fails closed to "none" with
 * invalid=true and no fall-through.
 */
export function resolveOtelSignalExporter(
  signal: OtelSignal,
  levels: OtelScopeLevels,
): ResolvedOtelSignalExporter {
  const switchName =
    signal === "logs"
      ? "OTEL_LOGS_EXPORTER"
      : signal === "metrics"
        ? "OTEL_METRICS_EXPORTER"
        : "OTEL_TRACES_EXPORTER";
  for (const [source, value] of orderedLevels(levels)) {
    const normalized = normalizeExporter(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      logInvalid(switchName, source, value, "none");
      return {
        exporter: "none",
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        source,
      };
    }
    return {
      exporter: normalized,
      invalid: false,
      raw: typeof value === "string" ? value : undefined,
      source,
    };
  }
  return { exporter: "none", invalid: false, raw: undefined, source: "builtin" };
}

export interface ResolvedOtelDomainEnabled {
  enabled: boolean;
  invalid: boolean;
  raw?: string;
  source: OtelResolutionSource;
}

/**
 * Resolves one domain's enabled flag over run > session > user
 * > env > file > builtin (OFF). First non-blank level wins;
 * an unrecognized winning value fails closed to OFF with
 * invalid=true and no fall-through.
 */
export function resolveOtelDomainEnabled(
  domain: OtelDomain,
  levels: OtelScopeLevels,
): ResolvedOtelDomainEnabled {
  const switchName = `OTEL_DOMAIN_${domain.toUpperCase().replace(/-/g, "_")}_ENABLED`;
  for (const [source, value] of orderedLevels(levels)) {
    const normalized = normalizeBoolean(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      logInvalid(switchName, source, value, "OFF");
      return {
        enabled: false,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        source,
      };
    }
    return {
      enabled: normalized,
      invalid: false,
      raw: typeof value === "string" ? value : undefined,
      source,
    };
  }
  return { enabled: false, invalid: false, raw: undefined, source: "builtin" };
}

export interface ResolvedOtelDomainLevel {
  level: OtelLevel;
  invalid: boolean;
  raw?: string;
  source: OtelResolutionSource;
}

/**
 * Resolves one domain's log level over run > session > user >
 * env > file > builtin (OFF). First non-blank level wins; an
 * unrecognized winning value fails closed to OFF with
 * invalid=true and no fall-through.
 */
export function resolveOtelDomainLevel(
  domain: OtelDomain,
  levels: OtelScopeLevels,
): ResolvedOtelDomainLevel {
  const switchName = `OTEL_DOMAIN_${domain.toUpperCase().replace(/-/g, "_")}_LEVEL`;
  for (const [source, value] of orderedLevels(levels)) {
    const normalized = normalizeLevel(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      logInvalid(switchName, source, value, "OFF");
      return {
        level: "OFF",
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        source,
      };
    }
    return {
      level: normalized,
      invalid: false,
      raw: typeof value === "string" ? value : undefined,
      source,
    };
  }
  return { level: "OFF", invalid: false, raw: undefined, source: "builtin" };
}

export interface ResolvedOtelDomainSampling {
  ratio: number;
  invalid: boolean;
  raw?: string;
  source: OtelResolutionSource;
}

/**
 * Resolves one domain's sampling ratio over run > session >
 * user > env > file > builtin (0). First non-blank level wins;
 * a non-numeric or out-of-range winning value fails closed to
 * 0 with invalid=true and no fall-through.
 */
export function resolveOtelDomainSampling(
  domain: OtelDomain,
  levels: OtelScopeLevels,
): ResolvedOtelDomainSampling {
  const switchName = `OTEL_DOMAIN_${domain.toUpperCase().replace(/-/g, "_")}_SAMPLING`;
  for (const [source, value] of orderedLevels(levels)) {
    const normalized = normalizeSampling(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      logInvalid(switchName, source, value, "0");
      return {
        ratio: 0,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        source,
      };
    }
    return {
      ratio: normalized,
      invalid: false,
      raw: typeof value === "string" ? value : undefined,
      source,
    };
  }
  return { ratio: 0, invalid: false, raw: undefined, source: "builtin" };
}

export interface OtelMetricsSettingsInput {
  exportIntervalMs: OtelScopeLevels;
  freeTierDailyWriteLimit: OtelScopeLevels;
  freeTierDailyReadQueryLimit: OtelScopeLevels;
  healthPipelineMaxFailureRate: OtelScopeLevels;
  sloResourceRowsReadMaxPct: OtelScopeLevels;
}

export interface ResolvedOtelMetricsSettings {
  settings: OtelMetricsSettings;
  /** True when any setting's winning level held an unrecognized value. */
  invalid: boolean;
}

/**
 * Issue #5082 (S2) — resolves the metrics settings over run >
 * session > user > env > file > builtin (the safe defaults).
 * Each setting resolves independently through the same
 * five-level mechanism; an unrecognized winning value for a
 * setting fails closed to that setting's builtin safe default
 * with a coded OBS-1001 message and no fall-through.
 * `invalid` is true when any setting failed closed.
 */
export function resolveOtelMetricsSettings(
  input: OtelMetricsSettingsInput,
): ResolvedOtelMetricsSettings {
  let invalid = false;
  const resolveOne = <T>(
    switchName: string,
    levels: OtelScopeLevels,
    normalize: (raw: unknown) => T | "invalid" | null,
    builtin: T,
  ): T => {
    for (const [source, value] of orderedLevels(levels)) {
      const normalized = normalize(value);
      if (normalized === null) continue;
      if (normalized === "invalid") {
        logInvalid(switchName, source, value, String(builtin));
        invalid = true;
        return builtin;
      }
      return normalized;
    }
    return builtin;
  };
  return {
    settings: {
      exportIntervalMs: resolveOne(
        "OTEL_METRICS_EXPORT_INTERVAL_MS",
        input.exportIntervalMs,
        normalizePositiveInt,
        OTEL_METRICS_SETTINGS_BUILTIN.exportIntervalMs,
      ),
      freeTierDailyWriteLimit: resolveOne(
        "OTEL_METRICS_FREE_TIER_DAILY_WRITE_LIMIT",
        input.freeTierDailyWriteLimit,
        normalizeNonNegativeInt,
        OTEL_METRICS_SETTINGS_BUILTIN.freeTierDailyWriteLimit,
      ),
      freeTierDailyReadQueryLimit: resolveOne(
        "OTEL_METRICS_FREE_TIER_DAILY_READ_QUERY_LIMIT",
        input.freeTierDailyReadQueryLimit,
        normalizeNonNegativeInt,
        OTEL_METRICS_SETTINGS_BUILTIN.freeTierDailyReadQueryLimit,
      ),
      healthPipelineMaxFailureRate: resolveOne(
        "OTEL_METRICS_HEALTH_PIPELINE_MAX_FAILURE_RATE",
        input.healthPipelineMaxFailureRate,
        normalizeRatio,
        OTEL_METRICS_SETTINGS_BUILTIN.healthPipelineMaxFailureRate,
      ),
      sloResourceRowsReadMaxPct: resolveOne(
        "OTEL_METRICS_SLO_RESOURCE_ROWS_READ_MAX_PCT",
        input.sloResourceRowsReadMaxPct,
        normalizeRatio,
        OTEL_METRICS_SETTINGS_BUILTIN.sloResourceRowsReadMaxPct,
      ),
    },
    invalid,
  };
}

export interface OtelArchiveSettingsInput {
  pageSize: OtelScopeLevels;
  maxObjects: OtelScopeLevels;
}

export interface ResolvedOtelArchiveSettings {
  settings: OtelArchiveSettings;
  /** True when any setting's winning level held an unrecognized value. */
  invalid: boolean;
}

/**
 * Issue #5169 — resolves the archive settings over run >
 * session > user > env > file > builtin (the safe defaults).
 * Each setting resolves independently through the same
 * five-level mechanism; an unrecognized winning value for a
 * setting fails closed to that setting's builtin safe default
 * with a coded OBS-1001 message and no fall-through.
 * `invalid` is true when any setting failed closed.
 */
export function resolveOtelArchiveSettings(
  input: OtelArchiveSettingsInput,
): ResolvedOtelArchiveSettings {
  let invalid = false;
  const resolveOne = <T>(
    switchName: string,
    levels: OtelScopeLevels,
    normalize: (raw: unknown) => T | "invalid" | null,
    builtin: T,
  ): T => {
    for (const [source, value] of orderedLevels(levels)) {
      const normalized = normalize(value);
      if (normalized === null) continue;
      if (normalized === "invalid") {
        logInvalid(switchName, source, value, String(builtin));
        invalid = true;
        return builtin;
      }
      return normalized;
    }
    return builtin;
  };
  return {
    settings: {
      pageSize: resolveOne(
        "OTEL_ARCHIVE_PAGE_SIZE",
        input.pageSize,
        normalizePositiveInt,
        OTEL_ARCHIVE_SETTINGS_BUILTIN.pageSize,
      ),
      maxObjects: resolveOne(
        "OTEL_ARCHIVE_MAX_OBJECTS",
        input.maxObjects,
        normalizePositiveInt,
        OTEL_ARCHIVE_SETTINGS_BUILTIN.maxObjects,
      ),
    },
    invalid,
  };
}

/**
 * Resolves the OTel standard kill switch OTEL_SDK_DISABLED
 * ("true" disables the SDK entirely). This is the one switch
 * that is NOT resolved through the run/session/user levels: it
 * is the operator's global kill switch, read from env only.
 * Returns true when the SDK must be a no-op.
 */
export function otelSdkDisabled(envValue: unknown): boolean {
  const normalized = normalizeBoolean(envValue);
  return normalized === true;
}
