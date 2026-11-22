/**
 * Issue #5086 (S7, observability program #5080) — the one config
 * port: every OTel threshold, severity, retention, and sampling
 * value lives in config, and the runtime override store lets a
 * platform admin flip a switch without a redeploy.
 *
 * The store is D1 (AGENT_DB, table `otel_config_overrides`,
 * migration 0070): the Worker reads it at runtime through
 * `env.AGENT_DB`, so no redeploy and no new binding are needed.
 * D1 was chosen over KV (no KV namespace is provisioned for
 * this Worker — adding one is an owner provisioning step) and
 * over the DO SQLite settings store (`mas_settings`, which the
 * Worker isolate cannot read directly — DO SQL lives inside a
 * DO, while D1 is reachable from every context that has `env`).
 * See the decision doc
 * docs/architecture/observability/message-catalog-config-port-5086.md.
 *
 * Versioned, auditable, reversible (the #2838 / #2842
 * treatment): the table is APPEND-ONLY and versioned — every
 * change INSERTs a new row (config_key, version) with actor +
 * timestamp + reason, so the full value history is queryable
 * (`readOverrideHistory`); clearing an override INSERTs a
 * tombstone row (value_json NULL), which restores the
 * deploy-time value while preserving history. Every change
 * ALSO writes a `recordAuditEvent` audit event (the
 * attributable record: who changed which key, when, which
 * version); the values themselves ride the versioned rows.
 * Revert = apply an earlier version's value as a new version.
 *
 * Resolution: the `runtime` level in OtelScopeLevels
 * (src/config/otelModes.ts) — run > session > user > runtime >
 * env > file > builtin. The runtime store replaces the
 * deploy-time env/file source at runtime; the execution-owner
 * carriers (run/session/user) still win.
 *
 * Propagation, stated honestly: the override is READ at
 * runtime (no redeploy). It takes effect on the next operation
 * for the alerting port (per alert), the structured-logger sink
 * destinations (per write, through the override cache), and
 * the archive routes (per request). The OTel transport/provider
 * switches (master, exporters, domains, batch, metrics/traces
 * settings) are read at host/control init, so a flip there
 * applies at the next init — except the domain on/off switch,
 * which the domain gates consult per event through the cache.
 * The admin write route force-refreshes the cache, so the
 * writing isolate applies a flip immediately; other isolates
 * pick it up within the cache TTL (60s) or on their next
 * alert/admin request.
 *
 * The port never throws into the caller: a missing D1 binding
 * or a missing table (migration not yet applied) fails closed
 * to empty overrides (the deploy-time values govern).
 */
import {
  normalizeOtelBoolean,
  normalizeOtelExporter,
  normalizeOtelLevel,
  normalizeOtelNonNegativeInt,
  normalizeOtelPositiveInt,
  normalizeOtelRatio,
  normalizeOtelSampling,
  OTEL_DOMAINS,
} from "./otelModes";
import { OBS_CATALOG, OBS_CONFIG_INVALID, type ObsSeverity } from "../observability/otelMessages";
import {
  IAAA_AUDIT_POLICY_VERSION,
  type CreateIaaaAuditEventInput,
} from "../security/iaaaAudit";
import {
  createOtelConfigOverridesStore,
  OTEL_CONFIG_OVERRIDES_TABLE,
  type OtelConfigOverridesD1,
  type OtelConfigOverridesRow,
  type OtelConfigOverridesStore,
} from "../data/otelConfigOverridesStore";

/** The D1 table holding the runtime overrides (migration 0070) — owned by the data-layer store, re-exported here for the migration + tests. */
export { OTEL_CONFIG_OVERRIDES_TABLE };

/** The minimal D1 handle (owned by the data-layer store, re-exported here so existing import sites keep working). */
export type { OtelConfigOverridesD1 as OtelConfigD1 } from "../data/otelConfigOverridesStore";

/** The audit event type for runtime override changes. */
export const OTEL_CONFIG_OVERRIDE_AUDIT_TYPE = "otel.config.runtime_override" as const;

