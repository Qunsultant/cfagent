/**
 * Issue #5164 (S10, observability program #5080) — the Grafana
 * Cloud OTel backend: the external destination for the Worker's
 * OTLP export, behind the `backend.enabled` config switch.
 *
 * Reuse, don't rebuild: the S1/S2/S3 OTLP/HTTP exporter
 * transport is reused as-is — no new exporter is built here.
 * The backend is a FAN-OUT leg on that transport: the archive
 * transport (in-process ingestion → R2) runs first and its
 * status is what the exporter sees; the Grafana POST runs
 * second, best-effort, and never changes the returned status
 * or throws. Analytics Engine + R2 keep receiving telemetry
 * whatever the backend does (never-either-or: both paths
 * behind the switch; flipping it back restores the
 * free-tier-only path).
 *
 * Auth is Grafana Cloud OTLP Basic: the username is the
 * numeric stack/instance ID, the password is the API token
 * (glc_...), `Authorization: Basic base64(id:key)`. Three
 * values, all Worker secrets, never in the repo: they live in
 * GitHub Secrets and reach the Worker through the deploy
 * workflow's sync-secrets job (`.github/workflows/deploy.yml`,
 * "Set core secrets" step, `optional_secret` each;
 * `wrangler secret put` is the manual fallback).
 * GRAFANA_OTLP_ENDPOINT (the gateway URL from the portal,
 * Connections → OpenTelemetry,
 * `https://otlp-gateway-prod-<region>.grafana.net/otlp`),
 * GRAFANA_CLOUD_INSTANCE_ID, GRAFANA_CLOUD_API_KEY (scopes
 * metrics:write, logs:write, traces:write). The signal path
 * is appended per signal: /v1/logs, /v1/metrics, /v1/traces
 * (OTLP/HTTP JSON — the same payload the ingestion route
 * accepts; no serializer change).
 *
 * Fail-closed: backend disabled (the default) means no backend
 * attempt at all. Enabled but unconfigured (a secret missing,
 * or a non-https endpoint) means no fetch attempt: the failure
 * is NAMED once per UTC day per signal — one coded message
 * (the per-signal export-failed code: OBS-1002 logs / OBS-1006
 * metrics / OBS-1012 traces) plus one audit event (type
 * otel.backend.export_failed, actor system:otel-backend) — and
 * the free-tier path carries on. A failed POST names the same
 * way, once per day. The naming never carries a credential
 * value, only secret NAMES (which variable is missing) and the
 * HTTP status. The once-per-day guard is the OBS-1007/1013
 * free-tier-guard precedent: a down gateway would otherwise
 * emit a coded message and an audit event per batch (every
 * ~1s per signal) and flood the Analytics Engine sink and the
 * bounded (22,000) audit store. The batches are safe in the
 * archive, so silence after the first naming loses nothing.
 *
 * The `backend.enabled` switch resolves run > session > user >
 * runtime > env > file > builtin (OFF), and the runtime level
 * is consulted PER EXPORT (like the domain gates), so a flip
 * in the config panel applies on the next export without a
 * redeploy. The request timeout resolves at provider init
 * (like the batch settings).
 */
import { DEPLOYMENT_DEFAULT_TENANT_ID } from "../config/tenantDefaults";
import {
  effectiveOtelBackendEnabled,
  type OtelBackendSettings,
  type OtelSignal,
} from "../config/otelModes";
import {
  OBS_EXPORT_FAILED,
  OBS_METRICS_EXPORT_FAILED,
  OBS_TRACES_EXPORT_FAILED,
  formatCatalogMessage,
} from "./otelMessages";
import type { OtelTransport } from "./otelLogs";
import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
  type CreateIaaaAuditEventInput,
} from "../security/iaaaAudit";
import { createWiredAuditStore } from "../security/iaaaAuditStore";
import type { Env } from "../types";

/** The Grafana Cloud OTLP gateway URL (a Worker secret, never in the repo). */
export const GRAFANA_OTLP_ENDPOINT_ENV = "GRAFANA_OTLP_ENDPOINT";
/** The Grafana Cloud stack/instance ID (a Worker secret, never in the repo). */
export const GRAFANA_CLOUD_INSTANCE_ID_ENV = "GRAFANA_CLOUD_INSTANCE_ID";
/** The Grafana Cloud API key (a Worker secret, never in the repo). */
export const GRAFANA_CLOUD_API_KEY_ENV = "GRAFANA_CLOUD_API_KEY";

/** The audit event type for a named backend export failure (an audit type, not a catalog code). */
export const OTEL_BACKEND_EXPORT_FAILED_AUDIT_TYPE = "otel.backend.export_failed";
/**
 * The system actor that names a backend export failure (the
 * OBS-1020 namer precedent: system:<something>, service).
 */
