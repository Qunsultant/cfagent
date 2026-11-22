/**
 * Issue #5164 (S10, observability program #5080) — the Grafana
 * Cloud OTel backend: wire the Worker's OTLP export to Grafana
 * Cloud behind the `backend.enabled` config switch.
 *
 * TDD Red first (2026-11-22 fix): the service-name + protocol
 * externalization and the config endpoint/instance-ID move do
 * not exist yet — `otelServiceResource`, the new backend
 * settings fields, and the reworked credential resolver are
 * all missing, so this file fails at import.
 *
 * Design (recorded in the PR body):
 * - Reuse, don't rebuild: the S1/S2/S3 OTLP/HTTP exporter
 *   transport is reused as-is. The backend is a FAN-OUT leg
 *   on that transport: the archive transport (in-process
 *   ingestion → R2) runs first and its status is what the
 *   exporter sees; the Grafana POST runs second, best-effort,
 *   and never changes the returned status or throws. Analytics
 *   Engine + R2 keep receiving telemetry whatever the backend
 *   does (never-either-or: both paths behind the switch).
 * - Auth is Grafana Cloud OTLP Basic: the username is the
 *   numeric stack instance ID, the password is the API token
 *   (glc_...), `Authorization: Basic base64(id:key)`. ONE
 *   value is a Worker secret — GRAFANA_CLOUD_API_KEY (owner
 *   direction 2026-11-22: the endpoint + instance ID are
 *   config values, not secrets). The endpoint + instance ID
 *   live in config/otel.json `backend` (the gateway URL from
 *   the portal, `https://otlp-gateway-prod-us-east-2.grafana.net/otlp`,
 *   region us-east-2; the instance ID 1929738). The signal
 *   path is appended per signal: /v1/logs, /v1/metrics,
 *   /v1/traces (OTLP/HTTP JSON, the same payload the
 *   ingestion route accepts).
 * - The service name is externalized, never in code:
 *   config/otel.json `backend.serviceName` (default
 *   "ai-search-agent", the Worker name) + env override
 *   OTEL_SERVICE_NAME, resolved run > session > user >
 *   runtime > env > file > builtin; empty/invalid fails
 *   closed to the default. It is stamped as the OTLP
 *   `service.name` resource attribute on EVERY signal's
 *   outbound payload (logs, metrics, traces) — in the
 *   shared provider builders, so the archive AND Grafana
 *   both get it (the resource belongs in the builders, not
 *   the Grafana-only fan-out). Without it Grafana shows the
 *   service as "unknown_service:node" (the SDK default).
 * - The protocol is externalized too: config/otel.json
 *   `backend.protocol` ("http/json" | "http/protobuf",
 *   default "http/json") + env override
 *   OTEL_EXPORTER_OTLP_PROTOCOL; invalid fails closed to
 *   "http/json" with a coded message. Only http/json is
 *   implemented (the S1/S2/S3 serializers produce OTLP/JSON);
 *   protobuf serialization is out of scope for this slice.
 * - Fail-closed: backend disabled (the default) means no
 *   backend attempt at all. Enabled but unconfigured (the
 *   API key missing, or a non-https endpoint, or a missing
 *   instance ID) means no fetch attempt: the failure is
 *   NAMED once per UTC day per signal — one coded message
 *   (the per-signal export-failed code: OBS-1002 logs /
 *   OBS-1006 metrics / OBS-1012 traces) plus one audit
 *   event (type otel.backend.export_failed, actor
 *   system:otel-backend) — and the free-tier path carries
 *   on. A failed POST names the same way, once per day.
 *   The naming never carries a credential value, only the
 *   config key (`backend.endpoint`, `backend.instanceId`)
 *   or the secret NAME (GRAFANA_CLOUD_API_KEY) and the
 *   HTTP status.
 * - The `backend.enabled` switch resolves run > session >
 *   user > runtime > env > file > builtin (OFF), and the
 *   runtime level is consulted PER EXPORT (like the domain
 *   gates), so a flip in the config panel applies on the next
 *   export without a redeploy. The request timeout resolves
 *   at provider init (like the batch settings).
 */