/** The in-isolate override cache TTL (a flip propagates within this window on warm isolates). */
export const OTEL_RUNTIME_OVERRIDE_CACHE_TTL_MS = 60_000;

/** The kinds of values a runtime override can carry (validated by the matching normalizer). */
export type OtelRuntimeOverrideKind =
  | "boolean"
  | "exporter"
  | "level"
  | "sampling"
  | "positiveInt"
  | "nonNegativeInt"
  | "ratio"
  | "severity";

/** One overridable config key: its dotted config path, its value kind, and its env-var name (when one exists). */
export interface OtelRuntimeOverrideKeyDef {
  key: string;
  kind: OtelRuntimeOverrideKind;
  envName?: string;
  description: string;
}

/**
 * The allow-list of overridable config keys. ONE list: a key
 * not on it is rejected at write time and never stored. The
 * per-code severity keys (`catalog.<OBS-code>.severity`) are
 * generated from the catalog itself, so adding a code to the
 * catalog automatically makes its severity overridable — and
 * the admin UI lists keys from this list, so the catalog keys
 * must be IN it, not matched by a pattern elsewhere.
 *
 * LAZY: the list is built on first use, not at module top
 * level. The port sits in the otelModes ↔ observability
 * import cycle (otelModes imports createObservabilitySink,
 * which imports this port, which imports otelModes): a
 * top-level build would read OTEL_DOMAINS while otelModes is
 * still evaluating and throw "OTEL_DOMAINS is not iterable"
 * (caught by tests/otel_config_5081.test.ts). By the time any
 * caller asks for the list, every module has finished
 * evaluating.
 */
let cachedOverrideKeys: readonly OtelRuntimeOverrideKeyDef[] | null = null;

