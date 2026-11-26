/**
 * #945 GitHub end-to-end — the final GitHub wiring slice.
 *
 * This module is the wiring layer that turns the Phase 2b-part2
 * machinery (membership store, bootstrap provisioning, migration
 * aliases, PDP seam) into live behaviour for the GitHub provider,
 * under the user-authorized defaults documented in
 * docs/iaaa-github-end-to-end-defaults.md. Nothing here is a
 * policy of its own: every decision delegates to Slice 1 (binding),
 * Slice 3 (PDP + grants), or the Phase 2b-part2 modules.
 *
 * Tenant default (USER-AUTHORIZED, read this first): the end-to-end
 * call sites resolve the tenant as IAAA_TENANT_ID when set, else
 * the single-tenant default "primary". This is a deliberate,
 * documented departure from the earlier "no default tenant" stance
 * of the audit seam and the bootstrap module: those modules still
 * take tenantId as an explicit argument and invent nothing — the
 * default lives ONLY here, at the call-site resolution, so it is
 * visible, auditable, and reversible (set IAAA_TENANT_ID to change
 * it). No other tenant value is ever invented. A multi-tenant
 * deployment must set IAAA_TENANT_ID explicitly; "primary" is the
 * single-tenant assumption, not a multi-tenant answer.
 *
 * Genesis rule (USER-AUTHORIZED): a bootstrap entry prefixed
 * "platform:" grants platform-admin ONLY while no platform-admin
 * genesis has happened in the tenant. The window is tracked by a
 * single Kv marker key (see platformGenesisMarkerKey); once the
 * marker exists, later platform: entries grant tenant-admin only.
 * One-time repair (#1208): if the stored marker's grantedTo is the
 * retired Oct 22 activation id and the logging-in user matches a
 * platform: entry without already holding platform-admin, the marker
 * is deleted before the genesis decision, so the genesis path grants
 * and re-sets it; after that the reset conditions can never hold
 * again. All other markers are untouched.
 * Genesis grants carry createdBy/grantedBy "system:bootstrap-genesis";
 * ordinary bootstrap grants carry "system:bootstrap". The marker is
 * claimed atomically (#1756): backends offering KvLike.putIfAbsent
 * (production: the SessionStore DO, via its atomic consume op) claim
 * the marker in one indivisible operation, so no two first-logins
 * can both win — the loser falls through to the genesis-closed
 * tenant-admin path. Backends without putIfAbsent keep the legacy
 * check-then-set order, and a deployment on such a backend that
 * needs a hard guarantee must still serialize its first logins.
 * A claim won but followed by a failed grant releases the marker,
 * so a retry can win; the release is safe only because the atomic
 * claim has exactly one winner, so it runs on the atomic path only.
 *
 * Best-effort rule: runWiredPostLogin NEVER throws and NEVER fails
 * a login. Alias conflicts preserve the original alias; storage
 * failures are reported in the result and the login proceeds. This
 * is the same rule as the Phase 2b-part1 logout hook. Whether a
 * failed AUDIT write should block a wired login is still an open
 * CISO decision (see the defaults doc); this slice does not block
 * on audit failure.
 *
 * PDP flag: IAAA_PDP_ENABLED ("1"/"true" = on, default OFF).
 * shouldEnforcePdp() is true when the flag is on AND the session
 * is wired (carries internalUserId), OR when the flag is on and
 * the session is a legacy session past its #1749 grace bound
 * (isLegacyPdpGraceExpired). Legacy sessions INSIDE the bound are
 * exempt, exactly as in Phase 2b-part1, and flag OFF is byte-for-byte
 * the pre-change path. Default-deny within the gated set: a wired
 * session with no membership for the required permission is denied,
 * and a grace-expired legacy session is denied because it has no
 * internal id for the PDP to evaluate. That is why the flag
 * defaults OFF — with no bootstrap list set, turning it on would
 * lock out the legitimate owner. Activation is a config sequence
 * (bootstrap list + tenant + flag, then redeploy), documented in
 * the defaults doc.
 */

import type { Env, SessionData } from "../types";
import { resolveEnvironmentConfig } from "../config/environment";
import {
  SESSION_STORE_CONFIG,
  SESSION_STORE_CONFIG_ERRORS,
} from "../config/sessionStoreConfig";
import {
  createMembership,
  type MembershipStore,
  type Permission,
} from "./authorization";
import {
  getInternalUserId,
  type IdentityBindingStore,
} from "./identityBinding";
import {
  parseBootstrapAdmins,
  provisionBootstrapAdmins,
  type BootstrapEntry,
  type BootstrapRejection,
} from "./iaaaBootstrap";
import {
  readLoginAlias,
  recordIdMigration,
  recordLoginAlias,
} from "./iaaaMigration";
import { checkPermission } from "./iaaaPdpSeam";
import {
  buildAliasRecordedAuditEventInput,
  buildBootstrapGrantAuditEventInput,
  buildIdMigrationRecordedAuditEventInput,
  buildIdpProfileDivergedAuditEventInput,
  buildIdpProfileRefreshedAuditEventInput,
  recordWiredAuthAudit,
} from "./iaaaAuthAudit";
import type { AuditStore } from "./iaaaAudit";
import { sanitizeIdpAttributes } from "./idpAttributes";
import { loadIdpProfileConfig } from "./idpProfileConfig";
import type { UserProfileStore } from "../data/profilePorts";
import type { SettingsPort } from "../data/settingsReadPorts";
import { membershipIsLive } from "./runRevocationGate";
import { SESSION_TTL } from "./session";
import type { KvLike } from "./kvResilience";
import { DEPLOYMENT_DEFAULT_TENANT_ID } from "../config/tenantDefaults";
import { createStructuredLogger, type StructuredLogger } from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

