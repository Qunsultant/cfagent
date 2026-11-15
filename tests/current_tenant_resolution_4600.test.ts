/**
 * Issue #4600 — Define 'current tenant' for multi-membership logins (three tenant authorities)
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveCurrentTenant,
  resolvePlatformIdentity,
  toPlatformIdentityView,
} from "../src/services/platformIdentity";
import { handlePlatformUsersRoutes, type PlatformUsersRouteContext } from "../src/agents/routes/platformUsers";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { Membership, MembershipStore } from "../src/security/authorization";
import type { Env } from "../src/types";

function makeMembership(
  membershipId: string,
  tenantId: string,
  createdAtMs: number,
  revokedAtMs?: number,
): Membership {
  return {
    membershipId,
    internalUserId: "u-multi",
    tenantId,
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "op", grantedAtMs: createdAtMs }],
    createdAtMs,
    ...(revokedAtMs !== undefined ? { revokedAtMs } : {}),
  };
}

describe("Issue #4600 — current tenant resolution across three tenant authorities", () => {
  it("resolves commercial account tenant first (source: 'account'), even when the login holds multiple IAAA memberships", () => {
    const resolved = resolveCurrentTenant({
      accountTenantId: "tenant-billing",
      memberships: [
        makeMembership("m-2", "tenant-beta", 200),
        makeMembership("m-1", "tenant-alpha", 100),
      ],
    });
    expect(resolved).toEqual({
      currentTenantId: "tenant-billing",
      currentTenantSource: "account",
      candidateMembershipTenants: ["tenant-alpha", "tenant-beta"],
    });
  });

  it("resolves deterministically to the earliest-granted active tenant membership (source: 'membership') when no account row exists, ignoring revoked and platform-scoped memberships", () => {
    const resolved = resolveCurrentTenant({
      accountTenantId: null,
      memberships: [
        makeMembership("m-revoked", "tenant-earliest-revoked", 50, 90),
        makeMembership("m-platform", "platform", 60),
        makeMembership("m-late", "tenant-zeta", 300),
        makeMembership("m-tie-b", "tenant-beta", 100),
        makeMembership("m-tie-a", "tenant-alpha", 100),
      ],
    });
    expect(resolved).toEqual({
      currentTenantId: "tenant-alpha",
      currentTenantSource: "membership",
      candidateMembershipTenants: ["tenant-alpha", "tenant-beta", "tenant-zeta"],
    });
  });

  it("returns currentTenantId: null and currentTenantSource: 'unresolved' when neither account nor active membership exists — never silently falling back to env default", () => {
    const resolved = resolveCurrentTenant({
      accountTenantId: null,
      memberships: [
        makeMembership("m-revoked", "tenant-old", 10, 20),
        makeMembership("m-platform", "platform", 30),
      ],
    });
    expect(resolved).toEqual({
      currentTenantId: null,
      currentTenantSource: "unresolved",
      candidateMembershipTenants: [],
    });
  });

  it("records currentTenantId, currentTenantSource, and candidateMembershipTenants on resolvePlatformIdentity and handlePlatformUsersRoutes", async () => {
    const commercial = new InMemoryCommercialAdapter();
    const subscriptions = new InMemorySubscriptionAdapter();

    // Multi-membership login without an account row resolves to 'membership'
    const noAccountIdentity = await resolvePlatformIdentity(
      { commercial, subscriptions },
      {
        userId: "alice",
        nowMs: 1_000,
        memberships: [
          makeMembership("m-b", "tenant-b", 200),
          makeMembership("m-a", "tenant-a", 100),
        ],
      },
    );
    expect(noAccountIdentity.tenantId).toBeNull();
    expect(noAccountIdentity.currentTenantId).toBe("tenant-a");
    expect(noAccountIdentity.currentTenantSource).toBe("membership");
    expect(noAccountIdentity.candidateMembershipTenants).toEqual(["tenant-a", "tenant-b"]);
    expect(toPlatformIdentityView(noAccountIdentity)).toMatchObject({
      userLogin: "alice",
      tenantId: null,
      currentTenantId: "tenant-a",
      currentTenantSource: "membership",
    });

    // Once an account row exists, 'account' authority wins over memberships
    await commercial.upsertAccount({
      userId: "alice",
      tenantId: "tenant-commercial",
      tier: "PayPerUse",
      creditsUSD: 10,
      includedRuns: 0,
      nowMs: 1_000,
    });
    const kvMap = new Map<string, string>([
      [
        `${IAAA_ALIAS_KEY_PREFIX}login:alice`,
        JSON.stringify({
          githubLogin: "alice",
          internalUserId: "u-multi",
          recordedAtMs: 1,
          source: "wired-login",
        }),
      ],
    ]);
    const membershipStore: MembershipStore = {
      getMembershipsByUser: async () => [
        makeMembership("m-b", "tenant-b", 200),
        makeMembership("m-a", "tenant-a", 100),
      ],
      getMembershipsByTenant: async () => [],
      putMembership: async () => {},
      revokeMembership: async () => false,
    };
    const ctx: PlatformUsersRouteContext = {
      env: { IAAA_TENANT_ID: "env-default-should-never-win" } as unknown as Env,
      audit: vi.fn(),
      commercial,
      subscriptions,
      membershipStore,
      aliasKv: {
        get: async (k: string) => kvMap.get(k) ?? null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
      },
    };
    const res = await handlePlatformUsersRoutes(
      new Request("https://agent.test/api/admin/platform-users/me", {
        headers: { "x-user-login": "alice" },
      }),
      new URL("https://agent.test/api/admin/platform-users/me"),
      "/api/admin/platform-users/me",
      "s-1",
      ctx,
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.tenantId).toBe("tenant-commercial");
    expect(body.currentTenantId).toBe("tenant-commercial");
    expect(body.currentTenantSource).toBe("account");
    expect(body.candidateMembershipTenants).toEqual(["tenant-a", "tenant-b"]);
  });

  it("pins the current-tenant resolution rule in docs/architecture/business/platform-entity-capability-map.md", () => {
    const doc = readFileSync(
      new URL("../docs/architecture/business/platform-entity-capability-map.md", import.meta.url),
      "utf-8",
    );
    expect(doc).toContain("Three tenant authorities (#4600 — resolved and pinned)");
    expect(doc).toContain("resolveCurrentTenant");
    expect(doc).toContain("currentTenantSource");
  });
});