/** The allow-list of overridable config keys (memoized). */
export function otelRuntimeOverrideKeys(): readonly OtelRuntimeOverrideKeyDef[] {
  if (!cachedOverrideKeys) cachedOverrideKeys = buildOverrideKeys();
  return cachedOverrideKeys;
}
function buildOverrideKeys(): OtelRuntimeOverrideKeyDef[] {
  const keys: OtelRuntimeOverrideKeyDef[] = [
    { key: "enabled", kind: "boolean", envName: "OTEL_ENABLED", description: "OTel global master switch" },
    { key: "logsExporter", kind: "exporter", envName: "OTEL_LOGS_EXPORTER", description: "Logs exporter (otlp | console | none)" },
    { key: "metricsExporter", kind: "exporter", envName: "OTEL_METRICS_EXPORTER", description: "Metrics exporter (otlp | console | none)" },
    { key: "tracesExporter", kind: "exporter", envName: "OTEL_TRACES_EXPORTER", description: "Traces exporter (otlp | console | none)" },
    { key: "destinations.analyticsEngine", kind: "boolean", envName: "OTEL_DESTINATION_ANALYTICS_ENGINE_ENABLED", description: "Analytics Engine sink on/off" },
    { key: "destinations.console", kind: "boolean", envName: "OTEL_DESTINATION_CONSOLE_ENABLED", description: "Console sink on/off" },
    { key: "destinations.r2", kind: "boolean", envName: "OTEL_DESTINATION_R2_ENABLED", description: "R2 OTLP export on/off" },
    { key: "batch.maxBatchSize", kind: "positiveInt", description: "OTLP batch max size" },
    { key: "batch.maxQueueSize", kind: "positiveInt", description: "OTLP batch max queue size" },
    { key: "batch.scheduledDelayMs", kind: "positiveInt", description: "OTLP batch scheduled delay (ms)" },
    { key: "metrics.exportIntervalMs", kind: "positiveInt", envName: "OTEL_METRICS_EXPORT_INTERVAL_MS", description: "Metrics export interval (ms)" },
    { key: "metrics.freeTier.dailyWriteLimit", kind: "nonNegativeInt", envName: "OTEL_METRICS_FREE_TIER_DAILY_WRITE_LIMIT", description: "Metrics Analytics Engine daily write limit" },
    { key: "metrics.freeTier.dailyReadQueryLimit", kind: "nonNegativeInt", envName: "OTEL_METRICS_FREE_TIER_DAILY_READ_QUERY_LIMIT", description: "Metrics Analytics Engine daily read-query limit" },
    { key: "metrics.health.pipelineMaxFailureRate", kind: "ratio", envName: "OTEL_METRICS_HEALTH_PIPELINE_MAX_FAILURE_RATE", description: "Pipeline health max failure rate (0-1)" },
    { key: "metrics.slo.resourceRowsReadMaxPct", kind: "ratio", envName: "OTEL_METRICS_SLO_RESOURCE_ROWS_READ_MAX_PCT", description: "Resource rows-read SLO max pct (0-1)" },
    { key: "traces.freeTier.dailyWriteLimit", kind: "nonNegativeInt", envName: "OTEL_TRACES_FREE_TIER_DAILY_WRITE_LIMIT", description: "Traces Analytics Engine daily write limit" },
    { key: "archive.pageSize", kind: "positiveInt", envName: "OTEL_ARCHIVE_PAGE_SIZE", description: "Archive list page size" },
    { key: "archive.maxObjects", kind: "positiveInt", envName: "OTEL_ARCHIVE_MAX_OBJECTS", description: "Archive list max objects" },
    { key: "alerting.enabled", kind: "boolean", envName: "OTEL_ALERTING_ENABLED", description: "Alerting master switch" },
    { key: "alerting.slackEnabled", kind: "boolean", envName: "OTEL_ALERTING_SLACK_ENABLED", description: "Slack alert channel on/off" },
    { key: "alerting.emailEnabled", kind: "boolean", envName: "OTEL_ALERTING_EMAIL_ENABLED", description: "Email alert channel on/off" },
    { key: "alerting.maxAlertsPerDay", kind: "positiveInt", envName: "OTEL_ALERTING_MAX_ALERTS_PER_DAY", description: "Alerting free-tier guard: max alerts per day" },
    { key: "backend.enabled", kind: "boolean", envName: "OTEL_BACKEND_ENABLED", description: "Grafana Cloud backend on/off (the external OTLP destination)" },
    { key: "backend.requestTimeoutMs", kind: "positiveInt", envName: "OTEL_BACKEND_REQUEST_TIMEOUT_MS", description: "Grafana Cloud backend request timeout (ms)" },
  ];
  for (const domain of OTEL_DOMAINS) {
    const upper = domain.toUpperCase().replace(/-/g, "_");
    keys.push(
      { key: `domains.${domain}.enabled`, kind: "boolean", envName: `OTEL_DOMAIN_${upper}_ENABLED`, description: `Domain ${domain} on/off` },
      { key: `domains.${domain}.level`, kind: "level", envName: `OTEL_DOMAIN_${upper}_LEVEL`, description: `Domain ${domain} log level` },
      { key: `domains.${domain}.samplingRatio`, kind: "sampling", envName: `OTEL_DOMAIN_${upper}_SAMPLING`, description: `Domain ${domain} sampling ratio (0-1)` },
    );
  }
  for (const entry of Object.values(OBS_CATALOG)) {
    keys.push({
      key: otelCatalogSeverityOverrideKey(entry.code),
      kind: "severity",
      description: `Catalog severity override for ${entry.code} (${entry.name})`,
    });
  }
  return keys;
}

/** The per-code severity override keys (`catalog.<OBS-code>.severity`) — one per catalog code, generated, not listed. */
export function otelCatalogSeverityOverrideKey(code: string): string {
  return `catalog.${code}.severity`;
}

export function isOtelRuntimeOverrideKey(key: string): boolean {
  return otelRuntimeOverrideKeys().some((def) => def.key === key);
}

export function otelRuntimeOverrideKeyDef(key: string): OtelRuntimeOverrideKeyDef | undefined {
  return otelRuntimeOverrideKeys().find((def) => def.key === key);
}

/**
 * One stored override row. `value` is the parsed value_json;
 * null value_json is a TOMBSTONE (the override was cleared —
 * the deploy-time value governs, and the history is kept).
 */
export interface OtelRuntimeOverrideRecord {
  key: string;
  value: unknown;
  valueJson: string | null;
  version: number;
  updatedBy: string;
  updatedAtMs: number;
  reason: string;
}

