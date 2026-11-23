import { describe, it, expect } from "vitest";
import {
  createMemoryMembershipStore,
  createMembership,
  type Membership,
} from "../src/security/authorization";
import {
  createMemoryIdentityBindingStore,
  deriveInternalUserId,
  type IdentityBindingStore,
} from "../src/security/identityBinding";
import {
  recordIdMigration,
  STRANDED_PLATFORM_ADMIN_ID,
} from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";
import {
  cleanupStrandedIdReferences,
  resolveStaleCleanupMode,
  runStaleIdentityCleanup,
  type StaleCleanupItem,
} from "../src/security/iaaaStaleCleanup";
import { currentBootstrapEntries } from "../src/security/bootstrapProposals";
import { isPlatformBootstrapListed } from "../src/security/iaaaLogin";

/**
 * #6236 (subsumes #6240) — remove all stranded / stale ids and
 * accounts through the application. TDD Red: the cleanup module
 * does not exist yet, so this suite fails to load before the fix.
 *
 * Seeded production shape (from the live 2026-11-23 verification):
 * - GitHub owner identity https://github.com:82253453, minted old
 *   id superseded by the derived v1: id; its alias rows and
 *   reverse-index entry still point at the old id; its original
 *   membership is revoked (audit history, must be RETAINED).
 * - Stranded Oct 22 identity 00fbb0ba-… (STRANDED_PLATFORM_ADMIN_ID)
 *   with stale alias rows / reverse-index entry and a revoked
 *   membership.
 * - Google owner identity https://accounts.google.com:116080816274398642624
 *   with a live derived id — must be untouched.
 */

const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GITHUB_SUBJECT = "82253453";
const GOOGLE_SUBJECT = "116080816274398642624";
const OLD_MINTED_ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1794000000000;
const TENANT = "primary";

function memoryKv(): KvLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
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

function aliasValue(githubLogin: string, internalUserId: string): string {
  return JSON.stringify({
    githubLogin,
    internalUserId,
    recordedAtMs: NOW,
    source: "wired-login",
  });
}

function entriesFromKv(
  kv: KvLike & { map: Map<string, string> },
  prefix: string,
): Array<{ key: string; value: string }> {
  return [...kv.map.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ key, value }));
}

function reverseKey(userId: string, issuer: string): string {
  return `iaaa-binding:user:${userId}\0${issuer}`;
}

/** Binding store that records removeByUserAndIssuer calls. */
function spyingBindingStore(): IdentityBindingStore & {
  removed: Array<{ internalUserId: string; providerIssuer: string }>;
} {
  const inner = createMemoryIdentityBindingStore();
  const removed: Array<{ internalUserId: string; providerIssuer: string }> = [];
  return {
    ...inner,
    removed,
    async removeByUserAndIssuer(internalUserId: string, providerIssuer: string) {
      removed.push({ internalUserId, providerIssuer });
      await inner.removeByUserAndIssuer(internalUserId, providerIssuer);
    },
  };
}

async function seedMigratedGithub(world: {
  kv: KvLike & { map: Map<string, string> };
  bindingStore: IdentityBindingStore;
  reverseEntries: Array<{ key: string; value: string }>;
  derivedId: string;
}): Promise<void> {
  // Pre-migration binding (minted id), then the migrated binding
  // (derived id) — the by-provider record now carries the derived
  // id while the old reverse-index entry still lists the old id.
  const oldBinding = {
    internalUserId: OLD_MINTED_ID,
    providerIssuer: GITHUB_ISSUER,
    providerSubject: GITHUB_SUBJECT,
    linkedAt: NOW,
    proofOfControl: "oidc" as const,
  };
  await world.bindingStore.put(oldBinding);
  world.reverseEntries.push({
    key: reverseKey(OLD_MINTED_ID, GITHUB_ISSUER),
    value: JSON.stringify(oldBinding),
  });
  const derivedBinding = { ...oldBinding, internalUserId: world.derivedId };
  await world.bindingStore.put(derivedBinding);
  world.reverseEntries.push({
    key: reverseKey(world.derivedId, GITHUB_ISSUER),
    value: JSON.stringify(derivedBinding),
  });
  // The migration forward pointer (never deleted).
  const recorded = await recordIdMigration(world.kv, {
    oldInternalUserId: OLD_MINTED_ID,
    newInternalUserId: world.derivedId,
    nowMs: NOW,
  });
  expect(recorded.ok).toBe(true);
  // Stale alias rows pointing at the old id; one live row for the
  // derived id.
  await world.kv.put(
    `iaaa-alias:user:${OLD_MINTED_ID}`,
    aliasValue("OpenAIMP", OLD_MINTED_ID),
  );
  await world.kv.put(
    "iaaa-alias:login:OpenAIMP",
    aliasValue("OpenAIMP", OLD_MINTED_ID),
  );
  await world.kv.put(
    `iaaa-alias:user:${world.derivedId}`,
    aliasValue("OpenAIMP", world.derivedId),
  );
}

