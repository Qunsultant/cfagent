/**
 * Issue #6180 — store-operator is a second admin gate outside IAAA.
 *
 * The one gate helper (src/security/storeOperatorGate.ts): a live
 * tenant-scoped `store-operator` membership allows; revoked / expired /
 * wrong-scope / wrong-tenant bindings do not; a login in the deprecated
 * env/store lists still allows (lossless migration, via "legacy-list");
 * a bootstrap-listed caller is admitted to the founding handlers only.
 * Tenant-admin and platform-admin WITHOUT a store-operator binding do NOT
 * allow — the roles stay separate (the live Google-account case).
 */
import { describe, it, expect } from "vitest";
import {
  resolveStoreOperatorAccess,
  hasLiveStoreOperatorBinding,
} from "../src/security/storeOperatorGate";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { createMembership } from "../src/security/authorization";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import { createKvBindingStore } from "../src/security/iaaaLogin";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import type { KvLike } from "../src/security/kvResilience";

const NOW = 10_000;
const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";

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

async function seedMembership(
  store: ReturnType<typeof createKvMembershipStore>,
  internalUserId: string,
  tenantId: string,
  role: string,
  scope: string,
  opts: { expiresAtMs?: number; revoked?: boolean } = {},
) {
  const created = await createMembership(store, {
    internalUserId,
    tenantId,
    roleBindings: [
      {
        role: role as never,
        scope: scope as never,
        grantedBy: "seed",
        ...(opts.expiresAtMs !== undefined ? { expiresAtMs: opts.expiresAtMs } : {}),
      },
    ],
    createdBy: "seed",
    nowMs: 1000,
  });
  if (!created.ok) throw new Error(`seed failed: ${created.error}`);
  if (opts.revoked) {
    await store.revokeMembership(created.membership.membershipId, 2000);
  }
  return created.membership;
}

