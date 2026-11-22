/**
 * #1182 — stable provider-neutral identity.
 *
 * internalUserId becomes a deterministic function of the normalized
 * (issuer, subject) pair (version-prefixed SHA-256), instead of a
 * random UUID minted at first binding whose stability depended on
 * one stored record surviving. A login-time migration inside
 * resolveProviderBinding rewrites minted bindings to the derived
 * id, moves their memberships, and records an old→new alias — all
 * before post-login bootstrap provisioning runs.
 */
import { describe, expect, it } from "vitest";
import {
  createMembership,
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";
import {
  createMemoryIdentityBindingStore,
  deriveInternalUserId,
  type IdentityBindingStore,
} from "../src/security/identityBinding";
import {
  completeWiredLogin,
  resolveProviderBinding,
  type MigrationDeps,
} from "../src/security/iaaaLogin";
import {
  lookupInternalUserIdByLogin,
  lookupMigratedUserId,
  recordIdMigration,
  recordLoginAlias,
} from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";
import type { Env } from "../src/types";
import { makeFakeSessionStore } from "./fake-session-store";

const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const MINTED_ID = "11111111-1111-4111-8111-111111111111";
// Golden vectors: v1: + hex(SHA-256(issuer + "\0" + subject)).
const DERIVED_GITHUB_42 =
  "v1:0962030c695d4b7f3a855132a8d14e814ede67f43f538a4e67bf68a59f99b72a";
const DERIVED_GOOGLE_SUB_1 =
  "v1:c009b4302606b406e1da408a7587c2e6684240a4ea1845e401d16f39be66b647";

function memoryKv(): KvLike & { keys(): string[] } {
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
    keys() {
      return [...map.keys()];
    },
  };
}

function makeDeps(membershipStore: MembershipStore, aliasKv: KvLike): MigrationDeps {
  return { membershipStore, aliasKv };
}

async function seedMintedBinding(
  store: IdentityBindingStore,
  issuer: string,
  subject: string,
  internalUserId: string,
): Promise<void> {
  await store.put({
    internalUserId,
    providerIssuer: issuer,
    providerSubject: subject,
    linkedAt: 1_000,
    proofOfControl: "oidc",
  });
}

async function seedMemberships(store: MembershipStore, userId: string): Promise<void> {
  const admin = await createMembership(store, {
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
    createdBy: "system:bootstrap",
    nowMs: 2_000,
  });
  expect(admin.ok).toBe(true);
  const member = await createMembership(store, {
    internalUserId: userId,
    tenantId: "primary",
    workspaceId: "ws-1",
    roleBindings: [{ role: "member", scope: "workspace", workspaceId: "ws-1", grantedBy: "admin-1" }],
    createdBy: "admin-1",
    nowMs: 3_000,
  });
  expect(member.ok).toBe(true);
  const revoked = await createMembership(store, {
    internalUserId: userId,
    tenantId: "other",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
    createdBy: "system:bootstrap",
    nowMs: 4_000,
  });
  expect(revoked.ok).toBe(true);
  if (!revoked.ok) return;
  // Mirror a genuinely-revoked membership: same record, revoked long ago.
  await store.put({ ...revoked.membership, revokedAtMs: 5_000 });
}