async function seedMemberships(world: {
  membershipStore: ReturnType<typeof createMemoryMembershipStore>;
  derivedId: string;
}): Promise<{ revokedOld: Membership; liveDerived: Membership }> {
  const old = await createMembership(world.membershipStore, {
    internalUserId: OLD_MINTED_ID,
    tenantId: TENANT,
    roleBindings: [
      { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    nowMs: NOW,
  });
  expect(old.ok).toBe(true);
  if (!old.ok) throw new Error("seed failed");
  await world.membershipStore.revokeMembership(old.membership.membershipId, NOW);
  const live = await createMembership(world.membershipStore, {
    internalUserId: world.derivedId,
    tenantId: TENANT,
    roleBindings: [
      { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap" },
      { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    nowMs: NOW,
  });
  expect(live.ok).toBe(true);
  if (!live.ok) throw new Error("seed failed");
  return { revokedOld: old.membership, liveDerived: live.membership };
}

async function listMemberships(
  store: ReturnType<typeof createMemoryMembershipStore>,
  userIds: string[],
): Promise<Membership[]> {
  const out: Membership[] = [];
  for (const id of userIds) {
    out.push(...(await store.getMembershipsByUser(id)));
  }
  return out;
}

describe("resolveStaleCleanupMode", () => {
  it("executes only on an explicit execute value; anything else fails closed to dry-run", () => {
    expect(resolveStaleCleanupMode("execute")).toBe("execute");
    expect(resolveStaleCleanupMode("EXECUTE")).toBe("execute");
    expect(resolveStaleCleanupMode("  execute  ")).toBe("execute");
    expect(resolveStaleCleanupMode(undefined)).toBe("dry-run");
    expect(resolveStaleCleanupMode("")).toBe("dry-run");
    expect(resolveStaleCleanupMode("dry-run")).toBe("dry-run");
    expect(resolveStaleCleanupMode("on")).toBe("dry-run");
    expect(resolveStaleCleanupMode("yes")).toBe("dry-run");
    expect(resolveStaleCleanupMode("delete-everything")).toBe("dry-run");
  });
});

describe("runStaleIdentityCleanup — dry-run inventory", () => {
  it("names every stale item, deletes nothing, and keeps the migration forward pointer", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const membershipStore = createMemoryMembershipStore();
    const reverseEntries: Array<{ key: string; value: string }> = [];
    await seedMigratedGithub({ kv, bindingStore, reverseEntries, derivedId });
    const { revokedOld } = await seedMemberships({ membershipStore, derivedId });

    const report = await runStaleIdentityCleanup({
      aliasKv: kv,
      bindingStore,
      listAliasEntries: () => Promise.resolve(entriesFromKv(kv, "iaaa-alias:")),
      listReverseIndexEntries: () => Promise.resolve([...reverseEntries]),
      listMemberships: () =>
        listMemberships(membershipStore, [OLD_MINTED_ID, derivedId]),
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "dry-run",
    });

    expect(report.mode).toBe("dry-run");
    expect(report.dryRun).toBe(true);
    expect(report.deletedCount).toBe(0);
    const byKind = (kind: StaleCleanupItem["kind"]) =>
      report.items.filter((i) => i.kind === kind);
    expect(byKind("stale-alias-row")).toHaveLength(2);
    expect(byKind("stale-alias-row").every((i) => i.disposition === "reported-only")).toBe(true);
    expect(byKind("stale-reverse-index")).toHaveLength(1);
    expect(byKind("stale-reverse-index")[0].disposition).toBe("reported-only");
    const retained = byKind("revoked-membership-retained");
    expect(retained).toHaveLength(1);
    expect(retained[0].disposition).toBe("retained-audit-history");
    expect(retained[0].internalUserId).toBe(OLD_MINTED_ID);
    expect(byKind("migration-forward-pointer")).toHaveLength(1);
    expect(byKind("migration-forward-pointer")[0].disposition).toBe(
      "retained-forward-pointer",
    );
    // Nothing deleted: rows, reverse entry, and the revoked record
    // are all still there; the live alias row has no item at all.
    expect(await kv.get(`iaaa-alias:user:${OLD_MINTED_ID}`)).not.toBeNull();
    expect(await kv.get("iaaa-alias:login:OpenAIMP")).not.toBeNull();
    expect(await lookupAliasStillThere(kv, derivedId)).toBe(true);
    expect(
      await bindingStore.getByUserAndIssuer(OLD_MINTED_ID, GITHUB_ISSUER),
    ).not.toBeNull();
    expect(bindingStore.removed).toHaveLength(0);
    const olds = await membershipStore.getMembershipsByUser(OLD_MINTED_ID);
    expect(olds).toHaveLength(1);
    expect(olds[0].membershipId).toBe(revokedOld.membershipId);
    expect(olds[0].revokedAtMs).toBe(NOW);
    expect(report.items.some((i) => i.internalUserId === derivedId)).toBe(false);
  });

  async function lookupAliasStillThere(
    kv: KvLike,
    derivedId: string,
  ): Promise<boolean> {
    return (await kv.get(`iaaa-alias:user:${derivedId}`)) !== null;
  }
});

describe("runStaleIdentityCleanup — execute mode", () => {
  it("deletes the stale alias rows and reverse entry, keeps the forward pointer and the live binding", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const membershipStore = createMemoryMembershipStore();
    const reverseEntries: Array<{ key: string; value: string }> = [];
    await seedMigratedGithub({ kv, bindingStore, reverseEntries, derivedId });
    await seedMemberships({ membershipStore, derivedId });
    const audited: StaleCleanupItem[] = [];

    const report = await runStaleIdentityCleanup({
      aliasKv: kv,
      bindingStore,
      listAliasEntries: () => Promise.resolve(entriesFromKv(kv, "iaaa-alias:")),
      listReverseIndexEntries: () => Promise.resolve([...reverseEntries]),
      listMemberships: () =>
        listMemberships(membershipStore, [OLD_MINTED_ID, derivedId]),
      audit: async (item) => {
        audited.push(item);
      },
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "execute",
    });

    expect(report.dryRun).toBe(false);
    expect(report.deletedCount).toBe(3);
    expect(await kv.get(`iaaa-alias:user:${OLD_MINTED_ID}`)).toBeNull();
    expect(await kv.get("iaaa-alias:login:OpenAIMP")).toBeNull();
    // Live alias row untouched.
    expect(await kv.get(`iaaa-alias:user:${derivedId}`)).not.toBeNull();
    // Forward pointer never deleted.
    const { lookupMigratedUserId } = await import("../src/security/iaaaMigration");
    expect(await lookupMigratedUserId(kv, OLD_MINTED_ID)).toBe(derivedId);
    // Reverse entry removed; the live binding still resolves.
    expect(bindingStore.removed).toEqual([
      { internalUserId: OLD_MINTED_ID, providerIssuer: GITHUB_ISSUER },
    ]);
    expect(
      await bindingStore.getByUserAndIssuer(OLD_MINTED_ID, GITHUB_ISSUER),
    ).toBeNull();
    expect(
      await bindingStore.getByProvider(GITHUB_ISSUER, GITHUB_SUBJECT),
    ).toMatchObject({ internalUserId: derivedId });
    // One audit event per deletion.
    expect(audited).toHaveLength(3);
    expect(audited.every((i) => i.disposition === "deleted")).toBe(true);
    // The revoked membership is retained as audit history, not deleted.
    const olds = await membershipStore.getMembershipsByUser(OLD_MINTED_ID);
    expect(olds).toHaveLength(1);
    expect(olds[0].revokedAtMs).toBe(NOW);
  });

  it("never deletes an orphan alias row or a corrupt row: no migration record, no proof, no delete", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const membershipStore = createMemoryMembershipStore();
    const orphanId = "33333333-3333-4333-8333-333333333333";
    await kv.put(`iaaa-alias:user:${orphanId}`, aliasValue("GhostLogin", orphanId));
    await kv.put("iaaa-alias:user:corrupt-row", "not-json{{{");
    const report = await runStaleIdentityCleanup({
      aliasKv: kv,
      bindingStore,
      listAliasEntries: () => Promise.resolve(entriesFromKv(kv, "iaaa-alias:")),
      listReverseIndexEntries: () => Promise.resolve([]),
      listMemberships: () => Promise.resolve([]),
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "execute",
    });
    expect(report.deletedCount).toBe(0);
    expect(await kv.get(`iaaa-alias:user:${orphanId}`)).not.toBeNull();
    expect(await kv.get("iaaa-alias:user:corrupt-row")).not.toBeNull();
    expect(report.items.some((i) => i.kind === "orphan-alias-row")).toBe(true);
    expect(report.items.some((i) => i.kind === "corrupt-alias-row")).toBe(true);
  });

  it("never deletes a reverse entry whose provider binding is gone: orphan, reported only", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const dangling = {
      internalUserId: OLD_MINTED_ID,
      providerIssuer: GITHUB_ISSUER,
      providerSubject: GITHUB_SUBJECT,
      linkedAt: NOW,
      proofOfControl: "oidc" as const,
    };
    const report = await runStaleIdentityCleanup({
      aliasKv: kv,
      bindingStore,
      listAliasEntries: () => Promise.resolve([]),
      listReverseIndexEntries: () =>
        Promise.resolve([
          { key: reverseKey(OLD_MINTED_ID, GITHUB_ISSUER), value: JSON.stringify(dangling) },
        ]),
      listMemberships: () => Promise.resolve([]),
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "execute",
    });
    expect(report.deletedCount).toBe(0);
    expect(bindingStore.removed).toHaveLength(0);
    expect(report.items.some((i) => i.kind === "orphan-reverse-index")).toBe(true);
  });

  it("reports an active grant under a retired id but never deletes it", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const membershipStore = createMemoryMembershipStore();
    const recorded = await recordIdMigration(kv, {
      oldInternalUserId: OLD_MINTED_ID,
      newInternalUserId: derivedId,
      nowMs: NOW,
    });
    expect(recorded.ok).toBe(true);
    const active = await createMembership(membershipStore, {
      internalUserId: OLD_MINTED_ID,
      tenantId: TENANT,
      roleBindings: [
        { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap" },
      ],
      createdBy: "system:bootstrap",
      nowMs: NOW,
    });
    expect(active.ok).toBe(true);
    const report = await runStaleIdentityCleanup({
      aliasKv: kv,
      bindingStore,
      listAliasEntries: () => Promise.resolve([]),
      listReverseIndexEntries: () => Promise.resolve([]),
      listMemberships: () => listMemberships(membershipStore, [OLD_MINTED_ID]),
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "execute",
    });
    expect(report.items.some((i) => i.kind === "active-grant-under-retired-id")).toBe(true);
    expect(
      report.items.find((i) => i.kind === "active-grant-under-retired-id")
        ?.disposition,
    ).toBe("reported-only");
    const olds = await membershipStore.getMembershipsByUser(OLD_MINTED_ID);
    expect(olds).toHaveLength(1);
    expect(olds[0].revokedAtMs).toBeUndefined();
  });

  it("an audit failure is named in the report and never stops the pass", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const reverseEntries: Array<{ key: string; value: string }> = [];
    await seedMigratedGithub({ kv, bindingStore, reverseEntries, derivedId });
    const report = await runStaleIdentityCleanup({
      aliasKv: kv,
      bindingStore,
      listAliasEntries: () => Promise.resolve(entriesFromKv(kv, "iaaa-alias:")),
      listReverseIndexEntries: () => Promise.resolve([...reverseEntries]),
      listMemberships: () => Promise.resolve([]),
      audit: async () => {
        throw new Error("audit store down");
      },
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "execute",
    });
    expect(report.deletedCount).toBe(3);
    expect(report.auditFailures.length).toBe(3);
    expect(await kv.get(`iaaa-alias:user:${OLD_MINTED_ID}`)).toBeNull();
  });

  it("leaves both live owner identities byte-identical when there is nothing stale", async () => {
    const githubDerived = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const googleDerived = await deriveInternalUserId(GOOGLE_ISSUER, GOOGLE_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const membershipStore = createMemoryMembershipStore();
    for (const [issuer, subject, id] of [
      [GITHUB_ISSUER, GITHUB_SUBJECT, githubDerived],
      [GOOGLE_ISSUER, GOOGLE_SUBJECT, googleDerived],
    ] as const) {
      await bindingStore.put({
        internalUserId: id,
        providerIssuer: issuer,
        providerSubject: subject,
        linkedAt: NOW,
        proofOfControl: "oidc",
      });
      const created = await createMembership(membershipStore, {
        internalUserId: id,
        tenantId: TENANT,
        roleBindings: [
          { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap" },
          { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
        ],
        createdBy: "system:bootstrap",
        nowMs: NOW,
      });
      expect(created.ok).toBe(true);
    }
    const beforeGithub = JSON.stringify(
      await membershipStore.getMembershipsByUser(githubDerived),
    );
    const report = await runStaleIdentityCleanup({
      aliasKv: kv,
      bindingStore,
      listAliasEntries: () => Promise.resolve([]),
      listReverseIndexEntries: () => Promise.resolve([]),
      listMemberships: () =>
        listMemberships(membershipStore, [githubDerived, googleDerived]),
      nowMs: NOW,
      actorInternalUserId: githubDerived,
      mode: "execute",
    });
    expect(report.items).toHaveLength(0);
    expect(report.deletedCount).toBe(0);
    expect(
      await bindingStore.getByProvider(GITHUB_ISSUER, GITHUB_SUBJECT),
    ).toMatchObject({ internalUserId: githubDerived });
    expect(
      await bindingStore.getByProvider(GOOGLE_ISSUER, GOOGLE_SUBJECT),
    ).toMatchObject({ internalUserId: googleDerived });
    expect(
      JSON.stringify(await membershipStore.getMembershipsByUser(githubDerived)),
    ).toBe(beforeGithub);
  });
});

describe("cleanupStrandedIdReferences — targeted pass", () => {
  it("deletes only the stranded id's alias rows and reverse entry, in execute mode", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    const strandedBinding = {
      internalUserId: STRANDED_PLATFORM_ADMIN_ID,
      providerIssuer: GITHUB_ISSUER,
      providerSubject: GITHUB_SUBJECT,
      linkedAt: NOW,
      proofOfControl: "oidc" as const,
    };
    await bindingStore.put(strandedBinding);
    await bindingStore.put({ ...strandedBinding, internalUserId: derivedId });
    await kv.put(
      `iaaa-alias:user:${STRANDED_PLATFORM_ADMIN_ID}`,
      aliasValue("OpenAIMP", STRANDED_PLATFORM_ADMIN_ID),
    );
    await kv.put(
      "iaaa-alias:login:OpenAIMP",
      aliasValue("OpenAIMP", STRANDED_PLATFORM_ADMIN_ID),
    );
    await kv.put(`iaaa-alias:user:${derivedId}`, aliasValue("OpenAIMP", derivedId));
    const reverseEntries = [
      {
        key: reverseKey(STRANDED_PLATFORM_ADMIN_ID, GITHUB_ISSUER),
        value: JSON.stringify(strandedBinding),
      },
      {
        key: reverseKey(derivedId, GITHUB_ISSUER),
        value: JSON.stringify({ ...strandedBinding, internalUserId: derivedId }),
      },
    ];
    const result = await cleanupStrandedIdReferences({
      aliasKv: kv,
      bindingStore,
      listReverseIndexEntries: () => Promise.resolve([...reverseEntries]),
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "execute",
    });
    expect(result.deletedKeys).toHaveLength(3);
    expect(await kv.get(`iaaa-alias:user:${STRANDED_PLATFORM_ADMIN_ID}`)).toBeNull();
    expect(await kv.get("iaaa-alias:login:OpenAIMP")).toBeNull();
    // The live login row for the derived id is a different row in
    // production; here the shared login key held the stranded id, so
    // it is deleted — the derived id's own user: row survives.
    expect(await kv.get(`iaaa-alias:user:${derivedId}`)).not.toBeNull();
    expect(
      await bindingStore.getByUserAndIssuer(STRANDED_PLATFORM_ADMIN_ID, GITHUB_ISSUER),
    ).toBeNull();
    expect(
      await bindingStore.getByProvider(GITHUB_ISSUER, GITHUB_SUBJECT),
    ).toMatchObject({ internalUserId: derivedId });
  });

  it("dry-run reports the stranded rows and deletes nothing", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    await kv.put(
      `iaaa-alias:user:${STRANDED_PLATFORM_ADMIN_ID}`,
      aliasValue("OpenAIMP", STRANDED_PLATFORM_ADMIN_ID),
    );
    const result = await cleanupStrandedIdReferences({
      aliasKv: kv,
      bindingStore,
      listReverseIndexEntries: () => Promise.resolve([]),
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "dry-run",
    });
    expect(result.dryRun).toBe(true);
    expect(result.deletedKeys).toHaveLength(0);
    expect(result.items).toHaveLength(1);
    expect(await kv.get(`iaaa-alias:user:${STRANDED_PLATFORM_ADMIN_ID}`)).not.toBeNull();
  });

  it("never deletes a login row that already points at the derived id", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = spyingBindingStore();
    await kv.put(
      `iaaa-alias:user:${STRANDED_PLATFORM_ADMIN_ID}`,
      aliasValue("OpenAIMP", STRANDED_PLATFORM_ADMIN_ID),
    );
    // Re-recorded on login: the shared login row now points at the
    // derived id and must survive the stranded cleanup.
    await kv.put("iaaa-alias:login:OpenAIMP", aliasValue("OpenAIMP", derivedId));
    const result = await cleanupStrandedIdReferences({
      aliasKv: kv,
      bindingStore,
      listReverseIndexEntries: () => Promise.resolve([]),
      nowMs: NOW,
      actorInternalUserId: derivedId,
      mode: "execute",
    });
    expect(result.deletedKeys).toEqual([
      `iaaa-alias:user:${STRANDED_PLATFORM_ADMIN_ID}`,
    ]);
    expect(await kv.get("iaaa-alias:login:OpenAIMP")).not.toBeNull();
  });
});

