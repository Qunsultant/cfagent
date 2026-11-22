/**
 * Issue #5164 (S10, observability program #5080) — the Grafana
 * Cloud OTel backend: wire the Worker's OTLP export to Grafana
 * Cloud behind the `backend.enabled` config switch.
 *
 * TDD Red first: the backend module
 * (src/observability/otelBackend.ts) and the backend resolvers
 * (src/config/otelModes.ts) do not exist yet, so this file
 * fails at import.
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
 *   (glc_...), `Authorization: Basic base64(id:key)`. Three
 *   values, all Worker secrets, never in the repo:
 *   GRAFANA_OTLP_ENDPOINT (the gateway URL from the portal,
 *   `https://otlp-gateway-prod-<region>.grafana.net/otlp`),
 *   GRAFANA_CLOUD_INSTANCE_ID, GRAFANA_CLOUD_API_KEY.
 *   The signal path is appended per signal: /v1/logs,
 *   /v1/metrics, /v1/traces (OTLP/HTTP JSON, the same payload
 *   the ingestion route accepts).
 * - Fail-closed: backend disabled (the default) means no
 *   backend attempt at all. Enabled but unconfigured (a secret
 *   missing, or a non-https endpoint) means no fetch attempt:
 *   the failure is NAMED once per UTC day per signal — one
 *   coded message (the per-signal export-failed code:
 *   OBS-1002 logs / OBS-1006 metrics / OBS-1012 traces) plus
 *   one audit event (type otel.backend.export_failed, actor
 *   system:otel-backend) — and the free-tier path carries on.
 *   A failed POST names the same way, once per day. The
 *   naming never carries a credential value, only secret
 *   NAMES (which variable is missing) and the HTTP status.
 * - The `backend.enabled` switch resolves run > session >
 *   user > runtime > env > file > builtin (OFF), and the
 *   runtime level is consulted PER EXPORT (like the domain
 *   gates), so a flip in the config panel applies on the next
 *   export without a redeploy. The request timeout resolves
 *   at provider init (like the batch settings).
 */
import { describe, it, expect } from "vitest";
import {
  GRAFANA_CLOUD_API_KEY_ENV,
  GRAFANA_CLOUD_INSTANCE_ID_ENV,
  GRAFANA_OTLP_ENDPOINT_ENV,
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
} from "../src/config/otelModes";
import {
  OBS_EXPORT_FAILED,
  OBS_METRICS_EXPORT_FAILED,
  OBS_TRACES_EXPORT_FAILED,
} from "../src/observability/otelMessages";
import { IAAA_AUDIT_POLICY_VERSION } from "../src/security/iaaaAudit";
import type { OtelTransport } from "../src/observability/otelLogs";

const ENDPOINT = "https://otlp-gateway-prod-us-central-0.grafana.net/otlp";
const INSTANCE_ID = "1234567";
const API_KEY = "glc_test_api_key_value";

function fullEnv(): Record<string, unknown> {
  return {
    [GRAFANA_OTLP_ENDPOINT_ENV]: ENDPOINT,
    [GRAFANA_CLOUD_INSTANCE_ID_ENV]: INSTANCE_ID,
    [GRAFANA_CLOUD_API_KEY_ENV]: API_KEY,
  };
}

function disabledSettings(overrides: Partial<OtelBackendSettings> = {}): OtelBackendSettings {
  return { enabled: false, requestTimeoutMs: 10000, ...overrides };
}