import { describe, it, expect } from "vitest";
import { SeverityNumber } from "@opentelemetry/api";
import {
  GRAFANA_CLOUD_API_KEY_ENV,
  OTEL_BACKEND_AUDIT_ACTOR,
  OTEL_BACKEND_EXPORT_FAILED_AUDIT_TYPE,
  createOtelBackendFanOutTransport,
  resolveOtelBackendCredentials,
} from "../src/observability/otelBackend";
import {
  OTEL_BACKEND_SETTINGS_BUILTIN,
  effectiveOtelBackendEnabled,
  resolveOtelBackendSettings,
  type OtelBackendSettings,
  type OtelBackendSettingsInput,
  type OtelScopeLevels,
} from "../src/config/otelModes";
import {
  OBS_EXPORT_FAILED,
  OBS_METRICS_EXPORT_FAILED,
  OBS_TRACES_EXPORT_FAILED,
} from "../src/observability/otelMessages";
import { IAAA_AUDIT_POLICY_VERSION } from "../src/security/iaaaAudit";
import {
  createOtelLoggerProvider,
  type OtelLoggingConfig,
  type OtelTransport,
} from "../src/observability/otelLogs";
import {
  createOtelMeterProvider,
  type OtelMetricsConfig,
} from "../src/observability/otelMetrics";
import {
  createOtelTracerProvider,
  type OtelTracesConfig,
} from "../src/observability/otelTraces";
import type { ObservabilitySink } from "../src/observability/observabilityPorts";
import { otelServiceResource } from "../src/observability/otelResource";

const ENDPOINT = "https://otlp-gateway-prod-us-east-2.grafana.net/otlp";
const INSTANCE_ID = "1929738";
const API_KEY = "glc_test_api_key_value";
const SERVICE_NAME = "ai-search-agent";

/** The resolved backend settings with everything configured. */
function fullSettings(overrides: Partial<OtelBackendSettings> = {}): OtelBackendSettings {
  return {
    enabled: true,
    requestTimeoutMs: 10000,
    serviceName: SERVICE_NAME,
    protocol: "http/json",
    endpoint: ENDPOINT,
    instanceId: INSTANCE_ID,
    ...overrides,
  };
}

/** The env for the fan-out: ONLY the API key is a secret. */
function fullEnv(): Record<string, unknown> {
  return { [GRAFANA_CLOUD_API_KEY_ENV]: API_KEY };
}

function disabledSettings(overrides: Partial<OtelBackendSettings> = {}): OtelBackendSettings {
  return { enabled: false, requestTimeoutMs: 10000, serviceName: SERVICE_NAME, protocol: "http/json", endpoint: ENDPOINT, instanceId: INSTANCE_ID, ...overrides };
}

function enabledSettings(overrides: Partial<OtelBackendSettings> = {}): OtelBackendSettings {
  return { enabled: true, requestTimeoutMs: 10000, serviceName: SERVICE_NAME, protocol: "http/json", endpoint: ENDPOINT, instanceId: INSTANCE_ID, ...overrides };
}

/** The resolver input with every field present (file level). */
function backendInput(
  overrides: Partial<Record<keyof OtelBackendSettingsInput, OtelScopeLevels>> = {},
): OtelBackendSettingsInput {
  return {
    enabled: { file: false },
    requestTimeoutMs: { file: 10000 },
    serviceName: { file: SERVICE_NAME },
    protocol: { file: "http/json" },
    endpoint: { file: ENDPOINT },
    instanceId: { file: INSTANCE_ID },
    ...overrides,
  };
}

/** A controllable clock (defaults to 2026-11-22, a Sunday). */
function clock(startMs = Date.parse("2026-11-22T12:00:00.000Z")) {
  let now = startMs;
  return {
    nowMs: () => now,
    advanceMs: (ms: number) => {
      now += ms;
    },
  };
}

