/**
 * #945 GitHub end-to-end — final GitHub wiring slice.
 *
 * Tests are written FIRST (TDD): this file must fail on the missing
 * module before the implementation lands. Coverage:
 * - Tenant resolution: IAAA_TENANT_ID when set, else the documented
 *   single-tenant default "primary" (never any other invented value).
 * - PDP flag: "1"/"true" = on, default OFF; enforcement only for
 *   wired sessions, plus legacy sessions past their #1749 grace
 *   bound (legacy sessions inside the bound stay exempt,
 *   flag OFF = identity).
 * - Bootstrap list with genesis: "platform:" entries grant
 *   platform-admin ONLY while no genesis marker exists; once the
 *   marker is set, later platform: entries grant tenant-admin only;
 *   createdBy is system:bootstrap-genesis for genesis grants and
 *   system:bootstrap otherwise; blank list provisions nothing.
 * - Alias recording on login: success in both directions, conflict
 *   (login already mapped to a different user) preserves the
 *   original and never throws, throwing storage never fails the run.
 * - Bootstrap on login: bare-UUID match and issuer:subject match
 *   provision tenant-admin; a non-listed user gets nothing.
 * - PDP route permission helper: tenant-admin allows, no
 *   membership denies, legacy (no internalUserId) denies safely.
 * - Audit best-effort: a failing audit store returns ok:false and
 *   never throws; a good store records the event.
 */
import { describe, expect, it } from "vitest";
import {
  checkPermission,
} from "../src/security/iaaaPdpSeam";
import {
  authorize,
  createMemoryMembershipStore,
} from "../src/security/authorization";
import {
  createMemoryIdentityBindingStore,
  resolveOrCreateBinding,
} from "../src/security/identityBinding";
import {
  lookupInternalUserIdByLogin,
  lookupLoginByUserId,
} from "../src/security/iaaaMigration";
import {
  buildLoginSuccessAuditEventInput,
  recordWiredAuthAudit,
} from "../src/security/iaaaAuthAudit";
import { createKvAuditStore } from "../src/security/iaaaAuditStore";
import type { KvLike } from "../src/security/kvResilience";
import {
  IAAA_DEFAULT_TENANT_ID,
  checkRoutePermission,
  isPdpEnabled,
  parseBootstrapListWithGenesis,
  platformGenesisMarkerKey,
  platformGenesisMarkerKeyForUser,
  resolveIaaaTenant,
  runWiredPostLogin,
  shouldEnforcePdp,
} from "../src/security/iaaaGithubEndToEnd";

