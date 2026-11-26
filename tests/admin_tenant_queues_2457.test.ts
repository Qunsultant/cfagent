/**
 * Issue #2457 — cross-tenant queue routes (platform admin manages all tenants).
 *
 * The routes run in the admin's own instance and fan out to member
 * instances via stub fetch. Tests inject every store and the fan-out
 * stub: no DO, no network. The gate mirrors #2331 slice 1 exactly
 * (x-user-login -> alias -> internalUserId -> isPlatformAdmin).
 */
import { describe, it, expect, vi } from "vitest";
import { handleAdminTenantQueueRoutes } from "../src/agents/routes/adminTenantQueues";
import type { Membership } from "../src/security/authorization";

function membership(
  membershipId: string,
  internalUserId: string,
  tenantId: string,
  role: Membership["roleBindings"][number]["role"],
  scope: Membership["roleBindings"][number]["scope"],
): Membership {
  return {
    membershipId,
    internalUserId,
    tenantId,
    roleBindings: [{ role, scope, grantedBy: "test" }],
    createdBy: "test",
    createdAtMs: 1,
  };
}

const ADMIN_MEMBERSHIPS = [
  membership("m-admin", "user-admin", "primary", "platform-admin", "platform"),
];
const TENANT_ADMIN_MEMBERSHIPS = [
  membership("m-ta", "user-ta", "tenant-a", "tenant-admin", "tenant"),
];
const TENANT_A_MEMBERSHIPS = [
  membership("m1", "user-alice", "tenant-a", "member", "tenant"),
  membership("m2", "user-ghost", "tenant-a", "member", "tenant"),
  membership("m3", "user-bob", "tenant-b", "member", "tenant"),
];

function aliasKv(entries: Record<string, string>) {
  return {
    get: async (key: string) => entries[key] ?? null,
    put: async () => {},
    delete: async () => {},
  };
}

function aliasFor(login: string, internalUserId: string) {
  const record = JSON.stringify({
    githubLogin: login,
    internalUserId,
    recordedAtMs: 1,
    source: "wired-login",
  });
  return {
    [`iaaa-alias:login:${login}`]: record,
    [`iaaa-alias:user:${internalUserId}`]: record,
  };
}

interface TestDeps {
  callerMemberships: Membership[];
  membershipEntries?: Array<{ key: string; value: string }>;
  sessionEntries?: Array<{ key: string; value: string }>;
  /** login -> canned target response */
  targets?: Record<string, { status: number; body: unknown }>;
}

