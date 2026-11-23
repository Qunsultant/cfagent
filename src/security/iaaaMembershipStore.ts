/**
 * #945 Wiring Phase 2b-part2 — Kv-backed membership store + grant path.
 *
 * Slice 3 (authorization.ts) defined the MembershipStore interface,
 * the PDP, and the canGrantRole rule, with a memory implementation
 * only. This module is the first durable backend, in the SessionStore
 * Durable Object (the same store as sessions, bindings, and the
 * audit log), plus the grant path that enforces Slice 3's hard rule
 * in storage code: a tenant admin cannot grant platform privileges,
 * and granting requires the separate role:assign grant in scope —
 * possessing the target permission is never enough.
 *
 * Storage layout, two key shapes under the one prefix:
 *   iaaa-membership:<membershipId>          -> JSON Membership
 *   iaaa-membership:user:<internalUserId>   -> JSON string[] of membershipIds
 * Each membership is its own record, so revoke-by-id works without
 * knowing the owner; the per-user index makes getMembershipsByUser
 * a bounded read (memberships per user are few). The prefix cannot
 * collide with session keys (bare UUIDs), binding keys
 * ("iaaa-binding:"), audit keys ("iaaa-audit:"), or alias keys
 * ("iaaa-alias:"). No expiry: a membership must not silently vanish
 * on a TTL boundary; expiry is per-binding (expiresAtMs) and
 * revocation is explicit.
 *
 * This store is NOT live enforcement. Nothing here is called from
 * any route. The PDP seam (iaaaPdpSeam.ts) reads through it, and
 * route wiring is a later, separately reviewed step.
 *
 * Honest limitations (same family as the audit store's):
 * - Index writes are verified, never assumed (#6238): put
 *   writes the membership record, then the index, then reads
 *   the index back and retries the read-modify-write (up to
 *   three attempts) when its own id is missing — a lost index
 *   write can no longer silently hide a grant. A failure that
 *   survives all attempts throws loudly; the record already
 *   landed, so the throw names the membership id and the
 *   `repairMembershipIndexes` pass reconciles it from the
 *   record scan. Two concurrent puts for the same user can
 *   still interleave, but the loser's verify fails and its
 *   retry re-reads the winner's entry, so no entry is lost in
 *   the ordinary case. Membership writes are rare
 *   (provisioning, grants, revokes), not per-request.
 * - A stale index entry pointing at a deleted-or-missing
 *   record is skipped on read. Revoke-by-id reads the
 *   membership record directly, so it works even when the
 *   index is stale.
 * - Corruption is loud, never silent: a membership record or index
 *   value that is not valid JSON (or not the expected shape) throws
 *   on read, and the corrupt bytes are left untouched for
 *   investigation, never overwritten. The repair pass likewise
 *   never overwrites a corrupt index value, and never prunes an
 *   index entry whose record key exists but is corrupt — the
 *   point read still throws loudly on it.
 *
 * #6238 — the index can still drift when a write predates this
 * fix, so the store also carries the reconciliation pass:
 * `repairMembershipIndexes` rebuilds every per-user index from
 * the record scan (`listMembershipsFromEntries`), through the
 * application (the route is `POST /api/iaaa/membership-index/
 * repair`). It writes index keys only, never membership
 * records.
 *
 * Grant path vs bootstrap path — do not confuse them:
 * - grantMembership() requires an existing granter and enforces
 *   canGrantRole() for EVERY binding before writing anything. A
 *   single denied binding denies the whole grant; nothing is
 *   partially written. grantedBy is always overwritten with the
 *   granter's internalUserId, so a caller cannot forge attribution.
 * - provisionBootstrapAdmins() (iaaaBootstrap.ts) is the genesis
 *   exception: it runs when no granter exists yet, so it cannot
 *   check canGrantRole. It grants tenant-admin ONLY, never
 *   platform-admin, and only in a caller-supplied tenant. There is
 *   therefore still no path in this slice that creates a
 *   platform-admin — that genesis mechanism is an owner decision
 *   (see the bootstrap module header). The parent must call the
 *   bootstrap function only from an admin-only setup path.
 */

