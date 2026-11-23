/**
 * Issues #6238 + #6259 — per-user membership index drift.
 *
 * The per-user index (`iaaa-membership:user:<id>`) is the only
 * thing `getMembershipsByUser` reads, and the module header
 * documents it as drift-prone: a failed index write hides a
 * grant, and two concurrent puts can lose an entry. The owner's
 * index held only the revoked 10/22 grant while the newer
 * grants existed as records (visible to the full-scan Role
 * grants list, invisible to the Users view and to the
 * service-user panel's platform-admin gate).
 *
 * These tests pin the fix:
 * - `repairMembershipIndexes` rebuilds every per-user index
 *   from the full scan (`listMembershipsFromEntries`), through
 *   the application — no hand-editing the store. Dry-run
 *   reports without writing; execute writes only the index
 *   keys. Membership records are never touched; corrupt
 *   records stay indexed so the point read still throws loudly.
 * - `put` verifies its index write (read-back) and retries a
 *   lost index write instead of silently succeeding; a
 *   persistently failing index write throws loudly.
 */
import { describe, it, expect } from "vitest";
import {
  createKvMembershipStore,
  listMembershipsFromEntries,
  repairMembershipIndexes,
  resolveMembershipIndexRepairMode,
  MEMBERSHIP_INDEX_REPAIR_AUDIT_TYPE,
  IAAA_MEMBERSHIP_KEY_PREFIX,
  type Membership,
} from "../src/security/iaaaMembershipStore";
import type { KvLike } from "../src/security/kvResilience";

const OWNER_ID = "v1:owner-derived-id";
const OTHER_ID = "v1:other-user-id";
const STALE_ID = "old-owner-id";

function mapKv(seed: Record<string, string> = {}): {
  kv: KvLike;
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(seed));
  const kv = {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as unknown as KvLike;
  return { kv, map };
}

function membership(
  membershipId: string,
  internalUserId: string,
  opts: { revokedAtMs?: number; role?: string; scope?: string } = {},
): Membership {
  return {
    membershipId,
    internalUserId,
    tenantId: "primary",
    roleBindings: [
      {
        role: (opts.role ?? "platform-admin") as Membership["roleBindings"][number]["role"],
        scope: (opts.scope ?? "platform") as Membership["roleBindings"][number]["scope"],
        grantedBy: "bootstrap",
      },
    ],
    createdBy: "bootstrap",
    createdAtMs: 1,
    ...(opts.revokedAtMs !== undefined ? { revokedAtMs: opts.revokedAtMs } : {}),
  };
}

function recordEntry(m: Membership): { key: string; value: string } {
  return {
    key: `${IAAA_MEMBERSHIP_KEY_PREFIX}${m.membershipId}`,
    value: JSON.stringify(m),
  };
}

function indexEntry(userId: string, ids: string[]): { key: string; value: string } {
  return {
    key: `${IAAA_MEMBERSHIP_KEY_PREFIX}user:${userId}`,
    value: JSON.stringify(ids),
  };
}

function indexOf(map: Map<string, string>, userId: string): string[] | null {
  const raw = map.get(`${IAAA_MEMBERSHIP_KEY_PREFIX}user:${userId}`);
  if (raw === undefined) return null;
  return JSON.parse(raw) as string[];
}

