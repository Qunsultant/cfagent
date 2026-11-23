/**
 * #6236 (subsumes #6240) — remove all stranded / stale ids and
 * accounts through the application.
 *
 * The problem: login-time migration (#1182) moves a binding and its
 * memberships onto the derived `v1:` id and records the old→new
 * forward pointer (`iaaa-alias:migrated:`), but it leaves the old
 * login-alias rows (`iaaa-alias:user:` / `iaaa-alias:login:`) and
 * the old reverse-index entry (`iaaa-binding:user:<old>\0<issuer>`)
 * in place — the reverse drop is best-effort only, and there was
 * no cleanup pass at all. The stranded Oct 22 identity
 * (`STRANDED_PLATFORM_ADMIN_ID`) was never a binding migration, so
 * nothing ever touched its rows either. The login path and the
 * Users view therefore still resolve to revoked ids while the
 * session carries the derived id.
 *
 * This module is the cleanup pass, run through the application
 * only (owner rule): it reads and deletes through the same store
 * interfaces the login path uses — `KvLike` deletes for alias
 * rows, `IdentityBindingStore.removeByUserAndIssuer` for reverse
 * entries. No SQL, no hand-editing the store.
 *
 * Disposition rules (every item in the report names one):
 * - A stale alias row / reverse entry is DELETED — but only when
 *   the id it names is provably retired: it is the known stranded
 *   id, or an `iaaa-alias:migrated:` record points it at a derived
 *   id — AND no live binding still carries it (the by-provider
 *   record is authoritative; a reverse entry that still resolves
 *   to the id blocks deletion of that id's rows).
 * - The `migrated:` forward pointer is NEVER deleted: it is the
 *   record that lets anything still holding the old id (an audit
 *   event, a bootstrap entry, an old session) resolve forward.
 *   Disposition: retained-forward-pointer.
 * - A revoked membership under a retired id is audit history: it
 *   is RETAINED, never deleted. Disposition:
 *   retained-audit-history. Its audit trail is the membership
 *   record itself plus the `iaaa.stale_identity_cleanup` audit
 *   event naming it.
 * - An ACTIVE grant under a retired id is a live grant with a
 *   stale key: deleting it would destroy access, so it is
 *   REPORTED ONLY (the #1210 repair moves it; this pass never
 *   moves or deletes a live grant).
 * - An alias row / reverse entry with no migration record and no
 *   live binding is an ORPHAN: without a forward pointer there
 *   is no proof of which live identity it belongs to, so it is
 *   REPORTED ONLY for an operator decision, never deleted.
 * - A corrupt / unparseable row is REPORTED ONLY, never deleted:
 *   deleting unreadable data destroys evidence.
 * - Every deletion in execute mode writes one audit event through
 *   the caller's audit callback (type
 *   `iaaa.stale_identity_cleanup`); an audit failure is named in
 *   `auditFailures` and never stops the pass. The pass itself
 *   never throws: a store failure is named in `errors` and the
 *   pass continues with the remaining classes.
 *
 * Modes (config `IAAA_STALE_CLEANUP_MODE`, resolved by
 * `resolveStaleCleanupMode`): `execute` deletes; anything else —
 * including unset and invalid — fails closed to `dry-run`, which
 * inventories and reports but deletes nothing.
 *
 * Live identities are never touched: a derived id with a live
 * binding (or a row whose id is neither retired nor orphaned)
 * produces no item, and the pass verifies that by construction —
 * see tests/iaaa_stale_cleanup_6236.test.ts.
 */

import {
  IAAA_ALIAS_KEY_PREFIX,
  lookupMigratedUserId,
  STRANDED_PLATFORM_ADMIN_ID,
} from "./iaaaMigration";
import type { IdentityBindingStore } from "./identityBinding";
import type { KvLike } from "./kvResilience";
import type { Membership } from "./authorization";

/** Audit event type for every cleanup deletion and run. */
export const STALE_CLEANUP_AUDIT_TYPE = "iaaa.stale_identity_cleanup";

