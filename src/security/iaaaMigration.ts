/**
 * #945 Wiring Phase 2b-part2 — migration aliases (no data destruction).
 *
 * The migration problem, from the Phase 2b scope note: three areas
 * are keyed by GitHub login today, and login is not identity (a
 * login can change; a recycled login can name a different person).
 *   1. E*TRADE tokens: etrade:token:<login> / etrade:req_token:<login>
 *      (plus env-prefixed variants) in the SessionStore DO.
 *   2. SearchAgent DO names: idFromName(githubLogin).
 *   3. DIDs: getUserDid(githubLogin) derives did:user:github:<login>.
 * Bindings (iaaa-binding:) already join wired logins to stable
 * internalUserIds. This module adds the alias layer that lets the
 * login-keyed world be REACHED from an internalUserId without
 * rewriting, renaming, or deleting anything:
 *
 * - recordLoginAlias(): when a wired login is observed (session
 *   carries both githubLogin and internalUserId), record the pair
 *   in both directions under iaaa-alias: keys. Idempotent for the
 *   identical pair. A CONFLICT — same login, different internal
 *   user — is rejected and the original preserved, never silently
 *   reassigned: reassigning would hand one user's tokens, DO state,
 *   and DID to another. A conflict needs operator resolution; this
 *   module will not guess. (Note the underlying reason a conflict
 *   can legitimately occur: GitHub logins can be recycled after an
 *   account is deleted. An alias is a migration aid, not identity,
 *   and must never be used to PROVE identity — only bindings do.)
 * - lookups in both directions, for the three areas above.
 * - readWithFallback(): the dual-read helper pattern for token
 *   keys — try the internal-id key first, fall back to the login
 *   key, report which one hit. Reads NEVER delete or rename
 *   either key; the old key stays until a verified cutover retires
 *   it, which this module does not perform.
 * - resolveDoNameInput(): the DO-naming input for an internal user.
 *   It returns either the legacy login (option (a) below) or
 *   "unresolved" — it NEVER invents a name. Naming a new DO from
 *   the internalUserId would silently create an empty DO and
 *   orphan the user's existing agent state; that is a cutover
 *   decision, not a fallback.
 *
 * Cutover decision (DECIDED issue #1759, 2026-10-28, recorded on
 * the issue before the build): (a) ALIAS-FOREVER for DO names +
 * DUAL-READ for tokens (internal-id key first, login key second
 * via the alias). Copy-cutover (b) is REJECTED as the naming
 * decision; dual-write alone (c) is REJECTED as insufficient.
 * - (a) Alias naming (ADOPTED): keep login-derived DO names and
 *   token keys, reached through the alias. Cost: login remains a
 *   naming input, which weakens the "login is not identity" claim
 *   for naming (though not for authorization — the PDP never
 *   consults a login). Benefit: no state is copied, nothing can
 *   be orphaned, rollback is trivial. Executed by
 *   resolveDoNameForUser below and by the identity-aware token
 *   reads in etradeOAuth.ts.
 * - (b) Copy cutover (REJECTED): copy token/DO state to
 *   internal-id-derived keys/DOs, dual-read during a verification
 *   window, then retire old keys. Benefit: login fully leaves the
 *   data model. Risks: idFromName cannot rename an existing DO, so
 *   DO state must be copied (in-flight agent state can be orphaned
 *   mid-copy); token copies must preserve env-prefixed variants;
 *   old login-derived DIDs break unless an alias record is kept
 *   for them. The copy risk is the reason for rejection: a rename
 *   must never orphan live state, and a copy can.
 * - (c) Dual-write going forward (REJECTED as the sole mechanism):
 *   new writes go to both keys. Halves the (b) risks for tokens
 *   only; does not help DO names. Note: new access-token writes
 *   DO also land under the internal-id key (see etradeOAuth.ts),
 *   but that is dual-read's primary key, not a replacement for
 *   the alias fallback that keeps OLD tokens reachable.
 *
 * Key construction here MIRRORS etradeOAuth.ts (whose key builders
 * are private): etrade:token:<login>, etrade:req_token:<login>, and
 * etrade:token:<ENV>:<login> / etrade:req_token:<ENV>:<login> for
 * env-prefixed variants. etradeOAuth.ts remains the owner of the
 * live format; if it changes, this mirror must change with it.
 * Alias keys use the iaaa-alias: prefix and cannot collide with
 * session keys (bare UUIDs), iaaa-binding:, iaaa-audit:, or
 * iaaa-membership: keys. No expiry: an alias must not silently
 * vanish, or the data it points at becomes unreachable.
 *
 * DID note: getUserDid(login) is NOT changed here. The alias keeps
 * the OLD login-derived DID reachable (lookupLoginByUserId, then
 * the existing derivation) while a future change derives new DIDs
 * from internalUserId. No new DID method is invented in this slice.
 */

