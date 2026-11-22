/**
 * Issue #5086 (S7, observability program #5080) — the OTel
 * config HTTP routes: the admin surface for the message
 * catalog + the runtime config port.
 *
 *   GET    /api/otel/v1/config — the catalog, the overridable
 *          key allow-list, the current overrides, and the
 *          effective value + winning source for every key.
 *   POST   /api/otel/v1/config — apply one override
 *          { key, value, reason } (a new versioned row).
 *   DELETE /api/otel/v1/config?key=…&reason=… — clear one
 *          override (a tombstone row; the deploy-time value
 *          governs again).
 *
 * Gating follows the IAAA admin pattern exactly (requireAuth →
 * live platform-admin membership, fail-closed): an
 * unauthenticated caller reads 401, a signed-in non-admin
 * reads 403 with a coded OBS-1022 message and a best-effort
 * deny audit record. A write is audited by the config port
 * itself (the attributable record); the route force-refreshes
 * the runtime override cache after a successful write, so the
 * writing isolate applies the flip immediately — other
 * isolates pick it up within the 60s cache TTL or on their
 * next alert/admin request.
 *
 * The handler takes injectable deps (the telemetry-route
 * pattern): tests pass fakes, production wires the real auth,
 * admin, audit, and config port.
 */

import type { Env, SessionData } from "../../types";
import { requireAuth } from "../auth";
import {
  IAAA_AUDIT_POLICY_VERSION,
  type CreateIaaaAuditEventInput,
} from "../../security/iaaaAudit";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { defaultAudit, defaultIsPlatformAdmin } from "./otelArchive";
import {
  OTEL_DESTINATIONS,
  OTEL_DOMAINS,
  OTEL_FILE_CONFIG,
  normalizeOtelBackendProtocol,
  normalizeOtelBoolean,
  normalizeOtelExporter,
  normalizeOtelLevel,
  normalizeOtelNonNegativeInt,
  normalizeOtelPositiveInt,
  normalizeOtelRatio,
  normalizeOtelSampling,
  normalizeOtelString,
  resolveOtelAlertingSettings,
  resolveOtelArchiveSettings,
  resolveOtelBackendSettings,
  resolveOtelDestinationEnabled,
  resolveOtelDomainEnabled,
  resolveOtelDomainLevel,
  resolveOtelDomainSampling,
  resolveOtelMaster,
  resolveOtelMetricsSettings,
  resolveOtelSignalExporter,
  resolveOtelTracesSettings,
  type OtelDestination,
  type OtelDomain,
  type OtelScopeLevels,
} from "../../config/otelModes";
import {
  createOtelConfigPort,
  otelConfigD1FromEnv,
  otelRuntimeLevel,
  otelRuntimeLevelByEnvName,
  otelRuntimeOverrideKeys,
  refreshOtelRuntimeOverrideCache,
  type OtelConfigPort,
  type OtelRuntimeOverrideKind,
  type OtelRuntimeOverrideRecord,
} from "../../config/otelConfigPort";
import {
  OBS_CATALOG,
  OBS_CONFIG_FORBIDDEN,
  formatCatalogMessage,
  resolveCatalogSeverity,
  type ObsSeverity,
} from "../../observability/otelMessages";

/** The OTel config route (one path, three methods). */
export const OTEL_CONFIG_ROUTE = "/api/otel/v1/config" as const;

/** The audit type for a config-route deny (the port audits writes itself). */
export const OTEL_CONFIG_AUDIT_TYPE = "otel.config.read" as const;

export interface OtelConfigRouteDeps {
  requireSession: (request: Request, env: Env) => Promise<SessionData | null>;
  isPlatformAdmin: (session: SessionData, env: Env) => Promise<boolean>;
  audit: (env: Env, input: CreateIaaaAuditEventInput) => Promise<boolean>;
  createConfigPort: (env: Env) => OtelConfigPort;
}

function defaultCreateConfigPort(env: Env): OtelConfigPort {
  return createOtelConfigPort({
    d1: otelConfigD1FromEnv(env),
    audit: async (input) => defaultAudit(env, input),
    tenantId: resolveIaaaTenant(env),
  });
}