/** The documented single-tenant default tenant id. */
export const IAAA_DEFAULT_TENANT_ID = DEPLOYMENT_DEFAULT_TENANT_ID;

/** Prefix for the platform-admin genesis marker keys. */
export const IAAA_PLATFORM_GENESIS_KEY_PREFIX = "iaaa-bootstrap:platform-genesis:";

/** Kv key recording that a platform-admin genesis happened in a tenant. */
export function platformGenesisMarkerKey(tenantId: string): string {
  return `${IAAA_PLATFORM_GENESIS_KEY_PREFIX}${tenantId}`;
}

/**
 * #6191 — per-identity genesis marker key. The one-time constraint is
 * per-identity, not per-tenant: each platform-listed identity claims
 * ITS OWN marker, so one identity's claim never blocks another's.
 * The legacy global key above is kept for the global-once mode
 * (config `genesis.oneTime`) and for the clean-state wipe prefix.
 */
export function platformGenesisMarkerKeyForUser(
  tenantId: string,
  internalUserId: string,
): string {
  return `${IAAA_PLATFORM_GENESIS_KEY_PREFIX}${tenantId}:${internalUserId}`;
}

/**
 * #1208 one-time repair: the minted internal id of the Oct 22
 * activation identity, retired by #1182 derivation and replaced in
 * wrangler.jsonc by #1196. Its platform-admin genesis grant is
 * stranded: no current login carries this id, so the marker it set
 * blocks every later platform: grant. The reset below deletes a
 * marker ONLY when its grantedTo is exactly this id (and the
 * logging-in user matches a platform: entry without already
 * holding platform-admin); after the re-grant the marker points
 * at the logging-in id, so the reset can never fire again.
 */
export const RETIRED_OCT22_GENESIS_ID =
  "00fbb0ba-9e4b-43ec-a7d6-df2a1dfc5d6c";

/**
 * Tenant resolution for end-to-end call sites: IAAA_TENANT_ID when
 * set and non-blank, else the documented default "primary".
 */
export function resolveIaaaTenant(
  env: Partial<Env> | null | undefined,
): string {
  const raw = env?.IAAA_TENANT_ID;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return IAAA_DEFAULT_TENANT_ID;
}

/** True only when IAAA_PDP_ENABLED is "1" or "true" (case-insensitive, trimmed). Phase 3 (#6550): resolves from environment.config.json (defaults.iaaa.pdpEnabled); a still-set env var wins. */
export function isPdpEnabled(
  env: Partial<Env> | null | undefined,
): boolean {
  return resolveEnvironmentConfig(env ?? undefined).workerSettings.iaaa.pdpEnabled;
}

/**
 * #1749 legacy-session PDP grace bound (parent #1717, IAAA-1).
 *
 * A legacy session (no internalUserId) is PDP-exempt ONLY while it
 * is inside its absolute session lifetime: createdAt + SESSION_TTL
 * (7 days, the same deadline the SessionStore record already
 * expires at, and the same exclusive boundary getValidatedSession
 * enforces). Past that deadline the exemption ends at the gate,
 * not just in the store: the session is denied at PDP-gated routes
 * until it re-logs in through wiring and becomes wired. That is
 * the migration path, not a lockout cliff — ungated routes are
 * unaffected, and login itself is never PDP-gated.
 *
 * Fail-closed corners, all deliberate:
 * - Flag OFF: no bound applies, because there is no PDP
 *   enforcement for the exemption to be relative to (byte-for-byte
 *   the pre-change path).
 * - Wired sessions: never grace-expired. Their absolute/idle
 *   expiry lives on the requireAuth path, not here.
 * - No session: not grace-expired. That is a 401 upstream, not a
 *   grace denial.
 * - Missing or non-finite createdAt: expired. A session that
 *   cannot prove it is inside its bound is not granted one.
 *
 * The bound is deliberately NOT configurable at any scope: it
 * reuses the SESSION_TTL constant, so no caller — and no config
 * typo — can widen, narrow, or disable their own enforcement.
 * A scoped override here would let the gated subject tune its own
 * gate, which this program's security guard forbids. There is no
 * divergent pair to unify, so there is no switch to add: one
 * session lifetime, one bound, enforced at the single choke point
 * (shouldEnforcePdp) every gated route already calls.
 *
 * Time is a caller-supplied nowMs seam, never Date.now() inside
 * this decision, so every boundary is testable exactly.
 */
export function isLegacyPdpGraceExpired(
  env: Partial<Env> | null | undefined,
  session: SessionData | null | undefined,
  nowMs: number,
): boolean {
  if (!isPdpEnabled(env)) return false;
  if (!session || session.internalUserId) return false;
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) {
    return true;
  }
  return nowMs >= session.createdAt + SESSION_TTL * 1000;
}

/**
 * Whether PDP enforcement applies to this request: flag on AND
 * (a wired session, or a legacy session past its #1749 grace
 * bound). Flag OFF, or a legacy session inside its bound, means
 * the pre-change path, unchanged. A grace-expired legacy session
 * enforces — and then denies, because checkRoutePermission has no
 * internal id to evaluate — rather than silently bypassing the PDP.
 */
export function shouldEnforcePdp(
  env: Partial<Env> | null | undefined,
  session: SessionData | null | undefined,
  nowMs: number,
): boolean {
  if (!isPdpEnabled(env)) return false;
  if (session?.internalUserId) return true;
  return isLegacyPdpGraceExpired(env, session, nowMs);
}