function makeCtx(deps: TestDeps) {
  const audit = vi.fn();
  const forwarded: Array<{ login: string; url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const ctx: Parameters<typeof handleAdminTenantQueueRoutes>[4] = {
    env: {} as never,
    audit,
    aliasKv: aliasKv({
      ...aliasFor("admin", "user-admin"),
      ...aliasFor("alice", "user-alice"),
      ...aliasFor("bob", "user-bob"),
      ...aliasFor("ta", "user-ta"),
    }),
    membershipStore: {
      getMembershipsByUser: async (id: string) =>
        id === "user-admin"
          ? deps.callerMemberships
          : id === "user-ta"
            ? TENANT_ADMIN_MEMBERSHIPS
            : [],
      put: async () => {},
      revokeMembership: async () => false,
    },
    listMembershipEntries: async () =>
      deps.membershipEntries ??
      TENANT_A_MEMBERSHIPS.map((m) => ({
        key: `iaaa-membership:${m.membershipId}`,
        value: JSON.stringify(m),
      })),
    listSessionEntries: async () => deps.sessionEntries ?? [],
    fetchInstance: (login: string) => ({
      fetch: async (req: Request) => {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        forwarded.push({
          login,
          url: req.url,
          method: req.method,
          headers,
          body: await req.json().catch(() => undefined),
        });
        const canned = deps.targets?.[login];
        if (!canned) return new Response("not found", { status: 404 });
        return Response.json(canned.body, { status: canned.status });
      },
    }),
  };
  return { ctx, audit, forwarded };
}

function call(
  ctx: Parameters<typeof handleAdminTenantQueueRoutes>[4],
  path: string,
  init: RequestInit & { login?: string } = {},
) {
  const { login, ...rest } = init;
  const headers = new Headers(rest.headers as HeadersInit | undefined);
  if (login !== undefined) headers.set("x-user-login", login);
  const req = new Request(`https://agent.internal${path}`, { ...rest, headers });
  return handleAdminTenantQueueRoutes(
    req,
    new URL(req.url),
    new URL(req.url).pathname,
    "session",
    ctx,
  );
}

describe("adminTenantQueues (#2457)", () => {
  it("returns null for unrelated paths", async () => {
    const { ctx } = makeCtx({ callerMemberships: ADMIN_MEMBERSHIPS });
    expect(await call(ctx, "/api/schedules", { login: "admin" })).toBeNull();
  });

  it("401 without a session-shaped login", async () => {
    const { ctx } = makeCtx({ callerMemberships: ADMIN_MEMBERSHIPS });
    const res = await call(ctx, "/api/admin/tenants");
    expect(res?.status).toBe(401);
  });

  it("403 without a wired session (no alias record)", async () => {
    const { ctx } = makeCtx({ callerMemberships: ADMIN_MEMBERSHIPS });
    const res = await call(ctx, "/api/admin/tenants", { login: "nobody" });
    expect(res?.status).toBe(403);
  });

  it("403 for a tenant admin on every new route", async () => {
    const { ctx } = makeCtx({ callerMemberships: TENANT_ADMIN_MEMBERSHIPS });
    for (const path of [
      "/api/admin/tenants",
      "/api/admin/tenants/tenant-a/queues/resolve",
      "/api/admin/tenants/tenant-a/queues/dump",
    ]) {
      const res = await call(ctx, path, {
        login: "ta",
        method: path === "/api/admin/tenants" ? "GET" : "POST",
      });
      expect(res?.status).toBe(403);
    }
  });

  it("lists tenants with member counts for a platform admin", async () => {
    const { ctx } = makeCtx({ callerMemberships: ADMIN_MEMBERSHIPS });
    const res = await call(ctx, "/api/admin/tenants", { login: "admin", method: "GET" });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      tenants: Array<{ tenantId: string; memberCount: number }>;
    };
    expect(body.tenants).toEqual([
      { tenantId: "tenant-a", memberCount: 2 },
      { tenantId: "tenant-b", memberCount: 1 },
    ]);
  });

  it("400 for a malformed tenant id", async () => {
    const { ctx } = makeCtx({ callerMemberships: ADMIN_MEMBERSHIPS });
    const res = await call(ctx, "/api/admin/tenants/%20/queues/resolve", {
      login: "admin",
      method: "POST",
    });
    expect(res?.status).toBe(400);
  });

  it("409 with unmapped members when zero logins resolve", async () => {
    const { ctx } = makeCtx({
      callerMemberships: ADMIN_MEMBERSHIPS,
      membershipEntries: [
        {
          key: "iaaa-membership:m9",
          value: JSON.stringify(
            membership("m9", "user-ghost", "tenant-a", "member", "tenant"),
          ),
        },
      ],
    });
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/resolve", {
      login: "admin",
      method: "POST",
    });
    expect(res?.status).toBe(409);
    const body = (await res?.json()) as { unmappedMembers: string[] };
    expect(body.unmappedMembers).toEqual(["user-ghost"]);
  });

  it("resolve discloses resolved logins and unmapped members", async () => {
    const { ctx } = makeCtx({ callerMemberships: ADMIN_MEMBERSHIPS });
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/resolve", {
      login: "admin",
      method: "POST",
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      resolvedLogins: string[];
      unmappedMembers: string[];
    };
    expect(body.resolvedLogins).toEqual(["alice"]);
    expect(body.unmappedMembers).toEqual(["user-ghost"]);
  });

  it("dump fans out per resolved login and aggregates", async () => {
    const { ctx, forwarded } = makeCtx({
      callerMemberships: ADMIN_MEMBERSHIPS,
      targets: {
        alice: {
          status: 200,
          body: {
            count: 2,
            schedules: [
              { id: "s1", callback: "autonomousMarketScreen" },
              { id: "s2", callback: "autonomousOptionsAnalysis" },
            ],
          },
        },
      },
    });
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/dump", {
      login: "admin",
      method: "POST",
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      perLogin: Array<{ login: string; schedules: Array<{ id: string }> }>;
      unmappedMembers: string[];
    };
    expect(body.perLogin).toEqual([
      {
        login: "alice",
        schedules: [
          { id: "s1", callback: "autonomousMarketScreen" },
          { id: "s2", callback: "autonomousOptionsAnalysis" },
        ],
      },
    ]);
    expect(body.unmappedMembers).toEqual(["user-ghost"]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].login).toBe("alice");
    expect(forwarded[0].url).toBe("https://agent.internal/schedules");
    // Issue #6503 step 8c — the fan-out still routes to the target
    // instance (per-login stub), but the forwarded identity is the
    // verified admin, never the target login (the dump read ignores
    // the header — it returns the instance's own list — so the
    // identity switch changes no read behavior).
    expect(forwarded[0].headers["x-user-login"]).toBe("admin");
    expect(forwarded[0].headers["x-admin-actor"]).toBe("admin");
    expect(forwarded[0].headers["x-admin-tenant"]).toBe("tenant-a");
  });

  it("cancel-all preview cancels nothing and writes no audit", async () => {
    const { ctx, audit, forwarded } = makeCtx({
      callerMemberships: ADMIN_MEMBERSHIPS,
      targets: {
        alice: {
          status: 200,
          body: {
            cancelled: 0,
            confirmRequired: true,
            wouldCancel: [{ id: "s1", callback: "x" }],
            wouldCancelCount: 1,
            pausedPreserved: 0,
          },
        },
      },
    });
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/cancel-all", {
      login: "admin",
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      confirmRequired: boolean;
      perLogin: Array<{ login: string; wouldCancel: Array<{ id: string }> }>;
    };
    expect(body.confirmRequired).toBe(true);
    expect(body.perLogin[0].wouldCancel).toEqual([{ id: "s1", callback: "x" }]);
    expect(audit).not.toHaveBeenCalled();
    // Preview forwards without confirm: the target cancels nothing.
    expect(forwarded.every((f) => (f.body as Record<string, unknown>).confirm !== true)).toBe(true);
  });

  it("cancel-all confirm fans out with delegation headers and audits once in aggregate", async () => {
    const { ctx, audit, forwarded } = makeCtx({
      callerMemberships: ADMIN_MEMBERSHIPS,
      targets: {
        alice: { status: 200, body: { cancelled: 2, cancelledIds: ["s1", "s2"], failed: [], pausedPreserved: 1 } },
      },
    });
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/cancel-all", {
      login: "admin",
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      perLogin: Array<{ login: string; cancelled: number }>;
      unmappedMembers: string[];
    };
    expect(body.perLogin).toEqual([
      { login: "alice", cancelled: 2, cancelledIds: ["s1", "s2"], failed: [], pausedPreserved: 1 },
    ]);
    expect(body.unmappedMembers).toEqual(["user-ghost"]);
    const cancel = forwarded.find((f) => f.method === "POST");
    expect(cancel?.url).toBe("https://agent.internal/schedules/cancel-all");
    // Issue #6503 step 8c — the forwarded identity is the verified
    // admin login, not the target login: the target's step-8 gate
    // re-verifies the platform-admin binding, so a target login
    // would 403 the fan-out in production.
    expect(cancel?.headers["x-user-login"]).toBe("admin");
    expect(cancel?.headers["x-admin-actor"]).toBe("admin");
    expect(cancel?.headers["x-admin-tenant"]).toBe("tenant-a");
    expect(cancel?.body).toEqual({ confirm: true });
    expect(audit).toHaveBeenCalledTimes(1);
    const [, , payload] = audit.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(payload["tenantId"]).toBe("tenant-a");
    expect(payload["adminLogin"]).toBe("admin");
    expect(payload["unmappedMembers"]).toEqual(["user-ghost"]);
  });

  it("a failing login does not hide other logins", async () => {
    const { ctx } = makeCtx({
      callerMemberships: ADMIN_MEMBERSHIPS,
      membershipEntries: [
        {
          key: "iaaa-membership:m1",
          value: JSON.stringify(
            membership("m1", "user-alice", "tenant-a", "member", "tenant"),
          ),
        },
        {
          key: "iaaa-membership:m4",
          value: JSON.stringify(
            membership("m4", "user-bob", "tenant-a", "member", "tenant"),
          ),
        },
      ],
      targets: {
        alice: { status: 200, body: { cancelled: 1, cancelledIds: ["s1"], failed: [], pausedPreserved: 0 } },
      },
    });
    // user-bob resolves (alias) but its instance answers 404: the result
    // must carry bob's error alongside alice's success, not fail the batch.
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/cancel-all", {
      login: "admin",
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      perLogin: Array<{ login: string; error?: string; cancelled?: number }>;
      unmappedMembers: string[];
    };
    expect(body.perLogin.map((p) => p.login)).toEqual(["alice", "bob"]);
    expect(body.perLogin.find((p) => p.login === "alice")?.cancelled).toBe(1);
    expect(body.perLogin.find((p) => p.login === "bob")?.error).toBeTruthy();
    expect(body.unmappedMembers).toEqual([]);
  });

  it("clear-table forwards the allowlist decision from the target (refusals pass through per login)", async () => {
    const { ctx, audit, forwarded } = makeCtx({
      callerMemberships: ADMIN_MEMBERSHIPS,
      targets: {
        alice: {
          status: 400,
          body: { error: "mas_events (audit history) is never bulk-clearable via this endpoint" },
        },
      },
    });
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/clear-table", {
      login: "admin",
      method: "POST",
      body: JSON.stringify({ table: "mas_events", confirm: true }),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      perLogin: Array<{ login: string; error: string }>;
    };
    expect(body.perLogin[0].error).toMatch(/never bulk-clearable/);
    expect(audit).toHaveBeenCalledTimes(1);
    // Issue #6503 step 8c — the clear-table fan-out carries the
    // verified admin login, not the target login: the target's
    // step-8b gate requires platform-admin for mas_events, so a
    // target login would 403 the fan-out in production.
    const clear = forwarded.find((f) => f.url === "https://agent.internal/maintenance/clear-table");
    expect(clear?.login).toBe("alice");
    expect(clear?.headers["x-user-login"]).toBe("admin");
    expect(clear?.headers["x-admin-actor"]).toBe("admin");
    expect(clear?.headers["x-admin-tenant"]).toBe("tenant-a");
    expect(clear?.body).toEqual({ table: "mas_events", confirm: true });
  });

  it("405 for a wrong method on a matched action", async () => {
    const { ctx } = makeCtx({ callerMemberships: ADMIN_MEMBERSHIPS });
    const res = await call(ctx, "/api/admin/tenants/tenant-a/queues/dump", {
      login: "admin",
      method: "GET",
    });
    expect(res?.status).toBe(405);
  });
});
