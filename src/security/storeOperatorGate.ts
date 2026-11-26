/**
 * Issue #6180 — the one store-operator gate.
 *
 * Store-operator was a second admin gate outside IAAA: login-keyed
 * (env COMMERCIAL_STORE_OPERATORS UNION the DB store list), with no
 * membership, no revocation, no expiry, no audit, and no tenant
 * scoping. Every gate site now calls resolveStoreOperatorAccess here,
 * which decides in one order:
 *
 *   1. membership — a live tenant-scoped `store-operator` binding
 *      (unrevoked, unexpired) in the tenant. This is the gate.
 *   2. bootstrap-founding — when the caller runs a founding handler
 *      (allowBootstrapFounding, data-lifecycle bootstrap handlers
 *      only) and matches ANY IAAA_BOOTSTRAP_ADMINS entry. The
 *      bootstrap list is the deployment-owned trust root; it admits
 *      the caller to the handlers that create the first memberships.
 *      Never used for steady-state operations (clean-state, recreate,
 *      DLQ, channels, tenants, payments).
 *   3. legacy-list — the deprecated fallback: the login sits in the
 *      effective legacy list (env UNION store, read by the single
 *      shared listEffectiveOperatorLogins). This is what makes the
 *      migration lossless: an operator whose login has no alias
 *      record yet (never signed in) keeps access until they sign in
 *      and the migration mints their membership. The fallback is
 *      named in the deprecation ledger with a removal follow-up
 *      issue; the route logs each fallback use.
 *
 * A membership-store read failure degrades to the legacy list —
 * exactly today's behavior, no lockout — and the result carries
 * storeDegraded so the route audits the degradation. A platform-admin
 * or tenant-admin WITHOUT a store-operator binding does NOT allow:
 * the roles stay separate.
 */
import { createKvBindingStore, isBootstrapListed } from "./iaaaLogin";
import { lookupInternalUserIdByLogin, lookupLoginByUserId } from "./iaaaMigration";
import { listMembershipsFromEntries } from "./iaaaMembershipStore";
import { listEffectiveOperatorLogins } from "../data/createStoreOperatorsPorts";
import { resolveEnvironmentConfig } from "../config/environment";
import type { Env } from "../types";
import type { Membership, MembershipStore } from "./authorization";
import type { StoreOperators } from "../data/storeOperatorsPorts";
import type { KvLike } from "./kvResilience";

export type StoreOperatorAccessVia = "membership" | "legacy-list" | "bootstrap-founding" | "none";

export interface StoreOperatorAccess {
  allowed: boolean;
  via: StoreOperatorAccessVia;
  login: string;
  internalUserId: string | null;
  /** True when a membership/store read failed and the decision fell back to the legacy list. */
  storeDegraded: boolean;
}

export interface StoreOperatorGateDeps {
  login: string;
  tenantId: string;
  nowMs: number;
  /** Sessions KV: the alias record and the identity binding store. Absent in test contexts — the gate degrades to the legacy list. */
  kv?: KvLike;
  /** IAAA membership store. Absent in test contexts — same degrade. */
  membershipStore?: MembershipStore;
  /** Worker env: IAAA_BOOTSTRAP_ADMINS, COMMERCIAL_STORE_OPERATORS, AGENT_DB. */
  env?: Record<string, unknown>;
  /** Injected store adapter (test seam, mirrors other modules' ctx.operators). Undefined builds from env. Narrow on purpose: the only operator operation the gate needs is listOperators. */
  operators?: Pick<StoreOperators, "listOperators"> | null;
  /** True only for the data-lifecycle bootstrap handlers (check, init, tenant-bootstrap). */
  allowBootstrapFounding?: boolean;
}

/**
 * Pure live-binding check: the memberships hold a live tenant-scoped
 * store-operator binding for this tenant (unrevoked, unexpired).
 * Reused by the migration (already-held) and the /operators list.
 */
export function hasLiveStoreOperatorBinding(
  memberships: Membership[],
  tenantId: string,
  nowMs: number,
): boolean {
  return findLiveStoreOperatorBinding(memberships, tenantId, nowMs) !== null;
}

/**
 * The live binding itself (membership + binding), or null. The
 * single definition of "live store-operator binding" — the add
 * route's idempotency check and the membership listing both read
 * through here, never a re-declared predicate.
 */