describe("store-operator gate (#6180)", () => {
  it("allows a live tenant-scoped store-operator membership", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "op", internalUserId: "user-op", nowMs: 1000 });
    await seedMembership(store, "user-op", TENANT, "store-operator", "tenant");
    const out = await resolveStoreOperatorAccess({
      login: "op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
    });
    expect(out).toEqual({ allowed: true, via: "membership", login: "op", internalUserId: "user-op", storeDegraded: false });
  });

  it("denies a revoked store-operator binding", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "op", internalUserId: "user-op", nowMs: 1000 });
    await seedMembership(store, "user-op", TENANT, "store-operator", "tenant", { revoked: true });
    const out = await resolveStoreOperatorAccess({
      login: "op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
    });
    expect(out.allowed).toBe(false);
    expect(out.via).toBe("none");
  });

  it("denies an expired store-operator binding", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "op", internalUserId: "user-op", nowMs: 1000 });
    await seedMembership(store, "user-op", TENANT, "store-operator", "tenant", {
      expiresAtMs: NOW - 1,
    });
    const out = await resolveStoreOperatorAccess({
      login: "op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
    });
    expect(out.allowed).toBe(false);
    expect(out.via).toBe("none");
  });

  it("denies a platform-scoped store-operator binding (tenant gate needs tenant scope)", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "op", internalUserId: "user-op", nowMs: 1000 });
    await seedMembership(store, "user-op", TENANT, "store-operator", "platform");
    const out = await resolveStoreOperatorAccess({
      login: "op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
    });
    expect(out.allowed).toBe(false);
  });

  it("denies a store-operator binding in another tenant", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "op", internalUserId: "user-op", nowMs: 1000 });
    await seedMembership(store, "user-op", OTHER_TENANT, "store-operator", "tenant");
    const out = await resolveStoreOperatorAccess({
      login: "op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
    });
    expect(out.allowed).toBe(false);
  });

  it("denies a tenant-admin WITHOUT a store-operator binding (roles stay separate)", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "alice", internalUserId: "user-alice", nowMs: 1000 });
    await seedMembership(store, "user-alice", TENANT, "tenant-admin", "tenant");
    const out = await resolveStoreOperatorAccess({
      login: "alice",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
    });
    expect(out.allowed).toBe(false);
    expect(out.via).toBe("none");
  });

  it("denies a platform-admin WITHOUT a store-operator binding (separation preserved)", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "root", internalUserId: "user-root", nowMs: 1000 });
    await seedMembership(store, "user-root", TENANT, "platform-admin", "platform");
    const out = await resolveStoreOperatorAccess({
      login: "root",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
    });
    expect(out.allowed).toBe(false);
  });

  it("allows a legacy env-list login with no membership (deprecated fallback, lossless)", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    const out = await resolveStoreOperatorAccess({
      login: "legacy-op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: { COMMERCIAL_STORE_OPERATORS: "legacy-op,other-op" },
    });
    expect(out.allowed).toBe(true);
    expect(out.via).toBe("legacy-list");
    expect(out.internalUserId).toBeNull();
  });

  it("allows a legacy store-list login with no membership (deprecated fallback)", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    const operators = new InMemoryStoreOperatorsAdapter();
    await operators.addOperator({ login: "db-op", addedBy: "seed" });
    const out = await resolveStoreOperatorAccess({
      login: "db-op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: {},
      operators,
    });
    expect(out.allowed).toBe(true);
    expect(out.via).toBe("legacy-list");
  });

  it("allows a legacy login with no alias record (never signed in — migration pending)", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    const out = await resolveStoreOperatorAccess({
      login: "never-signed-in",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: { COMMERCIAL_STORE_OPERATORS: "never-signed-in" },
    });
    expect(out.allowed).toBe(true);
    expect(out.via).toBe("legacy-list");
  });

  it("denies a login in neither the memberships nor the legacy lists", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    const out = await resolveStoreOperatorAccess({
      login: "nobody",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: { COMMERCIAL_STORE_OPERATORS: "someone-else" },
    });
    expect(out).toEqual({ allowed: false, via: "none", login: "nobody", internalUserId: null, storeDegraded: false });
  });

  it("degrades to the legacy list when no KV/membership store is available", async () => {
    const out = await resolveStoreOperatorAccess({
      login: "env-op",
      tenantId: TENANT,
      nowMs: NOW,
      env: { COMMERCIAL_STORE_OPERATORS: "env-op" },
    });
    expect(out.allowed).toBe(true);
    expect(out.via).toBe("legacy-list");
  });

  it("admits a bootstrap-listed caller to a founding handler (platform: entry)", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "founder", internalUserId: "user-founder", nowMs: 1000 });
    const bindingStore = createKvBindingStore(kv);
    await bindingStore.put({
      internalUserId: "user-founder",
      providerIssuer: "https://github.com",
      providerSubject: "82253453",
      linkedAt: 1000,
      proofOfControl: "oidc",
    });
    const out = await resolveStoreOperatorAccess({
      login: "founder",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: { IAAA_BOOTSTRAP_ADMINS: "platform:https://github.com:82253453" },
      allowBootstrapFounding: true,
    });
    expect(out.allowed).toBe(true);
    expect(out.via).toBe("bootstrap-founding");
    expect(out.internalUserId).toBe("user-founder");
  });

  it("admits a plain (non-platform:) bootstrap-listed caller to a founding handler", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "founder", internalUserId: "user-founder", nowMs: 1000 });
    const bindingStore = createKvBindingStore(kv);
    await bindingStore.put({
      internalUserId: "user-founder",
      providerIssuer: "https://github.com",
      providerSubject: "82253453",
      linkedAt: 1000,
      proofOfControl: "oidc",
    });
    const out = await resolveStoreOperatorAccess({
      login: "founder",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: { IAAA_BOOTSTRAP_ADMINS: "https://github.com:82253453" },
      allowBootstrapFounding: true,
    });
    expect(out.allowed).toBe(true);
    expect(out.via).toBe("bootstrap-founding");
  });

  it("does NOT apply the founding bypass when the handler is not a founding handler", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "founder", internalUserId: "user-founder", nowMs: 1000 });
    const bindingStore = createKvBindingStore(kv);
    await bindingStore.put({
      internalUserId: "user-founder",
      providerIssuer: "https://github.com",
      providerSubject: "82253453",
      linkedAt: 1000,
      proofOfControl: "oidc",
    });
    const out = await resolveStoreOperatorAccess({
      login: "founder",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: { IAAA_BOOTSTRAP_ADMINS: "platform:https://github.com:82253453" },
      allowBootstrapFounding: false,
    });
    expect(out.allowed).toBe(false);
    expect(out.via).toBe("none");
  });

  it("prefers the membership over the legacy list when both hold", async () => {
    const kv = makeKv(new Map());
    const store = createKvMembershipStore(kv);
    await recordLoginAlias(kv, { githubLogin: "op", internalUserId: "user-op", nowMs: 1000 });
    await seedMembership(store, "user-op", TENANT, "store-operator", "tenant");
    const out = await resolveStoreOperatorAccess({
      login: "op",
      tenantId: TENANT,
      nowMs: NOW,
      kv,
      membershipStore: store,
      env: { COMMERCIAL_STORE_OPERATORS: "op" },
    });
    expect(out.allowed).toBe(true);
    expect(out.via).toBe("membership");
  });
});

describe("hasLiveStoreOperatorBinding (#6180)", () => {
  it("is true only for a live tenant-scoped binding in the tenant", () => {
    const live = {
      membershipId: "m-1",
      internalUserId: "u",
      tenantId: TENANT,
      roleBindings: [{ role: "store-operator", scope: "tenant", grantedBy: "seed" }],
      createdBy: "seed",
      createdAtMs: 1000,
    } as never;
    const expired = {
      ...live,
      membershipId: "m-2",
      roleBindings: [
        { role: "store-operator", scope: "tenant", grantedBy: "seed", expiresAtMs: NOW - 1 },
      ],
    } as never;
    const revoked = { ...live, membershipId: "m-3", revokedAtMs: 2000 } as never;
    expect(hasLiveStoreOperatorBinding([live], TENANT, NOW)).toBe(true);
    expect(hasLiveStoreOperatorBinding([expired], TENANT, NOW)).toBe(false);
    expect(hasLiveStoreOperatorBinding([revoked], TENANT, NOW)).toBe(false);
    expect(hasLiveStoreOperatorBinding([live], OTHER_TENANT, NOW)).toBe(false);
    expect(hasLiveStoreOperatorBinding([], TENANT, NOW)).toBe(false);
  });
});