/** A transport that records every OTLP/HTTP body it is handed. */
function recordingTransport() {
  const bodies: Uint8Array[] = [];
  const transport: OtelTransport = async (body) => {
    bodies.push(body);
    return { status: 202 };
  };
  return { transport, bodies };
}

/** A sink that drops everything (the resource tests need no AE events). */
function noopSink(): ObservabilitySink {
  return { write: () => {}, writeBatch: () => {} };
}

/** The 8 domains, all OFF except j1j7 (the shape every provider config needs). */
function domainsOn() {
  return {
    j1j7: { enabled: true, level: "INFO", samplingRatio: 1 },
    "stock-copilot": { enabled: false, level: "INFO", samplingRatio: 1 },
    iaaa: { enabled: false, level: "INFO", samplingRatio: 1 },
    "mcp-a2a": { enabled: false, level: "INFO", samplingRatio: 1 },
    scheduler: { enabled: false, level: "INFO", samplingRatio: 1 },
    payments: { enabled: false, level: "INFO", samplingRatio: 1 },
    "market-data": { enabled: false, level: "INFO", samplingRatio: 1 },
    platform: { enabled: false, level: "INFO", samplingRatio: 1 },
  } as const;
}

/** Reads one OTLP/JSON envelope's resource attributes into a plain map. */
function resourceAttributes(body: Uint8Array, envelopeKey: string): Record<string, string> {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  const envelopes = parsed[envelopeKey] as Array<{
    resource?: { attributes?: Array<{ key: string; value?: { stringValue?: string } }> };
  }>;
  const out: Record<string, string> = {};
  for (const attr of envelopes[0]?.resource?.attributes ?? []) {
    if (typeof attr.value?.stringValue === "string") out[attr.key] = attr.value.stringValue;
  }
  return out;
}

describe("resolveOtelBackendCredentials — the config endpoint + instance ID, one secret", () => {
  it("is configured when the config carries endpoint + instance ID and env carries the API key", () => {
    const r = resolveOtelBackendCredentials(fullSettings(), fullEnv());
    expect(r.configured).toBe(true);
    if (!r.configured) return;
    expect(r.credentials.endpoint).toBe(ENDPOINT);
    expect(r.credentials.instanceId).toBe(INSTANCE_ID);
    expect(r.credentials.apiKey).toBe(API_KEY);
  });

  it("strips a trailing slash from the config endpoint", () => {
    const r = resolveOtelBackendCredentials(fullSettings({ endpoint: `${ENDPOINT}/` }), fullEnv());
    expect(r.configured).toBe(true);
    if (!r.configured) return;
    expect(r.credentials.endpoint).toBe(ENDPOINT);
  });

  it("is not configured when the endpoint or instance ID is missing from config, and names the config key", () => {
    const noEndpoint = resolveOtelBackendCredentials(fullSettings({ endpoint: "" }), fullEnv());
    expect(noEndpoint.configured).toBe(false);
    if (!noEndpoint.configured) {
      expect(noEndpoint.problems.join(" ")).toContain("backend.endpoint");
    }
    const noInstance = resolveOtelBackendCredentials(fullSettings({ instanceId: "" }), fullEnv());
    expect(noInstance.configured).toBe(false);
    if (!noInstance.configured) {
      expect(noInstance.problems.join(" ")).toContain("backend.instanceId");
    }
  });

  it("is not configured when the API key is missing from env, and names the secret NAME", () => {
    const r = resolveOtelBackendCredentials(fullSettings(), {});
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(r.problems.join(" ")).toContain(GRAFANA_CLOUD_API_KEY_ENV);
  });

  it("treats a blank API key as missing", () => {
    const r = resolveOtelBackendCredentials(fullSettings(), { [GRAFANA_CLOUD_API_KEY_ENV]: "   " });
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(r.problems.join(" ")).toContain(GRAFANA_CLOUD_API_KEY_ENV);
  });

  it("rejects a non-https endpoint (Basic auth must never go over plaintext)", () => {
    const r = resolveOtelBackendCredentials(
      fullSettings({ endpoint: "http://otlp-gateway-prod-us-east-2.grafana.net/otlp" }),
      fullEnv(),
    );
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(r.problems.join(" ")).toContain("backend.endpoint");
  });

  it("reads ONLY the API key from env — endpoint/instance ID in env do not configure it", () => {
    // The owner redirect (2026-11-22): endpoint + instance ID are
    // config values, not secrets. An env that still carries the old
    // secret names must not configure the backend.
    const r = resolveOtelBackendCredentials(fullSettings({ endpoint: "", instanceId: "" }), {
      GRAFANA_OTLP_ENDPOINT: ENDPOINT,
      GRAFANA_CLOUD_INSTANCE_ID: INSTANCE_ID,
      [GRAFANA_CLOUD_API_KEY_ENV]: API_KEY,
    });
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(r.problems.join(" ")).toContain("backend.endpoint");
    expect(r.problems.join(" ")).toContain("backend.instanceId");
  });
});