export interface OtelConfigPortDeps {
  /** The D1 database (env.AGENT_DB); null = unbound, reads fail closed to empty overrides. */
  d1: OtelConfigOverridesD1 | null;
  /** The audit writer: records the change in the canonical audit store. */
  audit: (input: CreateIaaaAuditEventInput) => Promise<boolean>;
  /** The tenant the change is attributed to (the route resolves it from env). */
  tenantId: string;
  /** Clock override (tests); defaults to Date.now. */
  nowMs?: () => number;
}

export type OtelOverrideApplyResult =
  | { ok: true; record: OtelRuntimeOverrideRecord }
  | { ok: false; reason: string };

export type OtelOverrideClearResult = { ok: true; key: string } | { ok: false; reason: string };

export interface OtelConfigPort {
  readOverrides(): Promise<OtelRuntimeOverrideRecord[]>;
  readOverrideMap(): Promise<Record<string, OtelRuntimeOverrideRecord>>;
  /** The full version history for one key, oldest first (tombstones included, value null). */
  readOverrideHistory(key: string): Promise<OtelRuntimeOverrideRecord[]>;
  applyOverride(input: {
    key: string;
    value: unknown;
    actor: string;
    reason: string;
  }): Promise<OtelOverrideApplyResult>;
  clearOverride(input: { key: string; actor: string; reason: string }): Promise<OtelOverrideClearResult>;
}

function normalizeOverrideValue(
  kind: OtelRuntimeOverrideKind,
  raw: unknown,
): unknown | "invalid" | null {
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
    case "severity": {
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "string") return "invalid";
      const normalized = raw.trim().toLowerCase();
      if (!normalized) return null;
      if (["info", "warning", "error", "critical"].includes(normalized)) {
        return normalized as ObsSeverity;
      }
      return "invalid";
    }
  }
}

function toRecord(row: OtelConfigOverridesRow): OtelRuntimeOverrideRecord {
  let value: unknown = null;
  if (row.value_json !== null) {
    try {
      value = JSON.parse(row.value_json);
    } catch {
      value = null;
    }
  }
  return {
    key: row.config_key,
    value,
    valueJson: row.value_json,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAtMs: row.updated_at_ms,
    reason: row.reason,
  };
}

/** The latest row per key wins; a tombstone (value_json null) means no override is set. */
function latestPerKey(rows: OtelConfigOverridesRow[]): OtelRuntimeOverrideRecord[] {
  const latest = new Map<string, OtelConfigOverridesRow>();
  for (const row of rows) {
    const current = latest.get(row.config_key);
    if (!current || row.version > current.version) latest.set(row.config_key, row);
  }
  const out: OtelRuntimeOverrideRecord[] = [];
  for (const row of latest.values()) {
    if (row.value_json !== null) out.push(toRecord(row));
  }
  return out;
}