import type { KvLike } from "./kvResilience";
import {
  createMembership,
  type Membership,
  type MembershipStore,
} from "./authorization";

/** Prefix for every IAAA migration-alias key in the SessionStore DO. */
export const IAAA_ALIAS_KEY_PREFIX = "iaaa-alias:";

export interface LoginAlias {
  githubLogin: string;
  internalUserId: string;
  recordedAtMs: number;
  /** How the alias was observed; "wired-login" is the only source in this slice. */
  source: "wired-login";
}

function loginKey(githubLogin: string): string {
  return `${IAAA_ALIAS_KEY_PREFIX}login:${githubLogin}`;
}

function userKey(internalUserId: string): string {
  return `${IAAA_ALIAS_KEY_PREFIX}user:${internalUserId}`;
}

function isValidField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512
  );
}

export type RecordAliasResult =
  | { ok: true; alias: LoginAlias }
  | {
      ok: false;
      code: "INVALID_LOGIN" | "INVALID_USER_ID" | "ALIAS_CONFLICT";
      error: string;
    };

/**
 * Record a login <-> internalUserId alias. The login must be passed
 * verbatim as observed on the wired session (session.githubLogin);
 * this module does not normalize case, because the token keys and
 * DO names it points at were built from that exact string. A
 * conflicting record is rejected and the original is preserved.
 */
export async function recordLoginAlias(
  kv: KvLike,
  input: {
    githubLogin: string;
    internalUserId: string;
    nowMs: number;
  },
): Promise<RecordAliasResult> {
  if (!isValidField(input.githubLogin)) {
    return { ok: false, code: "INVALID_LOGIN", error: "githubLogin must be a non-empty string" };
  }
  if (!isValidField(input.internalUserId)) {
    return { ok: false, code: "INVALID_USER_ID", error: "internalUserId must be a non-empty string" };
  }
  const existingByLogin = await kv.get(loginKey(input.githubLogin));
  if (existingByLogin !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingByLogin);
    } catch {
      return {
        ok: false,
        code: "ALIAS_CONFLICT",
        error: "existing alias record is corrupt; refusing to overwrite it",
      };
    }
    const existing = parsed as LoginAlias;
    if (existing.internalUserId === input.internalUserId) {
      return { ok: true, alias: existing };
    }
    return {
      ok: false,
      code: "ALIAS_CONFLICT",
      error:
        `login ${input.githubLogin} is already aliased to a different internal user; ` +
        "refusing to reassign it (possible login recycling — needs operator resolution)",
    };
  }
  const existingByUser = await kv.get(userKey(input.internalUserId));
  if (existingByUser !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingByUser);
    } catch {
      return {
        ok: false,
        code: "ALIAS_CONFLICT",
        error: "existing alias record is corrupt; refusing to overwrite it",
      };
    }
    const existing = parsed as LoginAlias;
    if (existing.githubLogin === input.githubLogin) {
      return { ok: true, alias: existing };
    }
    // One user, one login alias: a second login for the same user
    // would make the reverse lookup ambiguous. Reject, don't append.
    return {
      ok: false,
      code: "ALIAS_CONFLICT",
      error:
        `internal user already has an alias for login ${existing.githubLogin}; ` +
        "refusing to add a second login alias",
    };
  }
  const alias: LoginAlias = {
    githubLogin: input.githubLogin,
    internalUserId: input.internalUserId,
    recordedAtMs: input.nowMs,
    source: "wired-login",
  };
  const serialized = JSON.stringify(alias);
  await kv.put(loginKey(input.githubLogin), serialized);
  await kv.put(userKey(input.internalUserId), serialized);
  return { ok: true, alias };
}