const defaultOtelConfigRouteDeps: OtelConfigRouteDeps = {
  requireSession: requireAuth,
  isPlatformAdmin: defaultIsPlatformAdmin,
  audit: defaultAudit,
  createConfigPort: defaultCreateConfigPort,
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The effective value + winning source for one allow-list key.
 * `source` is the level that governed: "runtime" (an override
 * is set), "env" / "file" (deploy-time), "builtin" (the safe
 * default — including when the winning level held an invalid
 * value and failed closed), or "catalog" (a catalog severity
 * with no override).
 */
export interface OtelEffectiveConfigEntry {
  value: unknown;
  source: string;
}

export type OtelEffectiveConfig = Record<string, OtelEffectiveConfigEntry>;

/**
 * Normalizes one raw value through the key's kind (the same
 * normalizers the resolvers use). Returns "invalid" for an
 * unrecognized winning value, null for a blank level.
 */
function normalizeByKind(kind: OtelRuntimeOverrideKind, raw: unknown): unknown {
  switch (kind) {
    case "boolean":
      return normalizeOtelBoolean(raw);
    case "exporter":
      return normalizeOtelExporter(raw);
    case "level":
      return normalizeOtelLevel(raw);
    case "sampling":
      return normalizeOtelSampling(raw);
    case "positiveInt":
      return normalizeOtelPositiveInt(raw);
    case "nonNegativeInt":
      return normalizeOtelNonNegativeInt(raw);
    case "ratio":
      return normalizeOtelRatio(raw);
    case "string":
      return normalizeOtelString(raw);
    case "protocol":
      return normalizeOtelBackendProtocol(raw);
    case "severity": {
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "string") return "invalid";
      const normalized = raw.trim().toLowerCase();
      if (!normalized) return null;
      return ["info", "warning", "error", "critical"].includes(normalized) ? normalized : "invalid";
    }
  }
}

/**
 * The winning source for one settings-family field, from the
 * same levels object the resolver reads: the first non-blank
 * level wins; an unrecognized winning value fails closed to
 * the builtin, so its source is "builtin".
 */
function settingsFieldSource(
  kind: OtelRuntimeOverrideKind,
  levels: OtelScopeLevels,
): string {
  const ordered: Array<[string, unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["runtime", levels.runtime],
    ["env", levels.env],
    ["file", levels.file],
  ];
  for (const [source, value] of ordered) {
    const normalized = normalizeByKind(kind, value);
    if (normalized === null) continue;
    if (normalized === "invalid") return "builtin";
    return source;
  }
  return "builtin";
}

/**
 * Resolves the effective value + winning source for every
 * allow-list key, through the same resolvers the providers
 * use — so what the panel shows is what governs. The runtime
 * level comes from the override map (the cache as it stands);
 * callers refresh the cache first when they need fresh data.
 */