describe("deriveInternalUserId", () => {
  it("is deterministic for the same normalized (issuer, subject)", async () => {
    const a = await deriveInternalUserId(GITHUB_ISSUER, "42");
    const b = await deriveInternalUserId(GITHUB_ISSUER, "42");
    expect(a).toBe(b);
    expect(a).toBe(DERIVED_GITHUB_42);
  });

  it("differs across issuers and across subjects", async () => {
    const github = await deriveInternalUserId(GITHUB_ISSUER, "42");
    const googleSameSubject = await deriveInternalUserId(GOOGLE_ISSUER, "42");
    const githubOtherSubject = await deriveInternalUserId(GITHUB_ISSUER, "43");
    expect(googleSameSubject).not.toBe(github);
    expect(githubOtherSubject).not.toBe(github);
    expect(await deriveInternalUserId(GOOGLE_ISSUER, "google-sub-1")).toBe(
      DERIVED_GOOGLE_SUB_1,
    );
  });

  it("normalizes the way the binding layer does: surrounding whitespace is ignored", async () => {
    const plain = await deriveInternalUserId(GITHUB_ISSUER, "42");
    const padded = await deriveInternalUserId(`  ${GITHUB_ISSUER}  `, "  42  ");
    expect(padded).toBe(plain);
  });

  it("has the version-prefixed SHA-256 shape", async () => {
    const id = await deriveInternalUserId(GITHUB_ISSUER, "42");
    expect(id).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("rejects blank issuer or subject", async () => {
    await expect(deriveInternalUserId("", "42")).rejects.toThrow();
    await expect(deriveInternalUserId(GITHUB_ISSUER, "   ")).rejects.toThrow();
  });
});

describe("login-time migration in resolveProviderBinding", () => {
  it("rewrites a minted binding to the derived id and moves its memberships", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedMintedBinding(bindings, GITHUB_ISSUER, "42", MINTED_ID);
    const memberships = createMemoryMembershipStore();
    await seedMemberships(memberships, MINTED_ID);
    const aliasKv = memoryKv();

    const result = await resolveProviderBinding(
      bindings,
      GITHUB_ISSUER,
      "42",
      10_000,
      makeDeps(memberships, aliasKv),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.internalUserId).toBe(DERIVED_GITHUB_42);
    expect(result.binding.providerIssuer).toBe(GITHUB_ISSUER);
    expect(result.binding.providerSubject).toBe("42");
    // The binding itself is rewritten, not duplicated.
    const byProvider = await bindings.getByProvider(GITHUB_ISSUER, "42");
    expect(byProvider?.internalUserId).toBe(DERIVED_GITHUB_42);
    expect(byProvider?.linkedAt).toBe(1_000);
    expect(await bindings.getByUserAndIssuer(MINTED_ID, GITHUB_ISSUER)).toBeNull();
    expect(
      (await bindings.getByUserAndIssuer(DERIVED_GITHUB_42, GITHUB_ISSUER))
        ?.internalUserId,
    ).toBe(DERIVED_GITHUB_42);

    // Memberships moved: same tenants/roles under the derived id.
    const moved = await memberships.getMembershipsByUser(DERIVED_GITHUB_42);
    expect(moved).toHaveLength(3);
    const primaryAdmin = moved.find(
      (m) => m.tenantId === "primary" && m.roleBindings.some((b) => b.role === "tenant-admin"),
    );
    expect(primaryAdmin).toBeDefined();
    expect(primaryAdmin?.revokedAtMs).toBeUndefined();
    const workspaceMember = moved.find((m) => m.workspaceId === "ws-1");
    expect(workspaceMember?.roleBindings[0]?.role).toBe("member");
    // The genuinely-revoked membership mirrors as revoked, with its
    // original revocation timestamp preserved — never resurrected.
    const otherRevoked = moved.find((m) => m.tenantId === "other");
    expect(otherRevoked?.revokedAtMs).toBe(5_000);

    // Old memberships are revoked, not deleted (evidence preserved).
    const olds = await memberships.getMembershipsByUser(MINTED_ID);
    expect(olds).toHaveLength(3);
    for (const old of olds) {
      expect(old.revokedAtMs).toBeDefined();
    }

    // Old→new alias recorded via the alias layer.
    expect(await lookupMigratedUserId(aliasKv, MINTED_ID)).toBe(DERIVED_GITHUB_42);
  });

  it("is idempotent: a re-login is a no-op with no duplicate memberships", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedMintedBinding(bindings, GITHUB_ISSUER, "42", MINTED_ID);
    const memberships = createMemoryMembershipStore();
    await seedMemberships(memberships, MINTED_ID);
    const aliasKv = memoryKv();
    const deps = makeDeps(memberships, aliasKv);

    const first = await resolveProviderBinding(bindings, GITHUB_ISSUER, "42", 10_000, deps);
    expect(first.ok).toBe(true);
    const second = await resolveProviderBinding(bindings, GITHUB_ISSUER, "42", 11_000, deps);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.binding.internalUserId).toBe(DERIVED_GITHUB_42);
    expect(await memberships.getMembershipsByUser(DERIVED_GITHUB_42)).toHaveLength(3);
    expect(await lookupMigratedUserId(aliasKv, MINTED_ID)).toBe(DERIVED_GITHUB_42);
  });

  it("is a no-op for a binding that is already derived", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedMintedBinding(bindings, GITHUB_ISSUER, "42", DERIVED_GITHUB_42);
    const memberships = createMemoryMembershipStore();
    await seedMemberships(memberships, DERIVED_GITHUB_42);
    const aliasKv = memoryKv();

    const result = await resolveProviderBinding(
      bindings,
      GITHUB_ISSUER,
      "42",
      10_000,
      makeDeps(memberships, aliasKv),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.internalUserId).toBe(DERIVED_GITHUB_42);
    expect(result.binding.linkedAt).toBe(1_000);
    expect(await memberships.getMembershipsByUser(DERIVED_GITHUB_42)).toHaveLength(3);
    expect(await lookupMigratedUserId(aliasKv, DERIVED_GITHUB_42)).toBeNull();
  });

  it("creates a derived binding when none exists", async () => {
    const bindings = createMemoryIdentityBindingStore();
    const memberships = createMemoryMembershipStore();
    const aliasKv = memoryKv();

    const result = await resolveProviderBinding(
      bindings,
      GITHUB_ISSUER,
      "42",
      10_000,
      makeDeps(memberships, aliasKv),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.internalUserId).toBe(DERIVED_GITHUB_42);
    expect(await memberships.getMembershipsByUser(DERIVED_GITHUB_42)).toHaveLength(0);
  });

  it("without migration deps, an existing minted binding is returned unchanged", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedMintedBinding(bindings, GITHUB_ISSUER, "42", MINTED_ID);
    const result = await resolveProviderBinding(bindings, GITHUB_ISSUER, "42", 10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.internalUserId).toBe(MINTED_ID);
  });

  it("fails closed when the membership move fails, leaving the minted binding intact", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedMintedBinding(bindings, GITHUB_ISSUER, "42", MINTED_ID);
    const failingMemberships: MembershipStore = {
      async getMembershipsByUser(internalUserId: string) {
        if (internalUserId !== MINTED_ID) return [];
        return [
          {
            membershipId: "m-1",
            internalUserId: MINTED_ID,
            tenantId: "primary",
            roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
            createdBy: "system:bootstrap",
            createdAtMs: 2_000,
          },
        ];
      },
      async put() {
        throw new Error("membership store unavailable");
      },
      async revokeMembership() {
        return true;
      },
    };
    const result = await resolveProviderBinding(
      bindings,
      GITHUB_ISSUER,
      "42",
      10_000,
      makeDeps(failingMemberships, memoryKv()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("BINDING_FAILED");
    // Retryable: the minted binding was not rewritten.
    expect((await bindings.getByProvider(GITHUB_ISSUER, "42"))?.internalUserId).toBe(
      MINTED_ID,
    );
  });
});