/** In-memory KvLike with key inspection. */
function memoryKv(): KvLike & { keys(): string[] } {
  const map = new Map<string, string>();
  const kv: KvLike & { keys(): string[] } = {
    keys: () => [...map.keys()],
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
  return kv;
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const NOW = 1780000000000;

describe("tenant resolution", () => {
  it("uses IAAA_TENANT_ID when set and trimmed", () => {
    expect(resolveIaaaTenant({ IAAA_TENANT_ID: "  tenant-1 " })).toBe("tenant-1");
  });
  it("defaults to the documented single-tenant default when unset or blank", () => {
    expect(resolveIaaaTenant({})).toBe("primary");
    expect(resolveIaaaTenant({ IAAA_TENANT_ID: "   " })).toBe("primary");
    expect(resolveIaaaTenant(null)).toBe("primary");
    expect(IAAA_DEFAULT_TENANT_ID).toBe("primary");
  });
});

describe("PDP flag gating", () => {
  it("is on only for 1/true (case-insensitive, trimmed)", () => {
    expect(isPdpEnabled({ IAAA_PDP_ENABLED: "1" })).toBe(true);
    expect(isPdpEnabled({ IAAA_PDP_ENABLED: "true" })).toBe(true);
    expect(isPdpEnabled({ IAAA_PDP_ENABLED: " TRUE " })).toBe(true);
    expect(isPdpEnabled({})).toBe(false);
    expect(isPdpEnabled({ IAAA_PDP_ENABLED: "0" })).toBe(false);
    expect(isPdpEnabled({ IAAA_PDP_ENABLED: "false" })).toBe(false);
    expect(isPdpEnabled({ IAAA_PDP_ENABLED: "" })).toBe(false);
  });
  it("enforces only for wired sessions when the flag is on", () => {
    const wired = { githubLogin: "octo", internalUserId: UUID_A } as never;
    // #1749 pin update (same PR, pin rule): a legacy session with no
    // createdAt cannot prove it is inside its PDP grace bound, so it
    // enforces fail-closed. The inside-bound legacy exemption is
    // pinned in tests/iaaa_legacy_pdp_bound_1749.test.ts.
    const legacy = { githubLogin: "octo" } as never;
    expect(shouldEnforcePdp({ IAAA_PDP_ENABLED: "1" }, wired, NOW)).toBe(true);
    expect(shouldEnforcePdp({ IAAA_PDP_ENABLED: "1" }, legacy, NOW)).toBe(true);
    expect(shouldEnforcePdp({ IAAA_PDP_ENABLED: "1" }, null, NOW)).toBe(false);
    expect(shouldEnforcePdp({}, wired, NOW)).toBe(false);
  });
});

describe("bootstrap list with genesis", () => {
  it("parses plain, provider, and platform: entries", () => {
    const parsed = parseBootstrapListWithGenesis(
      `${UUID_A},platform:${UUID_B},platform:https://github.com:123`,
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toHaveLength(3);
    // #6191 — explicit roles: a plain entry defaults to tenant
    // only; platform: grants platform only (no silent tenant).
    expect(parsed.entries[0]).toEqual({
      roles: ["tenant"],
      entry: { kind: "internalUserId", internalUserId: UUID_A },
    });
    expect(parsed.entries[1]).toEqual({
      roles: ["platform"],
      entry: { kind: "internalUserId", internalUserId: UUID_B },
    });
    expect(parsed.entries[2]).toEqual({
      roles: ["platform"],
      entry: {
        kind: "providerSubject",
        providerIssuer: "https://github.com",
        providerSubject: "123",
      },
    });
  });
  it("rejects a platform: entry whose remainder is not an identity", () => {
    const parsed = parseBootstrapListWithGenesis("platform:not-a-uuid,platform:");
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected).toHaveLength(2);
  });
  it("blank input yields zero entries and zero rejections", () => {
    expect(parseBootstrapListWithGenesis(undefined)).toEqual({ entries: [], rejected: [] });
    expect(parseBootstrapListWithGenesis("  , ")).toEqual({ entries: [], rejected: [] });
  });
});

describe("wired post-login: alias + bootstrap", () => {
  function deps() {
    return {
      kv: memoryKv(),
      bindingStore: createMemoryIdentityBindingStore(),
      membershipStore: createMemoryMembershipStore(),
    };
  }

  it("records the login alias in both directions", async () => {
    const d = deps();
    const result = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: undefined,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.alias.status).toBe("recorded");
    expect(await lookupLoginByUserId(d.kv, UUID_A)).toBe("octo");
    expect(await lookupInternalUserIdByLogin(d.kv, "octo")).toBe(UUID_A);
  });

  it("an alias conflict preserves the original and never throws", async () => {
    const d = deps();
    await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "1",
      bootstrapRaw: undefined,
      tenantId: "primary",
      nowMs: NOW,
    });
    const result = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_B,
      providerIssuer: "https://github.com",
      providerSubject: "2",
      bootstrapRaw: undefined,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.alias.status).toBe("conflict-preserved");
    expect(await lookupInternalUserIdByLogin(d.kv, "octo")).toBe(UUID_A);
    expect(await lookupLoginByUserId(d.kv, UUID_B)).toBeNull();
  });

  it("throwing storage never fails the post-login run", async () => {
    const throwingKv: KvLike = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("store unavailable");
      },
      async delete() {},
    };
    const result = await runWiredPostLogin(
      {
        kv: throwingKv,
        bindingStore: createMemoryIdentityBindingStore(),
        membershipStore: createMemoryMembershipStore(),
      },
      {
        githubLogin: "octo",
        internalUserId: UUID_A,
        providerIssuer: "https://github.com",
        providerSubject: "123",
        bootstrapRaw: undefined,
        tenantId: "primary",
        nowMs: NOW,
      },
    );
    expect(result.alias.status).toBe("error");
    expect(result.bootstrap.status).toBe("blank");
  });

  it("provisions tenant-admin for a listed bare-UUID user", async () => {
    const d = deps();
    const result = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: UUID_A,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.bootstrap.status).toBe("provisioned");
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
    expect(memberships[0].roleBindings[0].scope).toBe("tenant");
    expect(memberships[0].createdBy).toBe("system:bootstrap");
    const decision = await authorize(d.membershipStore, {
      actorInternalUserId: UUID_A,
      tenantId: "primary",
      permission: "integration:connect",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("provisions tenant-admin for a listed issuer:subject user via binding", async () => {
    const d = deps();
    const binding = await resolveOrCreateBinding(d.bindingStore, {
      providerIssuer: "https://github.com",
      providerSubject: "123",
      proofVerified: true,
      nowMs: NOW,
    });
    if (!binding.ok) throw new Error("binding setup failed");
    const result = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: binding.binding.internalUserId,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: "https://github.com:123",
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.bootstrap.status).toBe("provisioned");
    const memberships = await d.membershipStore.getMembershipsByUser(
      binding.binding.internalUserId,
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
  });

  it("provisions nothing for a non-listed user or a blank list", async () => {
    const d = deps();
    const notListed = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: UUID_B,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(notListed.bootstrap.status).toBe("not-listed");
    const blank = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: "   ",
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(blank.bootstrap.status).toBe("blank");
    expect(await d.membershipStore.getMembershipsByUser(UUID_A)).toEqual([]);
  });

  it("genesis: first platform: entry grants platform-admin and sets the marker", async () => {
    const d = deps();
    const result = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: `platform:${UUID_A}`,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.bootstrap.status).toBe("genesis");
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("platform-admin");
    expect(memberships[0].roleBindings[0].scope).toBe("platform");
    expect(memberships[0].createdBy).toBe("system:bootstrap-genesis");
    // #6191 — per-identity default: the claim is on the user's own
    // marker, not the legacy global key.
    expect(
      await d.kv.get(platformGenesisMarkerKeyForUser("primary", UUID_A)),
    ).not.toBeNull();
    expect(await d.kv.get(platformGenesisMarkerKey("primary"))).toBeNull();
    const decision = await checkPermission(d.membershipStore, {
      internalUserId: UUID_A,
      tenantId: "primary",
      permission: "role:assign",
      scope: "platform",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("genesis closed: a later platform: entry grants tenant-admin only", async () => {
    // #6191 — the closed path is GLOBAL-ONCE mode
    // (genesisOneTime: true): under the per-identity default the
    // second identity would win its own claim (pinned in
    // iaaa_genesis_per_identity.test.ts). The entries are
    // platform,tenant: so the closed path still grants tenant-admin
    // (a platform-only entry would get genesis-claim-lost).
    const d = { ...deps(), genesisOneTime: true };
    await runWiredPostLogin(d, {
      githubLogin: "first",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "1",
      bootstrapRaw: `platform,tenant:${UUID_A}`,
      tenantId: "primary",
      nowMs: NOW,
    });
    const result = await runWiredPostLogin(d, {
      githubLogin: "second",
      internalUserId: UUID_B,
      providerIssuer: "https://github.com",
      providerSubject: "2",
      bootstrapRaw: `platform,tenant:${UUID_B}`,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(result.bootstrap.status).toBe("genesis-closed-tenant-admin");
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_B);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
    expect(memberships[0].createdBy).toBe("system:bootstrap");
    const platformDecision = await checkPermission(d.membershipStore, {
      internalUserId: UUID_B,
      tenantId: "primary",
      permission: "role:assign",
      scope: "platform",
      nowMs: NOW,
    });
    expect(platformDecision.decision).toBe("deny");
  });

  it("genesis is idempotent for a user who already holds platform-admin", async () => {
    const d = deps();
    const first = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: `platform:${UUID_A}`,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(first.bootstrap.status).toBe("genesis");
    const second = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: `platform:${UUID_A}`,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(second.bootstrap.status).toBe("already-admin");
    expect(await d.membershipStore.getMembershipsByUser(UUID_A)).toHaveLength(1);
  });

  it("a second login for the same user does not duplicate tenant-admin", async () => {
    const d = deps();
    await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: UUID_A,
      tenantId: "primary",
      nowMs: NOW,
    });
    const again = await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: UUID_A,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(again.bootstrap.status).toBe("already-admin");
    expect(await d.membershipStore.getMembershipsByUser(UUID_A)).toHaveLength(1);
  });

  it("an unrelated third user is never provisioned by someone else's login", async () => {
    const d = deps();
    await runWiredPostLogin(d, {
      githubLogin: "octo",
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "123",
      bootstrapRaw: UUID_A,
      tenantId: "primary",
      nowMs: NOW,
    });
    expect(await d.membershipStore.getMembershipsByUser(UUID_C)).toEqual([]);
  });
});

describe("PDP route permission helper", () => {
  it("allows a tenant-admin, denies without membership, denies legacy safely", async () => {
    const store = createMemoryMembershipStore();
    const { provisionBootstrapAdmins } = await import(
      "../src/security/iaaaBootstrap"
    );
    await provisionBootstrapAdmins(store, {
      tenantId: "primary",
      internalUserIds: [UUID_A],
      nowMs: NOW,
    });
    expect(
      await checkRoutePermission(
        store,
        { githubLogin: "octo", internalUserId: UUID_A } as never,
        "primary",
        "integration:connect",
        NOW,
      ),
    ).toBe(true);
    expect(
      await checkRoutePermission(
        store,
        { githubLogin: "other", internalUserId: UUID_B } as never,
        "primary",
        "integration:connect",
        NOW,
      ),
    ).toBe(false);
    expect(
      await checkRoutePermission(
        store,
        { githubLogin: "legacy" } as never,
        "primary",
        "integration:connect",
        NOW,
      ),
    ).toBe(false);
  });
});

describe("audit best-effort", () => {
  it("a failing audit store returns ok:false and never throws", async () => {
    const throwingKv: KvLike = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("store unavailable");
      },
      async delete() {},
    };
    const store = createKvAuditStore(throwingKv);
    const result = await recordWiredAuthAudit(
      store,
      buildLoginSuccessAuditEventInput({
        internalUserId: UUID_A,
        tenantId: "primary",
        timestamp: NOW,
        correlationId: "session-1",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("a good audit store records the login event", async () => {
    const store = createKvAuditStore(memoryKv());
    const result = await recordWiredAuthAudit(
      store,
      buildLoginSuccessAuditEventInput({
        internalUserId: UUID_A,
        tenantId: "primary",
        timestamp: NOW,
        correlationId: "session-1",
      }),
    );
    expect(result.ok).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });
});
