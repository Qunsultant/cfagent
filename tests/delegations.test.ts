/**
 * Issue #3153 (#945 Q8, owner directive 2026-11-04: delegation
 * wiring LIVE) — delegation management routes: a wired user
 * creates, lists, and revokes their OWN delegations. Self-service
 * only: creating a delegation for another principal is not a
 * route capability, and revoking another user's delegation is a
 * 403. Creation is PDP-checked through Slice 3 (the delegator
 * must hold every delegated permission in the tenant).
 *
 * RED FIRST: written against src/agents/routes/delegations.ts
 * before that module exists. Mirrors the serviceUser route test
 * harness (memory membership store + alias KV seed).
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleDelegationRoutes,
  type DelegationRouteContext,
} from "../src/agents/routes/delegations";
import {
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";
import {
  createMemoryDelegationStore,
  type DelegationStore,
} from "../src/security/delegation";
import {
  createMemoryAgentGrantStore,
  type AgentGrantStore,
} from "../src/security/agentAccess";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";

const CREATE = "/api/iaaa/delegations/create";
const LIST = "/api/iaaa/delegations";
const REVOKE = "/api/iaaa/delegations/revoke";

const CALLER_LOGIN = "caller-user";
const CALLER_ID = "caller-id-1";
const OTHER_ID = "other-id-1";
const TENANT = "tenant-1";

function mapKv(seed: Record<string, string> = {}): KvLike {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as unknown as KvLike;
}

function aliasSeed(login: string, internalUserId: string): Record<string, string> {
  return {
    [`${IAAA_ALIAS_KEY_PREFIX}login:${login}`]: JSON.stringify({
      githubLogin: login,
      internalUserId,
      recordedAtMs: 1,
      source: "wired-login",
    }),
  };
}

function membership(userId: string, role: "tenant-admin" | "member"): Membership {
  return {
    membershipId: `m-${role}-${userId}`,
    internalUserId: userId,
    tenantId: TENANT,
    roleBindings: [{ role, scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

interface CtxBundle {
  ctx: DelegationRouteContext;
  audit: ReturnType<typeof vi.fn>;
  memberships: MembershipStore;
  delegations: DelegationStore;
  grants: AgentGrantStore;
}

function makeCtx(opts: {
  callerRole?: "tenant-admin" | "member" | "none";
  aliasLogin?: string;
  aliasId?: string;
}): CtxBundle {
  const memberships = createMemoryMembershipStore();
  const delegations = createMemoryDelegationStore();
  const grants = createMemoryAgentGrantStore();
  const audit = vi.fn();
  const ctx = {
    env: {},
    audit,
    membershipStore: memberships,
    delegationStore: delegations,
    grantStore: grants,
    aliasKv: mapKv(
      opts.aliasLogin !== undefined
        ? aliasSeed(opts.aliasLogin, opts.aliasId ?? CALLER_ID)
        : {},
    ),
  } as unknown as DelegationRouteContext;
  return { ctx, audit, memberships, delegations, grants };
}

async function seedCaller(bundle: CtxBundle, role: "tenant-admin" | "member"): Promise<void> {
  await bundle.memberships.put(membership(CALLER_ID, role));
}

function call(
  ctx: DelegationRouteContext,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const request = new Request(`https://worker.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleDelegationRoutes(request, new URL(request.url), path, "session-1", ctx);
}

function callerHeaders(): Record<string, string> {
  return { "x-user-login": CALLER_LOGIN };
}

const CREATE_BODY = {
  delegateAgentId: "agent:fleet:orchestrator",
  tenantId: TENANT,
  allowedActions: ["task:read"],
  resourceScope: [],
  expiresAtMs: Date.now() + 86_400_000,
  reDelegationAllowed: false,
};

describe("delegation routes (#3153)", () => {
  it("returns null for an unrelated path", async () => {
    const { ctx } = makeCtx({ aliasLogin: CALLER_LOGIN });
    expect(await call(ctx, "/api/iaaa/other", "GET", undefined, callerHeaders())).toBeNull();
  });

  it("requires a signed-in session: no login header is 401", async () => {
    const { ctx } = makeCtx({ aliasLogin: CALLER_LOGIN });
    const res = await call(ctx, CREATE, "POST", CREATE_BODY);
    expect(res?.status).toBe(401);
  });

  it("requires a wired session: a login with no alias is 403", async () => {
    const { ctx } = makeCtx({});
    const res = await call(ctx, CREATE, "POST", CREATE_BODY, callerHeaders());
    expect(res?.status).toBe(403);
  });

  it("refuses service-token callers", async () => {
    const { ctx } = makeCtx({ aliasLogin: CALLER_LOGIN });
    const res = await call(ctx, CREATE, "POST", CREATE_BODY, {
      "x-user-login": CALLER_LOGIN,
      "x-principal-kind": "service-token",
    });
    expect(res?.status).toBe(403);
  });

  it("creates a delegation for a permission the caller holds, and audits it", async () => {
    const bundle = makeCtx({ aliasLogin: CALLER_LOGIN });
    await seedCaller(bundle, "tenant-admin");
    const res = await call(bundle.ctx, CREATE, "POST", CREATE_BODY, callerHeaders());
    expect(res?.status).toBe(201);
    const body = (await res?.json()) as { ok: boolean; delegation: { delegatorInternalUserId: string } };
    expect(body.ok).toBe(true);
    expect(body.delegation.delegatorInternalUserId).toBe(CALLER_ID);
    expect(bundle.audit).toHaveBeenCalledWith(
      "delegation.created",
      "orchestrator",
      expect.objectContaining({ delegator: CALLER_ID }),
    );
  });

  it("refuses creation when the caller lacks the delegated permission", async () => {
    const bundle = makeCtx({ aliasLogin: CALLER_LOGIN });
    await seedCaller(bundle, "member");
    const res = await call(
      bundle.ctx,
      CREATE,
      "POST",
      { ...CREATE_BODY, allowedActions: ["role:assign"] },
      callerHeaders(),
    );
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { code: string };
    expect(body.code).toBe("DELEGATOR_LACKS_PERMISSION");
  });

  it("refuses creation when the delegate id is not an agent id", async () => {
    const bundle = makeCtx({ aliasLogin: CALLER_LOGIN });
    await seedCaller(bundle, "tenant-admin");
    const res = await call(
      bundle.ctx,
      CREATE,
      "POST",
      { ...CREATE_BODY, delegateAgentId: "user-123" },
      callerHeaders(),
    );
    expect(res?.status).toBe(400);
  });

  it("lists only the caller's own delegations", async () => {
    const bundle = makeCtx({ aliasLogin: CALLER_LOGIN });
    await seedCaller(bundle, "tenant-admin");
    await call(bundle.ctx, CREATE, "POST", CREATE_BODY, callerHeaders());
    const res = await call(bundle.ctx, LIST, "GET", undefined, callerHeaders());
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { delegations: { delegatorInternalUserId: string }[] };
    expect(body.delegations).toHaveLength(1);
    expect(body.delegations[0].delegatorInternalUserId).toBe(CALLER_ID);
  });

  it("revokes the caller's delegation, cascades its grants, and audits", async () => {
    const bundle = makeCtx({ aliasLogin: CALLER_LOGIN });
    await seedCaller(bundle, "tenant-admin");
    const created = (await (
      await call(bundle.ctx, CREATE, "POST", CREATE_BODY, callerHeaders())
    )?.json()) as { delegation: { id: string } };
    const res = await call(
      bundle.ctx,
      REVOKE,
      "POST",
      { delegationId: created.delegation.id },
      callerHeaders(),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { ok: boolean; revoked: boolean };
    expect(body.ok).toBe(true);
    expect(body.revoked).toBe(true);
    expect(bundle.audit).toHaveBeenCalledWith(
      "delegation.revoked",
      "orchestrator",
      expect.objectContaining({ delegationId: created.delegation.id }),
    );
  });

  it("refuses to revoke another user's delegation, and 404s an unknown one", async () => {
    const bundle = makeCtx({ aliasLogin: CALLER_LOGIN });
    await seedCaller(bundle, "tenant-admin");
    // Seed a delegation owned by someone else directly in the store.
    const { createDelegation } = await import("../src/security/delegation");
    await bundle.memberships.put(membership(OTHER_ID, "tenant-admin"));
    const created = await createDelegation(bundle.memberships, bundle.delegations, {
      delegatorInternalUserId: OTHER_ID,
      delegateAgentId: "agent:fleet:orchestrator",
      tenantId: TENANT,
      allowedActions: ["task:read"],
      resourceScope: [],
      expiresAtMs: Date.now() + 86_400_000,
      reDelegationAllowed: false,
      nowMs: Date.now(),
    });
    if (!created.ok) throw new Error("other-user delegation setup failed");
    const forbidden = await call(
      bundle.ctx,
      REVOKE,
      "POST",
      { delegationId: created.delegation.id },
      callerHeaders(),
    );
    expect(forbidden?.status).toBe(403);
    const missing = await call(
      bundle.ctx,
      REVOKE,
      "POST",
      { delegationId: "no-such-delegation" },
      callerHeaders(),
    );
    expect(missing?.status).toBe(404);
  });

  it("rejects wrong methods with 405", async () => {
    const bundle = makeCtx({ aliasLogin: CALLER_LOGIN });
    const res = await call(bundle.ctx, LIST, "POST", undefined, callerHeaders());
    expect(res?.status).toBe(405);
  });
});