/**
 * Login -> internalUserId, or null when no alias exists.
 *
 * #6182 — follows the id-migration chain: the alias may still name
 * a retired minted id (recordLoginAlias refuses to re-point it on
 * ALIAS_CONFLICT, by design — possible login recycling), while the
 * #1182 login-time migration records the old→new forward pointer
 * under iaaa-alias:migrated:<oldId>. The lookup follows that chain
 * to the current derived id, reusing lookupMigratedUserId. Cycle
 * termination via a visited set plus a self-referential check; a
 * corrupt or unreadable migration record falls back to the last
 * good id; never throws. Read-path only: no record is written, and
 * the alias conflict guard, the gate, the migration, and all stored
 * state are untouched.
 */
export async function lookupInternalUserIdByLogin(
  kv: KvLike,
  githubLogin: string,
): Promise<string | null> {
  if (!isValidField(githubLogin)) return null;
  let current: string | null = null;
  try {
    const raw = await kv.get(loginKey(githubLogin));
    if (raw === null) return null;
    try {
      current = (JSON.parse(raw) as LoginAlias).internalUserId ?? null;
    } catch {
      return null;
    }
    if (current === null) return null;
    const visited = new Set<string>([current]);
    while (true) {
      const next = await lookupMigratedUserId(kv, current);
      if (next === null || next === current || visited.has(next)) {
        return current;
      }
      visited.add(next);
      current = next;
    }
  } catch {
    // A store failure mid-chain must never deny the request: fall
    // back to the last good id (null when the alias itself was
    // unreadable).
    return current;
  }
}

/** InternalUserId -> login (verbatim, as observed), or null when no alias exists. */
export async function lookupLoginByUserId(
  kv: KvLike,
  internalUserId: string,
): Promise<string | null> {
  if (!isValidField(internalUserId)) return null;
  const raw = await kv.get(userKey(internalUserId));
  if (raw === null) return null;
  try {
    return (JSON.parse(raw) as LoginAlias).githubLogin ?? null;
  } catch {
    return null;
  }
}

export type FallbackReadResult =
  | { value: string; source: "primary" }
  | { value: string; source: "fallback" }
  | { value: null; source: "none" };

/**
 * Dual-read helper pattern for migrating a keyed value: try the
 * internal-id key first, fall back to the login key, and report
 * which one hit. Pure reads — neither key is deleted, renamed, or
 * written. Callers migrating E*TRADE tokens pass the token-key
 * strings (see etradeTokenKeys below); the helper itself is
 * key-agnostic so the same pattern serves any login-keyed value.
 */
export async function readWithFallback(
  read: (key: string) => Promise<string | null>,
  primaryKey: string,
  fallbackKey: string,
): Promise<FallbackReadResult> {
  const primary = await read(primaryKey);
  if (primary !== null) return { value: primary, source: "primary" };
  const fallback = await read(fallbackKey);
  if (fallback !== null) return { value: fallback, source: "fallback" };
  return { value: null, source: "none" };
}

/**
 * E*TRADE token-key strings for both naming schemes, mirroring
 * etradeOAuth.ts exactly (env-prefixed variants included). No I/O:
 * the caller passes the pair to readWithFallback. The live token
 * code is untouched; this is the migration-side view of its keys.
 */