describe("resolveOtelBackendSettings — the backend settings", () => {
  it("defaults to OFF with a 10s timeout, the ai-search-agent service name, http/json, and an empty endpoint/instance ID", () => {
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.enabled).toBe(false);
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.requestTimeoutMs).toBe(10000);
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.serviceName).toBe(SERVICE_NAME);
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.protocol).toBe("http/json");
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.endpoint).toBe("");
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.instanceId).toBe("");
    const r = resolveOtelBackendSettings(backendInput());
    expect(r.settings.enabled).toBe(false);
    expect(r.settings.requestTimeoutMs).toBe(10000);
    expect(r.settings.serviceName).toBe(SERVICE_NAME);
    expect(r.settings.protocol).toBe("http/json");
    expect(r.settings.endpoint).toBe(ENDPOINT);
    expect(r.settings.instanceId).toBe(INSTANCE_ID);
    expect(r.invalid).toBe(false);
  });

  it("resolves enabled=true from env over the file default", () => {
    const r = resolveOtelBackendSettings(backendInput({ enabled: { env: "true", file: false } }));
    expect(r.settings.enabled).toBe(true);
  });

  it("resolves the runtime level over env and file (the S7 flip)", () => {
    const r = resolveOtelBackendSettings(
      backendInput({ enabled: { runtime: true, env: "false", file: false } }),
    );
    expect(r.settings.enabled).toBe(true);
  });

  it("fails closed to OFF on an unrecognized enabled value", () => {
    const r = resolveOtelBackendSettings(backendInput({ enabled: { env: "maybe", file: true } }));
    expect(r.settings.enabled).toBe(false);
    expect(r.invalid).toBe(true);
  });

  it("fails closed to the 10s timeout on an invalid timeout value", () => {
    const r = resolveOtelBackendSettings(backendInput({ requestTimeoutMs: { env: "0", file: 10000 } }));
    expect(r.settings.requestTimeoutMs).toBe(10000);
    expect(r.invalid).toBe(true);
  });

  it("resolves the service name from the OTEL_SERVICE_NAME env override over the file", () => {
    const r = resolveOtelBackendSettings(
      backendInput({ serviceName: { env: "custom-svc", file: SERVICE_NAME } }),
    );
    expect(r.settings.serviceName).toBe("custom-svc");
    expect(r.invalid).toBe(false);
  });

  it("fails closed to ai-search-agent on a blank or non-string service name", () => {
    const blank = resolveOtelBackendSettings(
      backendInput({ serviceName: { env: "   ", file: SERVICE_NAME } }),
    );
    expect(blank.settings.serviceName).toBe(SERVICE_NAME);
    const wrongType = resolveOtelBackendSettings(
      backendInput({ serviceName: { file: 42 as unknown as string } }),
    );
    expect(wrongType.settings.serviceName).toBe(SERVICE_NAME);
    expect(wrongType.invalid).toBe(true);
  });

  it("resolves the protocol from env, accepting http/protobuf (the portal default)", () => {
    const r = resolveOtelBackendSettings(
      backendInput({ protocol: { env: "http/protobuf", file: "http/json" } }),
    );
    expect(r.settings.protocol).toBe("http/protobuf");
    expect(r.invalid).toBe(false);
  });

  it("fails closed to http/json on an unrecognized protocol value", () => {
    const r = resolveOtelBackendSettings(backendInput({ protocol: { env: "grpc", file: "http/json" } }));
    expect(r.settings.protocol).toBe("http/json");
    expect(r.invalid).toBe(true);
  });

  it("resolves the endpoint + instance ID from env over the file (the config values)", () => {
    const r = resolveOtelBackendSettings(
      backendInput({
        endpoint: { env: "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp", file: ENDPOINT },
        instanceId: { env: "7654321", file: INSTANCE_ID },
      }),
    );
    expect(r.settings.endpoint).toBe("https://otlp-gateway-prod-eu-west-0.grafana.net/otlp");
    expect(r.settings.instanceId).toBe("7654321");
    expect(r.invalid).toBe(false);
  });
});

