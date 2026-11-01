/**
 * Issue #2681 — tenant-bound service tokens (svc_token).
 *
 * Store-level contract, mirroring the apiKeys.ts template with the two
 * deliberate deviations the issue requires: expiry is REQUIRED at mint
 * (no immortal tokens), and every token is bound to exactly one tier
 * (platform, or one tenant) that verification re-checks on every use.
 *
 * RED FIRST: these tests are written against src/security/serviceTokens.ts
 * before that module exists.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_ROLES,
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";
import {
  authorizeServiceToken,
  listServiceTokens,
  mintServiceToken,
  rotateServiceToken,
  revokeServiceToken,
  SERVICE_TOKEN_PREFIX,
  verifyServiceToken,
  type ServiceTokenMetadata,
} from "../src/security/serviceTokens";

const SERVICE_LOGIN = "svc-background";
const SERVICE_ID = "service:svc-background";
const ADMIN_ID = "admin-id-1";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

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

function platformMemberBinding(userId: string): Membership {
  return {
    membershipId: `m-platform-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "platform", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function platformAdminMembership(userId: string): Membership {
  return {
    membershipId: `m-platform-admin-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function tenantMemberMembership(userId: string, tenantId: string): Membership {
  return {
    membershipId: `m-tenant-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

function tenantAdminMembership(userId: string, tenantId: string): Membership {
  return {
    membershipId: `m-tenant-admin-${userId}-${tenantId}`,
    internalUserId: userId,
    tenantId,
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

async function provisionedStore(opts: {
  platform?: boolean;
  tenant?: string;
  admin?: boolean;
  tenantAdmin?: string;
}): Promise<MembershipStore> {
  const store = createMemoryMembershipStore();
  if (opts.platform) await store.put(platformMemberBinding(SERVICE_ID));
  if (opts.tenant) await store.put(tenantMemberMembership(SERVICE_ID, opts.tenant));
  if (opts.admin) await store.put(platformAdminMembership(ADMIN_ID));
  if (opts.tenantAdmin) await store.put(tenantAdminMembership(ADMIN_ID, opts.tenantAdmin));
  return store;
}

async function mintPlatformToken(
  kv: KvLike,
  store: MembershipStore,
  overrides: Partial<Parameters<typeof mintServiceToken>[2]> = {},
): Promise<{ token: ServiceTokenMetadata; secret: string }> {
  return mintServiceToken(
    kv,
    store,
    {
      label: "automation",
      tier: "platform",
      roles: ["member"],
      expiresAtMs: NOW + 90 * DAY,
      serviceLogin: SERVICE_LOGIN,
      serviceInternalUserId: SERVICE_ID,
      createdBy: ADMIN_ID,
      ...overrides,
    },
    NOW,
  );
}

describe("issue #2681: service token mint", () => {
  it("mints a svc_ token and returns the plaintext secret exactly once", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    const { token, secret } = await mintPlatformToken(kv, store);
    expect(secret.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
    expect(secret).toMatch(/^svc_[A-Za-z0-9_-]{43}$/);
    expect(token.prefix).toBe(secret.slice(0, 12));
    expect(token.tier).toBe("platform");
    expect(token.roles).toEqual(["member"]);
    expect(token.expiresAtMs).toBe(NOW + 90 * DAY);
    expect(token.revokedAtMs).toBeNull();
    // The stored record never carries the plaintext secret.
    const listed = await listServiceTokens(kv);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed[0])).not.toContain(secret);
    expect(listed[0]).not.toHaveProperty("hash");
    expect(listed[0]).not.toHaveProperty("secret");
  });

  it("refuses mint when no expiry is supplied (no immortal tokens)", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    await expect(
      mintServiceToken(
        kv,
        store,
        {
          label: "no-expiry",
          tier: "platform",
          roles: ["member"],
          expiresAtMs: 0,
          serviceLogin: SERVICE_LOGIN,
          serviceInternalUserId: SERVICE_ID,
          createdBy: ADMIN_ID,
        },
        NOW,
      ),
    ).rejects.toThrow(/expir/i);
  });

  it("refuses mint when the service identity is not provisioned for the tier", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ admin: true });
    await expect(mintPlatformToken(kv, store)).rejects.toThrow(/provision/i);
  });

  it("refuses a tenant token without a tenant id, and without a tenant binding", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ admin: true, tenantAdmin: "tenant-a" });
    await expect(
      mintPlatformToken(kv, store, { tier: "tenant", tenantId: undefined }),
    ).rejects.toThrow(/tenant/i);
    await expect(
      mintPlatformToken(kv, store, { tier: "tenant", tenantId: "tenant-a" }),
    ).rejects.toThrow(/provision/i);
  });

  it("refuses roles the granter cannot grant (never self-granted)", async () => {
    const kv = mapKv();
    // Granter is only a tenant-admin in tenant-a: platform-admin is ungrantable.
    const store = await provisionedStore({
      platform: true,
      tenantAdmin: "tenant-a",
      tenant: "tenant-a",
    });
    await expect(
      mintPlatformToken(kv, store, { roles: ["platform-admin"] }),
    ).rejects.toThrow(/grant/i);
  });

  it("validates roles against the single catalog (ALL_ROLES, shared with #2688)", async () => {
    expect([...ALL_ROLES]).toEqual([
      "platform-admin",
      "tenant-admin",
      "workspace-admin",
      "member",
      "approver",
      "auditor",
    ]);
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    await expect(
      mintPlatformToken(kv, store, { roles: ["superuser" as never] }),
    ).rejects.toThrow("Unknown role");
  });

  it("refuses the workspace-admin role (no workspace binding exists on tokens)", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    await expect(
      mintPlatformToken(kv, store, { roles: ["workspace-admin"] }),
    ).rejects.toThrow(/workspace/i);
  });
});

describe("issue #2681: service token verify", () => {
  it("verifies a live platform token and stamps last use", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    const { token, secret } = await mintPlatformToken(kv, store);
    const verified = await verifyServiceToken(kv, store, secret, "primary", NOW + 1000);
    expect(verified).not.toBeNull();
    expect(verified!.tokenId).toBe(token.id);
    expect(verified!.serviceLogin).toBe(SERVICE_LOGIN);
    expect(verified!.tier).toBe("platform");
    const listed = await listServiceTokens(kv);
    expect(listed[0].lastUsedAtMs).toBe(NOW + 1000);
  });

  it("denies malformed, unknown, expired, and revoked tokens indistinguishably", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    const { secret } = await mintPlatformToken(kv, store);
    expect(await verifyServiceToken(kv, store, "not-a-token", "primary", NOW)).toBeNull();
    expect(await verifyServiceToken(kv, store, `${SERVICE_TOKEN_PREFIX}${"x".repeat(43)}`, "primary", NOW)).toBeNull();
    expect(await verifyServiceToken(kv, store, secret, "primary", NOW + 91 * DAY)).toBeNull();
  });

  it("denies a token whose service identity lost its provisioning (0 ms)", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    const { secret } = await mintPlatformToken(kv, store);
    expect(await verifyServiceToken(kv, store, secret, "primary", NOW)).not.toBeNull();
    // Revoke the platform member binding: the next verify denies.
    const memberships = await store.getMembershipsByUser(SERVICE_ID);
    await store.revokeMembership(memberships[0].membershipId, NOW);
    expect(await verifyServiceToken(kv, store, secret, "primary", NOW)).toBeNull();
  });

  it("denies a tenant token used in another tenant (cross-tenant, never fall-through)", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ tenant: "tenant-a", tenantAdmin: "tenant-a", admin: true });
    const { secret } = await mintPlatformToken(kv, store, {
      tier: "tenant",
      tenantId: "tenant-a",
    });
    expect(await verifyServiceToken(kv, store, secret, "tenant-a", NOW)).not.toBeNull();
    expect(await verifyServiceToken(kv, store, secret, "tenant-b", NOW)).toBeNull();
    expect(await verifyServiceToken(kv, store, secret, "primary", NOW)).toBeNull();
  });

  it("revocation is immediate: the next verify denies", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ platform: true, admin: true });
    const { token, secret } = await mintPlatformToken(kv, store);
    expect(await verifyServiceToken(kv, store, secret, "primary", NOW)).not.toBeNull();
    expect(await revokeServiceToken(kv, token.id, NOW)).toBe(true);
    expect(await verifyServiceToken(kv, store, secret, "primary", NOW)).toBeNull();
    const listed = await listServiceTokens(kv);
    expect(listed[0].revokedAtMs).toBe(NOW);
  });

  it("rotation invalidates the old secret immediately and keeps id/roles/tenant", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ tenant: "tenant-a", tenantAdmin: "tenant-a", admin: true });
    const { token, secret } = await mintPlatformToken(kv, store, {
      tier: "tenant",
      tenantId: "tenant-a",
    });
    const rotated = await rotateServiceToken(kv, token.id, NOW + 30 * DAY, NOW);
    expect(rotated).not.toBeNull();
    expect(rotated!.token.id).toBe(token.id);
    expect(rotated!.token.roles).toEqual(["member"]);
    expect(rotated!.token.tenantId).toBe("tenant-a");
    expect(rotated!.secret).not.toBe(secret);
    expect(await verifyServiceToken(kv, store, secret, "tenant-a", NOW)).toBeNull();
    expect(await verifyServiceToken(kv, store, rotated!.secret, "tenant-a", NOW)).not.toBeNull();
  });
});

describe("issue #2681: authorizeServiceToken (PDP seam)", () => {
  it("grants what the token roles grant and denies the rest, tenant-scoped", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ tenant: "tenant-a", tenantAdmin: "tenant-a", admin: true });
    const { secret } = await mintPlatformToken(kv, store, {
      tier: "tenant",
      tenantId: "tenant-a",
      roles: ["member"],
    });
    const verified = await verifyServiceToken(kv, store, secret, "tenant-a", NOW);
    expect(verified).not.toBeNull();
    const allow = await authorizeServiceToken(verified!, "task:create", NOW);
    expect(allow.decision).toBe("allow");
    const deny = await authorizeServiceToken(verified!, "action:approve", NOW);
    expect(deny.decision).toBe("deny");
  });

  it("denies a permission check in a different tenant than the token", async () => {
    const kv = mapKv();
    const store = await provisionedStore({ tenant: "tenant-a", tenantAdmin: "tenant-a", admin: true });
    const { secret } = await mintPlatformToken(kv, store, {
      tier: "tenant",
      tenantId: "tenant-a",
      roles: ["tenant-admin"],
    });
    const verified = await verifyServiceToken(kv, store, secret, "tenant-a", NOW);
    expect(verified).not.toBeNull();
    const cross = await authorizeServiceToken(verified!, "task:create", NOW, "tenant-b");
    expect(cross.decision).toBe("deny");
    expect(cross.reason).toBe("CROSS_TENANT");
  });
});