export function etradeTokenKeys(
  internalUserId: string,
  githubLogin: string,
  envName?: string,
): { primary: string; fallback: string; primaryRequest: string; fallbackRequest: string } {
  const envPart = envName ? `${envName.toUpperCase()}:` : "";
  return {
    primary: `etrade:token:${envPart}${internalUserId}`,
    fallback: `etrade:token:${envPart}${githubLogin}`,
    primaryRequest: `etrade:req_token:${envPart}${internalUserId}`,
    fallbackRequest: `etrade:req_token:${envPart}${githubLogin}`,
  };
}

export type DoNameInput =
  | { kind: "legacy-login"; login: string }
  | { kind: "unresolved" };

/**
 * #1182 — internal-id migration records. Distinct from login
 * aliases: a login alias maps a (possibly recycled) login to a
 * user, and its conflict rule must never be weakened. An id
 * migration record maps a RETIRED minted internal id to the
 * derived id that replaced it, so anything still holding the old
 * id (an audit event, a bootstrap list, an old session) can
 * resolve forward. It is written only by the login-time
 * migration, which knows from the binding itself that both ids
 * name the same provider identity — never from a login string.
 * Records are never deleted or overwritten: a second migration
 * for the same old id to a different new id is a corrupt-state
 * conflict, refused with the original preserved.
 */
export interface IdMigrationRecord {
  oldInternalUserId: string;
  newInternalUserId: string;
  migratedAtMs: number;
  source: "stable-id-migration";
}

function migratedKey(oldInternalUserId: string): string {
  return `${IAAA_ALIAS_KEY_PREFIX}migrated:${oldInternalUserId}`;
}

export type RecordIdMigrationResult =
  | { ok: true; record: IdMigrationRecord }
  | {
      ok: false;
      code: "INVALID_USER_ID" | "ID_MIGRATION_CONFLICT";
      error: string;
    };

/** Record old → new. Idempotent for the identical pair. */
export async function recordIdMigration(
  kv: KvLike,
  input: {
    oldInternalUserId: string;
    newInternalUserId: string;
    nowMs: number;
  },
): Promise<RecordIdMigrationResult> {
  if (!isValidField(input.oldInternalUserId) || !isValidField(input.newInternalUserId)) {
    return {
      ok: false,
      code: "INVALID_USER_ID",
      error: "old and new internal user ids must be non-empty strings",
    };
  }
  const existingRaw = await kv.get(migratedKey(input.oldInternalUserId));
  if (existingRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingRaw);
    } catch {
      return {
        ok: false,
        code: "ID_MIGRATION_CONFLICT",
        error: "existing id-migration record is corrupt; refusing to overwrite it",
      };
    }
    const existing = parsed as IdMigrationRecord;
    if (existing.newInternalUserId === input.newInternalUserId) {
      return { ok: true, record: existing };
    }
    return {
      ok: false,
      code: "ID_MIGRATION_CONFLICT",
      error:
        `internal user ${input.oldInternalUserId} was already migrated to a different id; ` +
        "refusing to reassign it (corrupt state — needs operator resolution)",
    };
  }
  const record: IdMigrationRecord = {
    oldInternalUserId: input.oldInternalUserId,
    newInternalUserId: input.newInternalUserId,
    migratedAtMs: input.nowMs,
    source: "stable-id-migration",
  };
  await kv.put(migratedKey(input.oldInternalUserId), JSON.stringify(record));
  return { ok: true, record };
}

/** Old id → current derived id, or null when no migration is recorded. */
export async function lookupMigratedUserId(
  kv: KvLike,
  oldInternalUserId: string,
): Promise<string | null> {
  if (!isValidField(oldInternalUserId)) return null;
  const raw = await kv.get(migratedKey(oldInternalUserId));
  if (raw === null) return null;
  try {
    return (JSON.parse(raw) as IdMigrationRecord).newInternalUserId ?? null;
  } catch {
    return null;
  }
}

/**
 * The SearchAgent DO-naming input for an internal user, via the
 * alias (cutover option (a): keep login-derived DO names). An
 * unresolved user yields "unresolved" — the caller must then decide
 * (alias now, or a copy cutover later); this function never invents
 * a name, because idFromName(internalUserId) would silently create
 * an empty DO and orphan the user's existing agent state.
 */
