/**
 * Issue #6180 — migrate every legacy store-operator login to an IAAA
 * membership via the alias record / derived id. Lossless by
 * construction: a login with no alias record is reported unresolved
 * and keeps access through the deprecated legacy-list fallback —
 * identity is never invented. A login that already holds a live
 * tenant-scoped store-operator binding is reported already-held, never
 * minted twice. Every minted binding carries the Q9 default expiry
 * (90 days, operator-overridable via IAAA_GRANT_DEFAULT_EXPIRY_DAYS),
 * stamped with the same applyDefaultGrantExpiry the grant route uses.
 * Minted by "system:store-operator-migration", the same way genesis
 * mints platform-admin by "system:bootstrap-genesis": a bootstrap-root
 * mint, not a grant — no granter exists yet at migration time.
 */
import { createMembership, type MembershipStore } from "./authorization";
import {
  applyDefaultGrantExpiry,
  resolveGrantDefaultExpiryDays,
} from "./grantRules";
import { lookupInternalUserIdByLogin } from "./iaaaMigration";
import { hasLiveStoreOperatorBinding } from "./storeOperatorGate";
import type { KvLike } from "./kvResilience";

export const STORE_OPERATOR_MIGRATION_GRANTOR = "system:store-operator-migration";

export interface StoreOperatorMigrationInput {
  membershipStore: MembershipStore;
  kv: KvLike;
  legacyLogins: string[];
  tenantId: string;
  nowMs: number;
  /** Operator override for the Q9 default lifetime (days). Defaults to 90. */
  defaultExpiryDays?: number;
  /** When true, count what would be migrated without minting (preview). */
  dryRun?: boolean;
}

export interface StoreOperatorMigrationResult {
  /** Logins minted (or, under dryRun, that would be minted). */
  migrated: string[];
  alreadyHeld: string[];
  /** Logins with no alias record — identity never invented, still effective via the legacy fallback. */
  unresolved: string[];
  failed: Array<{ login: string; error: string }>;
}

export async function migrateStoreOperatorsToMemberships(
  input: StoreOperatorMigrationInput,
): Promise<StoreOperatorMigrationResult> {
  const days = resolveGrantDefaultExpiryDays(input.defaultExpiryDays);
  const result: StoreOperatorMigrationResult = {
    migrated: [],
    alreadyHeld: [],
    unresolved: [],
    failed: [],
  };
  for (const login of input.legacyLogins) {
    const internalUserId = await lookupInternalUserIdByLogin(input.kv, login);
    if (internalUserId === null) {
      result.unresolved.push(login);
      continue;
    }
    const memberships = await input.membershipStore.getMembershipsByUser(internalUserId);
    if (hasLiveStoreOperatorBinding(memberships, input.tenantId, input.nowMs)) {
      result.alreadyHeld.push(login);
      continue;
    }
    if (input.dryRun) {
      result.migrated.push(login);
      continue;
    }
    const bindings = applyDefaultGrantExpiry(
      [{ role: "store-operator", scope: "tenant", grantedBy: STORE_OPERATOR_MIGRATION_GRANTOR }],
      input.nowMs,
      days,
    );
    const created = await createMembership(input.membershipStore, {
      internalUserId,
      tenantId: input.tenantId,
      roleBindings: bindings,
      createdBy: STORE_OPERATOR_MIGRATION_GRANTOR,
      nowMs: input.nowMs,
    });
    if (created.ok) result.migrated.push(login);
    else result.failed.push({ login, error: created.error });
  }
  return result;
}