export const OTEL_BACKEND_AUDIT_ACTOR = "system:otel-backend";

export interface OtelBackendCredentials {
  /** The gateway base URL (no trailing slash, https only). */
  endpoint: string;
  /** The numeric Grafana Cloud stack/instance ID. */
  instanceId: string;
  /** The Grafana Cloud API token (glc_...). */
  apiKey: string;
}

export type OtelBackendCredentialsResolution =
  | { configured: true; credentials: OtelBackendCredentials }
  | {
      configured: false;
      /** Short reasons, each naming the env var (never a value). */
      problems: string[];
    };

/**
 * Resolves the three Grafana Worker secrets. Blank counts as
 * missing; a non-https endpoint is unusable (Basic auth must
 * never go over plaintext) and is reported the same way. The
 * region is NOT guessed: the endpoint comes from the portal
 * (Connections → OpenTelemetry), so a stack in any region
 * works without a code change.
 */
export function resolveOtelBackendCredentials(
  env: Record<string, unknown>,
): OtelBackendCredentialsResolution {
  const problems: string[] = [];
  const readSecret = (name: string): string | undefined => {
    const raw = env[name];
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  };
  const endpoint = readSecret(GRAFANA_OTLP_ENDPOINT_ENV);
  const instanceId = readSecret(GRAFANA_CLOUD_INSTANCE_ID_ENV);
  const apiKey = readSecret(GRAFANA_CLOUD_API_KEY_ENV);
  if (!endpoint) {
    problems.push(`${GRAFANA_OTLP_ENDPOINT_ENV} is not set`);
  } else {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:") {
        problems.push(`${GRAFANA_OTLP_ENDPOINT_ENV} is not an https URL`);
      }
    } catch {
      problems.push(`${GRAFANA_OTLP_ENDPOINT_ENV} is not a valid URL`);
    }
  }
  if (!instanceId) problems.push(`${GRAFANA_CLOUD_INSTANCE_ID_ENV} is not set`);
  if (!apiKey) problems.push(`${GRAFANA_CLOUD_API_KEY_ENV} is not set`);
  if (problems.length > 0 || !endpoint || !instanceId || !apiKey) {
    return { configured: false, problems };
  }
  return {
    configured: true,
    credentials: {
      endpoint: endpoint.replace(/\/+$/, ""),
      instanceId,
      apiKey,
    },
  };
}

/** The OTLP/HTTP signal path appended to the gateway URL (one per signal). */
export function otelBackendSignalPath(signal: OtelSignal): string {
  if (signal === "metrics") return "v1/metrics";
  if (signal === "traces") return "v1/traces";
  return "v1/logs";
}

/** The catalog code for a backend export failure, one per signal. */
function otelBackendFailureCode(signal: OtelSignal): string {
  if (signal === "metrics") return OBS_METRICS_EXPORT_FAILED;
  if (signal === "traces") return OBS_TRACES_EXPORT_FAILED;
  return OBS_EXPORT_FAILED;
}

/** The audit writer the backend failure naming calls (best-effort: false on any failure). */
export type OtelBackendAuditFn = (input: CreateIaaaAuditEventInput) => Promise<boolean>;

/**
 * The default audit writer for a backend failure: the canonical
 * IAAA audit store (the S5 owner), reached through
 * createWiredAuditStore + recordAuditEvent — the same two calls
 * the archive routes use. It never throws: a failed audit
 * write returns false, and the coded message (the floor) is
 * still emitted by the caller.
 */
export function createOtelBackendAudit(env: Env): OtelBackendAuditFn {
  return async (input) => {
    try {
      const result = await recordAuditEvent(createWiredAuditStore(env), input);
      return result.ok;
    } catch {
      return false;
    }
  };
}

export interface OtelBackendFanOutDeps {
  signal: OtelSignal;
  env: Record<string, unknown>;
  /** The init-time resolved backend settings (enabled + timeout). */
  settings: OtelBackendSettings;
  /**
   * The archive transport (in-process ingestion → R2). Its
   * status is returned; the backend leg never changes it.
   */
  archive: OtelTransport;
  /**
   * Receives the coded failure message (the per-signal
   * export-failed code with detail naming "Grafana Cloud").
   * Called at most once per UTC day per signal. The providers
   * wire this to their ingestionLog (base sink only, never the
   * OTel sink — a fallback record must not re-enter the OTel
   * pipeline).
   */
  onError?: (message: string) => void;
  /**
   * The audit writer for the named failure (the providers pass
   * createOtelBackendAudit(env)). When omitted, no audit event
   * is written — the coded message is the floor.
   */
  audit?: OtelBackendAuditFn;
  /**
   * The runtime override accessor (defaults to the S7 override
   * cache): consulted per export, so a flip of backend.enabled
   * in the config panel applies on the next export.
   */
  getRuntimeOverrides?: () => Record<string, { value: unknown }>;
  /** The fetch implementation (defaults to global fetch); injectable for tests. */
  fetchFn?: typeof fetch;
  /** The clock (defaults to Date.now); injectable for tests. */
  nowMs?: () => number;
}