export function resolveDoNameInput(
  login: string | null,
): DoNameInput {
  if (login === null || login.trim() === "") return { kind: "unresolved" };
  return { kind: "legacy-login", login };
}

export type DoNameForUser =
  | { kind: "alias-login"; login: string }
  | { kind: "current-login"; login: string };

/**
 * Issue #1759 — the cutover decision, executed (see the header
 * note and docs/architecture/security/iaaa-login-key-cutover-1759.md):
 * ALIAS-FOREVER for DO names. A DO name is resolved for a user,
 * not for a login string:
 * - A wired user WITH an alias resolves to the alias login — the
 *   name their DO state already lives under. After a rename this
 *   is the OLD login, so the renamed session reaches its existing
 *   state instead of addressing a fresh empty DO.
 * - A user WITHOUT an alias (never wired-logged-in, or legacy)
 *   resolves to their current login: behavior identical to today.
 * This function never invents a name, never follows a conflicted
 * alias (recordLoginAlias preserves the original on conflict, so a
 * recycled login can never hand one user's DO to another), and
 * never deletes or renames anything: the old DO name stays live
 * until every dispatch site adopts this resolver. Callers that
 * cannot reach the alias store must fall back to the current
 * login — a lookup failure must never deny the request.
 */
export async function resolveDoNameForUser(
  kv: KvLike,
  input: {
    currentLogin: string;
    internalUserId?: string;
  },
): Promise<DoNameForUser> {
  if (input.internalUserId) {
    const aliasLogin = await lookupLoginByUserId(kv, input.internalUserId);
    if (aliasLogin !== null) {
      return { kind: "alias-login", login: aliasLogin };
    }
  }
  return { kind: "current-login", login: input.currentLogin };
}

/**
 * #1210 — one-time repair constant: the retired Oct 22 activation
 * identity. Its platform-admin grant is stranded: the genesis
 * marker was already set for this minted id, which no current
 * login carries (post-#1182 logins carry derived ids), so the
 * `platform:` bootstrap entry degrades to tenant-admin and normal
 * binding migration — which moves only the logging-in user's own
 * memberships — never touches it. This id is the pre-#1196
 * bootstrap entry value from git history: retired, never a
 * secret, and the only id this repair ever moves FROM.
 */
export const STRANDED_PLATFORM_ADMIN_ID =
  "00fbb0ba-9e4b-43ec-a7d6-df2a1dfc5d6c";

export type RepairStrandedPlatformAdminResult =
  | { status: "moved"; movedCount: number; revokedCount: number }
  | { status: "revoked-only"; revokedCount: number }
  | { status: "noop" }
  | { status: "error"; error: string };

export interface RepairStrandedPlatformAdminInput {
  membershipStore: MembershipStore;
  /**
   * Whether the logging-in user matches a `platform:` bootstrap
   * entry. Computed by the caller with the existing bootstrap
   * parser (see isPlatformBootstrapListed in iaaaLogin.ts); this
   * module never parses bootstrap entries itself.
   */
  isPlatformListed: boolean;
  /** The logging-in user's id (post-migration derived id). */
  targetInternalUserId: string;
  nowMs: number;
}

/** True when two role-binding lists grant identically, in order. */
function sameRepairRoleBindings(
  a: readonly {
    role: string;
    scope: string;
    workspaceId?: string;
    resourceId?: string;
    expiresAtMs?: number;
    grantedBy: string;
  }[],
  b: readonly {
    role: string;
    scope: string;
    workspaceId?: string;
    resourceId?: string;
    expiresAtMs?: number;
    grantedBy: string;
  }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (binding, i) =>
      binding.role === b[i].role &&
      binding.scope === b[i].scope &&
      binding.workspaceId === b[i].workspaceId &&
      binding.resourceId === b[i].resourceId &&
      binding.expiresAtMs === b[i].expiresAtMs &&
      binding.grantedBy === b[i].grantedBy,
  );
}