import {
  canGrantRole,
  createMembership,
  type AuthorizationScope,
  type Membership,
  type MembershipStore,
  type Role,
  type RoleBinding,
} from "./authorization";
import type { KvLike } from "./kvResilience";
import { applyDefaultGrantExpiry, resolveGrantDefaultExpiryDays } from "./grantRules";

/** Prefix for every IAAA membership key in the SessionStore DO. */
export const IAAA_MEMBERSHIP_KEY_PREFIX = "iaaa-membership:";

function membershipKey(membershipId: string): string {
  return `${IAAA_MEMBERSHIP_KEY_PREFIX}${membershipId}`;
}

function userIndexKey(internalUserId: string): string {
  return `${IAAA_MEMBERSHIP_KEY_PREFIX}user:${internalUserId}`;
}

function corruptError(what: string): Error {
  return new Error(
    `iaaa membership ${what} is corrupt; refusing to overwrite membership evidence`,
  );
}

async function readIndex(
  kv: KvLike,
  internalUserId: string,
): Promise<string[]> {
  const raw = await kv.get(userIndexKey(internalUserId));
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptError("index");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((id) => typeof id === "string")
  ) {
    throw corruptError("index");
  }
  return parsed as string[];
}

async function readMembership(
  kv: KvLike,
  membershipId: string,
): Promise<Membership | null> {
  const raw = await kv.get(membershipKey(membershipId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptError("record");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Membership).membershipId !== membershipId ||
    !Array.isArray((parsed as Membership).roleBindings)
  ) {
    throw corruptError("record");
  }
  return parsed as Membership;
}

/**
 * #1758 — read one membership record by id, for the admin revoke
 * route. The MembershipStore interface has no get-by-id (it was
 * built around getMembershipsByUser), and revoke-by-id in the
 * store does not return the record the gate needs to inspect
 * (tenant, scope) before revoking. Returns null for a missing
 * record; corrupt bytes still throw, loudly, like every other read.
 */
export async function readMembershipById(
  kv: KvLike,
  membershipId: string,
): Promise<Membership | null> {
  return readMembership(kv, membershipId);
}

/**
 * #1758 — list all memberships from a store listing (F-21: the
 * store had no list-all API, so the panel could only ever show
 * the caller's own memberships). Entries come from the sessions
 * namespace listing with prefix `iaaa-membership:`; per-user
 * index keys (`iaaa-membership:user:<id>`, whose values are id
 * arrays, not memberships) are skipped, as is any entry whose
 * record id does not match its key or whose shape is wrong.
 * Corrupt record bytes are skipped here — unlike point reads,
 * a listing must not fail the whole panel because one record is
 * corrupt; the point read still throws loudly when that record
 * is addressed directly.
 */
export function listMembershipsFromEntries(
  entries: Array<{ key: string; value: string }>,
): Membership[] {
  const found: Membership[] = [];
  for (const entry of entries) {
    if (!entry.key.startsWith(IAAA_MEMBERSHIP_KEY_PREFIX)) continue;
    const remainder = entry.key.slice(IAAA_MEMBERSHIP_KEY_PREFIX.length);
    if (remainder.startsWith("user:")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.value);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Membership).membershipId === remainder &&
      Array.isArray((parsed as Membership).roleBindings)
    ) {
      found.push(parsed as Membership);
    }
  }
  return found;
}

/**
 * #6238 — audit event type for every membership-index repair run.
 */
export const MEMBERSHIP_INDEX_REPAIR_AUDIT_TYPE = "iaaa.membership_index_repair";

export type MembershipIndexRepairMode = "dry-run" | "execute";

/**
 * Config resolution for IAAA_MEMBERSHIP_INDEX_REPAIR_MODE: only
 * an explicit `execute` (case-insensitive, trimmed) executes.
 * Unset, blank, and invalid values fail closed to `dry-run` —
 * the pass then inventories only and writes nothing. The mode
 * never comes from the request body, so a caller cannot escalate
 * it. Same shape as `resolveStaleCleanupMode` (#6236).
 */
export function resolveMembershipIndexRepairMode(
  raw: string | undefined,
): MembershipIndexRepairMode {
  return typeof raw === "string" && raw.trim().toLowerCase() === "execute"
    ? "execute"
    : "dry-run";
}