export function buildEffectiveOtelConfig(
  env: Env,
  overrides: Record<string, OtelRuntimeOverrideRecord>,
): OtelEffectiveConfig {
  const envRecord = env as unknown as Record<string, unknown>;
  const levelsFor = (envName: string, fileValue: unknown): OtelScopeLevels => ({
    // The runtime level for this env var (undefined when no
    // override is set for the key behind it).
    runtime: otelRuntimeLevelByEnvName(overrides, envName),
    env: envRecord[envName],
    file: fileValue,
  });
  const effective: OtelEffectiveConfig = {};

  const master = resolveOtelMaster(levelsFor("OTEL_ENABLED", OTEL_FILE_CONFIG.enabled));
  effective.enabled = { value: master.enabled, source: master.source };

  for (const signal of ["logs", "metrics", "traces"] as const) {
    const envName = `OTEL_${signal.toUpperCase()}_EXPORTER`;
    const fileValue =
      signal === "logs"
        ? OTEL_FILE_CONFIG.logsExporter
        : signal === "metrics"
          ? OTEL_FILE_CONFIG.metricsExporter
          : OTEL_FILE_CONFIG.tracesExporter;
    const resolved = resolveOtelSignalExporter(signal, levelsFor(envName, fileValue));
    effective[`${signal}Exporter`] = { value: resolved.exporter, source: resolved.source };
  }

  for (const destination of OTEL_DESTINATIONS) {
    const envName =
      destination === "analyticsEngine"
        ? "OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED"
        : destination === "r2"
          ? "OTEL_DESTINATION_R2_ENABLED"
          : "OTEL_DESTINATION_CONSOLE_ENABLED";
    const resolved = resolveOtelDestinationEnabled(
      destination as OtelDestination,
      levelsFor(envName, OTEL_FILE_CONFIG.destinations[destination]),
    );
    effective[`destinations.${destination}`] = { value: resolved.enabled, source: resolved.source };
  }

  for (const domain of OTEL_DOMAINS) {
    const upper = domain.toUpperCase().replace(/-/g, "_");
    const fileDomain = OTEL_FILE_CONFIG.domains[domain as OtelDomain];
    const enabled = resolveOtelDomainEnabled(
      domain as OtelDomain,
      levelsFor(`OTEL_DOMAIN_${upper}_ENABLED`, fileDomain?.enabled),
    );
    const level = resolveOtelDomainLevel(
      domain as OtelDomain,
      levelsFor(`OTEL_DOMAIN_${upper}_LEVEL`, fileDomain?.level),
    );
    const sampling = resolveOtelDomainSampling(
      domain as OtelDomain,
      levelsFor(`OTEL_DOMAIN_${upper}_SAMPLING`, fileDomain?.samplingRatio),
    );
    effective[`domains.${domain}.enabled`] = { value: enabled.enabled, source: enabled.source };
    effective[`domains.${domain}.level`] = { value: level.level, source: level.source };
    // The allow-list names this key `samplingRatio` (the
    // env var is OTEL_DOMAIN_<D>_SAMPLING); the effective
    // record must use the allow-list's key, not the resolver's
    // field name.
    effective[`domains.${domain}.samplingRatio`] = { value: sampling.ratio, source: sampling.source };
  }

  // Batch: no env level and no resolver — the runtime override
  // wins when set (a positive number), else the file value.
  for (const batchKey of ["maxBatchSize", "maxQueueSize", "scheduledDelayMs"] as const) {
    const override = otelRuntimeLevel(overrides, `batch.${batchKey}`);
    const fileValue = OTEL_FILE_CONFIG.batch[batchKey];
    const validOverride =
      typeof override === "number" && Number.isFinite(override) && override > 0;
    effective[`batch.${batchKey}`] = {
      value: validOverride ? override : fileValue,
      source: validOverride ? "runtime" : "file",
    };
  }

  // Metrics settings (export interval, free-tier limits,
  // health/SLO thresholds) — values from the resolver, sources
  // from the same levels objects.
  const metricsFile = OTEL_FILE_CONFIG.metrics;
  const metricsLevels = {
    exportIntervalMs: levelsFor("OTEL_METRICS_EXPORT_INTERVAL_MS", metricsFile?.exportIntervalMs),
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
  };
  const metricsSettings = resolveOtelMetricsSettings(metricsLevels).settings;
  effective["metrics.exportIntervalMs"] = {
    value: metricsSettings.exportIntervalMs,
    source: settingsFieldSource("positiveInt", metricsLevels.exportIntervalMs),
  };
  effective["metrics.freeTier.dailyWriteLimit"] = {
    value: metricsSettings.freeTierDailyWriteLimit,
    source: settingsFieldSource("nonNegativeInt", metricsLevels.freeTierDailyWriteLimit),
  };
  effective["metrics.freeTier.dailyReadQueryLimit"] = {
    value: metricsSettings.freeTierDailyReadQueryLimit,
    source: settingsFieldSource("nonNegativeInt", metricsLevels.freeTierDailyReadQueryLimit),
  };
  effective["metrics.health.pipelineMaxFailureRate"] = {
    value: metricsSettings.healthPipelineMaxFailureRate,
    source: settingsFieldSource("ratio", metricsLevels.healthPipelineMaxFailureRate),
  };
  effective["metrics.slo.resourceRowsReadMaxPct"] = {
    value: metricsSettings.sloResourceRowsReadMaxPct,
    source: settingsFieldSource("ratio", metricsLevels.sloResourceRowsReadMaxPct),
  };

  // Traces settings (free-tier daily write limit).
  const tracesFile = OTEL_FILE_CONFIG.traces;
  const tracesLevels = {
    freeTierDailyWriteLimit: levelsFor(
      "OTEL_TRACES_FREE_TIER_DAILY_WRITE_LIMIT",
      tracesFile?.freeTier?.dailyWriteLimit,
    ),
  };
  const tracesSettings = resolveOtelTracesSettings(tracesLevels).settings;
  effective["traces.freeTier.dailyWriteLimit"] = {
    value: tracesSettings.freeTierDailyWriteLimit,
    source: settingsFieldSource("nonNegativeInt", tracesLevels.freeTierDailyWriteLimit),
  };

  // Archive settings (list page size, max objects).
  const archiveLevels = {
    pageSize: levelsFor("OTEL_ARCHIVE_PAGE_SIZE", OTEL_FILE_CONFIG.archive?.pageSize),
    maxObjects: levelsFor("OTEL_ARCHIVE_MAX_OBJECTS", OTEL_FILE_CONFIG.archive?.maxObjects),
  };
  const archiveSettings = resolveOtelArchiveSettings(archiveLevels).settings;
  effective["archive.pageSize"] = {
    value: archiveSettings.pageSize,
    source: settingsFieldSource("positiveInt", archiveLevels.pageSize),
  };
  effective["archive.maxObjects"] = {
    value: archiveSettings.maxObjects,
    source: settingsFieldSource("positiveInt", archiveLevels.maxObjects),
  };

  // Alerting settings (master, channels, free-tier guard).
  const alertingLevels = {
    enabled: levelsFor("OTEL_ALERTING_ENABLED", OTEL_FILE_CONFIG.alerting?.enabled),
    slackEnabled: levelsFor("OTEL_ALERTING_SLACK_ENABLED", OTEL_FILE_CONFIG.alerting?.slackEnabled),
    emailEnabled: levelsFor("OTEL_ALERTING_EMAIL_ENABLED", OTEL_FILE_CONFIG.alerting?.emailEnabled),
    maxAlertsPerDay: levelsFor(
      "OTEL_ALERTING_MAX_ALERTS_PER_DAY",
      OTEL_FILE_CONFIG.alerting?.maxAlertsPerDay,
    ),
  };
  const alertingSettings = resolveOtelAlertingSettings(alertingLevels).settings;
  effective["alerting.enabled"] = {
    value: alertingSettings.enabled,
    source: settingsFieldSource("boolean", alertingLevels.enabled),
  };
  effective["alerting.slackEnabled"] = {
    value: alertingSettings.slackEnabled,
    source: settingsFieldSource("boolean", alertingLevels.slackEnabled),
  };
  effective["alerting.emailEnabled"] = {
    value: alertingSettings.emailEnabled,
    source: settingsFieldSource("boolean", alertingLevels.emailEnabled),
  };
  effective["alerting.maxAlertsPerDay"] = {
    value: alertingSettings.maxAlertsPerDay,
    source: settingsFieldSource("positiveInt", alertingLevels.maxAlertsPerDay),
  };

  // Backend settings (the Grafana Cloud switch + request timeout + service name + protocol + endpoint + instance ID).
  const backendFile = OTEL_FILE_CONFIG.backend;
  const backendLevels = {
    enabled: levelsFor("OTEL_BACKEND_ENABLED", backendFile?.enabled),
    requestTimeoutMs: levelsFor(
      "OTEL_BACKEND_REQUEST_TIMEOUT_MS",
      backendFile?.requestTimeoutMs,
    ),
    serviceName: levelsFor("OTEL_SERVICE_NAME", backendFile?.serviceName),
    protocol: levelsFor("OTEL_EXPORTER_OTLP_PROTOCOL", backendFile?.protocol),
    endpoint: levelsFor("OTEL_BACKEND_ENDPOINT", backendFile?.endpoint),
    instanceId: levelsFor("OTEL_BACKEND_INSTANCE_ID", backendFile?.instanceId),
  };
  const backendSettings = resolveOtelBackendSettings(backendLevels).settings;
  effective["backend.enabled"] = {
    value: backendSettings.enabled,
    source: settingsFieldSource("boolean", backendLevels.enabled),
  };
  effective["backend.requestTimeoutMs"] = {
    value: backendSettings.requestTimeoutMs,
    source: settingsFieldSource("positiveInt", backendLevels.requestTimeoutMs),
  };
  effective["backend.serviceName"] = {
    value: backendSettings.serviceName,
    source: settingsFieldSource("string", backendLevels.serviceName),
  };
  effective["backend.protocol"] = {
    value: backendSettings.protocol,
    source: settingsFieldSource("protocol", backendLevels.protocol),
  };
  effective["backend.endpoint"] = {
    value: backendSettings.endpoint,
    source: settingsFieldSource("string", backendLevels.endpoint),
  };
  effective["backend.instanceId"] = {
    value: backendSettings.instanceId,
    source: settingsFieldSource("string", backendLevels.instanceId),
  };

  // Catalog severities: the override wins, else the catalog
  // default. The override map carries the stored severity
  // strings; resolveCatalogSeverity validates them.
  const severityOverrides: Record<string, string> = {};
  for (const record of Object.values(overrides)) {
    if (record.key.startsWith("catalog.") && typeof record.value === "string") {
      severityOverrides[record.key] = record.value;
    }
  }
  for (const entry of Object.values(OBS_CATALOG)) {
    const key = `catalog.${entry.code}.severity`;
    const override = overrides[key];
    effective[key] = {
      value: resolveCatalogSeverity(entry.code, severityOverrides),
      source: override ? "runtime" : "catalog",
    };
  }

  return effective;
}