export function createOtelConfigPort(deps: OtelConfigPortDeps): OtelConfigPort {
  const nowMs = deps.nowMs ?? Date.now;
  const { d1 } = deps;
  // The SQL lives in the data layer (src/data/): the global
  // D-D census (#2356, surface 3) pins prepare() sites outside
  // src/data/ to an exact allow-list, so this port calls the
  // store instead of prepare() itself.
  const store: OtelConfigOverridesStore = createOtelConfigOverridesStore(d1);

  async function readAllRows(): Promise<OtelConfigOverridesRow[]> {
    return store.readAllRows();
  }

  async function readOverrides(): Promise<OtelRuntimeOverrideRecord[]> {
    return latestPerKey(await readAllRows());
  }

  async function readOverrideMap(): Promise<Record<string, OtelRuntimeOverrideRecord>> {
    const rows = await readOverrides();
    const map: Record<string, OtelRuntimeOverrideRecord> = {};
    for (const row of rows) map[row.key] = row;
    return map;
  }

  async function readOverrideHistory(key: string): Promise<OtelRuntimeOverrideRecord[]> {
    const rows = (await readAllRows())
      .filter((row) => row.config_key === key)
      .sort((a, b) => a.version - b.version);
    return rows.map(toRecord);
  }

  function auditInput(
    action: string,
    actor: string,
    key: string,
  ): CreateIaaaAuditEventInput {
    return {
      timestamp: nowMs(),
      type: OTEL_CONFIG_OVERRIDE_AUDIT_TYPE,
      actorPrincipalId: actor,
      actorType: "human",
      initiatingPrincipalId: actor,
      tenantId: deps.tenantId,
      correlationId: crypto.randomUUID(),
      action,
      resourceId: key,
      decision: "allow",
      policyVersion: IAAA_AUDIT_POLICY_VERSION,
      outcome: "succeeded",
    };
  }

  async function applyOverride(input: {
    key: string;
    value: unknown;
    actor: string;
    reason: string;
  }): Promise<OtelOverrideApplyResult> {
    const def = otelRuntimeOverrideKeyDef(input.key);
    if (!def) {
      return { ok: false, reason: `unknown config key: ${input.key}` };
    }
    if (typeof input.reason !== "string" || !input.reason.trim()) {
      return { ok: false, reason: "a reason is required (audited)" };
    }
    if (typeof input.actor !== "string" || !input.actor.trim()) {
      return { ok: false, reason: "an actor is required (audited)" };
    }
    const normalized = normalizeOverrideValue(def.kind, input.value);
    if (normalized === "invalid") {
      return {
        ok: false,
        reason: `[${OBS_CONFIG_INVALID}] invalid value for ${input.key}: ${JSON.stringify(input.value) ?? "undefined"}`,
      };
    }
    if (normalized === null) {
      return { ok: false, reason: `empty value for ${input.key}` };
    }
    if (!d1) {
      return { ok: false, reason: "D1 is unbound: the runtime override store is unavailable" };
    }
    const valueJson = JSON.stringify(normalized);
    const history = await readOverrideHistory(input.key);
    const version = (history.length > 0 ? history[history.length - 1]!.version : 0) + 1;
    const record: OtelRuntimeOverrideRecord = {
      key: input.key,
      value: normalized,
      valueJson,
      version,
      updatedBy: input.actor,
      updatedAtMs: nowMs(),
      reason: input.reason.trim(),
    };
    try {
      await store.insertRow({
        config_key: record.key,
        value_json: record.valueJson,
        version: record.version,
        updated_by: record.updatedBy,
        updated_at_ms: record.updatedAtMs,
        reason: record.reason,
      });
    } catch {
      return { ok: false, reason: "the runtime override store write failed" };
    }
    // The audit is best-effort after the write: a failed audit
    // does not roll the override back (the row carries actor +
    // reason), but the failure is reported so the caller knows
    // the change is unaudited.
    const audited = await deps
      .audit(auditInput("otel.config.override.set", input.actor, input.key))
      .catch(() => false);
    if (!audited) {
      return { ok: false, reason: "override applied but the audit write failed" };
    }
    return { ok: true, record };
  }

  async function clearOverride(input: {
    key: string;
    actor: string;
    reason: string;
  }): Promise<OtelOverrideClearResult> {
    if (!otelRuntimeOverrideKeyDef(input.key)) {
      return { ok: false, reason: `unknown config key: ${input.key}` };
    }
    if (typeof input.reason !== "string" || !input.reason.trim()) {
      return { ok: false, reason: "a reason is required (audited)" };
    }
    if (!d1) {
      return { ok: false, reason: "D1 is unbound: the runtime override store is unavailable" };
    }
    const history = await readOverrideHistory(input.key);
    const latest = history.length > 0 ? history[history.length - 1]! : undefined;
    if (!latest || latest.valueJson === null) {
      return { ok: false, reason: `no override set for ${input.key}` };
    }
    const version = latest.version + 1;
    try {
      await store.insertRow({
        config_key: input.key,
        value_json: null,
        version,
        updated_by: input.actor,
        updated_at_ms: nowMs(),
        reason: input.reason.trim(),
      });
    } catch {
      return { ok: false, reason: "the runtime override store write failed" };
    }
    const audited = await deps
      .audit(auditInput("otel.config.override.clear", input.actor, input.key))
      .catch(() => false);
    if (!audited) {
      return { ok: false, reason: "override cleared but the audit write failed" };
    }
    return { ok: true, key: input.key };
  }

  return { readOverrides, readOverrideMap, readOverrideHistory, applyOverride, clearOverride };
}