/** A role a bootstrap list entry can grant. */
export type BootstrapRole = "platform" | "tenant";

const BOOTSTRAP_ROLES: readonly BootstrapRole[] = ["platform", "tenant"];

function isBootstrapRole(value: string): value is BootstrapRole {
  return (BOOTSTRAP_ROLES as readonly string[]).includes(value);
}

/** Canonical role order: platform first, then tenant. */
function canonicalRoles(roles: BootstrapRole[]): BootstrapRole[] {
  const out: BootstrapRole[] = [];
  for (const role of BOOTSTRAP_ROLES) {
    if (roles.includes(role)) out.push(role);
  }
  return out;
}

/**
 * The identity a bootstrap entry names, as a dedupe key. A bare id is
 * itself; a provider entry is `issuer:subject` — the same string the
 * plain form of that identity carries, so `platform:<issuer>:<subject>`
 * and `<issuer>:<subject>` dedupe to one user.
 */
function bootstrapIdentityKey(entry: BootstrapEntry): string {
  return entry.kind === "internalUserId"
    ? entry.internalUserId
    : `${entry.providerIssuer}:${entry.providerSubject}`;
}

export interface GenesisBootstrapEntry {
  /** The roles this entry grants, explicitly named, canonical order. */
  roles: BootstrapRole[];
  entry: BootstrapEntry;
}

export interface ParsedBootstrapListWithGenesis {
  entries: GenesisBootstrapEntry[];
  rejected: BootstrapRejection[];
}

/**
 * Parse a bootstrap list with explicit roles (#6191). Each
 * comma-separated entry is `[<role>[,<role>]*:]<identity>`, where the
 * roles are `platform` and/or `tenant` and the identity is a bare
 * UUID / derived `v1:` id or an `issuer:subject` pair (delegated to
 * parseBootstrapAdmins). A plain entry (no role prefix) grants
 * tenant-admin only, for backward compatibility.
 *
 * The comma is both the entry separator and the role-list separator,
 * so the parse is left-to-right over comma-split segments: a bare
 * `platform`/`tenant` segment continues the pending role list, and a
 * segment whose text before its first `:` is a known role closes the
 * list onto its identity. An unknown role is a named rejection, never
 * silently treated as an issuer. The same identity twice (any forms)
 * is deduped by MERGING roles into one entry, with the dropped
 * duplicate recorded in `rejected` as a named warning — no privilege
 * is silently lost, and one user still appears once.
 */
export function parseBootstrapListWithGenesis(
  raw: string | undefined,
): ParsedBootstrapListWithGenesis {
  const entries: GenesisBootstrapEntry[] = [];
  const rejected: BootstrapRejection[] = [];
  if (raw === undefined) return { entries, rejected };
  const byIdentity = new Map<string, GenesisBootstrapEntry>();
  let pendingRoles: BootstrapRole[] = [];
  for (const part of raw.split(",")) {
    const segment = part.trim();
    if (segment === "") continue;
    // A bare role token continues the pending role list.
    if (isBootstrapRole(segment)) {
      if (pendingRoles.includes(segment)) {
        rejected.push({
          entry: segment,
          reason: `duplicate role '${segment}' in bootstrap entry`,
        });
        pendingRoles = [];
        continue;
      }
      pendingRoles.push(segment);
      continue;
    }
    const firstColon = segment.indexOf(":");
    let segmentRoles: BootstrapRole[] = [];
    let identityText = segment;
    if (firstColon !== -1) {
      const prefixText = segment.slice(0, firstColon).trim();
      if (isBootstrapRole(prefixText)) {
        segmentRoles = [prefixText];
        identityText = segment.slice(firstColon + 1).trim();
      } else if (pendingRoles.length > 0) {
        // A pending role list plus a non-role prefix token means the
        // operator was writing a role list with an unknown role —
        // reject it by name instead of misreading it as an issuer.
        rejected.push({
          entry: segment,
          reason: `unknown bootstrap role '${prefixText}' in bootstrap entry`,
        });
        pendingRoles = [];
        continue;
      }
      // Otherwise the whole segment is the identity (an issuer:subject
      // pair or a derived v1: id — neither starts with a known role).
    }
    const duplicateRole = segmentRoles.find((r) => pendingRoles.includes(r));
    if (duplicateRole) {
      rejected.push({
        entry: segment,
        reason: `duplicate role '${duplicateRole}' in bootstrap entry`,
      });
      pendingRoles = [];
      continue;
    }
    const roles = canonicalRoles([...pendingRoles, ...segmentRoles]);
    pendingRoles = [];
    if (identityText === "") {
      rejected.push({
        entry: segment,
        reason: "bootstrap entry has no identity after the role prefix",
      });
      continue;
    }
    const parsed = parseBootstrapAdmins(identityText);
    if (parsed.entries.length === 0) {
      for (const rejection of parsed.rejected) {
        rejected.push({ entry: segment, reason: rejection.reason });
      }
      if (parsed.rejected.length === 0) {
        rejected.push({ entry: segment, reason: "bootstrap entry could not be parsed" });
      }
      continue;
    }
    const entry = parsed.entries[0];
    const finalRoles = roles.length === 0 ? ["tenant" as BootstrapRole] : roles;
    const key = bootstrapIdentityKey(entry);
    const existing = byIdentity.get(key);
    if (existing) {
      existing.roles = canonicalRoles([...existing.roles, ...finalRoles]);
      rejected.push({
        entry: segment,
        reason:
          "duplicate bootstrap entry for the same identity; merged roles into a single entry — list each user once",
      });
      continue;
    }
    const merged: GenesisBootstrapEntry = { roles: finalRoles, entry };
    byIdentity.set(key, merged);
    entries.push(merged);
  }
  if (pendingRoles.length > 0) {
    rejected.push({
      entry: pendingRoles.join(","),
      reason: `bootstrap role list '${pendingRoles.join(",")}' has no identity after the prefix`,
    });
  }
  return { entries, rejected };
}

