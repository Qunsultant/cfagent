/**
 * Issue #2221 (program #2218, slice 3) — tenant administration surface.
 *
 * Operator routes for tenant create / list / settings / detail, plus the
 * tenant directory port (D1 + in-memory). Membership MANAGEMENT is out
 * of scope here by design: membership writes stay in the CISO-owned
 * IAAA surfaces, and this slice's membership view comes from the
 * existing IAAA read path (GET /api/iaaa/memberships, filtered by
 * tenant on the client) — the server routes below never mutate IAAA
 * state. Tests inject every port: no DO, no D1, no network.
 *
 * Gate: effective operators = env COMMERCIAL_STORE_OPERATORS UNION
 * the store list (#2680, empty = deny all). No login is 401, a
 * non-operator is 403, an unbound store is 503. Session scoping
 * always: the operator login comes from the verified session
 * header (x-user-login); a tenant id in a path or body names the
 * operator's ADMINISTRATION target, never the caller's scope.
 */
import { describe, it, expect } from "vitest";
import { handlePlatformTenantRoutes } from "../src/agents/routes/platformTenants";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import type { TenantDirectory } from "../src/data/tenantDirectoryPorts";

function ctx(overrides: Record<string, unknown> = {}) {
  const commercial = new InMemoryCommercialAdapter();
  const directory = new InMemoryTenantDirectoryAdapter();
  return {
    commercial,
    directory,
    operators: {
      listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }],
    },
    ...overrides,
  };
}

async function seed(c: ReturnType<typeof ctx>) {
  await c.commercial.upsertAccount({
    userId: "alice",
    tenantId: "tenant-a",
    tier: "PayPerUse",
    creditsUSD: 5,
    includedRuns: 2,
  });
  await c.commercial.upsertAccount({
    userId: "bob",
    tenantId: "tenant-a",
    tier: "Free",
  });
  c.directory.seedTenant("tenant-a", ["alice", "bob"]);
  c.directory.seedTenant("tenant-b", []);
  await c.commercial.setTenantAdsEnabled("tenant-b", false);
}

function req(
  path: string,
  method: string,
  login: string | null,
  body?: unknown,
): Request {
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
  const res = await handlePlatformTenantRoutes(req(path, method, login, body), new URL(`https://worker.test${path}`), path, "session-1", {
    env: env as never,
    commercial: c.commercial as never,
    directory: c.directory as never,
    operators: c.operators as never,
  });
  return res;
}

describe("tenant admin gate (#2221)", () => {
  it("401 without a verified login; 403 for a non-operator; null for an unmatched path", async () => {
    const c = ctx();
    await seed(c);
    expect((await call(c, "/platform-tenants", "GET", null))?.status).toBe(401);
    expect((await call(c, "/platform-tenants", "GET", "mallory"))?.status).toBe(403);
    expect(await call(c, "/unrelated", "GET")).toBeNull();
  });

  it("503 when the store is unbound, after an operator passes the gate", async () => {
    const res = await handlePlatformTenantRoutes(
      req("/platform-tenants", "GET", "op"),
      new URL("https://worker.test/platform-tenants"),
      "/platform-tenants",
      "session-1",
      {
        env: {} as never,
        commercial: null,
        directory: null,
        operators: { listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }] } as never,
      },
    );
    expect(res?.status).toBe(503);
  });

  it("env-list operators are admitted when the store list is empty", async () => {
    const c = ctx({ operators: { listOperators: async () => [] } });
    await seed(c);
    const res = await handlePlatformTenantRoutes(
      req("/platform-tenants", "GET", "env-op"),
      new URL("https://worker.test/platform-tenants"),
      "/platform-tenants",
      "session-1",
      {
        env: { COMMERCIAL_STORE_OPERATORS: "env-op" } as never,
        commercial: c.commercial as never,
        directory: c.directory as never,
        operators: c.operators as never,
      },
    );
    expect(res?.status).toBe(200);
  });
});