function sameRepairMembershipSignature(a: Membership, b: Membership): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.workspaceId === b.workspaceId &&
    sameRepairRoleBindings(a.roleBindings, b.roleBindings)
  );
}

function hasActivePlatformAdmin(memberships: readonly Membership[]): boolean {
  return memberships.some(
    (m) =>
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) => b.role === "platform-admin" && b.scope === "platform",
      ),
  );
}

/**
 * #1210 — move the stranded platform-admin grant to the logging-in
 * user. Runs in the login path at the same point as normal binding
 * migration (see completeWiredLogin), BEFORE post-login bootstrap,
 * so bootstrap observes the repaired state as already-admin.
 *
 * Rules, in order:
 *  1. Not platform-listed, invalid target, or target IS the retired
 *     id → no-op. (The target-equals-retired guard exists so the
 *     repair can never revoke the caller's own grant.)
 *  2. Only ACTIVE platform-admin memberships of the retired id
 *     move. A revoked or absent retired membership is a no-op:
 *     migration never resurrects access, and a revoked record's
 *     original revokedAtMs is never overwritten.
 *  3. If the target already holds platform-admin → revoke the
 *     retired records only (cleanup, no duplicate grant).
 *  4. Otherwise → create equivalents under the target (via the
 *     provisioning path, unless an equivalent already exists —
 *     that check is what makes a retry after a partial move
 *     converge instead of duplicating), then revoke the retired
 *     records. Old records are revoked, never deleted.
 * After the retired records are revoked, later runs find nothing
 * to move: the repair is self-retiring. Any store failure returns
 * `error` — this function never throws, and the caller must never
 * let a repair failure change the login outcome.
 */
export async function repairStrandedPlatformAdmin(
  input: RepairStrandedPlatformAdminInput,
): Promise<RepairStrandedPlatformAdminResult> {
  try {
    if (!input.isPlatformListed) return { status: "noop" };
    if (
      !isValidField(input.targetInternalUserId) ||
      input.targetInternalUserId === STRANDED_PLATFORM_ADMIN_ID
    ) {
      return { status: "noop" };
    }
    const retired = await input.membershipStore.getMembershipsByUser(
      STRANDED_PLATFORM_ADMIN_ID,
    );
    const activePlatform = retired.filter(
      (m) =>
        m.revokedAtMs === undefined &&
        m.roleBindings.some(
          (b) => b.role === "platform-admin" && b.scope === "platform",
        ),
    );
    if (activePlatform.length === 0) return { status: "noop" };
    const targetMemberships = await input.membershipStore.getMembershipsByUser(
      input.targetInternalUserId,
    );
    if (hasActivePlatformAdmin(targetMemberships)) {
      for (const old of activePlatform) {
        await input.membershipStore.revokeMembership(old.membershipId, input.nowMs);
      }
      return { status: "revoked-only", revokedCount: activePlatform.length };
    }
    let moved = 0;
    for (const old of activePlatform) {
      if (
        !targetMemberships.some((n) => sameRepairMembershipSignature(old, n))
      ) {
        const created = await createMembership(input.membershipStore, {
          internalUserId: input.targetInternalUserId,
          tenantId: old.tenantId,
          workspaceId: old.workspaceId,
          roleBindings: old.roleBindings.map((b) => ({ ...b })),
          createdBy: old.createdBy,
          nowMs: input.nowMs,
        });
        if (!created.ok) {
          throw new Error(
            `stranded platform-admin repair failed for ${STRANDED_PLATFORM_ADMIN_ID}: ${created.error}`,
          );
        }
        targetMemberships.push(created.membership);
        moved++;
      }
    }
    for (const old of activePlatform) {
      await input.membershipStore.revokeMembership(old.membershipId, input.nowMs);
    }
    return { status: "moved", movedCount: moved, revokedCount: activePlatform.length };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "stranded platform-admin repair failed",
    };
  }
}