export interface MembershipIndexRepairUserReport {
  internalUserId: string;
  /** Index contents before the repair (empty when no index key existed). */
  before: string[];
  /** Index contents after the repair (intended contents in dry-run). */
  after: string[];
  /** Membership ids added to the index (scan order). */
  added: string[];
  /** Stale ids pruned: no record key exists for them in the scan. */
  removed: string[];
  /** Ids kept although absent from the well-formed scan: their
   * record key exists but the record is corrupt, so the id stays
   * indexed and the point read still throws loudly on it. */
  keptCorrupt: string[];
  /** True when the index key was deleted (the user has no memberships at all). */
  indexDeleted: boolean;
}

export interface MembershipIndexRepairReport {
  mode: MembershipIndexRepairMode;
  dryRun: boolean;
  scannedMemberships: number;
  scannedIndexKeys: number;
  users: MembershipIndexRepairUserReport[];
  addedCount: number;
  removedCount: number;
  indexesDeleted: number;
  /** Named failures; the pass continues with the remaining users. */
  errors: string[];
  ranAtMs: number;
}

/**
 * #6238 — rebuild every per-user membership index from the
 * record scan, through the application. The desired index for a
 * user is exactly the set of that user's membership ids in
 * `listMembershipsFromEntries(entries)` — revoked memberships
 * included, because revocation is history shown by the Users
 * view, not a missing row. Stale entries (no record key in the
 * scan) are pruned; an index key for a user with no memberships
 * at all is deleted. Membership records are never touched — only
 * `iaaa-membership:user:<id>` keys are written or deleted.
 *
 * Corruption is loud, never silent, like every other read in
 * this module: a corrupt index value is left untouched and named
 * in `errors` (that user is skipped, the rest are still
 * repaired), and an index entry whose record key exists but is
 * corrupt is kept (its id stays indexed so the point read still
 * throws on it). The pass never throws: a per-user write failure
 * is named in `errors` and the pass continues.
 */