/**
 * Reverse-index key prefix. Mirrors the key built by
 * `createKvBindingStore` in iaaaLogin.ts
 * (`iaaa-binding:user:<userId>\0<issuer>`); iaaaLogin.ts remains
 * the owner of the live format. A local const (not an import)
 * keeps this module importable from iaaaLogin.ts without a cycle.
 */
export const STALE_CLEANUP_REVERSE_INDEX_PREFIX = "iaaa-binding:user:";

export type StaleCleanupMode = "dry-run" | "execute";

/**
 * Config resolution for IAAA_STALE_CLEANUP_MODE: only an explicit
 * `execute` (case-insensitive, trimmed) executes. Unset, blank,
 * and invalid values fail closed to `dry-run` — the pass then
 * inventories only and deletes nothing.
 */
export function resolveStaleCleanupMode(raw: string | undefined): StaleCleanupMode {
  return typeof raw === "string" && raw.trim().toLowerCase() === "execute"
    ? "execute"
    : "dry-run";
}

export type StaleCleanupItemKind =
  | "stale-alias-row"
  | "stale-reverse-index"
  | "revoked-membership-retained"
  | "active-grant-under-retired-id"
  | "orphan-alias-row"
  | "orphan-reverse-index"
  | "corrupt-alias-row"
  | "corrupt-reverse-index"
  | "unknown-alias-row"
  | "alias-retired-but-live"
  | "migration-forward-pointer";

export type StaleCleanupDisposition =
  | "deleted"
  | "retained-audit-history"
  | "retained-forward-pointer"
  | "reported-only";

export interface StaleCleanupItem {
  kind: StaleCleanupItemKind;
  /** Store key (alias / reverse-index) or membership id. */
  key: string;
  /** The internal user id the item is about, when known. */
  internalUserId: string | null;
  detail: string;
  disposition: StaleCleanupDisposition;
}

export interface StaleCleanupReport {
  mode: StaleCleanupMode;
  dryRun: boolean;
  scanned: {
    aliasRows: number;
    reverseIndexEntries: number;
    memberships: number;
  };
  items: StaleCleanupItem[];
  deletedCount: number;
  retainedCount: number;
  reportedOnlyCount: number;
  /** Keys whose deletion audit failed (deletion still happened). */
  auditFailures: string[];
  /** Named store / classification failures; the pass continued. */
  errors: string[];
  ranAtMs: number;
}

export interface SessionFamilyEntry {
  key: string;
  value: string;
}

export interface StaleCleanupDeps {
  aliasKv: KvLike;
  bindingStore: IdentityBindingStore;
  listAliasEntries: () => Promise<SessionFamilyEntry[]>;
  listReverseIndexEntries: () => Promise<SessionFamilyEntry[]>;
  listMemberships: () => Promise<Membership[]>;
  /** Called once per deletion, after the delete lands. May throw. */
  audit?: (item: StaleCleanupItem) => Promise<void>;
  nowMs: number;
  actorInternalUserId: string;
  mode: StaleCleanupMode;
}

interface ParsedReverseEntry {
  key: string;
  userId: string;
  issuer: string;
  providerIssuer: string;
  providerSubject: string;
}

function parseReverseEntry(
  entry: SessionFamilyEntry,
): ParsedReverseEntry | null {
  if (!entry.key.startsWith(STALE_CLEANUP_REVERSE_INDEX_PREFIX)) return null;
  const rest = entry.key.slice(STALE_CLEANUP_REVERSE_INDEX_PREFIX.length);
  const sep = rest.indexOf("\0");
  if (sep === -1) return null;
  const userId = rest.slice(0, sep);
  const issuer = rest.slice(sep + 1);
  if (userId === "" || issuer === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { providerIssuer?: unknown }).providerIssuer !== "string" ||
    typeof (parsed as { providerSubject?: unknown }).providerSubject !== "string"
  ) {
    return null;
  }
  return {
    key: entry.key,
    userId,
    issuer,
    providerIssuer: (parsed as { providerIssuer: string }).providerIssuer,
    providerSubject: (parsed as { providerSubject: string }).providerSubject,
  };
}

interface AliasRow {
  key: string;
  internalUserId: string;
  githubLogin: string;
}