describe("repairMembershipIndexes (#6238)", () => {
  it("rebuilds a stale per-user index from the full scan (owner case)", async () => {
    const revoked = membership("m-revoked-1022", OWNER_ID, {
      revokedAtMs: 2,
      role: "platform-admin",
    });
    const platform = membership("m-platform-1023", OWNER_ID, {
      role: "platform-admin",
    });
    const tenant = membership("m-tenant-1023", OWNER_ID, {
      role: "tenant-admin",
      scope: "tenant",
    });
    const other = membership("m-other-1", OTHER_ID, { role: "member", scope: "tenant" });
    const entries = [
      recordEntry(revoked),
      recordEntry(platform),
      recordEntry(tenant),
      recordEntry(other),
      // The owner's index holds only the first (revoked) id; the
      // other user has no index key at all.
      indexEntry(OWNER_ID, ["m-revoked-1022"]),
    ];
    const { kv, map } = mapKv(
      Object.fromEntries(entries.map((e) => [e.key, e.value])),
    );
    const report = await repairMembershipIndexes(kv, entries, {
      mode: "execute",
      nowMs: 10,
    });
    expect(report.mode).toBe("execute");
    expect(report.dryRun).toBe(false);
    expect(report.scannedMemberships).toBe(4);
    expect(report.errors).toEqual([]);
    const owner = report.users.find((u) => u.internalUserId === OWNER_ID);
    expect(owner).toBeDefined();
    expect(owner!.added).toEqual(["m-platform-1023", "m-tenant-1023"]);
    expect(owner!.removed).toEqual([]);
    expect(indexOf(map, OWNER_ID)).toEqual([
      "m-revoked-1022",
      "m-platform-1023",
      "m-tenant-1023",
    ]);
    // The other user's index is created from the scan too.
    expect(indexOf(map, OTHER_ID)).toEqual(["m-other-1"]);
    // The repair is what the index read then returns: the Users
    // view agrees with the full scan.
    const store = createKvMembershipStore(kv);
    const seen = await store.getMembershipsByUser(OWNER_ID);
    expect(seen.map((m) => m.membershipId).sort()).toEqual([
      "m-platform-1023",
      "m-revoked-1022",
      "m-tenant-1023",
    ]);
    expect(listMembershipsFromEntries(entries).length).toBe(4);
  });

  it("dry-run reports the repair but writes nothing", async () => {
    const live = membership("m-live", OWNER_ID);
    const entries = [recordEntry(live), indexEntry(OWNER_ID, [])];
    const { kv, map } = mapKv(
      Object.fromEntries(entries.map((e) => [e.key, e.value])),
    );
    const report = await repairMembershipIndexes(kv, entries, {
      mode: "dry-run",
      nowMs: 10,
    });
    expect(report.dryRun).toBe(true);
    expect(report.users.find((u) => u.internalUserId === OWNER_ID)?.added).toEqual([
      "m-live",
    ]);
    expect(indexOf(map, OWNER_ID)).toEqual([]);
  });

  it("prunes index entries with no record, keeps ids whose record is corrupt", async () => {
    const live = membership("m-live", OWNER_ID);
    const entries = [
      recordEntry(live),
      { key: `${IAAA_MEMBERSHIP_KEY_PREFIX}m-corrupt`, value: "{not json" },
      indexEntry(OWNER_ID, ["m-live", "m-ghost", "m-corrupt"]),
    ];
    const { kv, map } = mapKv(
      Object.fromEntries(entries.map((e) => [e.key, e.value])),
    );
    const report = await repairMembershipIndexes(kv, entries, {
      mode: "execute",
      nowMs: 10,
    });
    const owner = report.users.find((u) => u.internalUserId === OWNER_ID);
    expect(owner!.removed).toEqual(["m-ghost"]);
    // The corrupt record's key exists, so its id stays indexed:
    // the point read still throws loudly on it, exactly as the
    // store's corruption rule requires. The repair never hides
    // corrupt evidence by pruning it.
    expect(owner!.keptCorrupt).toEqual(["m-corrupt"]);
    expect(indexOf(map, OWNER_ID)).toEqual(["m-live", "m-corrupt"]);
  });

  it("deletes the index key when the user has no memberships at all", async () => {
    const entries = [indexEntry(STALE_ID, ["m-gone"])];
    const { kv, map } = mapKv(
      Object.fromEntries(entries.map((e) => [e.key, e.value])),
    );
    const report = await repairMembershipIndexes(kv, entries, {
      mode: "execute",
      nowMs: 10,
    });
    const stale = report.users.find((u) => u.internalUserId === STALE_ID);
    expect(stale!.removed).toEqual(["m-gone"]);
    expect(stale!.indexDeleted).toBe(true);
    expect(map.has(`${IAAA_MEMBERSHIP_KEY_PREFIX}user:${STALE_ID}`)).toBe(false);
  });

  it("leaves a corrupt index value untouched, names the error, and still repairs other users", async () => {
    const live = membership("m-live", OWNER_ID);
    const otherLive = membership("m-other-live", OTHER_ID);
    const entries = [
      recordEntry(live),
      recordEntry(otherLive),
      { key: `${IAAA_MEMBERSHIP_KEY_PREFIX}user:${OWNER_ID}`, value: "{not json" },
      indexEntry(OTHER_ID, []),
    ];
    const { kv, map } = mapKv(
      Object.fromEntries(entries.map((e) => [e.key, e.value])),
    );
    const report = await repairMembershipIndexes(kv, entries, {
      mode: "execute",
      nowMs: 10,
    });
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain(OWNER_ID);
    // Corrupt bytes are left untouched for investigation, never
    // overwritten — the store's corruption rule.
    expect(map.get(`${IAAA_MEMBERSHIP_KEY_PREFIX}user:${OWNER_ID}`)).toBe("{not json");
    expect(indexOf(map, OTHER_ID)).toEqual(["m-other-live"]);
  });

  it("keeps revoked memberships indexed: revocation is history, not a missing row", async () => {
    const revoked = membership("m-revoked", OWNER_ID, { revokedAtMs: 5 });
    const entries = [recordEntry(revoked), indexEntry(OWNER_ID, [])];
    const { kv, map } = mapKv(
      Object.fromEntries(entries.map((e) => [e.key, e.value])),
    );
    await repairMembershipIndexes(kv, entries, { mode: "execute", nowMs: 10 });
    expect(indexOf(map, OWNER_ID)).toEqual(["m-revoked"]);
  });
});