export async function repairMembershipIndexes(
  kv: KvLike,
  entries: Array<{ key: string; value: string }>,
  opts: { mode: MembershipIndexRepairMode; nowMs: number },
): Promise<MembershipIndexRepairReport> {
  const execute = opts.mode === "execute";
  const errors: string[] = [];
  const memberships = listMembershipsFromEntries(entries);
  const recordKeys = new Set(entries.map((e) => e.key));

  // Desired index per user, in scan order.
  const desired = new Map<string, string[]>();
  for (const m of memberships) {
    const ids = desired.get(m.internalUserId) ?? [];
    if (!ids.includes(m.membershipId)) ids.push(m.membershipId);
    desired.set(m.internalUserId, ids);
  }

  // Existing index keys, as stored. A corrupt value is reported
  // and left untouched; that user is skipped, never overwritten.
  const current = new Map<string, string[]>();
  const corruptIndexUsers = new Set<string>();
  let scannedIndexKeys = 0;
  for (const entry of entries) {
    if (!entry.key.startsWith(`${IAAA_MEMBERSHIP_KEY_PREFIX}user:`)) continue;
    scannedIndexKeys += 1;
    const userId = entry.key.slice(`${IAAA_MEMBERSHIP_KEY_PREFIX}user:`.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.value);
    } catch {
      errors.push(
        `membership index for ${userId} is corrupt; left untouched`,
      );
      corruptIndexUsers.add(userId);
      continue;
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((id) => typeof id === "string")
    ) {
      errors.push(
        `membership index for ${userId} is corrupt; left untouched`,
      );
      corruptIndexUsers.add(userId);
      continue;
    }
    current.set(userId, parsed as string[]);
  }

  const users: MembershipIndexRepairUserReport[] = [];
  const allUsers = new Set([...desired.keys(), ...current.keys()]);
  for (const userId of [...allUsers].sort()) {
    // A corrupt index value is never overwritten: the user is
    // skipped entirely (the error above names it).
    if (corruptIndexUsers.has(userId)) continue;
    const want = desired.get(userId) ?? [];
    const before = current.get(userId);
    if (before === undefined) {
      // No index key: create it in execute mode. (A user in this
      // set without an index always has memberships in the scan.)
      const report: MembershipIndexRepairUserReport = {
        internalUserId: userId,
        before: [],
        after: [...want],
        added: [...want],
        removed: [],
        keptCorrupt: [],
        indexDeleted: false,
      };
      users.push(report);
      if (execute && want.length > 0) {
        try {
          await kv.put(userIndexKey(userId), JSON.stringify(report.after));
        } catch (err) {
          errors.push(
            `membership index write failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      continue;
    }
    const wantSet = new Set(want);
    const added = want.filter((id) => !before.includes(id));
    const removed: string[] = [];
    const keptCorrupt: string[] = [];
    for (const id of before) {
      if (wantSet.has(id)) continue;
      if (recordKeys.has(membershipKey(id))) keptCorrupt.push(id);
      else removed.push(id);
    }
    // Minimal diff: keep the stored order, drop the pruned ids,
    // append the added ids in scan order.
    const after = [
      ...before.filter((id) => !removed.includes(id)),
      ...added,
    ];
    const report: MembershipIndexRepairUserReport = {
      internalUserId: userId,
      before: [...before],
      after,
      added,
      removed,
      keptCorrupt,
      indexDeleted: false,
    };
    users.push(report);
    if (!execute) continue;
    try {
      if (after.length === 0) {
        await kv.delete(userIndexKey(userId));
        report.indexDeleted = true;
      } else if (JSON.stringify(after) !== JSON.stringify(before)) {
        await kv.put(userIndexKey(userId), JSON.stringify(after));
      }
    } catch (err) {
      errors.push(
        `membership index write failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    mode: opts.mode,
    dryRun: !execute,
    scannedMemberships: memberships.length,
    scannedIndexKeys,
    users,
    addedCount: users.reduce((n, u) => n + u.added.length, 0),
    removedCount: users.reduce((n, u) => n + u.removed.length, 0),
    indexesDeleted: users.filter((u) => u.indexDeleted).length,
    errors,
    ranAtMs: opts.nowMs,
  };
}

/**
 * Durable MembershipStore backed by the `SessionStore` Durable Object
 * (via its `KvLike` adapter — no Cloudflare KV binding exists in this repo,
 * #5025). `createKvMembershipStore` is retained as a backwards-compatible
 * alias for `createSessionMembershipStore`.
 *
 * #2433 (step 5b): this SessionStore-backed factory remains the flag-off
 * and adapter-internal construction. Env-level composition goes through
 * `session.ts` `wiredMembershipStore(env)`, which returns the session
 * family's membership port when `SESSION_PORTS_ENABLED` is on and this
 * factory when off.
 */
export function createKvMembershipStore(kv: KvLike): MembershipStore {
  return {
    async getMembershipsByUser(
      internalUserId: string,
    ): Promise<Membership[]> {
      const ids = await readIndex(kv, internalUserId);
      const found: Membership[] = [];
      for (const id of ids) {
        // A stale index entry (record missing) is skipped; a
        // corrupt record throws, loudly, above.
        const membership = await readMembership(kv, id);
        if (membership) {
          found.push({
            ...membership,
            roleBindings: membership.roleBindings.map((b) => ({ ...b })),
          });
        }
      }
      return found;
    },
    async put(membership: Membership): Promise<void> {
      await kv.put(
        membershipKey(membership.membershipId),
        JSON.stringify(membership),
      );
      // #6238 — the index write is verified (read-back) and
      // retried: a lost index write used to hide the grant
      // silently (the owner's index held only the revoked 10/22
      // grant while the newer grants existed as records). Up to
      // three read-modify-write attempts; the verify after each
      // write also closes the concurrent-put race in the ordinary
      // case (the loser re-reads and sees the winner's entry).
      // A failure that survives all attempts throws loudly
      // instead of returning success with a stale index — the
      // record already landed, so the throw names the membership
      // id and the repair pass reconciles it from the scan.
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const ids = await readIndex(kv, membership.internalUserId);
        if (ids.includes(membership.membershipId)) return;
        ids.push(membership.membershipId);
        await kv.put(userIndexKey(membership.internalUserId), JSON.stringify(ids));
        const verify = await readIndex(kv, membership.internalUserId);
        if (verify.includes(membership.membershipId)) return;
      }
      throw new Error(
        `iaaa membership index write failed for ${membership.membershipId}: ` +
          `the membership record was written but its id could not be added to the per-user index; ` +
          `run the membership-index repair to reconcile it`,
      );
    },
    async revokeMembership(
      membershipId: string,
      nowMs: number,
    ): Promise<boolean> {
      const membership = await readMembership(kv, membershipId);
      if (!membership) return false;
      membership.revokedAtMs = nowMs;
      await kv.put(membershipKey(membershipId), JSON.stringify(membership));
      return true;
    },
  };
}

export interface GrantMembershipInput {
  granterInternalUserId: string;
  internalUserId: string;
  tenantId: string;
  workspaceId?: string;
  roleBindings: RoleBinding[];
  nowMs: number;
  /** #2661 — optional grantee email, stored on the record when supplied. */
  email?: string;
  /**
   * Issue #3155 (Q9): default grant lifetime in days, applied to
   * non-platform-scope bindings without an explicit expiresAtMs.
   * Absent resolves to the adopted default (90 days); a non-positive
   * or unparseable value also resolves to 90, never to unbounded.
   * Routes pass the env-resolved value; direct callers get the
   * adopted default. The bootstrap path bypasses grantMembership
   * entirely, so genesis grants are exempt by construction.
   */
  defaultExpiryDays?: number;
}

export type GrantMembershipResult =
  | { ok: true; membership: Membership }
  | {
      ok: false;
      code:
        | "GRANT_DENIED"
        | "INVALID_USER_ID"
        | "INVALID_TENANT_ID"
        | "INVALID_CREATED_BY"
        | "INVALID_ROLE"
        | "INVALID_SCOPE"
        | "INVALID_GRANTED_BY"
        | "INVALID_EMAIL"
        | "EMPTY_ROLE_BINDINGS";
      error: string;
    };

/**
 * Grant a membership, enforcing Slice 3's canGrantRole rule for
 * every binding BEFORE anything is written. The granter must hold
 * role:assign in the right scope, and platform privileges require
 * a platform-admin granter, full stop. grantedBy on every binding
 * is overwritten with the granter — attribution is never caller
 * supplied. A denied binding denies the whole grant atomically.
 */
export async function grantMembership(
  store: MembershipStore,
  input: GrantMembershipInput,
): Promise<GrantMembershipResult> {
  // Issue #3155 (Q9): stamp the default expiry before the grant is
  // written, so every minted tenant binding carries a lifetime
  // unless the caller set one explicitly. Platform-scope bindings
  // are untouched, and the canGrantRole loop below still runs on
  // the stamped bindings (expiry never changes grantability).
  const roleBindings = applyDefaultGrantExpiry(
    input.roleBindings,
    input.nowMs,
    resolveGrantDefaultExpiryDays(input.defaultExpiryDays),
  );
  for (const binding of roleBindings) {
    const decision = await canGrantRole(store, {
      granterInternalUserId: input.granterInternalUserId,
      targetTenantId: input.tenantId,
      targetScope: binding.scope as AuthorizationScope,
      targetRole: binding.role as Role,
      targetWorkspaceId: binding.workspaceId ?? input.workspaceId,
      nowMs: input.nowMs,
    });
    if (decision.decision === "deny") {
      return {
        ok: false,
        code: "GRANT_DENIED",
        error:
          `granter may not grant role ${binding.role} in scope ${binding.scope} ` +
          `(reason: ${decision.reason})`,
      };
    }
  }
  return createMembership(store, {
    internalUserId: input.internalUserId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    roleBindings: roleBindings.map((b) => ({
      ...b,
      grantedBy: input.granterInternalUserId,
    })),
    createdBy: input.granterInternalUserId,
    nowMs: input.nowMs,
    ...(input.email !== undefined ? { email: input.email } : {}),
  });
}

/**
 * Alias for `createKvMembershipStore` clarifying that the backing store
 * in production is the `SessionStore` Durable Object, not Cloudflare KV.
 */
export const createSessionMembershipStore = createKvMembershipStore;
