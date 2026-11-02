/**
 * Issue #2661 (monetization Phase 2.6) — TDD Red-first route tests.
 *
 * Email-bearing provisioning + welcome trigger on grant + grant idempotency.
 * Worker-fetch harness (same pattern as tests/iaaa_lifecycle_routes_1758.test.ts).
 *
 * - POST /api/iaaa/membership/grant with an optional grantee email:
 *   the email is captured on the membership record and a tier-selected
 *   welcome is best-effort sent (never blocking the grant).
 * - Re-granting bindings the target already holds live is a no-op:
 *   200 with the existing membership, no new record, no second welcome.
 * - Approve/offboard routes are verified live by the 1758 tests and
 *   are NOT rebuilt here; this file pins only the 2.6 layer.
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

const ADMIN_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a1";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000a3";
const ADMIN_ID = "v1:routeadmin00000000000000000000000000000000000000000001";
const MEMBER_ID = "v1:routemember00000000000000000000000000000000000000001";
const TARGET_ID = "v1:routetarget00000000000000000000000000000000000000001";
const NEWUSER_ID = "v1:routnewuser000000000000000000000000000000000000000001";

interface SentMail {
  from?: string;
  to: string;
  subject: string;
  text?: string;
}

async function makeEnv(withMail: boolean) {
  const fake = makeFakeSessionStore();
  const { namespace, seed } = fake;
  const now = Date.now();
  const session = (login: string, internalUserId: string | undefined, fresh: boolean) => ({
    githubLogin: login,
    githubName: login,
    ...(internalUserId ? { internalUserId } : {}),
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
    ...(fresh ? { authTimeMs: now } : {}),
  });
  seed("sessions", ADMIN_SESSION, session("admin-user", ADMIN_ID, true));
  seed("sessions", MEMBER_SESSION, session("member-user", MEMBER_ID, true));
  const mailbox: SentMail[] = [];
  const env = {
    SESSION_STORE: namespace,
    ...(withMail
      ? {
          EMAIL: {
            send: async (input: SentMail) => {
              mailbox.push(input);
            },
          },
        }
      : {}),
  } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  const adminMembership = await createMembership(membershipStore, {
    internalUserId: ADMIN_ID,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  const memberMembership = await createMembership(membershipStore, {
    internalUserId: MEMBER_ID,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  const targetMembership = await createMembership(membershipStore, {
    internalUserId: TARGET_ID,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  if (!adminMembership.ok || !memberMembership.ok || !targetMembership.ok) {
    throw new Error("test seed failed");
  }
  return { env, mailbox, membershipIds: { target: targetMembership.membership.membershipId } };
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: `session_id=${cookie}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function listFor(env: unknown, userId: string, cookie: string) {
  const res = await worker.fetch(req("GET", "/api/iaaa/memberships", undefined, cookie), env as any);
  const body = (await res.json()) as { memberships: Array<{ membershipId: string; internalUserId: string }> };
  return body.memberships.filter((m) => m.internalUserId === userId);
}

describe("email-bearing provisioning (#2661)", () => {
  it("captures the grantee email and best-effort sends the welcome on grant", async () => {
    const { env, mailbox } = await makeEnv(true);
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: NEWUSER_ID,
        roleBindings: [{ role: "member", scope: "tenant" }],
        email: "newuser@example.test",
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      membership: { internalUserId: string; email?: string };
      welcome?: { sent: boolean; reason?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.membership.email).toBe("newuser@example.test");
    expect(body.welcome?.sent).toBe(true);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].to).toBe("newuser@example.test");
    const listed = await listFor(env, NEWUSER_ID, ADMIN_SESSION);
    expect(listed).toHaveLength(1);
  });

  it("grants without an email and attempts no welcome", async () => {
    const { env, mailbox } = await makeEnv(true);
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: NEWUSER_ID,
        roleBindings: [{ role: "member", scope: "tenant" }],
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { membership: { email?: string }; welcome?: unknown };
    expect(body.membership.email).toBeUndefined();
    expect(body.welcome).toBeUndefined();
    expect(mailbox).toHaveLength(0);
  });

  it("refuses a malformed grantee email without creating a membership", async () => {
    const { env, mailbox } = await makeEnv(true);
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: NEWUSER_ID,
        roleBindings: [{ role: "member", scope: "tenant" }],
        email: "not-an-email",
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(400);
    expect(mailbox).toHaveLength(0);
    expect(await listFor(env, NEWUSER_ID, ADMIN_SESSION)).toHaveLength(0);
  });

  it("grants with an email but no mail transport, without failing the grant", async () => {
    const { env, mailbox } = await makeEnv(false);
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: NEWUSER_ID,
        roleBindings: [{ role: "member", scope: "tenant" }],
        email: "newuser@example.test",
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { welcome?: { sent: boolean; reason?: string } };
    expect(body.welcome?.sent).toBe(false);
    expect(body.welcome?.reason).toBe("no-email-transport");
    expect(mailbox).toHaveLength(0);
  });
});

describe("grant idempotency (#2661)", () => {
  it("re-granting held bindings is a no-op: same membership, no new record, no second welcome", async () => {
    const { env, mailbox, membershipIds } = await makeEnv(true);
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: TARGET_ID,
        roleBindings: [{ role: "member", scope: "tenant" }],
        email: "target@example.test",
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      membership: { membershipId: string };
      alreadyProvisioned?: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.alreadyProvisioned).toBe(true);
    expect(body.membership.membershipId).toBe(membershipIds.target);
    expect(mailbox).toHaveLength(0);
    expect(await listFor(env, TARGET_ID, ADMIN_SESSION)).toHaveLength(1);
  });

  it("a non-granter still gets 403 on the no-op path (no existence leak)", async () => {
    const { env } = await makeEnv(true);
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: TARGET_ID,
        roleBindings: [{ role: "member", scope: "tenant" }],
      }, MEMBER_SESSION),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("a partial overlap still grants (superset not met)", async () => {
    const { env, mailbox } = await makeEnv(true);
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: TARGET_ID,
        roleBindings: [
          { role: "member", scope: "tenant" },
          { role: "auditor", scope: "tenant" },
        ],
      }, ADMIN_SESSION),
      env,
    );
    expect(res.status).toBe(201);
    expect(await listFor(env, TARGET_ID, ADMIN_SESSION)).toHaveLength(2);
    expect(mailbox).toHaveLength(0);
  });
});