function parseAliasRow(entry: SessionFamilyEntry): AliasRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { internalUserId?: unknown }).internalUserId !== "string" ||
    typeof (parsed as { githubLogin?: unknown }).githubLogin !== "string"
  ) {
    return null;
  }
  return {
    key: entry.key,
    internalUserId: (parsed as { internalUserId: string }).internalUserId,
    githubLogin: (parsed as { githubLogin: string }).githubLogin,
  };
}

/**
 * Full inventory + cleanup pass. Lists alias rows, reverse-index
 * entries, and memberships through the caller's application-level
 * list functions, classifies each item by the rules in the header,
 * and — in execute mode only — deletes the provably-stale rows.
 */
export async function runStaleIdentityCleanup(
  deps: StaleCleanupDeps,
): Promise<StaleCleanupReport> {
  const execute = deps.mode === "execute";
  const items: StaleCleanupItem[] = [];
  const auditFailures: string[] = [];
  const errors: string[] = [];
  const scanned = { aliasRows: 0, reverseIndexEntries: 0, memberships: 0 };

  const auditOne = async (item: StaleCleanupItem): Promise<void> => {
    if (!deps.audit) return;
    try {
      await deps.audit(item);
    } catch {
      auditFailures.push(item.key);
    }
  };

  // Retired test, memoized per id: the known stranded id, or an
  // id with a migration forward pointer. A lookup failure is
  // fail-closed: the id is treated as NOT retired, so nothing
  // under it is deleted.
  const retiredCache = new Map<string, boolean>();
  const isRetired = async (internalUserId: string): Promise<boolean> => {
    const cached = retiredCache.get(internalUserId);
    if (cached !== undefined) return cached;
    if (internalUserId === STRANDED_PLATFORM_ADMIN_ID) {
      retiredCache.set(internalUserId, true);
      return true;
    }
    try {
      const migrated = await lookupMigratedUserId(deps.aliasKv, internalUserId);
      const retired = migrated !== null;
      retiredCache.set(internalUserId, retired);
      return retired;
    } catch (err) {
      errors.push(
        `migration lookup failed for ${internalUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      retiredCache.set(internalUserId, false);
      return false;
    }
  };

  // -- Reverse-index entries: the by-provider record is
  // authoritative. Liveness is computed BEFORE any delete, so a
  // delete can never change another item's classification.
  const liveIds = new Set<string>();
  const staleReverse: ParsedReverseEntry[] = [];
  let reverseEntries: SessionFamilyEntry[] = [];
  try {
    reverseEntries = await deps.listReverseIndexEntries();
  } catch (err) {
    errors.push(
      `reverse-index listing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  scanned.reverseIndexEntries = reverseEntries.length;
  for (const entry of reverseEntries) {
    const parsed = parseReverseEntry(entry);
    if (parsed === null) {
      items.push({
        kind: "corrupt-reverse-index",
        key: entry.key,
        internalUserId: null,
        detail:
          "reverse-index entry is unparseable (bad key shape or corrupt binding value); reported only, never deleted",
        disposition: "reported-only",
      });
      continue;
    }
    let current: { internalUserId: string } | null = null;
    try {
      current = await deps.bindingStore.getByProvider(
        parsed.providerIssuer,
        parsed.providerSubject,
      );
    } catch (err) {
      errors.push(
        `binding lookup failed for ${parsed.providerIssuer}:${parsed.providerSubject}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (current === null) {
      items.push({
        kind: "orphan-reverse-index",
        key: entry.key,
        internalUserId: parsed.userId,
        detail:
          `no provider binding exists for ${parsed.providerIssuer}:${parsed.providerSubject}; the reverse entry is orphaned — reported only, never deleted`,
        disposition: "reported-only",
      });
      continue;
    }
    if (current.internalUserId === parsed.userId) {
      liveIds.add(parsed.userId);
      continue;
    }
    staleReverse.push(parsed);
    items.push({
      kind: "stale-reverse-index",
      key: entry.key,
      internalUserId: parsed.userId,
      detail:
        `binding for ${parsed.providerIssuer}:${parsed.providerSubject} now carries ${current.internalUserId}; the reverse entry still points at retired ${parsed.userId}`,
      disposition: execute ? "deleted" : "reported-only",
    });
  }

  // -- Alias rows.
  let aliasEntries: SessionFamilyEntry[] = [];
  try {
    aliasEntries = await deps.listAliasEntries();
  } catch (err) {
    errors.push(
      `alias listing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  scanned.aliasRows = aliasEntries.length;
  for (const entry of aliasEntries) {
    const suffix = entry.key.slice(IAAA_ALIAS_KEY_PREFIX.length);
    if (suffix.startsWith("migrated:")) {
      items.push({
        kind: "migration-forward-pointer",
        key: entry.key,
        internalUserId: suffix.slice("migrated:".length) || null,
        detail:
          "id-migration forward pointer; never deleted — it is what lets old ids resolve to their derived id",
        disposition: "retained-forward-pointer",
      });
      continue;
    }
    if (!suffix.startsWith("user:") && !suffix.startsWith("login:")) {
      items.push({
        kind: "unknown-alias-row",
        key: entry.key,
        internalUserId: null,
        detail: "unrecognized iaaa-alias: row; reported only, never deleted",
        disposition: "reported-only",
      });
      continue;
    }
    const row = parseAliasRow(entry);
    if (row === null) {
      items.push({
        kind: "corrupt-alias-row",
        key: entry.key,
        internalUserId: null,
        detail: "alias row is unparseable; reported only, never deleted",
        disposition: "reported-only",
      });
      continue;
    }
    const retired = await isRetired(row.internalUserId);
    const live = liveIds.has(row.internalUserId);
    if (retired && live) {
      items.push({
        kind: "alias-retired-but-live",
        key: entry.key,
        internalUserId: row.internalUserId,
        detail:
          `id ${row.internalUserId} has a migration record but a live binding still carries it; deletion blocked — reported only`,
        disposition: "reported-only",
      });
      continue;
    }
    if (retired) {
      const item: StaleCleanupItem = {
        kind: "stale-alias-row",
        key: entry.key,
        internalUserId: row.internalUserId,
        detail: `alias row points at retired id ${row.internalUserId} (login ${row.githubLogin}); no live binding carries it`,
        disposition: execute ? "deleted" : "reported-only",
      };
      items.push(item);
      if (execute) {
        try {
          await deps.aliasKv.delete(entry.key);
        } catch (err) {
          errors.push(
            `alias delete failed for ${entry.key}: ${err instanceof Error ? err.message : String(err)}`,
          );
          item.disposition = "reported-only";
          continue;
        }
        await auditOne(item);
      }
      continue;
    }
    if (!live) {
      items.push({
        kind: "orphan-alias-row",
        key: entry.key,
        internalUserId: row.internalUserId,
        detail:
          `alias row points at ${row.internalUserId}, which has no migration record and no live binding; orphan — reported only, never deleted without a forward pointer`,
        disposition: "reported-only",
      });
    }
    // Retired=false, live=true: a live row — no item.
  }

  // -- Stale reverse-index deletions (execute only).
  if (execute) {
    for (const parsed of staleReverse) {
      try {
        await deps.bindingStore.removeByUserAndIssuer(parsed.userId, parsed.issuer);
      } catch (err) {
        errors.push(
          `reverse-index delete failed for ${parsed.key}: ${err instanceof Error ? err.message : String(err)}`,
        );
        const item = items.find(
          (i) => i.kind === "stale-reverse-index" && i.key === parsed.key,
        );
        if (item) item.disposition = "reported-only";
        continue;
      }
      const item = items.find(
        (i) => i.kind === "stale-reverse-index" && i.key === parsed.key,
      );
      if (item) await auditOne(item);
    }
  }

  // -- Memberships: revoked records under a retired id are audit
  // history (retained); an active grant under a retired id is a
  // live grant with a stale key (reported only — the #1210 repair
  // moves it, this pass never deletes a live grant).
  let memberships: Membership[] = [];
  try {
    memberships = await deps.listMemberships();
  } catch (err) {
    errors.push(
      `membership listing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  scanned.memberships = memberships.length;
  for (const membership of memberships) {
    if (!(await isRetired(membership.internalUserId))) continue;
    if (membership.revokedAtMs !== undefined) {
      items.push({
        kind: "revoked-membership-retained",
        key: membership.membershipId,
        internalUserId: membership.internalUserId,
        detail:
          `revoked membership under retired id ${membership.internalUserId} (revokedAtMs ${membership.revokedAtMs}); retained as audit history, never deleted`,
        disposition: "retained-audit-history",
      });
    } else {
      items.push({
        kind: "active-grant-under-retired-id",
        key: membership.membershipId,
        internalUserId: membership.internalUserId,
        detail:
          `active grant under retired id ${membership.internalUserId}; a live grant with a stale key — reported only, the #1210 repair moves it, this pass never deletes a live grant`,
        disposition: "reported-only",
      });
    }
  }

  const deletedCount = items.filter((i) => i.disposition === "deleted").length;
  return {
    mode: deps.mode,
    dryRun: !execute,
    scanned,
    items,
    deletedCount,
    retainedCount: items.filter(
      (i) =>
        i.disposition === "retained-audit-history" ||
        i.disposition === "retained-forward-pointer",
    ).length,
    reportedOnlyCount: items.filter((i) => i.disposition === "reported-only").length,
    auditFailures,
    errors,
    ranAtMs: deps.nowMs,
  };
}

export interface StrandedCleanupDeps {
  aliasKv: KvLike;
  bindingStore: IdentityBindingStore;
  listReverseIndexEntries: () => Promise<SessionFamilyEntry[]>;
  /** Called once per deletion, after the delete lands. May throw. */
  audit?: (item: StaleCleanupItem) => Promise<void>;
  nowMs: number;
  actorInternalUserId: string;
  mode: StaleCleanupMode;
}

export interface StrandedCleanupResult {
  mode: StaleCleanupMode;
  dryRun: boolean;
  items: StaleCleanupItem[];
  deletedKeys: string[];
  auditFailures: string[];
  errors: string[];
}

/**
 * Targeted pass for the known stranded Oct 22 identity only
 * (STRANDED_PLATFORM_ADMIN_ID): its alias rows and its
 * reverse-index entries. No full-store scan — one alias get, one
 * reverse-index listing filtered to the stranded id. Used by the
 * login path after the #1210 repair (platform-listed logins only),
 * so the next owner login after the mode flips to `execute`
 * removes the stranded references. The shared `login:` row is
 * deleted only when it still points at the stranded id: a login
 * row re-recorded onto the derived id is live and survives.
 */
export async function cleanupStrandedIdReferences(
  deps: StrandedCleanupDeps,
): Promise<StrandedCleanupResult> {
  const execute = deps.mode === "execute";
  const items: StaleCleanupItem[] = [];
  const deletedKeys: string[] = [];
  const auditFailures: string[] = [];
  const errors: string[] = [];
  const stranded = STRANDED_PLATFORM_ADMIN_ID;

  const deleteKey = async (item: StaleCleanupItem): Promise<void> => {
    if (!execute) return;
    try {
      await deps.aliasKv.delete(item.key);
      deletedKeys.push(item.key);
    } catch (err) {
      errors.push(
        `alias delete failed for ${item.key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      item.disposition = "reported-only";
      return;
    }
    if (deps.audit) {
      try {
        await deps.audit(item);
      } catch {
        auditFailures.push(item.key);
      }
    }
  };

  const userKey = `${IAAA_ALIAS_KEY_PREFIX}user:${stranded}`;
  let login: string | null = null;
  try {
    const raw = await deps.aliasKv.get(userKey);
    if (raw !== null) {
      const row = parseAliasRow({ key: userKey, value: raw });
      if (row === null) {
        items.push({
          kind: "corrupt-alias-row",
          key: userKey,
          internalUserId: stranded,
          detail: "stranded alias row is unparseable; reported only, never deleted",
          disposition: "reported-only",
        });
      } else if (row.internalUserId !== stranded) {
        items.push({
          kind: "unknown-alias-row",
          key: userKey,
          internalUserId: row.internalUserId,
          detail: `stranded alias row points at ${row.internalUserId}, not the stranded id; reported only`,
          disposition: "reported-only",
        });
      } else {
        login = row.githubLogin;
        const item: StaleCleanupItem = {
          kind: "stale-alias-row",
          key: userKey,
          internalUserId: stranded,
          detail: `alias row points at stranded id ${stranded} (login ${row.githubLogin}); no live binding carries it`,
          disposition: execute ? "deleted" : "reported-only",
        };
        items.push(item);
        await deleteKey(item);
      }
    }
  } catch (err) {
    errors.push(
      `stranded alias read failed for ${userKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (login !== null) {
    const loginKey = `${IAAA_ALIAS_KEY_PREFIX}login:${login}`;
    try {
      const raw = await deps.aliasKv.get(loginKey);
      if (raw !== null) {
        const row = parseAliasRow({ key: loginKey, value: raw });
        if (row !== null && row.internalUserId === stranded) {
          const item: StaleCleanupItem = {
            kind: "stale-alias-row",
            key: loginKey,
            internalUserId: stranded,
            detail: `alias row points at stranded id ${stranded} (login ${login}); no live binding carries it`,
            disposition: execute ? "deleted" : "reported-only",
          };
          items.push(item);
          await deleteKey(item);
        }
        // A login row pointing elsewhere (e.g. re-recorded onto
        // the derived id) is live and is left untouched, silently:
        // it is not a stranded item.
      }
    } catch (err) {
      errors.push(
        `stranded alias read failed for ${loginKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let reverseEntries: SessionFamilyEntry[] = [];
  try {
    reverseEntries = await deps.listReverseIndexEntries();
  } catch (err) {
    errors.push(
      `reverse-index listing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const entry of reverseEntries) {
    if (!entry.key.startsWith(`${STALE_CLEANUP_REVERSE_INDEX_PREFIX}${stranded}\0`)) {
      continue;
    }
    const parsed = parseReverseEntry(entry);
    if (parsed === null) {
      items.push({
        kind: "corrupt-reverse-index",
        key: entry.key,
        internalUserId: stranded,
        detail: "stranded reverse-index entry is unparseable; reported only, never deleted",
        disposition: "reported-only",
      });
      continue;
    }
    let current: { internalUserId: string } | null = null;
    try {
      current = await deps.bindingStore.getByProvider(
        parsed.providerIssuer,
        parsed.providerSubject,
      );
    } catch (err) {
      errors.push(
        `binding lookup failed for ${parsed.providerIssuer}:${parsed.providerSubject}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (current === null) {
      items.push({
        kind: "orphan-reverse-index",
        key: entry.key,
        internalUserId: stranded,
        detail:
          `no provider binding exists for ${parsed.providerIssuer}:${parsed.providerSubject}; the stranded reverse entry is orphaned — reported only, never deleted`,
        disposition: "reported-only",
      });
      continue;
    }
    if (current.internalUserId === stranded) continue;
    const item: StaleCleanupItem = {
      kind: "stale-reverse-index",
      key: entry.key,
      internalUserId: stranded,
      detail:
        `binding for ${parsed.providerIssuer}:${parsed.providerSubject} now carries ${current.internalUserId}; the reverse entry still points at stranded ${stranded}`,
      disposition: execute ? "deleted" : "reported-only",
    };
    items.push(item);
    if (execute) {
      try {
        await deps.bindingStore.removeByUserAndIssuer(parsed.userId, parsed.issuer);
        deletedKeys.push(entry.key);
      } catch (err) {
        errors.push(
          `reverse-index delete failed for ${entry.key}: ${err instanceof Error ? err.message : String(err)}`,
        );
        item.disposition = "reported-only";
        continue;
      }
      if (deps.audit) {
        try {
          await deps.audit(item);
        } catch {
          auditFailures.push(item.key);
        }
      }
    }
  }

  return {
    mode: deps.mode,
    dryRun: !execute,
    items,
    deletedKeys,
    auditFailures,
    errors,
  };
}