describe("effectiveOtelBackendEnabled — the per-export runtime flip", () => {
  it("follows the runtime override when one is set, else the init-time value", () => {
    expect(
      effectiveOtelBackendEnabled(false, { "backend.enabled": { value: true } }),
    ).toBe(true);
    expect(
      effectiveOtelBackendEnabled(true, { "backend.enabled": { value: false } }),
    ).toBe(false);
    expect(effectiveOtelBackendEnabled(false, {})).toBe(false);
    expect(effectiveOtelBackendEnabled(true, {})).toBe(true);
  });

  it("ignores an invalid runtime override (the init-time value governs)", () => {
    expect(
      effectiveOtelBackendEnabled(false, { "backend.enabled": { value: "maybe" } }),
    ).toBe(false);
    expect(
      effectiveOtelBackendEnabled(true, { "backend.enabled": { value: "maybe" } }),
    ).toBe(true);
  });
});

describe("createOtelBackendFanOutTransport — the Grafana fan-out leg", () => {
  /** A recording archive transport (the in-process ingestion handler). */
  function recordingArchive(status = 202) {
    const bodies: Uint8Array[] = [];
    const transport: OtelTransport = async (body) => {
      bodies.push(body);
      return { status };
    };
    return { transport, bodies };
  }

  /** A recording fetch stub. */
  function recordingFetch(status = 202) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status } as Response;
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  function failureCollectors() {
    const messages: string[] = [];
    const audits: unknown[] = [];
    return {
      messages,
      audits,
      onError: (message: string) => {
        messages.push(message);
      },
      audit: (async (input: unknown) => {
        audits.push(input);
        return true;
      }) as (input: never) => Promise<boolean>,
    };
  }

  it("does not call the backend when disabled (the default: no attempt at all)", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch();
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: fullEnv(),
      settings: disabledSettings(),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
    });
    const body = new TextEncoder().encode("{}");
    const result = await transport(body, "application/json");
    expect(result.status).toBe(202);
    expect(archive.bodies).toHaveLength(1);
    expect(fetch.calls).toHaveLength(0);
  });

  it("POSTs the OTLP body to <config endpoint>/v1/<signal> with Basic auth when enabled", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch(202);
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: fullEnv(),
      settings: enabledSettings(),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
    });
    const body = new TextEncoder().encode("{\"resourceLogs\":[]}");
    const result = await transport(body, "application/json");
    expect(result.status).toBe(202);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.url).toBe(`${ENDPOINT}/v1/logs`);
    expect(fetch.calls[0]!.init.method).toBe("POST");
    expect(fetch.calls[0]!.init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${INSTANCE_ID}:${API_KEY}`)}`,
    });
    // The OTLP/JSON body is decoded to text for the POST (the
    // Worker's fetch types do not accept a bare Uint8Array).
    expect(fetch.calls[0]!.init.body).toBe("{\"resourceLogs\":[]}");
    expect(archive.bodies).toHaveLength(1);
  });

  it("uses /v1/metrics and /v1/traces for the other signals", async () => {
    for (const [signal, path] of [
      ["metrics", "v1/metrics"],
      ["traces", "v1/traces"],
    ] as const) {
      const archive = recordingArchive();
      const fetch = recordingFetch(202);
      const transport = createOtelBackendFanOutTransport({
        signal,
        env: fullEnv(),
        settings: enabledSettings(),
        archive: archive.transport,
        fetchFn: fetch.fetchFn,
      });
      await transport(new TextEncoder().encode("{}"), "application/json");
      expect(fetch.calls).toHaveLength(1);
      expect(fetch.calls[0]!.url).toBe(`${ENDPOINT}/${path}`);
    }
  });

  it("returns the ARCHIVE status when the backend rejects (the batch is safe in R2)", async () => {
    const archive = recordingArchive(202);
    const fetch = recordingFetch(401);
    const errors = failureCollectors();
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: fullEnv(),
      settings: enabledSettings(),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
      onError: errors.onError,
      audit: errors.audit,
    });
    const result = await transport(new TextEncoder().encode("{}"), "application/json");
    expect(result.status).toBe(202);
    expect(archive.bodies).toHaveLength(1);
    expect(errors.messages).toHaveLength(1);
    expect(errors.messages[0]).toContain(`[${OBS_EXPORT_FAILED}]`);
    expect(errors.messages[0]).toContain("Grafana Cloud");
    expect(errors.messages[0]).toContain("401");
    expect(errors.messages[0]).not.toContain(API_KEY);
    expect(errors.audits).toHaveLength(1);
    const audit = errors.audits[0] as Record<string, unknown>;
    expect(audit.type).toBe(OTEL_BACKEND_EXPORT_FAILED_AUDIT_TYPE);
    expect(audit.actorType).toBe("service");
    expect(audit.actorPrincipalId).toBe(OTEL_BACKEND_AUDIT_ACTOR);
    expect(audit.policyVersion).toBe(IAAA_AUDIT_POLICY_VERSION);
    expect(audit.outcome).toBe("failed");
  });

  it("names a backend failure once per UTC day per signal (no audit-store flood)", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch(500);
    const errors = failureCollectors();
    const time = clock();
    const transport = createOtelBackendFanOutTransport({
      signal: "metrics",
      env: fullEnv(),
      settings: enabledSettings(),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
      onError: errors.onError,
      audit: errors.audit,
      nowMs: time.nowMs,
    });
    const body = new TextEncoder().encode("{}");
    await transport(body, "application/json");
    await transport(body, "application/json");
    await transport(body, "application/json");
    expect(errors.messages).toHaveLength(1);
    expect(errors.messages[0]).toContain(`[${OBS_METRICS_EXPORT_FAILED}]`);
    expect(errors.audits).toHaveLength(1);
    // The next UTC day names the still-failing backend again.
    time.advanceMs(24 * 60 * 60 * 1000);
    await transport(body, "application/json");
    expect(errors.messages).toHaveLength(2);
    expect(errors.audits).toHaveLength(2);
  });

  it("names a fetch throw the same way (network failure, not just HTTP status)", async () => {
    const archive = recordingArchive();
    const errors = failureCollectors();
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const transport = createOtelBackendFanOutTransport({
      signal: "traces",
      env: fullEnv(),
      settings: enabledSettings(),
      archive: archive.transport,
      fetchFn: throwingFetch,
      onError: errors.onError,
      audit: errors.audit,
    });
    const result = await transport(new TextEncoder().encode("{}"), "application/json");
    expect(result.status).toBe(202);
    expect(errors.messages).toHaveLength(1);
    expect(errors.messages[0]).toContain(`[${OBS_TRACES_EXPORT_FAILED}]`);
    expect(errors.messages[0]).toContain("network down");
    expect(errors.messages[0]).not.toContain(API_KEY);
    expect(errors.audits).toHaveLength(1);
  });

  it("does not attempt a fetch when enabled but the API key is missing — and names the secret NAME, never its value", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch();
    const errors = failureCollectors();
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: {},
      settings: enabledSettings(),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
      onError: errors.onError,
      audit: errors.audit,
    });
    const result = await transport(new TextEncoder().encode("{}"), "application/json");
    expect(result.status).toBe(202);
    expect(fetch.calls).toHaveLength(0);
    expect(errors.messages).toHaveLength(1);
    expect(errors.messages[0]).toContain(GRAFANA_CLOUD_API_KEY_ENV);
    expect(errors.messages[0]).not.toContain(API_KEY);
    expect(errors.audits).toHaveLength(1);
  });

  it("does not attempt a fetch when enabled but the config endpoint is missing — and names backend.endpoint", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch();
    const errors = failureCollectors();
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: fullEnv(),
      settings: enabledSettings({ endpoint: "" }),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
      onError: errors.onError,
      audit: errors.audit,
    });
    const result = await transport(new TextEncoder().encode("{}"), "application/json");
    expect(result.status).toBe(202);
    expect(fetch.calls).toHaveLength(0);
    expect(errors.messages).toHaveLength(1);
    expect(errors.messages[0]).toContain("backend.endpoint");
    expect(errors.audits).toHaveLength(1);
  });

  it("applies a runtime flip on the next export (no redeploy, no init)", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch();
    let overrides: Record<string, { value: unknown }> = {};
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: fullEnv(),
      settings: disabledSettings(),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
      getRuntimeOverrides: () => overrides,
    });
    const body = new TextEncoder().encode("{}");
    await transport(body, "application/json");
    expect(fetch.calls).toHaveLength(0);
    overrides = { "backend.enabled": { value: true } };
    await transport(body, "application/json");
    expect(fetch.calls).toHaveLength(1);
    overrides = { "backend.enabled": { value: false } };
    await transport(body, "application/json");
    expect(fetch.calls).toHaveLength(1);
  });

  it("still attempts the backend when the archive throws, then rethrows the archive error", async () => {
    const archiveError = new Error("ingestion down");
    const archive: OtelTransport = async () => {
      throw archiveError;
    };
    const fetch = recordingFetch(202);
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: fullEnv(),
      settings: enabledSettings(),
      archive,
      fetchFn: fetch.fetchFn,
    });
    await expect(
      transport(new TextEncoder().encode("{}"), "application/json"),
    ).rejects.toThrow("ingestion down");
    expect(fetch.calls).toHaveLength(1);
  });

  it("never throws when the audit writer fails (the coded message is the floor)", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch(500);
    const errors = failureCollectors();
    const failingAudit = (async () => false) as (input: never) => Promise<boolean>;
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env: fullEnv(),
      settings: enabledSettings(),
      archive: archive.transport,
      fetchFn: fetch.fetchFn,
      onError: errors.onError,
      audit: failingAudit,
    });
    const result = await transport(new TextEncoder().encode("{}"), "application/json");
    expect(result.status).toBe(202);
    expect(errors.messages).toHaveLength(1);
  });
});