/** Maps a port failure reason to the route's status: 404 for a clear of nothing set, 503 for a store/audit failure, 400 for a validation failure. */
function portFailureStatus(reason: string): number {
  if (reason.includes("no override set")) return 404;
  if (reason.includes("unbound") || reason.includes("write failed")) return 503;
  return 400;
}

/**
 * The OTel config route handler (the server.ts dispatch shape:
 * returns a Response when the path matches, null to fall
 * through to the next handler).
 */
export async function handleOtelConfigRoutes(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  deps: OtelConfigRouteDeps = defaultOtelConfigRouteDeps,
): Promise<Response | null> {
  if (path !== OTEL_CONFIG_ROUTE) return null;

  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, POST, DELETE" },
    });
  }

  const session = await deps.requireSession(request, env);
  if (!session) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const actor = session.internalUserId ?? session.githubLogin ?? "unknown";
  const auditBase = {
    timestamp: Date.now(),
    type: OTEL_CONFIG_AUDIT_TYPE,
    actorPrincipalId: actor,
    actorType: "human" as const,
    initiatingPrincipalId: actor,
    tenantId: resolveIaaaTenant(env),
    correlationId: crypto.randomUUID(),
    action:
      request.method === "GET"
        ? "observability.config.read"
        : request.method === "POST"
          ? "observability.config.apply"
          : "observability.config.clear",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
  };

  let admin: boolean;
  try {
    admin = await deps.isPlatformAdmin(session, env);
  } catch {
    // The check itself failed — fail closed with 500 (the
    // archive route's precedent), not a 403: the caller was
    // not proven a non-admin, the verdict is unavailable.
    return jsonResponse(500, { error: "the platform-admin check failed" });
  }
  if (!admin) {
    try {
      await deps.audit(env, {
        ...auditBase,
        decision: "deny" as const,
        outcome: "failed" as const,
        errorCode: "OTEL_CONFIG_FORBIDDEN",
      });
    } catch {
      /* denial attribution is best-effort; the deny stands */
    }
    const error = formatCatalogMessage(OBS_CONFIG_FORBIDDEN);
    return jsonResponse(403, { error, code: OBS_CONFIG_FORBIDDEN });
  }

  const port = deps.createConfigPort(env);

  if (request.method === "GET") {
    // TTL-guarded refresh so the panel reads fresh overrides.
    const overrides = await refreshOtelRuntimeOverrideCache(otelConfigD1FromEnv(env));
    const records = Object.values(overrides);
    const catalog = Object.values(OBS_CATALOG).map((entry) => ({
      code: entry.code,
      name: entry.name,
      template: entry.template,
      severity: entry.severity as ObsSeverity,
    }));
    const keys = otelRuntimeOverrideKeys().map((def) => ({
      key: def.key,
      kind: def.kind,
      description: def.description,
      ...(def.envName ? { envName: def.envName } : {}),
    }));
    return jsonResponse(200, {
      catalog,
      keys,
      overrides: records.map((record) => ({
        key: record.key,
        value: record.value,
        version: record.version,
        updatedBy: record.updatedBy,
        updatedAtMs: record.updatedAtMs,
        reason: record.reason,
      })),
      effective: buildEffectiveOtelConfig(env, overrides),
    });
  }

  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      key?: unknown;
      value?: unknown;
      reason?: unknown;
    } | null;
    if (!body || typeof body !== "object" || typeof body.key !== "string") {
      return jsonResponse(400, { error: "a JSON body with { key, value, reason } is required" });
    }
    const result = await port.applyOverride({
      key: body.key,
      value: body.value,
      actor,
      reason: typeof body.reason === "string" ? body.reason : "",
    });
    if (!result.ok) {
      return jsonResponse(portFailureStatus(result.reason), { error: result.reason });
    }
    // Force-refresh the writing isolate's cache: the flip
    // applies here immediately; other isolates within 60s.
    await refreshOtelRuntimeOverrideCache(otelConfigD1FromEnv(env), { force: true });
    return jsonResponse(200, {
      record: {
        key: result.record.key,
        value: result.record.value,
        version: result.record.version,
        updatedBy: result.record.updatedBy,
        updatedAtMs: result.record.updatedAtMs,
        reason: result.record.reason,
      },
    });
  }

  // DELETE — key + reason ride the query string (no body).
  const key = url.searchParams.get("key") ?? "";
  const reason = url.searchParams.get("reason") ?? "";
  if (!key) {
    return jsonResponse(400, { error: "the ?key= query parameter is required" });
  }
  const result = await port.clearOverride({ key, actor, reason });
  if (!result.ok) {
    return jsonResponse(portFailureStatus(result.reason), { error: result.reason });
  }
  await refreshOtelRuntimeOverrideCache(otelConfigD1FromEnv(env), { force: true });
  return jsonResponse(200, { key: result.key });
}