export interface WiredPostLoginDeps {
  kv: KvLike;
  bindingStore: IdentityBindingStore;
  membershipStore: MembershipStore;
  /**
   * #1760 — optional audit seam for the previously silent
   * post-login occurrences (alias recording, bootstrap and
   * genesis grants). Best-effort: a failed write is warned, never
   * thrown, never changes the login outcome. Absent, post-login
   * work runs exactly as before and emits nothing.
   */
  audit?: { store: AuditStore; correlationId: string };
  /**
   * Issue #3515 S3 batch 8 — optional observability sink for the
   * post-login audit-failure warnings (the d1QueryLogger precedent).
   * Absent, the structured console fallback; the caller that owns
   * the request env can pass the env-constructed sink (the #5587
   * follow-up) so the events reach the Analytics Engine dataset.
   */
  sink?: ObservabilitySink;
  /**
   * #6191 — explicit genesis-mode override. When set, it wins over
   * the bundled SessionStore config (`genesis.oneTime`); when absent
   * the config resolves the mode (default false = per-identity).
   * Tests pass this to pin both modes; production callers leave it
   * unset so the config is the single source.
   */
  genesisOneTime?: boolean;
  /**
   * #5160 — the durable profile store for the sign-in IDP
   * attribute refresh. Absent (or unbound), the refresh is
   * skipped and the login proceeds exactly as before.
   */
  profile?: UserProfileStore | null;
  /**
   * #5160 — the operator-config store the profile config loads
   * from (mas_settings). Absent, the shipped defaults apply.
   */
  settings?: SettingsPort | null;
}

export interface WiredPostLoginInput {
  githubLogin: string;
  internalUserId: string;
  providerIssuer: string;
  providerSubject: string;
  bootstrapRaw: string | undefined;
  tenantId: string;
  nowMs: number;
  /**
   * #5160 — the raw IDP userinfo doc for this sign-in (before
   * sanitization). Absent, no refresh runs. Tokens are never in
   * this doc: the callback strips them before it reaches here.
   */
  idpAttributes?: Record<string, unknown> | null;
  /** #5160 — the issuer the attributes came from; defaults to providerIssuer. */
  idpIssuer?: string;
}

export type AliasRunStatus =
  | "recorded"
  | "conflict-preserved"
  | "invalid"
  | "migration-recorded"
  | "migration-error"
  | "error";

export type BootstrapRunStatus =
  | "provisioned"
  | "genesis"
  | "genesis-closed-tenant-admin"
  | "genesis-claim-lost"
  | "already-admin"
  | "not-listed"
  | "blank"
  | "error";

export type ProfileRunStatus = "refreshed" | "skipped" | "refresh-failed";

export interface WiredPostLoginResult {
  alias: { status: AliasRunStatus };
  bootstrap: { status: BootstrapRunStatus };
  /**
   * #5160 — the IDP profile refresh: "refreshed" (the row was
   * written), "skipped" (no store or no attributes), or
   * "refresh-failed" (the store threw — the login still
   * succeeded). diverged names the profile fields whose
   * user-owned value hid a different provider value.
   */
  profile: { status: ProfileRunStatus; diverged: string[] };
}

async function resolveEntryUserId(
  bindingStore: IdentityBindingStore,
  entry: BootstrapEntry,
): Promise<string | null> {
  if (entry.kind === "internalUserId") return entry.internalUserId;
  return getInternalUserId(
    bindingStore,
    entry.providerIssuer,
    entry.providerSubject,
  );
}

/**
 * #1208: true iff a stored genesis marker is the stranded Oct 22
 * marker — parses as a JSON object whose grantedTo is exactly the
 * retired Oct 22 activation id. Unparsable or malformed markers
 * return false, so they take the genesis-closed path, never a
 * delete.
 */
function isStrandedOct22Marker(marker: string): boolean {
  try {
    const parsed: unknown = JSON.parse(marker);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { grantedTo?: unknown }).grantedTo ===
        RETIRED_OCT22_GENESIS_ID
    );
  } catch {
    return false;
  }
}

/**
 * #1756 — release a marker this caller just claimed, after the
 * grant that was supposed to follow it failed. Best-effort: a
 * delete failure leaves the window closed (safe — no double grant —
 * but the window then needs operator repair, the same failure mode
 * as a failed marker write before this change). Only ever called
 * on the atomic path, where the claim has exactly one winner: on
 * the legacy path a "win" is not exclusive, so releasing there
 * could reopen the window under a grant that already landed.
 */
async function releaseGenesisMarker(
  kv: KvLike,
  markerKey: string,
): Promise<void> {
  try {
    await kv.delete(markerKey);
  } catch {
    // Best-effort release; the outer error status still reports.
  }
}

export async function holdsPlatformAdmin(
  store: MembershipStore,
  internalUserId: string,
  nowMs: number,
): Promise<boolean> {
  const memberships = await store.getMembershipsByUser(internalUserId);
  return memberships.some(
    (m) =>
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) =>
          b.role === "platform-admin" &&
          b.scope === "platform" &&
          (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
      ),
  );
}