/**
 * Builds the fan-out transport for one signal: the archive leg
 * first, the Grafana Cloud leg second. The backend leg is
 * best-effort and never throws; a backend failure is named
 * once per UTC day (coded message + audit event) and the
 * archive status is still returned — the batch is safe in R2.
 * When the archive itself throws, the backend is still
 * attempted (it may be the only surviving copy), then the
 * archive error is rethrown so the exporter still reports
 * the export FAILED, as before.
 */
export function createOtelBackendFanOutTransport(
  deps: OtelBackendFanOutDeps,
): OtelTransport {
  const { signal, settings } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowMs = deps.nowMs ?? Date.now;
  const credentials = resolveOtelBackendCredentials(deps.env);
  const failureCode = otelBackendFailureCode(signal);

  let guardedDay = "";
  let guardedFired = false;

  const nameFailure = (detail: string): void => {
    const today = new Date(nowMs()).toISOString().slice(0, 10);
    if (guardedDay !== today) {
      guardedDay = today;
      guardedFired = false;
    }
    if (guardedFired) return;
    guardedFired = true;
    const message = formatCatalogMessage(failureCode, {
      signal,
      detail: `Grafana Cloud backend: ${detail}`,
    });
    deps.onError?.(message);
    // Best-effort: a failed audit write never breaks the export.
    const audit = deps.audit;
    if (!audit) return;
    const tenantId =
      typeof deps.env.IAAA_TENANT_ID === "string" && deps.env.IAAA_TENANT_ID.trim() !== ""
        ? deps.env.IAAA_TENANT_ID.trim()
        : DEPLOYMENT_DEFAULT_TENANT_ID;
    void audit({
      type: OTEL_BACKEND_EXPORT_FAILED_AUDIT_TYPE,
      action: OTEL_BACKEND_EXPORT_FAILED_AUDIT_TYPE,
      actorPrincipalId: OTEL_BACKEND_AUDIT_ACTOR,
      actorType: "service",
      initiatingPrincipalId: OTEL_BACKEND_AUDIT_ACTOR,
      tenantId,
      decision: "allow",
      outcome: "failed",
      policyVersion: IAAA_AUDIT_POLICY_VERSION,
      correlationId: crypto.randomUUID(),
      timestamp: nowMs(),
    }).catch(() => undefined);
  };

  return async (body, contentType) => {
    let archiveStatus = 0;
    let archiveError: unknown = null;
    try {
      archiveStatus = (await deps.archive(body, contentType)).status;
    } catch (error) {
      archiveError = error;
    }

    try {
      const overrides = deps.getRuntimeOverrides?.() ?? {};
      const enabled = effectiveOtelBackendEnabled(settings.enabled, overrides);
      if (!enabled) {
        // Disabled (the default): no backend attempt at all.
      } else if (!credentials.configured) {
        // Enabled but unconfigured: no fetch attempt — name the
        // missing secret NAMES (never a value) once per day.
        nameFailure(`not configured: ${credentials.problems.join("; ")}`);
      } else {
        const { endpoint, instanceId, apiKey } = credentials.credentials;
        const url = `${endpoint}/${otelBackendSignalPath(signal)}`;
        try {
          // The OTLP payload is JSON text (the serializers
          // produce OTLP/JSON); decode it for the POST — the
          // Worker's fetch types do not accept a bare
          // Uint8Array as a body.
          const response = await fetchFn(url, {
            method: "POST",
            headers: {
              "Content-Type": contentType,
              Authorization: `Basic ${btoa(`${instanceId}:${apiKey}`)}`,
            },
            body: new TextDecoder().decode(body),
            signal: AbortSignal.timeout(settings.requestTimeoutMs),
          });
          if (response.status < 200 || response.status >= 300) {
            nameFailure(`HTTP ${response.status} from the Grafana Cloud backend`);
          }
        } catch (error) {
          nameFailure(error instanceof Error ? error.message : "fetch failed");
        }
      }
    } catch {
      // The backend leg never breaks the export.
    }

    if (archiveError) throw archiveError;
    return { status: archiveStatus };
  };
}