describe("put is index-safe (#6238)", () => {
  it("retries a dropped index write instead of silently hiding the grant", async () => {
    const { kv, map } = mapKv();
    const indexKey = `${IAAA_MEMBERSHIP_KEY_PREFIX}user:${OWNER_ID}`;
    let dropped = 0;
    const flaky = {
      get: kv.get,
      put: async (key: string, value: string) => {
        // Drop the FIRST write to the index key only; the record
        // write and the retry land.
        if (key === indexKey && dropped === 0) {
          dropped += 1;
          return;
        }
        return kv.put(key, value);
      },
      delete: kv.delete,
    } as unknown as KvLike;
    const store = createKvMembershipStore(flaky);
    const m = membership("m-new", OWNER_ID);
    await store.put(m);
    expect(dropped).toBe(1);
    expect(indexOf(map, OWNER_ID)).toEqual(["m-new"]);
    expect(await store.getMembershipsByUser(OWNER_ID)).toHaveLength(1);
  });

  it("throws loudly when the index write keeps failing; the record is still written", async () => {
    const { kv, map } = mapKv();
    const indexKey = `${IAAA_MEMBERSHIP_KEY_PREFIX}user:${OWNER_ID}`;
    const failing = {
      get: kv.get,
      put: async (key: string, value: string) => {
        if (key === indexKey) return; // every index write is lost
        return kv.put(key, value);
      },
      delete: kv.delete,
    } as unknown as KvLike;
    const store = createKvMembershipStore(failing);
    const m = membership("m-new", OWNER_ID);
    await expect(store.put(m)).rejects.toThrow("m-new");
    // The record write landed (evidence preserved); only the
    // index is missing — and the throw says so instead of
    // returning success.
    expect(map.get(`${IAAA_MEMBERSHIP_KEY_PREFIX}m-new`)).toContain("m-new");
    expect(indexOf(map, OWNER_ID)).toBeNull();
  });

  it("does not duplicate an id that is already indexed", async () => {
    const m = membership("m-dup", OWNER_ID);
    const { kv, map } = mapKv({
      [`${IAAA_MEMBERSHIP_KEY_PREFIX}m-dup`]: JSON.stringify(m),
      [`${IAAA_MEMBERSHIP_KEY_PREFIX}user:${OWNER_ID}`]: JSON.stringify(["m-dup"]),
    });
    const store = createKvMembershipStore(kv);
    await store.put(m);
    expect(indexOf(map, OWNER_ID)).toEqual(["m-dup"]);
  });
});

describe("resolveMembershipIndexRepairMode (#6238)", () => {
  it("only an explicit execute executes; anything else fails closed to dry-run", () => {
    expect(resolveMembershipIndexRepairMode("execute")).toBe("execute");
    expect(resolveMembershipIndexRepairMode(" Execute ")).toBe("execute");
    expect(resolveMembershipIndexRepairMode(undefined)).toBe("dry-run");
    expect(resolveMembershipIndexRepairMode("")).toBe("dry-run");
    expect(resolveMembershipIndexRepairMode("yes")).toBe("dry-run");
  });

  it("names the audit type for the repair run", () => {
    expect(MEMBERSHIP_INDEX_REPAIR_AUDIT_TYPE).toBe("iaaa.membership_index_repair");
  });
});
