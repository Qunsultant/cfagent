/**
 * Issue #2450 — deny/clear routes for per-user integration:connect
 * revocation, plus the end-to-end connect gate.
 *
 * Worker-fetch harness (same pattern as
 * tests/iaaa_lifecycle_routes_1758.test.ts): real handleFetch
 * against a fake SessionStore, seeded memberships + sessions.
 * IAAA_PDP_ENABLED=1 so the connect start route enforces the PEP.
 */
import { describe, expect, it, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import { createMembership } from "../src/security/authorization";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { sessionStore } from "../src/security/session";
import type { Env } from "../src/types";

const ADMIN_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000c1";
const PLATFORM_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000c2";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000c3";
const TARGET_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000c4";
const ADMIN_ID = "v1:denyadmin00000000000000000000000000000000000000001";
const PLATFORM_ID = "v1:denyplatform00000000000000000000000000000000001";
const MEMBER_ID = "v1:denymember00000000000000000000000000000000000001";
const TARGET_ID = "v1:denytarget00000000000000000000000000000000000001";

async function makeEnv() {
  const fake = makeFakeSessionStore();
  const { namespace, seed } = fake;
  const now = Date.now();
  const session = (login: string, internalUserId: string) => ({
    githubLogin: login,
    githubName: login,
    internalUserId,
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
    authTimeMs: now,
  });
  seed("sessions", ADMIN_SESSION, session("admin-user", ADMIN_ID));
  seed("sessions", PLATFORM_SESSION, session("platform-user", PLATFORM_ID));
  seed("sessions", MEMBER_SESSION, session("member-user", MEMBER_ID));
  seed("sessions", TARGET_SESSION, session("target-user", TARGET_ID));
  const env = {
    SESSION_STORE: namespace,
    IAAA_PDP_ENABLED: "1",
  } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  for (const [id, role, scope] of [
    [ADMIN_ID, "tenant-admin", "tenant"],
    [PLATFORM_ID, "platform-admin", "platform"],
    [MEMBER_ID, "member", "tenant"],
    [TARGET_ID, "member", "tenant"],
  ] as const) {
    const created = await createMembership(membershipStore, {
      internalUserId: id,
      tenantId: "primary",
      roleBindings: [{ role, scope, grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: now,
    });
    if (!created.ok) throw new Error(created.error);
  }
  return { env };
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("permission deny route (#2450)", () => {
  it("a tenant-admin sets a connect denial for a member", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.denial.internalUserId).toBe(TARGET_ID);
    expect(body.denial.tenantId).toBe("primary");
    expect(body.denial.permission).toBe("integration:connect");
    expect(body.denial.deniedBy).toBe(ADMIN_ID);
  });

  it("setting the same denial twice is idempotent, same denial id", async () => {
    const { env } = await makeEnv();
    const first = await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    const firstBody = (await first.json()) as any;
    const second = await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as any;
    expect(secondBody.alreadyDenied).toBe(true);
    expect(secondBody.denial.denialId).toBe(firstBody.denial.denialId);
  });

  it("a member cannot set a denial", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }, MEMBER_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("self-denial is forbidden with SELF_DENY", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: ADMIN_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("SELF_DENY");
  });

  it("only integration:connect is manageable in this slice", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req(
        "POST",
        "/api/iaaa/permission/deny",
        { internalUserId: TARGET_ID, permission: "integration:use" },
        ADMIN_SESSION,
      ),
      env,
      {} as any,
    );
    expect(res.status).toBe(400);
  });

  it("a platform-admin gains no tenant denial authority", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }, PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("unauthenticated denial is 401, wrong method is 405", async () => {
    const { env } = await makeEnv();
    const unauth = await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }),
      env,
      {} as any,
    );
    expect(unauth.status).toBe(401);
    const wrongMethod = await worker.fetch(
      req("GET", "/api/iaaa/permission/deny", undefined, ADMIN_SESSION),
      env,
      {} as any,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("self-clear is forbidden: restoring your own permission is a self-grant", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/permission/clear", { internalUserId: ADMIN_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("SELF_GRANT");
  });

  it("clearing restores, and clearing twice reports cleared:false the second time", async () => {
    const { env } = await makeEnv();
    await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    const cleared = await worker.fetch(
      req("POST", "/api/iaaa/permission/clear", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as any).cleared).toBe(true);
    const again = await worker.fetch(
      req("POST", "/api/iaaa/permission/clear", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    expect(((await again.json()) as any).cleared).toBe(false);
  });
});

describe("denied member at the connect gate (#2450)", () => {
  it("denial blocks the connect start with 403; clearing restores it", async () => {
    const { env } = await makeEnv();
    const start = () =>
      worker.fetch(
        req("GET", "/api/etrade/oauth/start", undefined, TARGET_SESSION),
        env,
        {} as any,
      );
    const before = await start();
    expect(before.status).not.toBe(403);
    await worker.fetch(
      req("POST", "/api/iaaa/permission/deny", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    const denied = await start();
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as any;
    expect(deniedBody.error).toContain("Authorization denied: integration:connect");
    await worker.fetch(
      req("POST", "/api/iaaa/permission/clear", { internalUserId: TARGET_ID }, ADMIN_SESSION),
      env,
      {} as any,
    );
    const restored = await start();
    expect(restored.status).not.toBe(403);
  });
});