describe("tenant list / create / detail / settings (#2221)", () => {
  it("list returns every directory tenant with settings composed from the commercial store", async () => {
    const c = ctx();
    await seed(c);
    const res = await call(c, "/platform-tenants", "GET");
    expect(res?.status).toBe(200);
    const data = (await res!.json()) as {
      tenants: { tenantId: string; adsEnabled: boolean; memberCount: number }[];
    };
    expect(data.tenants.map((t) => t.tenantId)).toEqual(["tenant-a", "tenant-b"]);
    const b = data.tenants.find((t) => t.tenantId === "tenant-b")!;
    expect(b.adsEnabled).toBe(false);
    expect(b.memberCount).toBe(0);
    const a = data.tenants.find((t) => t.tenantId === "tenant-a")!;
    expect(a.adsEnabled).toBe(true); // absent settings row = ads enabled
    expect(a.memberCount).toBe(2);
  });

  it("create writes a settings row with store defaults and re-create is an idempotent 200", async () => {
    const c = ctx();
    await seed(c);
    const created = await call(c, "/platform-tenants", "POST", "op", { tenantId: "tenant-c" });
    expect(created?.status).toBe(201);
    const data = (await created!.json()) as { tenant: { tenantId: string; adsEnabled: boolean } };
    expect(data.tenant.tenantId).toBe("tenant-c");
    expect(data.tenant.adsEnabled).toBe(true);
    // A seeded tenant re-creates idempotently (no duplicate, no 409).
    const again = await call(c, "/platform-tenants", "POST", "op", { tenantId: "tenant-b" });
    expect(again?.status).toBe(200);
    const againData = (await again!.json()) as { tenant: { tenantId: string; adsEnabled: boolean } };
    expect(againData.tenant).toMatchObject({ tenantId: "tenant-b", adsEnabled: false });
    expect((await call(c, "/platform-tenants", "POST", "op", { tenantId: "bad id" }))?.status).toBe(400);
    expect((await call(c, "/platform-tenants", "POST", "op", {}))?.status).toBe(400);
  });

  it("detail 404s on an unknown tenant and shows account-row members for a known one", async () => {
    const c = ctx();
    await seed(c);
    expect((await call(c, "/platform-tenants/nope", "GET"))?.status).toBe(404);
    const res = await call(c, "/platform-tenants/tenant-a", "GET");
    expect(res?.status).toBe(200);
    const data = (await res!.json()) as {
      tenant: {
        tenantId: string;
        members: { userId: string; hasAccount: boolean; tier: string; creditsUSD: number }[];
      };
    };
    expect(data.tenant.tenantId).toBe("tenant-a");
    expect(data.tenant.members.map((m) => m.userId)).toEqual(["alice", "bob"]);
    // Same authority as slice 1 (#2219): the account row is the identity.
    expect(data.tenant.members[0]).toMatchObject({
      hasAccount: true,
      tier: "PayPerUse",
      creditsUSD: 5,
    });
  });

  it("settings PATCH applies only the fields present and rejects bad values", async () => {
    const c = ctx();
    await seed(c);
    const res = await call(c, "/platform-tenants/tenant-a/settings", "PATCH", "op", {
      adsEnabled: false,
      autoRefresh: { enabled: true, intervalS: 30 },
      providers: { dataProviderId: "etrade", brokerId: "etrade" },
    });
    expect(res?.status).toBe(200);
    const data = (await res!.json()) as {
      tenant: {
        adsEnabled: boolean;
        autoRefreshEnabled: boolean;
        autoRefreshIntervalS: number;
        dataProviderId: string;
      };
    };
    expect(data.tenant.adsEnabled).toBe(false);
    expect(data.tenant.autoRefreshEnabled).toBe(true);
    expect(data.tenant.autoRefreshIntervalS).toBe(30);
    expect(data.tenant.dataProviderId).toBe("etrade");
    expect((await call(c, "/platform-tenants/tenant-a/settings", "PATCH", "op", {}))?.status).toBe(400);
    expect(
      (await call(c, "/platform-tenants/tenant-a/settings", "PATCH", "op", {
        autoRefresh: { enabled: true, intervalS: 0 },
      }))?.status,
    ).toBe(400);
    expect((await call(c, "/platform-tenants/nope/settings", "PATCH", "op", { adsEnabled: true }))?.status).toBe(404);
  });

  it("wrong methods are 405 and unknown sub-paths fall through to null", async () => {
    const c = ctx();
    await seed(c);
    expect((await call(c, "/platform-tenants", "DELETE"))?.status).toBe(405);
    expect(await call(c, "/platform-tenants/tenant-a/bogus", "GET")).toBeNull();
  });
});

describe("in-memory tenant directory port (#2221)", () => {
  it("lists seeded tenants sorted and members per tenant", async () => {
    const d: TenantDirectory = new InMemoryTenantDirectoryAdapter();
    d.seedTenant("tenant-b", []);
    d.seedTenant("tenant-a", ["bob", "alice"]);
    expect(await d.listTenantIds()).toEqual(["tenant-a", "tenant-b"]);
    expect(await d.listTenantMembers("tenant-a")).toEqual(["alice", "bob"]);
    expect(await d.listTenantMembers("tenant-b")).toEqual([]);
    expect(await d.listTenantMembers("unknown")).toEqual([]);
  });
});