/**
 * #6191 — true iff the user holds a platform-admin membership that is
 * no longer live (revoked, or expired). A revoked record is history,
 * never un-revoked — but its presence proves a genesis grant landed
 * once and is gone, which is what authorizes a restore (a fresh grant)
 * as opposed to a first grant. A user with NO platform-admin
 * membership at all has nothing to restore from.
 */
export async function hasNonLivePlatformAdmin(
  store: MembershipStore,
  internalUserId: string,
  nowMs: number,
): Promise<boolean> {
  const memberships = await store.getMembershipsByUser(internalUserId);
  return memberships.some(
    (m) =>
      m.roleBindings.some(
        (b) => b.role === "platform-admin" && b.scope === "platform",
      ) &&
      (m.revokedAtMs !== undefined ||
        m.roleBindings.some(
          (b) =>
            b.role === "platform-admin" &&
            b.scope === "platform" &&
            b.expiresAtMs !== undefined &&
            b.expiresAtMs <= nowMs,
        )),
  );
}

/** Mint one platform-admin membership via the genesis seam. */
async function grantPlatformAdmin(
  membershipStore: MembershipStore,
  internalUserId: string,
  tenantId: string,
  nowMs: number,
): Promise<boolean> {
  try {
    const created = await createMembership(membershipStore, {
      internalUserId,
      tenantId,
      roleBindings: [
        {
          role: "platform-admin",
          scope: "platform",
          grantedBy: "system:bootstrap-genesis",
        },
      ],
      createdBy: "system:bootstrap-genesis",
      nowMs,
    });
    return created.ok;
  } catch {
    return false;
  }
}

/**
 * Provision tenant-admin for one user (idempotent — skips when already
 * held). Returns whether a grant landed, was already held, or errored.
 */
async function provisionTenantAdmin(
  membershipStore: MembershipStore,
  internalUserId: string,
  tenantId: string,
  nowMs: number,
): Promise<"provisioned" | "already-admin" | "error"> {
  const provisioned = await provisionBootstrapAdmins(membershipStore, {
    tenantId,
    internalUserIds: [internalUserId],
    nowMs,
  });
  if (!provisioned.ok) return "error";
  return provisioned.skippedAlreadyAdmin.includes(internalUserId)
    ? "already-admin"
    : "provisioned";
}

/**
 * #6191 — platform genesis for one listed identity.
 *
 * The marker key depends on the mode (config `genesis.oneTime`,
 * default false = per-identity):
 * - Per-identity: the marker is per-identity
 *   (`platformGenesisMarkerKeyForUser`), so one identity's claim
 *   never blocks another's. A marker that exists but whose grant is
 *   gone is a RESTORE, not a refusal — but only when the marker
 *   names this identity AND a non-live platform-admin membership
 *   proves a grant landed once. The spent claim is deleted and the
 *   atomic claim retried, so concurrent restorers still produce
 *   exactly one grant. A marker with no such membership is either a
 *   concurrent grant in flight (do not disturb it) or a stuck marker
 *   from a failed grant whose release failed (operator repair, as
 *   before) — it is left alone and the caller takes the closed path.
 * - Global-once: the legacy single marker per tenant, preserved
 *   byte-for-byte in behaviour (including the #1208 stranded-marker
 *   repair, which only applies here — the stranded marker lives on
 *   the global key). A second identity is refused with the named
 *   error path, as before.
 *
 * In both modes the claim is atomic (#1756): the marker is claimed
 * BEFORE granting, and a failed grant releases the claim so a retry
 * can win. When the entry also lists `tenant`, a platform grant is
 * followed by a tenant-admin top-up (idempotent); when the entry is
 * platform-only, no tenant-admin is ever silently granted.
 */
