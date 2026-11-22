/**
 * #1208 — one-time genesis marker reset for the stranded Oct 22
 * activation grant.
 *
 * After #1182 (derived ids) + #1196 (issuer:subject bootstrap
 * entries), the owner login gets tenant-admin (E*TRADE works) but
 * NOT platform-admin (panel denies), because the genesis marker
 * was already set by the Oct 22 activation identity — a minted id
 * no current login carries. The fix lives in runWiredPostLogin's
 * matchedGenesis branch: before the genesis decision, delete the
 * marker if and only if the logging-in user matches a platform:
 * entry, does NOT already hold platform-admin, and the marker
 * parses as JSON with grantedTo exactly the retired Oct 22 id.
 * Then the existing genesis path runs unchanged (grant + re-set).
 *
 * #6191 — the repair runs in GLOBAL-ONCE mode only
 * (genesis.oneTime: true): the stranded marker lives on the
 * legacy global key, which the per-identity default never reads.
 * These tests therefore run with genesisOneTime: true; the
 * per-identity counterpart (a stranded global marker does not
 * block a per-identity claim) is pinned in
 * iaaa_genesis_atomic_claim.test.ts.
 *
 * Fail-closed pins: unparsable or malformed markers are NOT
 * deleted (genesis-closed path); a delete failure yields status
 * "error" without failing the login; not-listed and plain-entry
 * users never delete; an already-admin user never deletes.
 * Self-retiring: after the grant, the marker's grantedTo is the
 * logging-in id and the user holds platform-admin, so the reset
 * conditions can never hold again.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryIdentityBindingStore,
  resolveOrCreateBinding,
} from "../src/security/identityBinding";
import {
  createMemoryMembershipStore,
} from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";
import {
  platformGenesisMarkerKey,
  runWiredPostLogin,
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
const RETIRED_OCT22_ID = "00fbb0ba-9e4b-43ec-a7d6-df2a1dfc5d6c";
const NOW = 1780000000000;
const MARKER_KEY = platformGenesisMarkerKey("primary");

function strandedMarker(): string {
  return JSON.stringify({
    grantedTo: RETIRED_OCT22_ID,
    tenantId: "primary",
    atMs: NOW - 1000,
  });
}

function deps() {
  return {
    kv: memoryKv(),
    bindingStore: createMemoryIdentityBindingStore(),
    membershipStore: createMemoryMembershipStore(),
    // #6191 — the #1208 repair is global-once-only.
    genesisOneTime: true,
  };
}

function loginInput(
  internalUserId: string,
  bootstrapRaw: string | undefined,
) {
  return {
    githubLogin: "octo",
    internalUserId,
    providerIssuer: "https://github.com",
    providerSubject: "123",
    bootstrapRaw,
    tenantId: "primary",
    nowMs: NOW,
  };
}

describe("one-time genesis marker reset (#1208)", () => {
  it("resets a stranded marker, grants platform-admin, and re-sets the marker", async () => {
    const d = deps();
    await d.kv.put(MARKER_KEY, strandedMarker());
    const result = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis");
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("platform-admin");
    expect(memberships[0].roleBindings[0].scope).toBe("platform");
    expect(memberships[0].createdBy).toBe("system:bootstrap-genesis");
    const marker = await d.kv.get(MARKER_KEY);
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker!).grantedTo).toBe(UUID_A);
    expect(JSON.parse(marker!).tenantId).toBe("primary");
  });

  it("resets via an issuer:subject platform: entry resolved through the binding", async () => {
    const d = deps();
    const binding = await resolveOrCreateBinding(d.bindingStore, {
      providerIssuer: "https://github.com",
      providerSubject: "123",
      proofVerified: true,
      nowMs: NOW,
    });
    if (!binding.ok) throw new Error("binding setup failed");
    await d.kv.put(MARKER_KEY, strandedMarker());
    const result = await runWiredPostLogin(
      d,
      loginInput(binding.binding.internalUserId, "platform:https://github.com:123"),
    );
    expect(result.bootstrap.status).toBe("genesis");
    const memberships = await d.membershipStore.getMembershipsByUser(
      binding.binding.internalUserId,
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("platform-admin");
    const marker = await d.kv.get(MARKER_KEY);
    expect(JSON.parse(marker!).grantedTo).toBe(binding.binding.internalUserId);
  });

  it("does not delete a marker granted to a different id; tenant-admin only", async () => {
    const d = deps();
    const otherMarker = JSON.stringify({
      grantedTo: UUID_C,
      tenantId: "primary",
      atMs: NOW - 1000,
    });
    await d.kv.put(MARKER_KEY, otherMarker);
    // #6191 — platform,tenant: so the closed path still grants
    // tenant-admin (a platform-only entry would get
    // genesis-claim-lost and no tenant grant).
    const result = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis-closed-tenant-admin");
    expect(await d.kv.get(MARKER_KEY)).toBe(otherMarker);
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
  });

  it("does not delete when the user already holds platform-admin", async () => {
    const d = deps();
    const first = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform:${UUID_A}`),
    );
    expect(first.bootstrap.status).toBe("genesis");
    // Simulate the stranded state arriving after the grant.
    await d.kv.put(MARKER_KEY, strandedMarker());
    const second = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform:${UUID_A}`),
    );
    expect(second.bootstrap.status).toBe("already-admin");
    expect(await d.kv.get(MARKER_KEY)).toBe(strandedMarker());
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("platform-admin");
  });

  it("marker absent still grants via the normal genesis path", async () => {
    const d = deps();
    const result = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis");
    const marker = await d.kv.get(MARKER_KEY);
    expect(JSON.parse(marker!).grantedTo).toBe(UUID_A);
  });

  it("does not delete an unparsable marker; genesis-closed path", async () => {
    const d = deps();
    await d.kv.put(MARKER_KEY, "not-json{{{");
    // #6191 — platform,tenant: so the closed path still grants
    // tenant-admin (a platform-only entry would get
    // genesis-claim-lost and no tenant grant).
    const result = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis-closed-tenant-admin");
    expect(await d.kv.get(MARKER_KEY)).toBe("not-json{{{");
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
  });

  it("does not delete a malformed marker without grantedTo", async () => {
    const d = deps();
    const malformed = JSON.stringify({ tenantId: "primary", atMs: NOW });
    await d.kv.put(MARKER_KEY, malformed);
    // #6191 — platform,tenant: so the closed path still grants
    // tenant-admin (a platform-only entry would get
    // genesis-claim-lost and no tenant grant).
    const result = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform,tenant:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("genesis-closed-tenant-admin");
    expect(await d.kv.get(MARKER_KEY)).toBe(malformed);
  });

  it("does not delete for a not-listed user", async () => {
    const d = deps();
    await d.kv.put(MARKER_KEY, strandedMarker());
    const result = await runWiredPostLogin(
      d,
      loginInput(UUID_A, `platform:${UUID_B}`),
    );
    expect(result.bootstrap.status).toBe("not-listed");
    expect(await d.kv.get(MARKER_KEY)).toBe(strandedMarker());
    expect(await d.membershipStore.getMembershipsByUser(UUID_A)).toEqual([]);
  });

  it("plain entry does not delete the marker; tenant-admin only", async () => {
    const d = deps();
    await d.kv.put(MARKER_KEY, strandedMarker());
    const result = await runWiredPostLogin(d, loginInput(UUID_A, UUID_A));
    expect(result.bootstrap.status).toBe("provisioned");
    expect(await d.kv.get(MARKER_KEY)).toBe(strandedMarker());
    const memberships = await d.membershipStore.getMembershipsByUser(UUID_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
  });

  it("a delete failure yields bootstrap error without failing the login", async () => {
    const backing = memoryKv();
    await backing.put(MARKER_KEY, strandedMarker());
    const failingKv: KvLike = {
      async get(key: string) {
        return backing.get(key);
      },
      async put(key: string, value: string) {
        return backing.put(key, value);
      },
      async delete() {
        throw new Error("store unavailable");
      },
    };
    const result = await runWiredPostLogin(
      {
        kv: failingKv,
        bindingStore: createMemoryIdentityBindingStore(),
        membershipStore: createMemoryMembershipStore(),
        // #6191 — the #1208 repair is global-once-only.
        genesisOneTime: true,
      },
      loginInput(UUID_A, `platform:${UUID_A}`),
    );
    expect(result.bootstrap.status).toBe("error");
  });
});
