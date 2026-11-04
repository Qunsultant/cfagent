/**
 * Issue #3169 (program #2218, slice) — tenant delivery-channel
 * administration routes.
 *
 * Operator-gated with the same store-operator idiom as the
 * tenant slice (#2221): env COMMERCIAL_STORE_OPERATORS UNION
 * the store list, empty = deny all. No login is 401, a
 * non-operator is 403, an unbound store is 503. A tenant id in
 * a path names the operator's ADMINISTRATION target, never the
 * caller's scope. Tests inject every port: no DO, no D1, no
 * network. Enablement flags only — the routes never accept a
 * URL, token, or secret.
 */
import { describe, it, expect } from "vitest";
import { handlePlatformChannelRoutes } from "../src/agents/routes/platformChannels";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import { DEFAULT_TENANT_CHANNELS } from "../src/data/tenantChannelPorts";

function ctx(overrides: Record<string, unknown> = {}) {
  const channels = new InMemoryTenantChannelAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("tenant-a", ["alice"]);
  return {
    channels,
    directory,
    operators: {
      listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }],
    },
    ...overrides,
  };
}

function req(path: string, method: string, login: string | null, body?: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(
  c: ReturnType<typeof ctx>,
  path: string,
  method: string,
  login: string | null = "op",
  body?: unknown,
) {
  const env = { COMMERCIAL_STORE_OPERATORS: "" };
  const res = await handlePlatformChannelRoutes(
    req(path, method, login, body),
    new URL(`https://worker.test${path}`),
    path,
    "session-1",
    { env, ...c } as never,
  );
  return { res, body: (await res?.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("platform channel routes: gate (#3169)", () => {
  it("401 without a login, 403 for a non-operator", async () => {
    const c = ctx();
    const noLogin = await call(c, "/platform-channels/tenant-a", "GET", null);
    expect(noLogin.res?.status).toBe(401);
    const stranger = await call(c, "/platform-channels/tenant-a", "GET", "mallory");
    expect(stranger.res?.status).toBe(403);
  });

  it("503 when the channel store is unbound", async () => {
    const c = ctx({ channels: null });
    const { res } = await call(c, "/platform-channels/tenant-a", "GET");
    expect(res?.status).toBe(503);
  });

  it("404 for an unknown tenant", async () => {
    const c = ctx();
    const { res } = await call(c, "/platform-channels/nope", "GET");
    expect(res?.status).toBe(404);
  });

  it("returns null for paths it does not own", async () => {
    const c = ctx();
    const res = await handlePlatformChannelRoutes(
      req("/platform-tenants", "GET", "op"),
      new URL("https://worker.test/platform-tenants"),
      "/platform-tenants",
      "session-1",
      { env: { COMMERCIAL_STORE_OPERATORS: "" }, ...c } as never,
    );
    expect(res).toBeNull();
  });
});

describe("platform channel routes: read and patch (#3169)", () => {
  it("GET reads defaults for a tenant with no channel row", async () => {
    const c = ctx();
    const { res, body } = await call(c, "/platform-channels/tenant-a", "GET");
    expect(res?.status).toBe(200);
    expect(body.channels).toEqual(DEFAULT_TENANT_CHANNELS);
  });

  it("PATCH applies a partial patch and GET reads it back", async () => {
    const c = ctx();
    const patched = await call(c, "/platform-channels/tenant-a/channels", "PATCH", "op", {
      channels: { slack: false, docs: false },
    });
    expect(patched.res?.status).toBe(200);
    expect(patched.body.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, slack: false, docs: false });
    const reread = await call(c, "/platform-channels/tenant-a", "GET");
    expect(reread.body.channels).toEqual({ ...DEFAULT_TENANT_CHANNELS, slack: false, docs: false });
  });

  it("PATCH rejects unknown channels, non-booleans, and empty patches", async () => {
    const c = ctx();
    const unknown = await call(c, "/platform-channels/tenant-a/channels", "PATCH", "op", {
      channels: { smoke: true },
    });
    expect(unknown.res?.status).toBe(400);
    const nonBoolean = await call(c, "/platform-channels/tenant-a/channels", "PATCH", "op", {
      channels: { slack: "no" },
    });
    expect(nonBoolean.res?.status).toBe(400);
    const empty = await call(c, "/platform-channels/tenant-a/channels", "PATCH", "op", {
      channels: {},
    });
    expect(empty.res?.status).toBe(400);
    const missing = await call(c, "/platform-channels/tenant-a/channels", "PATCH", "op", {});
    expect(missing.res?.status).toBe(400);
  });

  it("PATCH with a wrong method is 405, GET on the patch path is 405", async () => {
    const c = ctx();
    const wrong = await call(c, "/platform-channels/tenant-a/channels", "POST", "op", {
      channels: { slack: false },
    });
    expect(wrong.res?.status).toBe(405);
    const getPatch = await call(c, "/platform-channels/tenant-a/channels", "GET");
    expect(getPatch.res?.status).toBe(405);
  });
});
