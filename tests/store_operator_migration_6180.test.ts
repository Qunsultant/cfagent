/**
 * Issue #6180 — migrate every legacy operator login to an IAAA
 * membership via the alias record / derived id. Lossless: a login
 * with no alias record is reported unresolved and keeps access via
 * the deprecated legacy-list fallback (identity is never invented);
 * a login that already holds a live store-operator binding is not
 * minted twice; a revoked binding does not block a fresh mint.
 * Every minted binding carries the Q9 default expiry.
 */
import { describe, it, expect } from "vitest";
import {
  migrateStoreOperatorsToMemberships,
  STORE_OPERATOR_MIGRATION_GRANTOR,
} from "../src/security/storeOperatorMigration";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { createMembership } from "../src/security/authorization";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";

const NOW = 10_000;
const TENANT = "tenant-a";
const DAY = 86_400_000;

function makeKv(map: Map<string, string>): KvLike {
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    putIfAbsent: async (key: string, value: string) => {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
  } as KvLike;
}

async function world() {
  const kv = makeKv(new Map());
  const store = createKvMembershipStore(kv);
  await recordLoginAlias(kv, { githubLogin: "env-op", internalUserId: "user-env", nowMs: 1000 });
  await recordLoginAlias(kv, { githubLogin: "db-op", internalUserId: "user-db", nowMs: 1000 });
  // "ghost" deliberately has no alias record.
  return { kv, store };
}

describe("store-operator migration (#6180)", () => {
  it("mints a tenant-scoped store-operator membership per resolvable login, with Q9 expiry", async () => {
    const { kv, store } = await world();
    const out = await migrateStoreOperatorsToMemberships({
      membershipStore: store,
      kv,
      legacyLogins: ["env-op", "db-op"],
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(out).toEqual({ migrated: ["env-op", "db-op"], alreadyHeld: [], unresolved: [], failed: [] });
    for (const id of ["user-env", "user-db"]) {
      const memberships = await store.getMembershipsByUser(id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].tenantId).toBe(TENANT);
      expect(memberships[0].createdBy).toBe(STORE_OPERATOR_MIGRATION_GRANTOR);
      expect(memberships[0].roleBindings).toEqual([
        {
          role: "store-operator",
          scope: "tenant",
          grantedBy: STORE_OPERATOR_MIGRATION_GRANTOR,
          expiresAtMs: NOW + 90 * DAY,
        },
      ]);
    }
  });

  it("reports an unresolvable login and mints nothing for it", async () => {
    const { kv, store } = await world();
    const out = await migrateStoreOperatorsToMemberships({
      membershipStore: store,
      kv,
      legacyLogins: ["env-op", "ghost"],
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(out.migrated).toEqual(["env-op"]);
    expect(out.unresolved).toEqual(["ghost"]);
    expect(out.failed).toEqual([]);
    expect(await store.getMembershipsByUser("ghost")).toEqual([]);
  });

  it("does not mint a duplicate when the login already holds a live binding", async () => {
    const { kv, store } = await world();
    const seeded = await createMembership(store, {
      internalUserId: "user-env",
      tenantId: TENANT,
      roleBindings: [{ role: "store-operator", scope: "tenant", grantedBy: "seed" }],
      createdBy: "seed",
      nowMs: 1000,
    });
    expect(seeded.ok).toBe(true);
    const out = await migrateStoreOperatorsToMemberships({
      membershipStore: store,
      kv,
      legacyLogins: ["env-op"],
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(out.migrated).toEqual([]);
    expect(out.alreadyHeld).toEqual(["env-op"]);
    expect((await store.getMembershipsByUser("user-env")).length).toBe(1);
  });

  it("mints a fresh membership when the existing binding is revoked", async () => {
    const { kv, store } = await world();
    const seeded = await createMembership(store, {
      internalUserId: "user-env",
      tenantId: TENANT,
      roleBindings: [{ role: "store-operator", scope: "tenant", grantedBy: "seed" }],
      createdBy: "seed",
      nowMs: 1000,
    });
    if (!seeded.ok) throw new Error("seed failed");
    await store.revokeMembership(seeded.membership.membershipId, 2000);
    const out = await migrateStoreOperatorsToMemberships({
      membershipStore: store,
      kv,
      legacyLogins: ["env-op"],
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(out.migrated).toEqual(["env-op"]);
    const memberships = await store.getMembershipsByUser("user-env");
    expect(memberships).toHaveLength(2);
    expect(memberships.filter((m) => m.revokedAtMs === undefined)).toHaveLength(1);
  });

  it("is idempotent across re-runs", async () => {
    const { kv, store } = await world();
    const input = {
      membershipStore: store,
      kv,
      legacyLogins: ["env-op", "db-op"],
      tenantId: TENANT,
      nowMs: NOW,
    };
    const first = await migrateStoreOperatorsToMemberships(input);
    expect(first.migrated).toEqual(["env-op", "db-op"]);
    const second = await migrateStoreOperatorsToMemberships(input);
    expect(second).toEqual({ migrated: [], alreadyHeld: ["env-op", "db-op"], unresolved: [], failed: [] });
  });

  it("dry-run counts without minting", async () => {
    const { kv, store } = await world();
    const out = await migrateStoreOperatorsToMemberships({
      membershipStore: store,
      kv,
      legacyLogins: ["env-op", "ghost"],
      tenantId: TENANT,
      nowMs: NOW,
      dryRun: true,
    });
    expect(out.migrated).toEqual(["env-op"]);
    expect(out.unresolved).toEqual(["ghost"]);
    expect(await store.getMembershipsByUser("user-env")).toEqual([]);
  });

  it("honors an explicit default expiry", async () => {
    const { kv, store } = await world();
    await migrateStoreOperatorsToMemberships({
      membershipStore: store,
      kv,
      legacyLogins: ["env-op"],
      tenantId: TENANT,
      nowMs: NOW,
      defaultExpiryDays: 30,
    });
    const [m] = await store.getMembershipsByUser("user-env");
    expect(m.roleBindings[0].expiresAtMs).toBe(NOW + 30 * DAY);
  });
});