describe("otelServiceResource — service.name on every signal's outbound payload", () => {
  function logsConfig(serviceName: string): OtelLoggingConfig {
    return {
      masterEnabled: true,
      logsExporter: "otlp",
      domains: domainsOn(),
      destinations: { analyticsEngine: true, r2: true, console: true },
      backend: fullSettings({ serviceName }),
    };
  }

  function metricsConfig(serviceName: string): OtelMetricsConfig {
    return {
      masterEnabled: true,
      metricsExporter: "otlp",
      domains: domainsOn(),
      destinations: { analyticsEngine: true, r2: true, console: true },
      settings: {
        exportIntervalMs: 60000,
        freeTierDailyWriteLimit: 100000,
        freeTierDailyReadQueryLimit: 10000,
        healthPipelineMaxFailureRate: 0.05,
        sloResourceRowsReadMaxPct: 0.7,
      },
      backend: fullSettings({ serviceName }),
    };
  }

  function tracesConfig(serviceName: string): OtelTracesConfig {
    return {
      masterEnabled: true,
      tracesExporter: "otlp",
      domains: domainsOn(),
      destinations: { analyticsEngine: true, r2: true, console: true },
      settings: { freeTierDailyWriteLimit: 100000 },
      backend: fullSettings({ serviceName }),
    };
  }

  it("builds a resource with the configured service name (not the SDK unknown_service default)", () => {
    const resource = otelServiceResource(SERVICE_NAME);
    expect(resource.attributes["service.name"]).toBe(SERVICE_NAME);
    // The merge keeps the SDK attributes — the resource is not
    // replaced, only the service name is overridden.
    expect(resource.attributes["telemetry.sdk.name"]).toBe("opentelemetry");
  });

  it("stamps service.name on the logs payload (the archive AND Grafana both get it)", async () => {
    const { transport, bodies } = recordingTransport();
    const { provider, logger } = createOtelLoggerProvider({
      config: logsConfig(SERVICE_NAME),
      transport,
      processor: "simple",
    });
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "test.event",
      attributes: {},
      timestamp: [1_700_000_000, 0],
    });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies).toHaveLength(1);
    const attrs = resourceAttributes(bodies[0]!, "resourceLogs");
    expect(attrs["service.name"]).toBe(SERVICE_NAME);
  });

  it("stamps service.name on the metrics payload", async () => {
    const { transport, bodies } = recordingTransport();
    const { provider, meter } = createOtelMeterProvider({
      config: metricsConfig(SERVICE_NAME),
      transport,
      sink: noopSink(),
    });
    const counter = meter.createCounter("job.runs", { description: "runs", unit: "1" });
    counter.add(3, { job_id: "feed", state: "completed", trigger: "cron" });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const attrs = resourceAttributes(bodies[0]!, "resourceMetrics");
    expect(attrs["service.name"]).toBe(SERVICE_NAME);
  });

  it("stamps service.name on the traces payload", async () => {
    const { transport, bodies } = recordingTransport();
    const { provider, tracer } = createOtelTracerProvider({
      config: tracesConfig(SERVICE_NAME),
      transport,
      sink: noopSink(),
      processor: "simple",
    });
    const span = tracer.startSpan("job.stage.step", {
      attributes: { component: "job-pipeline", step: "feed" },
    });
    span.end();
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies).toHaveLength(1);
    const attrs = resourceAttributes(bodies[0]!, "resourceSpans");
    expect(attrs["service.name"]).toBe(SERVICE_NAME);
  });

  it("stamps an overridden service name on the logs payload (the OTEL_SERVICE_NAME env override)", async () => {
    const { transport, bodies } = recordingTransport();
    const { provider, logger } = createOtelLoggerProvider({
      config: logsConfig("custom-svc"),
      transport,
      processor: "simple",
    });
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "test.event",
      attributes: {},
      timestamp: [1_700_000_000, 0],
    });
    await provider.forceFlush();
    await provider.shutdown();
    expect(bodies).toHaveLength(1);
    const attrs = resourceAttributes(bodies[0]!, "resourceLogs");
    expect(attrs["service.name"]).toBe("custom-svc");
  });
});

describe("OtelTransport — the shared transport shape", () => {
  it("is the same call shape the S1/S2/S3 exporters already use", () => {
    // Structural: (body, contentType) => Promise<{ status }>. The
    // fan-out returns a transport assignable to every provider's
    // OtelTransport (logs, metrics, traces) — no new exporter
    // type, no new exporter built.
    const transport: OtelTransport = async () => ({ status: 202 });
    expect(typeof transport).toBe("function");
  });
});