async function runPlatformGenesis(args: {
  kv: KvLike;
  membershipStore: MembershipStore;
  internalUserId: string;
  tenantId: string;
  nowMs: number;
  genesisOneTime: boolean;
  includeTenant: boolean;
  warn: (event: string, fields: Record<string, unknown>) => void;
}): Promise<BootstrapRunStatus> {
  const { kv, membershipStore, internalUserId, tenantId, nowMs } = args;
  // Already holding live platform-admin: top up tenant-admin if
  // listed (idempotent — skipped when already held).
  if (await holdsPlatformAdmin(membershipStore, internalUserId, nowMs)) {
    if (!args.includeTenant) return "already-admin";
    const tenant = await provisionTenantAdmin(
      membershipStore,
      internalUserId,
      tenantId,
      nowMs,
    );
    if (tenant === "provisioned") return "provisioned";
    return "already-admin";
  }
  const markerKey = args.genesisOneTime
    ? platformGenesisMarkerKey(tenantId)
    : platformGenesisMarkerKeyForUser(tenantId, internalUserId);
  // The claim lost (or the window closed): tenant-admin only when
  // the entry lists it — a platform-only entry gets nothing here,
  // and the status says so instead of claiming a tenant grant.
  const genesisClosed = async (): Promise<BootstrapRunStatus> => {
    if (!args.includeTenant) return "genesis-claim-lost";
    const tenant = await provisionTenantAdmin(
      membershipStore,
      internalUserId,
      tenantId,
      nowMs,
    );
    if (tenant === "provisioned") return "genesis-closed-tenant-admin";
    if (tenant === "already-admin") return "already-admin";
    return "error";
  };
  let marker = await kv.get(markerKey);
  if (marker !== null) {
    if (args.genesisOneTime && isStrandedOct22Marker(marker)) {
      // #1208 one-time repair (global-once mode only): the stranded
      // Oct 22 marker names a retired id no login carries — delete
      // it so the claim below grants and re-sets the marker. A
      // delete failure propagates to the outer catch (status
      // "error"); the login itself is unaffected.
      await kv.delete(markerKey);
      marker = null;
    } else {
      // Restore: the marker names this identity AND a non-live
      // platform-admin membership proves a grant landed once.
      let restorable = false;
      try {
        const parsedMarker = JSON.parse(marker) as { grantedTo?: unknown };
        restorable =
          parsedMarker.grantedTo === internalUserId &&
          (await hasNonLivePlatformAdmin(membershipStore, internalUserId, nowMs));
      } catch {
        restorable = false;
      }
      if (restorable) {
        await kv.delete(markerKey);
        marker = null;
      } else {
        return genesisClosed();
      }
    }
  }
  const markerValue = JSON.stringify({
    grantedTo: internalUserId,
    tenantId,
    atMs: nowMs,
  });
  if (typeof kv.putIfAbsent === "function") {
    // #1756 atomic path: claim the marker BEFORE granting, in one
    // indivisible backend operation. The loser takes the
    // genesis-closed path and never writes the marker, so exactly
    // one first-login can win. The grant follows the claim (never
    // precedes it): a grant before the claim would let the loser
    // hold platform-admin too. If the grant fails, release the
    // claim so a retry can win.
    const claimed = await kv.putIfAbsent(markerKey, markerValue);
    if (!claimed) return genesisClosed();
    const granted = await grantPlatformAdmin(
      membershipStore,
      internalUserId,
      tenantId,
      nowMs,
    );
    if (!granted) {
      await releaseGenesisMarker(kv, markerKey);
      return "error";
    }
    if (args.includeTenant) {
      const tenant = await provisionTenantAdmin(
        membershipStore,
        internalUserId,
        tenantId,
        nowMs,
      );
      if (tenant === "error") {
        // Platform-admin landed (status "genesis"); the tenant
        // top-up is best-effort and retries on the next login.
        args.warn("iaaaGithubEndToEnd.genesis_tenant_topup_failed", {
          message:
            "[post-login] genesis granted platform-admin but the tenant-admin top-up failed; it retries on the next login",
          code: "bootstrap.tenant_topup_failed",
        });
      }
    }
    return "genesis";
  }
  // Legacy path (backend without putIfAbsent): the pre-#1756
  // create-then-put order, unchanged. Two concurrent first-logins
  // can still both win here; deployments on such a backend must
  // serialize their first logins. The order is deliberately NOT
  // changed to claim-then-grant: without an atomic claim a "win"
  // is not exclusive, so releasing the marker on a failed grant
  // could reopen the window under a grant that already landed.
  const granted = await grantPlatformAdmin(
    membershipStore,
    internalUserId,
    tenantId,
    nowMs,
  );
  if (!granted) return "error";
  await kv.put(markerKey, markerValue);
  if (args.includeTenant) {
    await provisionTenantAdmin(membershipStore, internalUserId, tenantId, nowMs);
  }
  return "genesis";
}

/**
 * #6258 — repair the missing id-migration record after a post-login
 * alias conflict. The #1182 migration can never create this record
 * for a login whose provider key already holds a fresh derived-id
 * binding (its migration no-ops forever), and the #1208 repair
 * grants never write one — so the #6182 chain-follow has nothing
 * to follow and the login keeps resolving to the retired id. This
 * is the one place that can create the record: it runs on every
 * wired GitHub sign-in, holds the binding-proved derived id, and
 * already handles ALIAS_CONFLICT best-effort.
 *
 * The alias is never re-pointed: the ALIAS_CONFLICT guard stays
 * intact and the #6182 chain-follow does the resolution. The
 * repair fires only when the aliased id holds no live memberships
 * (none unrevoked/unexpired, by the dispatch gate's liveness
 * predicate) — a live identity can never be hijacked, and a true
 * login-recycling conflict stands for operator resolution.
 * Best-effort throughout: never throws, never fails the login.
 * Returns the alias status to report, plus the retired id the
 * record migrates from when one was written (for the audit seam).
 */