function enabledSettings(overrides: Partial<OtelBackendSettings> = {}): OtelBackendSettings {
  return { enabled: true, requestTimeoutMs: 10000, ...overrides };
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

describe("resolveOtelBackendCredentials — the three Worker secrets", () => {
  it("is configured when all three secrets are set with an https endpoint", () => {
    const r = resolveOtelBackendCredentials(fullEnv());
    expect(r.configured).toBe(true);
    if (!r.configured) return;
    expect(r.credentials.endpoint).toBe(ENDPOINT);
    expect(r.credentials.instanceId).toBe(INSTANCE_ID);
    expect(r.credentials.apiKey).toBe(API_KEY);
  });

  it("strips a trailing slash from the endpoint", () => {
    const env = fullEnv();
    env[GRAFANA_OTLP_ENDPOINT_ENV] = `${ENDPOINT}/`;
    const r = resolveOtelBackendCredentials(env);
    expect(r.configured).toBe(true);
    if (!r.configured) return;
    expect(r.credentials.endpoint).toBe(ENDPOINT);
  });

  it("is not configured when a secret is missing, and names the missing variable", () => {
    for (const missing of [
      GRAFANA_OTLP_ENDPOINT_ENV,
      GRAFANA_CLOUD_INSTANCE_ID_ENV,
      GRAFANA_CLOUD_API_KEY_ENV,
    ]) {
      const env = fullEnv();
      delete env[missing];
      const r = resolveOtelBackendCredentials(env);
      expect(r.configured).toBe(false);
      if (r.configured) continue;
      expect(r.problems.join(" ")).toContain(missing);
    }
  });

  it("treats blank secrets as missing", () => {
    const env = fullEnv();
    env[GRAFANA_CLOUD_API_KEY_ENV] = "   ";
    const r = resolveOtelBackendCredentials(env);
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(r.problems.join(" ")).toContain(GRAFANA_CLOUD_API_KEY_ENV);
  });

  it("rejects a non-https endpoint (Basic auth must never go over plaintext)", () => {
    const env = fullEnv();
    env[GRAFANA_OTLP_ENDPOINT_ENV] = "http://otlp-gateway-prod-us-central-0.grafana.net/otlp";
    const r = resolveOtelBackendCredentials(env);
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(r.problems.join(" ")).toContain(GRAFANA_OTLP_ENDPOINT_ENV);
  });
});

describe("resolveOtelBackendSettings — the backend switch", () => {
  it("defaults to OFF with a 10s timeout (the free-tier path stays the default)", () => {
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.enabled).toBe(false);
    expect(OTEL_BACKEND_SETTINGS_BUILTIN.requestTimeoutMs).toBe(10000);
    const r = resolveOtelBackendSettings({
      enabled: { file: false },
      requestTimeoutMs: { file: 10000 },
    });
    expect(r.settings.enabled).toBe(false);
    expect(r.settings.requestTimeoutMs).toBe(10000);
    expect(r.invalid).toBe(false);
  });

  it("resolves enabled=true from env over the file default", () => {
    const r = resolveOtelBackendSettings({
      enabled: { env: "true", file: false },
      requestTimeoutMs: { file: 10000 },
    });
    expect(r.settings.enabled).toBe(true);
  });

  it("resolves the runtime level over env and file (the S7 flip)", () => {
    const r = resolveOtelBackendSettings({
      enabled: { runtime: true, env: "false", file: false },
      requestTimeoutMs: { file: 10000 },
    });
    expect(r.settings.enabled).toBe(true);
  });

  it("fails closed to OFF on an unrecognized enabled value", () => {
    const r = resolveOtelBackendSettings({
      enabled: { env: "maybe", file: true },
      requestTimeoutMs: { file: 10000 },
    });
    expect(r.settings.enabled).toBe(false);
    expect(r.invalid).toBe(true);
  });

  it("fails closed to the 10s timeout on an invalid timeout value", () => {
    const r = resolveOtelBackendSettings({
      enabled: { file: false },
      requestTimeoutMs: { env: "0", file: 10000 },
    });
    expect(r.settings.requestTimeoutMs).toBe(10000);
    expect(r.invalid).toBe(true);
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

  it("POSTs the OTLP body to <endpoint>/v1/<signal> with Basic auth when enabled", async () => {
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

  it("does not attempt a fetch when enabled but unconfigured — and names the missing secret NAME, never its value", async () => {
    const archive = recordingArchive();
    const fetch = recordingFetch();
    const errors = failureCollectors();
    const env = fullEnv();
    delete env[GRAFANA_CLOUD_API_KEY_ENV];
    const transport = createOtelBackendFanOutTransport({
      signal: "logs",
      env,
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
