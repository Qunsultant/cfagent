/**
 * #6191 — genesis is per-identity, not global-once (default), and
 * configurable back to global-once.
 *
 * RED: the per-identity behaviour does not exist yet — the marker is
 * one global key per tenant, so a second platform,tenant:-listed
 * identity is refused. These tests pin the new behaviour:
 *  - a second listed identity gets platform-admin after the first claimed
 *  - the same identity never double-mints (repeat + concurrent logins)
 *  - a revoked platform-admin is restored on login (fresh membership,
 *    revoked record stays as history)
 *  - a single platform,tenant: entry yields BOTH roles
 *  - tenant:-only grants tenant-admin only, never platform-admin
 *  - global-once mode (genesis.oneTime = true) restores the old
 *    behaviour: the second identity is refused with the named error
 *  - an invalid one-time value fails closed to per-identity
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryIdentityBindingStore,
} from "../src/security/identityBinding";
import {
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";
import {
  platformGenesisMarkerKey,
  platformGenesisMarkerKeyForUser,
  runWiredPostLogin,
} from "../src/security/iaaaGithubEndToEnd";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const NOW = 1780000000000;
const GLOBAL_MARKER_KEY = platformGenesisMarkerKey("primary");
const MARKER_A = platformGenesisMarkerKeyForUser("primary", UUID_A);
const MARKER_B = platformGenesisMarkerKeyForUser("primary", UUID_B);

function memoryKv(): KvLike {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async putIfAbsent(key: string, value: string) {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
  };
}

function loginInput(
  githubLogin: string,
  internalUserId: string,
  bootstrapRaw: string | undefined,
) {
  return {
    githubLogin,
    internalUserId,
    providerIssuer: "https://github.com",
    providerSubject: "123",
    bootstrapRaw,
    tenantId: "primary",
    nowMs: NOW,
  };
}

function deps(
  kv: KvLike,
  membershipStore?: MembershipStore,
  genesisOneTime?: boolean,
) {
  return {
    kv,
    bindingStore: createMemoryIdentityBindingStore(),
    membershipStore: membershipStore ?? createMemoryMembershipStore(),
    genesisOneTime,
  };
}

async function livePlatformAdmin(
  store: MembershipStore,
  userId: string,
): Promise<boolean> {
  const memberships = await store.getMembershipsByUser(userId);
  return memberships.some(
    (m) =>
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) =>
          b.role === "platform-admin" &&
          b.scope === "platform" &&
          (b.expiresAtMs === undefined || b.expiresAtMs > NOW),
      ),
  );
}

async function liveTenantAdmin(
  store: MembershipStore,
  userId: string,
): Promise<boolean> {
  const memberships = await store.getMembershipsByUser(userId);
  return memberships.some(
    (m) =>
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) =>
          b.role === "tenant-admin" &&
          b.scope === "tenant" &&
          (b.expiresAtMs === undefined || b.expiresAtMs > NOW),
      ),
  );
}

describe("genesis per-identity (#6191)", () => {
  it("a second platform,tenant:-listed identity gets platform-admin after the first claimed", async () => {
    const kv = memoryKv();
    const d = deps(kv);
    const first = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(first.bootstrap.status).toBe("genesis");
    // The exact deadlock this fixes: a second listed identity is no
    // longer refused because the first claimed the (old) global marker.
    const second = await runWiredPostLogin(
      d,
      loginInput("bob", UUID_B, `platform,tenant:${UUID_B}`),
    );
    expect(second.bootstrap.status).toBe("genesis");
    expect(await livePlatformAdmin(d.membershipStore, UUID_A)).toBe(true);
    expect(await livePlatformAdmin(d.membershipStore, UUID_B)).toBe(true);
    // Each identity claimed ITS OWN marker — no shared global key.
    expect(await kv.get(MARKER_A)).not.toBeNull();
    expect(await kv.get(MARKER_B)).not.toBeNull();
    expect(JSON.parse((await kv.get(MARKER_A))!).grantedTo).toBe(UUID_A);
    expect(JSON.parse((await kv.get(MARKER_B))!).grantedTo).toBe(UUID_B);
    expect(await kv.get(GLOBAL_MARKER_KEY)).toBeNull();
  });

  it("the same identity never double-mints on repeat logins", async () => {
    const kv = memoryKv();
    const d = deps(kv);
    const first = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(first.bootstrap.status).toBe("genesis");
    const second = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(second.bootstrap.status).toBe("already-admin");
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    const platform = memberships.filter((m) =>
      m.roleBindings.some(
        (b) => b.role === "platform-admin" && b.scope === "platform",
      ),
    );
    expect(platform).toHaveLength(1);
  });

  it("a single platform,tenant: entry yields BOTH platform-admin and tenant-admin", async () => {
    const kv = memoryKv();
    const d = deps(kv);
    const result = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis");
    expect(await livePlatformAdmin(d.membershipStore, UUID_A)).toBe(true);
    expect(await liveTenantAdmin(d.membershipStore, UUID_A)).toBe(true);
  });

  it("a tenant:-only entry grants tenant-admin only, never platform-admin", async () => {
    const kv = memoryKv();
    const d = deps(kv);
    const result = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `tenant:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("provisioned");
    expect(await liveTenantAdmin(d.membershipStore, UUID_A)).toBe(true);
    expect(await livePlatformAdmin(d.membershipStore, UUID_A)).toBe(false);
  });

  it("a revoked platform-admin is restored on login; the revoked record stays as history", async () => {
    const kv = memoryKv();
    const d = deps(kv);
    const first = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(first.bootstrap.status).toBe("genesis");
    const before = await d.membershipStore.getMembershipsByUser(UUID_A);
    const platformMembership = before.find((m) =>
      m.roleBindings.some(
        (b) => b.role === "platform-admin" && b.scope === "platform",
      ),
    );
    expect(platformMembership).toBeDefined();
    // Revoke it (the owner-revocation this restores from).
    await d.membershipStore.revokeMembership(
      platformMembership!.membershipId,
      NOW + 1000,
    );
    expect(await livePlatformAdmin(d.membershipStore, UUID_A)).toBe(false);
    // Sign in again: genesis restores a FRESH live membership.
    const restored = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(restored.bootstrap.status).toBe("genesis");
    expect(await livePlatformAdmin(d.membershipStore, UUID_A)).toBe(true);
    const after = await d.membershipStore.getMembershipsByUser(UUID_A);
    const platform = after.filter((m) =>
      m.roleBindings.some(
        (b) => b.role === "platform-admin" && b.scope === "platform",
      ),
    );
    // The revoked record stays as history; the live one is new.
    expect(platform).toHaveLength(2);
    expect(platform.filter((m) => m.revokedAtMs === undefined)).toHaveLength(1);
    expect(platform.filter((m) => m.revokedAtMs !== undefined)).toHaveLength(1);
    expect(platform.find((m) => m.revokedAtMs !== undefined)!.membershipId).toBe(
      platformMembership!.membershipId,
    );
  });

  it("two concurrent first-logins of the SAME identity yield exactly one genesis winner", async () => {
    const kv = memoryKv();
    const d = deps(kv);
    const [first, second] = await Promise.all([
      runWiredPostLogin(d, loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`)),
      runWiredPostLogin(d, loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`)),
    ]);
    // Exactly one winner; the loser is already-admin on the next login
    // (it holds tenant-admin from this login, platform-admin from the win).
    expect([first.bootstrap.status, second.bootstrap.status].sort()).toEqual([
      "genesis",
      "genesis-closed-tenant-admin",
    ]);
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    const platform = memberships.filter((m) =>
      m.roleBindings.some(
        (b) => b.role === "platform-admin" && b.scope === "platform",
      ),
    );
    expect(platform).toHaveLength(1);
  });
});

describe("genesis one-time mode (#6191, configurable)", () => {
  it("global-once mode restores the old behaviour: the second identity is refused", async () => {
    const kv = memoryKv();
    const d = deps(kv, undefined, true);
    const first = await runWiredPostLogin(
      d,
      loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(first.bootstrap.status).toBe("genesis");
    const second = await runWiredPostLogin(
      d,
      loginInput("bob", UUID_B, `platform,tenant:${UUID_B}`),
    );
    // Old behaviour: the global marker is claimed, so the second
    // identity gets tenant-admin only — the named refusal path.
    expect(second.bootstrap.status).toBe("genesis-closed-tenant-admin");
    expect(await livePlatformAdmin(d.membershipStore, UUID_B)).toBe(false);
    expect(await liveTenantAdmin(d.membershipStore, UUID_B)).toBe(true);
    expect(await kv.get(GLOBAL_MARKER_KEY)).not.toBeNull();
    expect(await kv.get(MARKER_B)).toBeNull();
  });

  it("an invalid one-time value fails closed to per-identity with a named error", async () => {
    // The resolver is the unit under test for the invalid value;
    // the login path proves the fail-closed default: an invalid
    // config value must never restore the global-once refusal.
    const { resolveSessionStoreConfig } = await import(
      "../src/config/sessionStoreConfig"
    );
    const resolved = resolveSessionStoreConfig({
      genesis: { oneTime: "yes" },
    });
    expect(resolved.config.genesis.oneTime).toBe(false);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toMatch(/genesis\.oneTime/);
    // And the login path, given the resolved (default) mode, lets the
    // second identity claim — the fail-closed default in action.
    const kv = memoryKv();
    const d = deps(kv, undefined, resolved.config.genesis.oneTime);
    await runWiredPostLogin(d, loginInput("alice", UUID_A, `platform,tenant:${UUID_A}`));
    const second = await runWiredPostLogin(
      d,
      loginInput("bob", UUID_B, `platform,tenant:${UUID_B}`),
    );
    expect(second.bootstrap.status).toBe("genesis");
  });
});