describe("completeWiredLogin carries the derived id (Google path, generic tail)", () => {
  function makeEnv() {
    const { namespace, store } = makeFakeSessionStore();
    const env = {
      SESSION_STORE: namespace,
      SESSION_SECRET: "test-secret",
      APP_BASE_URL: "https://agent.test",
    } as unknown as Env;
    return { env, store };
  }

  function sessionEntries(store: Map<string, string>) {
    return [...store.entries()].filter(([k]) => /^sessions:[0-9a-f-]{36}$/.test(k));
  }

  it("migrates a minted Google binding and the session carries the derived id", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    await seedMintedBinding(bindingStore, GOOGLE_ISSUER, "google-sub-1", MINTED_ID);
    const memberships = createMemoryMembershipStore();
    await seedMemberships(memberships, MINTED_ID);
    const aliasKv = memoryKv();

    const res = await completeWiredLogin(
      env,
      GOOGLE_ISSUER,
      {
        subject: "google-sub-1",
        loginKey: "user@example.com",
        displayName: "Example User",
        avatarUrl: "https://example.com/pic",
      },
      {
        bindingStore,
        migration: makeDeps(memberships, aliasKv),
        nowMs: 5_000_000,
      },
    );
    expect(res.status).toBe(302);
    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    const session = JSON.parse(sessions[0][1]);
    expect(session.internalUserId).toBe(DERIVED_GOOGLE_SUB_1);
    expect(session.providerIssuer).toBe(GOOGLE_ISSUER);
    expect(session.providerSubject).toBe("google-sub-1");
    expect((await bindingStore.getByProvider(GOOGLE_ISSUER, "google-sub-1"))?.internalUserId).toBe(
      DERIVED_GOOGLE_SUB_1,
    );
    expect(await memberships.getMembershipsByUser(DERIVED_GOOGLE_SUB_1)).toHaveLength(3);
    expect(await lookupMigratedUserId(aliasKv, MINTED_ID)).toBe(DERIVED_GOOGLE_SUB_1);
  });

  it("derivation uses only (issuer, subject): a login-key change never re-identifies", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const first = await completeWiredLogin(
      env,
      GOOGLE_ISSUER,
      {
        subject: "google-sub-1",
        loginKey: "first@example.com",
        displayName: "First",
        avatarUrl: "",
      },
      { bindingStore, nowMs: 5_000_000 },
    );
    expect(first.status).toBe(302);
    const second = await completeWiredLogin(
      env,
      GOOGLE_ISSUER,
      {
        subject: "google-sub-1",
        loginKey: "second@example.com",
        displayName: "Second",
        avatarUrl: "",
      },
      { bindingStore, nowMs: 6_000_000 },
    );
    expect(second.status).toBe(302);
    const sessions = sessionEntries(store).map(([, v]) => JSON.parse(v));
    expect(sessions).toHaveLength(2);
    expect(sessions[0].internalUserId).toBe(DERIVED_GOOGLE_SUB_1);
    expect(sessions[1].internalUserId).toBe(DERIVED_GOOGLE_SUB_1);
  });

  it("migration runs BEFORE bootstrap provisioning: an issuer:subject entry provisions the derived id", async () => {
    const { env, store } = makeEnv();
    (env as unknown as Record<string, unknown>).IAAA_BOOTSTRAP_ADMINS =
      `${GOOGLE_ISSUER}:google-sub-1`;
    const bindingStore = createMemoryIdentityBindingStore();
    await seedMintedBinding(bindingStore, GOOGLE_ISSUER, "google-sub-1", MINTED_ID);

    const res = await completeWiredLogin(
      env,
      GOOGLE_ISSUER,
      {
        subject: "google-sub-1",
        loginKey: "user@example.com",
        displayName: "Example User",
        avatarUrl: "https://example.com/pic",
      },
      {
        bindingStore,
        nowMs: 5_000_000,
        postLoginEnabled: true,
        auditTenantId: "primary",
      },
    );
    expect(res.status).toBe(302);
    const sessions = sessionEntries(store).map(([, v]) => JSON.parse(v));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].internalUserId).toBe(DERIVED_GOOGLE_SUB_1);
    // Bootstrap resolved the issuer:subject entry through the
    // (migrated) binding and provisioned under the derived id —
    // proving migration ran before bootstrap matching. The
    // membership store here is the env-derived (fake-DO) store.
    const membershipRecords = [...store.entries()]
      .filter(([k]) => k.startsWith("sessions:iaaa-membership:") && !k.includes(":user:"))
      .map(([, v]) => JSON.parse(v));
    const derivedAdmin = membershipRecords.find(
      (m) =>
        m.internalUserId === DERIVED_GOOGLE_SUB_1 &&
        m.roleBindings?.some((b: { role: string }) => b.role === "tenant-admin"),
    );
    expect(derivedAdmin).toBeDefined();
    expect(
      membershipRecords.some((m) => m.internalUserId === MINTED_ID),
    ).toBe(false);
  });
});