/**
 * The in-isolate override cache: the synchronous readers (the
 * structured-logger sink's per-write destination resolution,
 * the domain gates) consult this snapshot — they cannot await
 * D1. Async call sites refresh it (TTL-guarded); the admin
 * write route force-refreshes it after a change, so the
 * writing isolate applies a flip immediately.
 */
let overrideCache: { atMs: number; overrides: Record<string, OtelRuntimeOverrideRecord> } | null =
  null;

/** The last override snapshot (empty when never refreshed). Never throws. */
export function cachedOtelRuntimeOverrides(): Record<string, OtelRuntimeOverrideRecord> {
  return overrideCache?.overrides ?? {};
}

/** Clears the cache (tests; the admin route force-refreshes instead). */
export function resetOtelRuntimeOverrideCache(): void {
  overrideCache = null;
}

/**
 * Refreshes the override cache from D1 (TTL-guarded unless
 * forced). A missing/unbound D1 refreshes to empty overrides.
 * Never throws.
 */
export async function refreshOtelRuntimeOverrideCache(
  d1: OtelConfigOverridesD1 | null,
  opts?: { force?: boolean; nowMs?: number },
): Promise<Record<string, OtelRuntimeOverrideRecord>> {
  const now = opts?.nowMs ?? Date.now();
  if (!opts?.force && overrideCache && now - overrideCache.atMs < OTEL_RUNTIME_OVERRIDE_CACHE_TTL_MS) {
    return overrideCache.overrides;
  }
  let overrides: Record<string, OtelRuntimeOverrideRecord> = {};
  if (d1) {
    try {
      const port = createOtelConfigPort({
        d1,
        audit: async () => true,
        tenantId: "",
        nowMs: () => now,
      });
      overrides = await port.readOverrideMap();
    } catch {
      overrides = {};
    }
  }
  overrideCache = { atMs: now, overrides };
  return overrides;
}

/** The runtime level value for one config key (undefined when no override is set). */
export function otelRuntimeLevel(
  overrides: Record<string, OtelRuntimeOverrideRecord>,
  key: string,
): unknown {
  return overrides[key]?.value;
}

/**
 * The env-var name for each overridable key that has one
 * (the deploy-time env var the resolver reads). The providers'
 * `levelsFor(envName, fileValue)` helpers look the runtime
 * level up through this map, so a flip applies at the runtime
 * level without each provider knowing the dotted key. Lazy
 * for the same import-cycle reason as the allow-list.
 */
let cachedEnvNames: Readonly<Record<string, string>> | null = null;

function otelRuntimeOverrideEnvNames(): Readonly<Record<string, string>> {
  if (!cachedEnvNames) {
    cachedEnvNames = Object.fromEntries(
      otelRuntimeOverrideKeys()
        .filter((def) => def.envName !== undefined)
        .map((def) => [def.envName as string, def.key]),
    );
  }
  return cachedEnvNames;
}

/** The runtime level value for one deploy-time env var (undefined when the key has no env var or no override is set). */
export function otelRuntimeLevelByEnvName(
  overrides: Record<string, OtelRuntimeOverrideRecord>,
  envName: string,
): unknown {
  const key = otelRuntimeOverrideEnvNames()[envName];
  if (!key) return undefined;
  return otelRuntimeLevel(overrides, key);
}

/**
 * The D1 binding for the override store, read off a Worker env
 * (null when unbound or absent). The one way any module gets
 * the override store's D1 from env — the alerting port, the
 * three OTel providers, and the config routes all use it.
 */
export function otelConfigD1FromEnv(env: unknown): OtelConfigOverridesD1 | null {
  if (!env || typeof env !== "object") return null;
  const d1 = (env as { AGENT_DB?: unknown }).AGENT_DB;
  if (!d1 || typeof d1 !== "object") return null;
  return d1 as OtelConfigOverridesD1;
}