describe("bootstrap list — role-prefixed entries resolve (#6236 verification)", () => {
  it("currentBootstrapEntries keeps the platform,tenant: role list instead of dropping it", () => {
    expect(
      currentBootstrapEntries(
        "platform,tenant:https://github.com:82253453,platform,tenant:https://accounts.google.com:116080816274398642624",
      ),
    ).toEqual([
      "platform,tenant:https://github.com:82253453",
      "platform,tenant:https://accounts.google.com:116080816274398642624",
    ]);
  });

  it("isPlatformBootstrapListed matches a bare retired id through its migration record", async () => {
    const derivedId = await deriveInternalUserId(GITHUB_ISSUER, GITHUB_SUBJECT);
    const kv = memoryKv();
    const bindingStore = createMemoryIdentityBindingStore();
    await bindingStore.put({
      internalUserId: derivedId,
      providerIssuer: GITHUB_ISSUER,
      providerSubject: GITHUB_SUBJECT,
      linkedAt: NOW,
      proofOfControl: "oidc",
    });
    const recorded = await recordIdMigration(kv, {
      oldInternalUserId: OLD_MINTED_ID,
      newInternalUserId: derivedId,
      nowMs: NOW,
    });
    expect(recorded.ok).toBe(true);
    // Without the alias kv the retired bare id matches nobody (old behaviour).
    expect(
      await isPlatformBootstrapListed(bindingStore, `platform:${OLD_MINTED_ID}`, derivedId),
    ).toBe(false);
    // With it, the entry names the same live identity via the forward pointer.
    expect(
      await isPlatformBootstrapListed(
        bindingStore,
        `platform:${OLD_MINTED_ID}`,
        derivedId,
        kv,
      ),
    ).toBe(true);
    // A provider entry still resolves through the binding store.
    expect(
      await isPlatformBootstrapListed(
        bindingStore,
        "platform:https://github.com:82253453",
        derivedId,
        kv,
      ),
    ).toBe(true);
  });
});
