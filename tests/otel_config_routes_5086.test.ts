/**
 * Issue #5086 (S7, observability program #5080) — the OTel
 * config HTTP routes (GET/POST/DELETE /api/otel/v1/config).
 *
 * The routes are the admin surface for the message catalog +
 * the runtime config port. Gating follows the IAAA admin
 * pattern exactly (requireAuth → live platform-admin
 * membership, fail-closed): 401 unauthenticated, 403 with a
 * coded OBS-1022 message + deny audit for a signed-in
 * non-admin, 500 when the admin check itself fails.
 *
 * The tests run the REAL config port against a fake in-memory
 * D1, so a POST really writes a versioned row and a GET
 * really reads it back: changing a severity or threshold is a
 * config edit (a D1 row), not a code change — the GET
 * effective value moves with no code involved. An unknown key
 * is rejected (400), never silently stored.
 *
 * Note on order: the route module was written before this
 * file (the catalog + config-port suites were TDD Red-first);
 * these tests were written to the filed spec and first run
 * against the finished route — see the PR's test evidence.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  OTEL_CONFIG_ROUTE,
  buildEffectiveOtelConfig,
  handleOtelConfigRoutes,
  type OtelConfigRouteDeps,
} from "../src/server/routes/otelConfig";
import { createOtelConfigPort, resetOtelRuntimeOverrideCache } from "../src/config/otelConfigPort";
import type { Env, SessionData } from "../src/types";
import type { CreateIaaaAuditEventInput } from "../src/security/iaaaAudit";

interface OverrideRow {
  config_key: string;
  value_json: string | null;
  version: number;
  updated_by: string;
  updated_at_ms: number;
  reason: string;
}

/** A fake D1 holding otel_config_overrides rows in memory. */
class MemoryD1 {
  readonly rows: OverrideRow[] = [];
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  } {
    const rows = this.rows;
    return {
      bind(...params: unknown[]) {
        return {
          async all<T>(): Promise<{ results: T[] }> {
            if (sql.trimStart().toUpperCase().startsWith("SELECT")) {
              return { results: [...rows] as unknown as T[] };
            }
            return { results: [] as unknown as T[] };
          },
          async run(): Promise<unknown> {
            if (sql.trimStart().toUpperCase().startsWith("INSERT")) {
              rows.push({
                config_key: params[0] as string,
                value_json: params[1] as string | null,
                version: params[2] as number,
                updated_by: params[3] as string,
                updated_at_ms: params[4] as number,
                reason: params[5] as string,
              });
            }
            return {};
          },
        };
      },
    };
  }
}

const ADMIN_SESSION = {
  githubLogin: "owner",
  internalUserId: "user-owner",
} as unknown as SessionData;

function buildDeps(overrides: Partial<OtelConfigRouteDeps> = {}): {
  deps: OtelConfigRouteDeps;
  auditCalls: CreateIaaaAuditEventInput[];
  d1: MemoryD1;
  env: Env;
} {
  const auditCalls: CreateIaaaAuditEventInput[] = [];
  const d1 = new MemoryD1();
  const deps: OtelConfigRouteDeps = {
    requireSession: async () => ADMIN_SESSION,
    isPlatformAdmin: async () => true,
    audit: async (_env, input) => {
      auditCalls.push(input);
      return true;
    },
    createConfigPort: (env) =>
      createOtelConfigPort({
        d1: env.AGENT_DB as never,
        audit: async (input) => {
          auditCalls.push(input);
          return true;
        },
        tenantId: "test-tenant",
      }),
    ...overrides,
  };
  const env = { AGENT_DB: d1 } as unknown as Env;
  return { deps, auditCalls, d1, env };
}