describe("id-migration alias records", () => {
  it("is idempotent for the same pair and refuses a conflicting new id", async () => {
    const kv = memoryKv();
    const first = await recordIdMigration(kv, {
      oldInternalUserId: MINTED_ID,
      newInternalUserId: DERIVED_GITHUB_42,
      nowMs: 10_000,
    });
    expect(first.ok).toBe(true);
    const again = await recordIdMigration(kv, {
      oldInternalUserId: MINTED_ID,
      newInternalUserId: DERIVED_GITHUB_42,
      nowMs: 11_000,
    });
    expect(again.ok).toBe(true);
    const conflict = await recordIdMigration(kv, {
      oldInternalUserId: MINTED_ID,
      newInternalUserId: DERIVED_GOOGLE_SUB_1,
      nowMs: 12_000,
    });
    expect(conflict.ok).toBe(false);
    expect(await lookupMigratedUserId(kv, MINTED_ID)).toBe(DERIVED_GITHUB_42);
  });
});

describe("login-alias lookup follows the id-migration record (#6182)", () => {
  it("the live scenario: after migration rewrites the binding, the alias still resolves the retired id until the lookup follows the record", async () => {
    const kv = memoryKv();
    const bindings = createMemoryIdentityBindingStore();
    const memberships = createMemoryMembershipStore();
    await seedMintedBinding(bindings, GITHUB_ISSUER, "42", MINTED_ID);
    await seedMemberships(memberships, MINTED_ID);
    const aliased = await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: MINTED_ID,
      nowMs: 1_000,
    });
    expect(aliased.ok).toBe(true);
    // The wired login migrates the binding to the derived id...
    const resolved = await resolveProviderBinding(
      bindings,
      GITHUB_ISSUER,
      "42",
      20_000,
      makeDeps(memberships, kv),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.binding.internalUserId).toBe(DERIVED_GITHUB_42);
    // ...but post-login alias recording hits ALIAS_CONFLICT (the
    // alias already points at the retired id), so the alias is
    // unchanged — and every login-keyed reader must still reach
    // the derived id by following the migration record.
    const after = await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: DERIVED_GITHUB_42,
      nowMs: 21_000,
    });
    expect(after.ok).toBe(false);
    expect(await lookupInternalUserIdByLogin(kv, "octocat")).toBe(DERIVED_GITHUB_42);
  });

  it("without a migration record the alias resolves verbatim", async () => {
    const kv = memoryKv();
    await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: MINTED_ID,
      nowMs: 1_000,
    });
    expect(await lookupInternalUserIdByLogin(kv, "octocat")).toBe(MINTED_ID);
  });

  it("no alias returns null, even when a migration record exists", async () => {
    const kv = memoryKv();
    await recordIdMigration(kv, {
      oldInternalUserId: MINTED_ID,
      newInternalUserId: DERIVED_GITHUB_42,
      nowMs: 10_000,
    });
    expect(await lookupInternalUserIdByLogin(kv, "nobody")).toBe(null);
  });

  it("follows a chain of migrations to the current id", async () => {
    const kv = memoryKv();
    await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: MINTED_ID,
      nowMs: 1_000,
    });
    await recordIdMigration(kv, {
      oldInternalUserId: MINTED_ID,
      newInternalUserId: DERIVED_GITHUB_42,
      nowMs: 10_000,
    });
    await recordIdMigration(kv, {
      oldInternalUserId: DERIVED_GITHUB_42,
      newInternalUserId: DERIVED_GOOGLE_SUB_1,
      nowMs: 11_000,
    });
    expect(await lookupInternalUserIdByLogin(kv, "octocat")).toBe(DERIVED_GOOGLE_SUB_1);
  });

  it("a self-referential migration record terminates on the alias value", async () => {
    const kv = memoryKv();
    await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: MINTED_ID,
      nowMs: 1_000,
    });
    await recordIdMigration(kv, {
      oldInternalUserId: MINTED_ID,
      newInternalUserId: MINTED_ID,
      nowMs: 10_000,
    });
    expect(await lookupInternalUserIdByLogin(kv, "octocat")).toBe(MINTED_ID);
  });

  it("a corrupt migration record falls back to the alias value, never throws", async () => {
    const kv = memoryKv();
    await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: MINTED_ID,
      nowMs: 1_000,
    });
    await kv.put(`iaaa-alias:migrated:${MINTED_ID}`, "not-json{");
    expect(await lookupInternalUserIdByLogin(kv, "octocat")).toBe(MINTED_ID);
  });
});