async function repairAliasConflictMigration(
  deps: WiredPostLoginDeps,
  input: WiredPostLoginInput,
  structuredLog: StructuredLogger,
): Promise<{ status: AliasRunStatus; migratedFrom: string | null }> {
  try {
    const alias = await readLoginAlias(deps.kv, input.githubLogin);
    if (alias === null) return { status: "conflict-preserved", migratedFrom: null };
    const aliasedId = alias.internalUserId;
    if (aliasedId === input.internalUserId) {
      return { status: "conflict-preserved", migratedFrom: null };
    }
    const aliasedMemberships =
      await deps.membershipStore.getMembershipsByUser(aliasedId);
    if (aliasedMemberships.some((m) => membershipIsLive(m, input.nowMs))) {
      return { status: "conflict-preserved", migratedFrom: null };
    }
    const recorded = await recordIdMigration(deps.kv, {
      oldInternalUserId: aliasedId,
      newInternalUserId: input.internalUserId,
      nowMs: input.nowMs,
    });
    if (!recorded.ok) {
      // ID_MIGRATION_CONFLICT (or invalid): the existing record
      // stands and the conflict is preserved for operator
      // resolution — never overwritten.
      structuredLog.warn("iaaaGithubEndToEnd.alias_migration_conflict", {
        message: `[post-login] id-migration refused (${recorded.code}); alias conflict preserved`,
        code: recorded.code,
      });
      return { status: "conflict-preserved", migratedFrom: null };
    }
    return { status: "migration-recorded", migratedFrom: aliasedId };
  } catch (err) {
    structuredLog.warn("iaaaGithubEndToEnd.alias_migration_failed", {
      message: `[post-login] id-migration repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
      code: "alias.migration_failed",
    });
    return { status: "migration-error", migratedFrom: null };
  }
}

/**
 * Wired post-login work: record the login alias, then bootstrap the
 * logging-in user if listed. Best-effort throughout: this function
 * never throws, and no failure here may change the login outcome.
 * The caller (the wired GitHub callback) awaits it only for its
 * side effects, never for a gate.
 */
export async function runWiredPostLogin(
  deps: WiredPostLoginDeps,
  input: WiredPostLoginInput,
): Promise<WiredPostLoginResult> {
  // #3515 S3 batch 8 — logger over the injected sink, else the structured
  // console fallback (never an empty-env sink, #5587).
  const structuredLog = createStructuredLogger(
    deps.sink ?? new ConsoleObservabilitySink(),
    { component: "security/iaaaGithubEndToEnd" },
  );
  let aliasStatus: AliasRunStatus;
  let migrationFrom: string | null = null;
  try {
    const recorded = await recordLoginAlias(deps.kv, {
      githubLogin: input.githubLogin,
      internalUserId: input.internalUserId,
      nowMs: input.nowMs,
    });
    aliasStatus = recorded.ok
      ? "recorded"
      : recorded.code === "ALIAS_CONFLICT"
        ? "conflict-preserved"
        : "invalid";
  } catch {
    aliasStatus = "error";
  }
  // #6258 — after an alias conflict, record the id-migration the
  // #6182 chain-follow needs. Best-effort: the helper never throws
  // and never changes the login outcome.
  if (aliasStatus === "conflict-preserved") {
    const repair = await repairAliasConflictMigration(deps, input, structuredLog);
    aliasStatus = repair.status;
    migrationFrom = repair.migratedFrom;
  }

  // #5160 — the sign-in IDP profile refresh: persist the
  // sanitized userinfo doc into the durable per-tenant profile
  // row (after the alias step, so a re-keyed identity refreshes
  // under its derived id). Best-effort: a failed refresh warns
  // and never throws or changes the login outcome — a login must
  // never fail because the profile store is down.
  let profileStatus: ProfileRunStatus = "skipped";
  let profileDiverged: string[] = [];
  if (deps.profile && input.idpAttributes && Object.keys(input.idpAttributes).length > 0) {
    try {
      const config = loadIdpProfileConfig(deps.settings ?? null);
      const sanitized = sanitizeIdpAttributes(input.idpAttributes, config);
      if (sanitized.ok && Object.keys(sanitized.attributes).length > 0) {
        const refreshed = await deps.profile.refreshFromIdp({
          internalUserId: input.internalUserId,
          tenantId: input.tenantId,
          userLogin: input.githubLogin,
          idpIssuer: input.idpIssuer ?? input.providerIssuer,
          attributes: sanitized.attributes,
          nowMs: input.nowMs,
        });
        profileStatus = "refreshed";
        profileDiverged = refreshed.diverged;
      }
    } catch {
      profileStatus = "refresh-failed";
      structuredLog.warn("iaaaGithubEndToEnd.idp_profile_refresh_failed", {
        message: "[post-login] IDP profile refresh failed (login proceeds)",
        code: "idp_profile.refresh_failed",
      });
    }
  }

  let bootstrapStatus: BootstrapRunStatus;
  try {
    if (input.bootstrapRaw === undefined || input.bootstrapRaw.trim() === "") {
      bootstrapStatus = "blank";
    } else {
      const parsed = parseBootstrapListWithGenesis(input.bootstrapRaw);
      let matchedRoles: BootstrapRole[] = [];
      let matched = false;
      for (const { roles, entry } of parsed.entries) {
        const resolved = await resolveEntryUserId(deps.bindingStore, entry);
        if (resolved === input.internalUserId) {
          matched = true;
          matchedRoles = roles;
        }
      }
      if (!matched) {
        bootstrapStatus = "not-listed";
      } else if (matchedRoles.includes("platform")) {
        // #6191 — the genesis mode is config
        // (config/sessionstore.json, genesis.oneTime; default false
        // = per-identity). An explicit override in deps wins over
        // config. An invalid config value fails closed to
        // per-identity (see the config resolver); the named config
        // errors are warned here, where the mode is actually used.
        const genesisOneTime =
          deps.genesisOneTime ?? SESSION_STORE_CONFIG.genesis.oneTime;
        if (
          deps.genesisOneTime === undefined &&
          SESSION_STORE_CONFIG_ERRORS.length > 0
        ) {
          for (const error of SESSION_STORE_CONFIG_ERRORS) {
            structuredLog.warn(
              "iaaaGithubEndToEnd.sessionstore_config_invalid",
              {
                message: `[post-login] sessionstore config invalid: ${error}`,
                code: "sessionstore.config.invalid",
              },
            );
          }
        }
        bootstrapStatus = await runPlatformGenesis({
          kv: deps.kv,
          membershipStore: deps.membershipStore,
          internalUserId: input.internalUserId,
          tenantId: input.tenantId,
          nowMs: input.nowMs,
          genesisOneTime,
          includeTenant: matchedRoles.includes("tenant"),
          warn: (event, fields) => structuredLog.warn(event, fields),
        });
      } else {
        // Tenant-only (plain or tenant:): unchanged bootstrap
        // provisioning — tenant-admin only, never platform-admin.
        const tenant = await provisionTenantAdmin(
          deps.membershipStore,
          input.internalUserId,
          input.tenantId,
          input.nowMs,
        );
        bootstrapStatus =
          tenant === "provisioned"
            ? "provisioned"
            : tenant === "already-admin"
              ? "already-admin"
              : "error";
      }
    }
  } catch {
    bootstrapStatus = "error";
  }

  // #1760 — emit audit events for the post-login occurrences that
  // used to be silent. Only statuses that DID something emit:
  // "recorded" (an alias row was written), "migration-recorded"
  // (#6258: an id-migration record was written), "provisioned" (an
  // ordinary bootstrap grant), "genesis" (platform-admin grant +
  // marker set), "genesis-closed-tenant-admin" (tenant-admin grant
  // via the genesis-closed path). "already-admin", "not-listed",
  // "blank", "conflict-preserved", "invalid", "migration-error",
  // "genesis-claim-lost", and "error" wrote nothing, so they emit
  // nothing — an event for a non-occurrence would be false
  // evidence. Best-effort throughout: a failed write warns and
  // never throws or changes the login outcome.
  if (deps.audit) {
    try {
      if (aliasStatus === "recorded") {
        const recorded = await recordWiredAuthAudit(
          deps.audit.store,
          buildAliasRecordedAuditEventInput({
            internalUserId: input.internalUserId,
            tenantId: input.tenantId,
            timestamp: input.nowMs,
            correlationId: deps.audit.correlationId,
          }),
        );
        if (!recorded.ok) {
          structuredLog.warn("iaaaGithubEndToEnd.alias_audit_write_failed", {
            message: `[post-login-audit] alias audit write failed (${recorded.code})`,
            code: recorded.code,
          });
        }
      }
      if (aliasStatus === "migration-recorded" && migrationFrom !== null) {
        const recorded = await recordWiredAuthAudit(
          deps.audit.store,
          buildIdMigrationRecordedAuditEventInput({
            oldInternalUserId: migrationFrom,
            newInternalUserId: input.internalUserId,
            tenantId: input.tenantId,
            timestamp: input.nowMs,
            correlationId: deps.audit.correlationId,
          }),
        );
        if (!recorded.ok) {
          structuredLog.warn(
            "iaaaGithubEndToEnd.alias_migration_audit_write_failed",
            {
              message: `[post-login-audit] id-migration audit write failed (${recorded.code})`,
              code: recorded.code,
            },
          );
        }
      }
      if (profileStatus === "refreshed") {
        const recorded = await recordWiredAuthAudit(
          deps.audit.store,
          buildIdpProfileRefreshedAuditEventInput({
            internalUserId: input.internalUserId,
            tenantId: input.tenantId,
            timestamp: input.nowMs,
            correlationId: deps.audit.correlationId,
          }),
        );
        if (!recorded.ok) {
          structuredLog.warn("iaaaGithubEndToEnd.idp_profile_audit_write_failed", {
            message: `[post-login-audit] IDP profile refresh audit write failed (${recorded.code})`,
            code: recorded.code,
          });
        }
      }
      if (profileDiverged.length > 0) {
        const recorded = await recordWiredAuthAudit(
          deps.audit.store,
          buildIdpProfileDivergedAuditEventInput({
            internalUserId: input.internalUserId,
            tenantId: input.tenantId,
            timestamp: input.nowMs,
            correlationId: deps.audit.correlationId,
            divergedFields: profileDiverged,
          }),
        );
        if (!recorded.ok) {
          structuredLog.warn("iaaaGithubEndToEnd.idp_profile_diverged_audit_write_failed", {
            message: `[post-login-audit] IDP profile divergence audit write failed (${recorded.code})`,
            code: recorded.code,
          });
        }
      }
      if (
        bootstrapStatus === "provisioned" ||
        bootstrapStatus === "genesis" ||
        bootstrapStatus === "genesis-closed-tenant-admin"
      ) {
        const granted = await recordWiredAuthAudit(
          deps.audit.store,
          buildBootstrapGrantAuditEventInput({
            internalUserId: input.internalUserId,
            tenantId: input.tenantId,
            timestamp: input.nowMs,
            correlationId: deps.audit.correlationId,
            genesis: bootstrapStatus === "genesis",
          }),
        );
        if (!granted.ok) {
          structuredLog.warn("iaaaGithubEndToEnd.bootstrap_audit_write_failed", {
            message: `[post-login-audit] bootstrap audit write failed (${granted.code})`,
            code: granted.code,
          });
        }
      }
    } catch {
      // Post-login work never fails a login; an audit failure here
      // is already fail-visible via the warn above when the store
      // answered, and a throwing store is swallowed like every
      // other post-login failure in this function.
    }
  }

  return {
    alias: { status: aliasStatus },
    bootstrap: { status: bootstrapStatus },
    profile: { status: profileStatus, diverged: profileDiverged },
  };
}

/**
 * PDP check for one gated route: allow iff the wired session's
 * internal user holds the permission in the tenant. Returns false
 * for a non-wired session (defense in depth — callers also check
 * shouldEnforcePdp before calling). Pure decision, no side effects.
 */
export async function checkRoutePermission(
  membershipStore: MembershipStore,
  session: SessionData | null | undefined,
  tenantId: string,
  permission: Permission,
  nowMs: number,
): Promise<boolean> {
  if (!session?.internalUserId) return false;
  const decision = await checkPermission(membershipStore, {
    internalUserId: session.internalUserId,
    tenantId,
    permission,
    nowMs,
  });
  return decision.decision === "allow";
}
