/**
 * Issue #4655 — GET /api/security/pip: session-gated read of the PIP's
 * live state: the attribute schema (Membership, RoleBinding,
 * PermissionDenial fields), the attribute sources (membership store
 * via membershipStoreToAttributeProvider; KV denial store), and the
 * signed-in user's OWN attributes (memberships + denials) as resolved
 * through the live AttributeProvider — never another user's.
 *
 * Worker-fetch harness (same pattern as
 * tests/sechub_pep_endpoint_4653.test.ts): real handleFetch against a
 * fake SessionStore, seeded memberships + denials + sessions.
 * TDD Red first: the route does not exist yet — every test below
 * fails until the slice lands.
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
import { createKvPermissionDenialStore } from "../src/security/iaaaPermissionDenialStore";
import { sessionStore } from "../src/security/session";
import type { Env } from "../src/types";

const PLATFORM_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000f1";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000f2";
const OTHER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000f3";
const LEGACY_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000f4";
const PLATFORM_ID = "v1:pipplatform000000000000000000000000000000000001";
const MEMBER_ID = "v1:pipmember000000000000000000000000000000000000001";
const OTHER_ID = "v1:pipother0000000000000000000000000000000000000001";

async function makeEnv(extra: Record<string, string> = {}) {
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
  seed("sessions", PLATFORM_SESSION, session("platform-user", PLATFORM_ID));
  seed("sessions", MEMBER_SESSION, session("member-user", MEMBER_ID));
  seed("sessions", OTHER_SESSION, session("other-user", OTHER_ID));
  // Legacy session: no internalUserId — the IAAA lifecycle block
  // refuses it before any handler runs (wired session required).
  seed("sessions", LEGACY_SESSION, {
    githubLogin: "legacy-user",
    githubName: "legacy-user",
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
  });
  const env = {
    SESSION_STORE: namespace,
    ...extra,
  } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  for (const [id, role, scope] of [
    [PLATFORM_ID, "platform-admin", "platform"],
    [MEMBER_ID, "member", "tenant"],
    [OTHER_ID, "member", "tenant"],
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
  // Denials: one for the platform admin, one for the OTHER user,
  // none for the member — so the member's empty-denials rendering
  // and the no-other-user rule are both exercised.
  const denialStore = createKvPermissionDenialStore(sessionStore(env));
  const platformDenial = await denialStore.putDenial({
    denialId: "0d9a3120-1c2b-4e3f-8a5b-3120000000d1",
    internalUserId: PLATFORM_ID,
    tenantId: "primary",
    permission: "integration:connect",
    deniedBy: PLATFORM_ID,
    deniedAtMs: now - 5000,
  });
  const otherDenial = await denialStore.putDenial({
    denialId: "0d9a3120-1c2b-4e3f-8a5b-3120000000d2",
    internalUserId: OTHER_ID,
    tenantId: "primary",
    permission: "integration:connect",
    deniedBy: PLATFORM_ID,
    deniedAtMs: now - 4000,
  });
  return { env, platformDenial, otherDenial };
}

function req(method: string, path: string, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      ...(cookie
        ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" }
        : {}),
    },
  });
}

describe("GET /api/security/pip (#4655)", () => {
  it("refuses unauthenticated callers with 401", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(req("GET", "/api/security/pip"), env, {} as any);
    expect(res.status).toBe(401);
  });

  it("refuses legacy (unwired) sessions with 403 — PIP state needs a wired session", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pip", LEGACY_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("returns the schema, sources, and the platform admin's own attributes — and no other user's", async () => {
    const { env, platformDenial, otherDenial } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pip", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    // The schema names the live AttributeProvider interfaces
    // (Membership, RoleBinding, PermissionDenial in
    // src/security/authorization.ts) — field for field.
    expect(body.schema).toEqual({
      membership: {
        fields: [
          "membershipId",
          "internalUserId",
          "tenantId",
          "workspaceId",
          "roleBindings",
          "createdBy",
          "createdAtMs",
          "revokedAtMs",
          "email",
        ],
        // #6164 (F6): the view-level login join, declared beside the
        // provider fields it annotates — the interface itself is
        // unchanged (src/security/authorization.ts).
        enrichmentFields: ["login"],
      },
      roleBinding: {
        fields: ["role", "scope", "workspaceId", "resourceId", "grantedBy", "expiresAtMs"],
        enrichmentFields: ["grantedByLogin"],
      },
      permissionDenial: {
        fields: ["denialId", "internalUserId", "tenantId", "permission", "deniedBy", "deniedAtMs"],
        enrichmentFields: ["deniedByLogin"],
      },
    });
    // Sources: which store each attribute group came from, and the
    // adapter that resolves it — never an invented source.
    expect(body.sources).toEqual([
      {
        id: "memberships",
        name: "Membership store",
        via: "membershipStoreToAttributeProvider",
        available: true,
      },
      {
        id: "denials",
        name: "KV denial store",
        via: "createKvPermissionDenialStore",
        available: true,
      },
    ]);
    // Own attributes only: the platform admin's membership and
    // denial, matching what the provider returns for that user.
    expect(body.attributes.denialsAvailable).toBe(true);
    expect(body.attributes.memberships).toHaveLength(1);
    expect(body.attributes.memberships[0].internalUserId).toBe(PLATFORM_ID);
    expect(body.attributes.memberships[0].tenantId).toBe("primary");
    expect(body.attributes.memberships[0].roleBindings[0].role).toBe("platform-admin");
    // #6164 (F6): the denial carries the denying principal's login
    // beside the id — null when the store has no alias, never invented.
    expect(body.attributes.denials).toEqual([{ ...platformDenial, deniedByLogin: null }]);
    // No other user's attributes leak: the other user's membership
    // and denial are absent from the whole response.
    expect(JSON.stringify(body)).not.toContain(OTHER_ID);
    expect(JSON.stringify(body)).not.toContain(otherDenial.denialId);
    // Returned records carry only declared keys — the provider fields
    // plus the enrichment the schema names, never an undeclared extra.
    const membershipKeys = new Set([
      ...body.schema.membership.fields,
      ...body.schema.membership.enrichmentFields,
    ]);
    const bindingKeys = new Set([
      ...body.schema.roleBinding.fields,
      ...body.schema.roleBinding.enrichmentFields,
    ]);
    const denialKeys = new Set([
      ...body.schema.permissionDenial.fields,
      ...body.schema.permissionDenial.enrichmentFields,
    ]);
    for (const record of body.attributes.memberships) {
      for (const key of Object.keys(record)) expect(membershipKeys.has(key)).toBe(true);
      for (const binding of record.roleBindings) {
        for (const key of Object.keys(binding)) expect(bindingKeys.has(key)).toBe(true);
      }
    }
    for (const record of body.attributes.denials) {
      for (const key of Object.keys(record)) expect(denialKeys.has(key)).toBe(true);
    }
  });

  it("returns a member's own attributes with an honest empty denials list", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pip", MEMBER_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.attributes.memberships).toHaveLength(1);
    expect(body.attributes.memberships[0].internalUserId).toBe(MEMBER_ID);
    expect(body.attributes.memberships[0].roleBindings[0].role).toBe("member");
    // No denial was recorded for this user: the endpoint reports
    // the empty list, never an invented denial.
    expect(body.attributes.denialsAvailable).toBe(true);
    expect(body.attributes.denials).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(OTHER_ID);
  });

  it("refuses non-GET methods with 405", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/security/pip", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(405);
  });
});