export function findLiveStoreOperatorBinding(
  memberships: Membership[],
  tenantId: string,
  nowMs: number,
): { membership: Membership; binding: Membership["roleBindings"][number] } | null {
  for (const membership of memberships) {
    if (membership.tenantId !== tenantId || membership.revokedAtMs !== undefined) continue;
    const binding = membership.roleBindings.find(
      (b) =>
        b.role === "store-operator" &&
        b.scope === "tenant" &&
        (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
    );
    if (binding) return { membership, binding };
  }
  return null;
}

export async function resolveStoreOperatorAccess(
  deps: StoreOperatorGateDeps,
): Promise<StoreOperatorAccess> {  const { login, tenantId, nowMs } = deps;
  let internalUserId: string | null = null;
  let storeDegraded = false;

  // 1. Membership — the gate.
  if (deps.kv && deps.membershipStore) {
    try {
      internalUserId = await lookupInternalUserIdByLogin(deps.kv, login);
    } catch {
      internalUserId = null;
      storeDegraded = true;
    }
    if (internalUserId !== null) {
      try {
        const memberships = await deps.membershipStore.getMembershipsByUser(internalUserId);
        if (hasLiveStoreOperatorBinding(memberships, tenantId, nowMs)) {
          return { allowed: true, via: "membership", login, internalUserId, storeDegraded };
        }
      } catch {
        storeDegraded = true;
      }
    }
  }

  // 2. Founding bypass — bootstrap handlers only.
  if (deps.allowBootstrapFounding && deps.kv && deps.env && internalUserId !== null) {
    const bindingStore = createKvBindingStore(deps.kv);
    const bootstrapRaw = resolveEnvironmentConfig(deps.env as Partial<Env>).workerSettings.iaaa.bootstrapAdmins;
    if (await isBootstrapListed(bindingStore, bootstrapRaw, internalUserId)) {
      return { allowed: true, via: "bootstrap-founding", login, internalUserId, storeDegraded };
    }
  }

  // 3. Deprecated legacy fallback — lossless migration bridge.
  if (deps.env) {
    const { logins, storeDegraded: legacyDegraded } = await listEffectiveOperatorLogins(
      deps.env,
      deps.operators,
    );
    if (legacyDegraded) storeDegraded = true;
    if (logins.has(login)) {
      return { allowed: true, via: "legacy-list", login, internalUserId, storeDegraded };
    }
  }

  return { allowed: false, via: "none", login, internalUserId, storeDegraded };
}

/** One live store-operator membership, as the /operators list reads it. */
export interface StoreOperatorMembershipRow {
  /** Null when the holder's login does not resolve — identity is never invented; the row still shows, keyed by its internal id. */
  login: string | null;
  internalUserId: string;
  membershipId: string;
  /** The binding's expiry (Q9 default); undefined when unbounded. */
  expiresAtMs: number | undefined;
  /** The binding's granter, as recorded on the binding. */
  grantedBy: string;
  /** The membership's creation time. */
  createdAtMs: number;
}

/**
 * #6180 — the live store-operator memberships in a tenant, from raw
 * sessions-bucket entries (listSessionFamilyEntries, or a test seam),
 * with logins resolved via the alias record. Live only: revoked and
 * expired bindings are not effective operators. Used by the
 * /operators list and the remove guard's holder count.
 */
export async function listLiveStoreOperatorMemberships(
  kv: KvLike | undefined,
  entries: Array<{ key: string; value: string }>,
  tenantId: string,
  nowMs: number,
): Promise<StoreOperatorMembershipRow[]> {
  const rows: StoreOperatorMembershipRow[] = [];
  for (const membership of listMembershipsFromEntries(entries)) {
    const found = findLiveStoreOperatorBinding([membership], tenantId, nowMs);
    if (!found) continue;
    const { binding } = found;
    let login: string | null = null;
    if (kv) {
      try {
        login = await lookupLoginByUserId(kv, membership.internalUserId);
      } catch {
        login = null;
      }
    }
    rows.push({
      login,
      internalUserId: membership.internalUserId,
      membershipId: membership.membershipId,
      expiresAtMs: binding.expiresAtMs,
      grantedBy: binding.grantedBy,
      createdAtMs: membership.createdAtMs,
    });
  }
  return rows;
}