async function call(
  path: string,
  deps: OtelConfigRouteDeps,
  env: Env,
  method = "GET",
  body?: unknown,
): Promise<Response | null> {
  const request = new Request(`https://agent.internal${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  return handleOtelConfigRoutes(request, env, new URL(request.url), path.split("?")[0], deps);
}

async function callJson(
  path: string,
  deps: OtelConfigRouteDeps,
  env: Env,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await call(path, deps, env, method, body);
  if (!res) throw new Error(`expected a Response for ${method} ${path}, got null`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  // The override cache is module-global: reset it so each
  // test reads its own fake D1.
  resetOtelRuntimeOverrideCache();
});

describe("handleOtelConfigRoutes — dispatch + gating", () => {
  it("falls through (null) for unrelated paths", async () => {
    const { deps, env } = buildDeps();
    expect(await call("/api/otel/v1/logs", deps, env, "POST")).toBeNull();
    expect(await call("/api/telemetry/summary", deps, env)).toBeNull();
  });

  it("rejects other methods with 405 and Allow: GET, POST, DELETE", async () => {
    const { deps, env } = buildDeps();
    const res = await call(OTEL_CONFIG_ROUTE, deps, env, "PUT");
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("GET, POST, DELETE");
  });

  it("401 when there is no session", async () => {
    const { deps, env } = buildDeps({ requireSession: async () => null });
    const { status, body } = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("403 with OBS-1022 + a deny audit for a signed-in non-admin", async () => {
    const { deps, env, auditCalls } = buildDeps({ isPlatformAdmin: async () => false });
    const { status, body } = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    expect(status).toBe(403);
    expect(body.code).toBe("OBS-1022");
    expect(body.error).toContain("platform admins only");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.decision).toBe("deny");
    expect(auditCalls[0]?.errorCode).toBe("OTEL_CONFIG_FORBIDDEN");
  });

  it("500 when the platform-admin check itself fails (fail closed, not a 403)", async () => {
    const { deps, env } = buildDeps({
      isPlatformAdmin: async () => {
        throw new Error("membership store down");
      },
    });
    const { status } = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    expect(status).toBe(500);
  });
});

describe("handleOtelConfigRoutes — GET (catalog + keys + overrides + effective)", () => {
  it("returns the catalog, the key allow-list, no overrides, and the deploy-time effective values", async () => {
    const { deps, env } = buildDeps();
    const { status, body } = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    expect(status).toBe(200);
    // The catalog: every pre-existing OBS code is in it.
    const codes = (body.catalog as Array<{ code: string }>).map((c) => c.code);
    for (const code of ["OBS-1001", "OBS-1006", "OBS-1007", "OBS-1012", "OBS-1013", "OBS-1014", "OBS-1019", "OBS-1020", "OBS-1022"]) {
      expect(codes).toContain(code);
    }
    const catalog1001 = (body.catalog as Array<{ code: string; severity: string }>).find(
      (c) => c.code === "OBS-1001",
    );
    expect(catalog1001?.severity).toBe("warning");
    // The allow-list: thresholds, severities, retention,
    // sampling — including a per-code severity key.
    const keys = (body.keys as Array<{ key: string }>).map((k) => k.key);
    expect(keys).toContain("enabled");
    expect(keys).toContain("alerting.maxAlertsPerDay");
    expect(keys).toContain("backend.enabled");
    expect(keys).toContain("backend.requestTimeoutMs");
    expect(keys).toContain("archive.pageSize");
    expect(keys).toContain("catalog.OBS-1001.severity");
    expect(keys).toContain("domains.j1j7.enabled");
    // No overrides yet; the effective values are the
    // deploy-time (file) values with source "file".
    expect(body.overrides).toEqual([]);
    expect(body.effective.enabled.value).toBe(true);
    expect(body.effective.enabled.source).toBe("file");
    expect(body.effective["alerting.maxAlertsPerDay"].value).toBe(100);
    expect(body.effective["alerting.maxAlertsPerDay"].source).toBe("file");
    expect(body.effective["catalog.OBS-1001.severity"].value).toBe("warning");
    expect(body.effective["catalog.OBS-1001.severity"].source).toBe("catalog");
  });
});

describe("handleOtelConfigRoutes — POST (apply) + DELETE (clear)", () => {
  it("a threshold flip is a config edit, not a code change: POST moves the effective value and its source to runtime", async () => {
    const { deps, env, d1, auditCalls } = buildDeps();
    const before = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    expect(before.body.effective["alerting.maxAlertsPerDay"].value).toBe(100);

    const applied = await callJson(OTEL_CONFIG_ROUTE, deps, env, "POST", {
      key: "alerting.maxAlertsPerDay",
      value: 25,
      reason: "tighten the free-tier guard for the incident",
    });
    expect(applied.status).toBe(200);
    expect(applied.body.record.key).toBe("alerting.maxAlertsPerDay");
    expect(applied.body.record.value).toBe(25);
    expect(applied.body.record.version).toBe(1);
    expect(applied.body.record.updatedBy).toBe("user-owner");
    expect(d1.rows).toHaveLength(1);
    // The change is audited (the port's attributable record).
    expect(auditCalls.some((a) => a.type === "otel.config.runtime_override")).toBe(true);

    const after = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    expect(after.body.effective["alerting.maxAlertsPerDay"].value).toBe(25);
    expect(after.body.effective["alerting.maxAlertsPerDay"].source).toBe("runtime");
    expect(after.body.overrides).toHaveLength(1);
  });

  it("a severity flip is a config edit: POST moves the catalog severity to runtime without touching the catalog", async () => {
    const { deps, env } = buildDeps();
    const applied = await callJson(OTEL_CONFIG_ROUTE, deps, env, "POST", {
      key: "catalog.OBS-1001.severity",
      value: "critical",
      reason: "config errors are critical during the migration",
    });
    expect(applied.status).toBe(200);
    expect(applied.body.record.value).toBe("critical");

    const after = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    // The catalog entry itself still carries its default
    // (OBS-1001 is a warning in the catalog).
    const catalog1001 = (after.body.catalog as Array<{ code: string; severity: string }>).find(
      (c) => c.code === "OBS-1001",
    );
    expect(catalog1001?.severity).toBe("warning");
    // The EFFECTIVE severity is the override.
    expect(after.body.effective["catalog.OBS-1001.severity"].value).toBe("critical");
    expect(after.body.effective["catalog.OBS-1001.severity"].source).toBe("runtime");
  });

  it("rejects an unknown key (400) — never silently stored", async () => {
    const { deps, env, d1 } = buildDeps();
    const { status, body } = await callJson(OTEL_CONFIG_ROUTE, deps, env, "POST", {
      key: "telemetry.secret",
      value: true,
      reason: "trying to invent a key",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("unknown config key");
    expect(d1.rows).toHaveLength(0);
  });

  it("rejects a missing reason (400) — every change is audited with a reason", async () => {
    const { deps, env, d1 } = buildDeps();
    const { status, body } = await callJson(OTEL_CONFIG_ROUTE, deps, env, "POST", {
      key: "alerting.maxAlertsPerDay",
      value: 25,
      reason: "   ",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("a reason is required");
    expect(d1.rows).toHaveLength(0);
  });

  it("rejects an invalid value (400) with the OBS-1001 code in the message", async () => {
    const { deps, env, d1 } = buildDeps();
    const { status, body } = await callJson(OTEL_CONFIG_ROUTE, deps, env, "POST", {
      key: "enabled",
      value: "maybe",
      reason: "an unrecognized switch value",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("OBS-1001");
    expect(d1.rows).toHaveLength(0);
  });

  it("rejects a malformed body (400)", async () => {
    const { deps, env } = buildDeps();
    const request = new Request(`https://agent.internal${OTEL_CONFIG_ROUTE}`, {
      method: "POST",
      body: "not json{",
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleOtelConfigRoutes(
      request,
      env,
      new URL(request.url),
      OTEL_CONFIG_ROUTE,
      deps,
    );
    expect(res?.status).toBe(400);
  });

  it("DELETE clears the override (tombstone): the effective value returns to the deploy-time value", async () => {
    const { deps, env, d1 } = buildDeps();
    await callJson(OTEL_CONFIG_ROUTE, deps, env, "POST", {
      key: "alerting.maxAlertsPerDay",
      value: 25,
      reason: "tighten the guard",
    });
    const cleared = await callJson(
      `${OTEL_CONFIG_ROUTE}?key=alerting.maxAlertsPerDay&reason=incident%20over`,
      deps,
      env,
      "DELETE",
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.key).toBe("alerting.maxAlertsPerDay");
    // Two rows: the apply + the tombstone.
    expect(d1.rows).toHaveLength(2);
    expect(d1.rows[1]?.value_json).toBeNull();

    const after = await callJson(OTEL_CONFIG_ROUTE, deps, env);
    expect(after.body.overrides).toEqual([]);
    expect(after.body.effective["alerting.maxAlertsPerDay"].value).toBe(100);
    expect(after.body.effective["alerting.maxAlertsPerDay"].source).toBe("file");
  });

  it("DELETE of a key with no override set is 404", async () => {
    const { deps, env } = buildDeps();
    const { status, body } = await callJson(
      `${OTEL_CONFIG_ROUTE}?key=alerting.maxAlertsPerDay&reason=nothing%20to%20clear`,
      deps,
      env,
      "DELETE",
    );
    expect(status).toBe(404);
    expect(body.error).toContain("no override set");
  });

  it("DELETE requires ?key= and a reason (400)", async () => {
    const { deps, env } = buildDeps();
    const noKey = await callJson(`${OTEL_CONFIG_ROUTE}?reason=x`, deps, env, "DELETE");
    expect(noKey.status).toBe(400);
    const noReason = await callJson(
      `${OTEL_CONFIG_ROUTE}?key=alerting.maxAlertsPerDay`,
      deps,
      env,
      "DELETE",
    );
    expect(noReason.status).toBe(400);
  });

  it("POST with D1 unbound fails closed with 503 (the store is unavailable)", async () => {
    const { deps, env } = buildDeps({
      createConfigPort: (env) =>
        createOtelConfigPort({
          d1: null,
          audit: async () => true,
          tenantId: "test-tenant",
        }),
    });
    const { status, body } = await callJson(OTEL_CONFIG_ROUTE, deps, env, "POST", {
      key: "alerting.maxAlertsPerDay",
      value: 25,
      reason: "D1 is down",
    });
    expect(status).toBe(503);
    expect(body.error).toContain("unbound");
  });
});

describe("buildEffectiveOtelConfig — per-key effective values", () => {
  it("resolves every allow-list key (no key is left without an effective value)", async () => {
    const { env } = buildDeps();
    const effective = buildEffectiveOtelConfig(env, {});
    // Every key the admin can flip has an effective value.
    const { otelRuntimeOverrideKeys } = await import("../src/config/otelConfigPort");
    for (const def of otelRuntimeOverrideKeys()) {
      expect(effective[def.key]).toBeDefined();
      expect(effective[def.key]?.value).not.toBeUndefined();
      expect(effective[def.key]?.source).toMatch(/^(runtime|env|file|builtin|catalog)$/);
    }
  });
});
