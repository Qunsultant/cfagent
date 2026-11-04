/**
 * Issue #3155 (parent #945, Q9) — grant-rule mechanics, LIVE.
 * Route-level tests: second-approver flow on the membership grant,
 * role-grants grant, and access-request decision surfaces; the
 * default 90-day tenant expiry; the granter-review queue; and the
 * revoke-time matrix pass. Worker-fetch harness, same pattern as
 * the #1274 route tests. Never a live provider; memberships are
 * seeded via createMembership (direct-seam records) or minted
 * through the routes under test.
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

const NOW = 1_790_000_000_000;
const ADMIN_A_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000001a";
const ADMIN_B_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000001b";
const PLAT_A_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000001c";
const PLAT_B_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000001d";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-31200000001e";
const ADMIN_A_ID = "v1:routeadmina00000000000000000000000000000000000000000001";
const ADMIN_B_ID = "v1:routeadminb000000000000000000000000000000000000000001";
const PLAT_A_ID = "v1:routeplata00000000000000000000000000000000000000000001";
const PLAT_B_ID = "v1:routeplatb000000000000000000000000000000000000000001";
const MEMBER_ID = "v1:routemember00000000000000000000000000000000000000000001";
const TARGET_ID = "v1:routetarget000000000000000000000000000000000000000001";
const GRANTER_ID = "v1:routegranter00000000000000000000000000000000000000001";
const VICTIM_ID = "v1:routevictim000000000000000000000000000000000000000001";

async function makeEnv() {
  const { namespace, seed } = makeFakeSessionStore();
  const seedSession = (cookie: string, login: string, internalUserId: string, issuer: string) =>
    seed("sessions", cookie, {
      githubLogin: login,
      githubName: login,
      internalUserId,
      providerIssuer: issuer,
      createdAt: NOW,
      // Grant routes carry the #3102 step-up obligation for
      // role:assign: without a fresh authTimeMs every grant
      // denies (403), admin or not. Seed fresh auth like the
      // #1758 lifecycle harness does.
      authTimeMs: Date.now(),
    });
  seedSession(ADMIN_A_SESSION, "admin-a", ADMIN_A_ID, "https://github.com");
  seedSession(ADMIN_B_SESSION, "admin-b", ADMIN_B_ID, "https://github.com");
  seedSession(PLAT_A_SESSION, "plat-a", PLAT_A_ID, "https://github.com");
  seedSession(PLAT_B_SESSION, "plat-b", PLAT_B_ID, "https://github.com");
  seedSession(MEMBER_SESSION, "member-user", MEMBER_ID, "https://github.com");
  const env = { SESSION_STORE: namespace } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  const seedMembership = (internalUserId: string, role: string, scope: string, tenantId = "primary") =>
    createMembership(membershipStore, {
      internalUserId,
      tenantId,
      roleBindings: [{ role: role as never, scope: scope as never, grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: NOW,
    });
  await seedMembership(ADMIN_A_ID, "tenant-admin", "tenant");
  await seedMembership(ADMIN_B_ID, "tenant-admin", "tenant");
  await seedMembership(PLAT_A_ID, "platform-admin", "platform");
  await seedMembership(PLAT_B_ID, "platform-admin", "platform");
  await seedMembership(MEMBER_ID, "member", "tenant");
  return { env, membershipStore };
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function listMemberships(env: Env, cookie: string) {
  const res = await worker.fetch(req("GET", "/api/iaaa/memberships", undefined, cookie), env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { memberships: Array<Record<string, unknown>> };
  return body.memberships;
}

function hasLiveBinding(
  memberships: Array<Record<string, unknown>>,
  userId: string,
  role: string,
): boolean {
  return memberships.some(
    (m) =>
      m.internalUserId === userId &&
      m.revokedAtMs === undefined &&
      Array.isArray(m.roleBindings) &&
      (m.roleBindings as Array<Record<string, unknown>>).some((b) => b.role === role),
  );
}

describe("membership grant second-approver (#3155)", () => {
  it("tenant-admin grant: first admin proposes (202), same admin awaits, second admin mints (201) with a 90-day expiry", async () => {
    const { env } = await makeEnv();
    const grantBody = {
      internalUserId: TARGET_ID,
      roleBindings: [{ role: "tenant-admin", scope: "tenant" }],
    };
    const first = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", grantBody, ADMIN_A_SESSION),
      env,
    );
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { pending: boolean; proposalId: string };
    expect(firstBody.pending).toBe(true);
    expect(typeof firstBody.proposalId).toBe("string");

    // Nothing minted yet.
    let memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, TARGET_ID, "tenant-admin")).toBe(false);

    const same = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", grantBody, ADMIN_A_SESSION),
      env,
    );
    expect(same.status).toBe(202);
    const sameBody = (await same.json()) as { pending: boolean };
    expect(sameBody.pending).toBe(true);
    memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, TARGET_ID, "tenant-admin")).toBe(false);

    const second = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", grantBody, ADMIN_B_SESSION),
      env,
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { membership: { roleBindings: Array<{ expiresAtMs?: number }> } };
    expect(secondBody.membership.roleBindings[0].role).toBe("tenant-admin");
    const expiry = secondBody.membership.roleBindings[0].expiresAtMs;
    expect(typeof expiry).toBe("number");
    // 90-day default: within (now, now + 91 days] of the real clock.
    const nowReal = Date.now();
    expect(expiry as number).toBeGreaterThan(nowReal);
    expect(expiry as number).toBeLessThanOrEqual(nowReal + 91 * 86_400_000);
  });

  it("member grant mints immediately, without a proposal", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", {
        internalUserId: TARGET_ID,
        roleBindings: [{ role: "member", scope: "tenant" }],
      }, ADMIN_A_SESSION),
      env,
    );
    expect(res.status).toBe(201);
    const memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, TARGET_ID, "member")).toBe(true);
  });

  it("platform-admin grant proposes too, and platform bindings carry no default expiry", async () => {
    const { env } = await makeEnv();
    const grantBody = {
      internalUserId: TARGET_ID,
      roleBindings: [{ role: "platform-admin", scope: "platform" }],
    };
    const first = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", grantBody, PLAT_A_SESSION),
      env,
    );
    expect(first.status).toBe(202);
    const second = await worker.fetch(
      req("POST", "/api/iaaa/membership/grant", grantBody, PLAT_B_SESSION),
      env,
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { membership: { roleBindings: Array<{ expiresAtMs?: number }> } };
    expect(secondBody.membership.roleBindings[0].expiresAtMs).toBeUndefined();
  });
});

describe("role-grants grant second-approver (#3155)", () => {
  it("first admin proposes (202), second admin mints (201)", async () => {
    const { env } = await makeEnv();
    const grantBody = { internalUserId: TARGET_ID, role: "tenant-admin" };
    const first = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", grantBody, ADMIN_A_SESSION),
      env,
    );
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { pending: boolean };
    expect(firstBody.pending).toBe(true);
    let memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, TARGET_ID, "tenant-admin")).toBe(false);
    const second = await worker.fetch(
      req("POST", "/api/iaaa/role-grants/grant", grantBody, ADMIN_B_SESSION),
      env,
    );
    expect(second.status).toBe(201);
    memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, TARGET_ID, "tenant-admin")).toBe(true);
  });
});

describe("access-request decision second-approver (#3155)", () => {
  it("first approve waits, same admin cannot self-confirm, second approve grants", async () => {
    const { env } = await makeEnv();
    const created = await worker.fetch(
      req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, MEMBER_SESSION),
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { request: { requestId: string } };
    const requestId = createdBody.request.requestId;

    const first = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId, decision: "approve" }, ADMIN_A_SESSION),
      env,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { pendingSecondApproval: boolean; request: { status: string } };
    expect(firstBody.pendingSecondApproval).toBe(true);
    expect(firstBody.request.status).toBe("pending");
    let memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, MEMBER_ID, "tenant-admin")).toBe(false);

    const same = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId, decision: "approve" }, ADMIN_A_SESSION),
      env,
    );
    expect(same.status).toBe(409);

    const second = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId, decision: "approve" }, ADMIN_B_SESSION),
      env,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { request: { status: string } };
    expect(secondBody.request.status).toBe("approved");
    memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, MEMBER_ID, "tenant-admin")).toBe(true);
  });

  it("deny still works single-admin and grants nothing", async () => {
    const { env } = await makeEnv();
    const created = await worker.fetch(
      req("POST", "/api/iaaa/access-request", { requestedRole: "tenant-admin" }, MEMBER_SESSION),
      env,
    );
    const createdBody = (await created.json()) as { request: { requestId: string } };
    const denied = await worker.fetch(
      req("POST", "/api/iaaa/access-request/decision", { requestId: createdBody.request.requestId, decision: "deny" }, ADMIN_A_SESSION),
      env,
    );
    expect(denied.status).toBe(200);
    const deniedBody = (await denied.json()) as { request: { status: string } };
    expect(deniedBody.request.status).toBe("denied");
    const memberships = await listMemberships(env, PLAT_A_SESSION);
    expect(hasLiveBinding(memberships, MEMBER_ID, "tenant-admin")).toBe(false);
  });
});

describe("granter-review queue and revoke pass (#3155)", () => {
  it("revoking a granter queues their valid grants and revokes their matrix-violating grants", async () => {
    const { env, membershipStore } = await makeEnv();
    // Granter holds tenant-admin in primary only.
    const granter = await createMembership(membershipStore, {
      internalUserId: GRANTER_ID,
      tenantId: "primary",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: NOW,
    });
    expect(granter.ok).toBe(true);
    // Valid grant: member in primary by the granter.
    const validGrant = await createMembership(membershipStore, {
      internalUserId: VICTIM_ID,
      tenantId: "primary",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: GRANTER_ID }],
      createdBy: GRANTER_ID,
      nowMs: NOW,
    });
    expect(validGrant.ok).toBe(true);
    // Violating grant: member in "other", where the granter holds nothing.
    const violatingGrant = await createMembership(membershipStore, {
      internalUserId: VICTIM_ID,
      tenantId: "other",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: GRANTER_ID }],
      createdBy: GRANTER_ID,
      nowMs: NOW,
    });
    expect(violatingGrant.ok).toBe(true);

    // Revoke the granter's membership through the route.
    if (!granter.ok) return;
    const revoked = await worker.fetch(
      req("POST", "/api/iaaa/membership/revoke", { membershipId: granter.membership.membershipId }, ADMIN_A_SESSION),
      env,
    );
    expect(revoked.status).toBe(200);

    const memberships = await listMemberships(env, PLAT_A_SESSION);
    const find = (id: string, tenant: string) =>
      memberships.find((m) => m.membershipId === id && m.tenantId === tenant);
    if (!validGrant.ok || !violatingGrant.ok) return;
    // Valid grant survives the pass (review, not cascade).
    expect(find(validGrant.membership.membershipId, "primary")?.revokedAtMs).toBeUndefined();
    // Violating grant is revoked with the granter.
    expect(find(violatingGrant.membership.membershipId, "other")?.revokedAtMs).not.toBeUndefined();

    // Review queue lists the surviving grant, not the pass-revoked one.
    const queueRes = await worker.fetch(
      req("GET", "/api/iaaa/role-grants?review=true", undefined, PLAT_A_SESSION),
      env,
    );
    expect(queueRes.status).toBe(200);
    const queueBody = (await queueRes.json()) as {
      reviewQueue: Array<{ membershipId: string; createdBy: string; reason: string }>;
    };
    expect(queueBody.reviewQueue.map((q) => q.membershipId)).toContain(
      validGrant.membership.membershipId,
    );
    expect(queueBody.reviewQueue.map((q) => q.membershipId)).not.toContain(
      violatingGrant.membership.membershipId,
    );
    expect(queueBody.reviewQueue.find((q) => q.membershipId === validGrant.membership.membershipId)?.reason)
      .toBe("granter-revoked");
  });
});
