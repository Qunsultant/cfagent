/**
 * #945 Wiring Phase 1 — GitHub login/session wiring, config-gated.
 *
 * This module is used ONLY when IAAA wiring is enabled (see providers.ts:
 * IAAA_WIRING_ENABLED = "1"/"true"). When wiring is OFF, server.ts calls
 * the legacy handleLogin/handleOAuthCallback directly and this module is
 * never invoked, so the legacy flow runs exactly as before.
 *
 * What Phase 1 does (GitHub only):
 * - After the existing GitHub profile fetch succeeds (the same
 *   exchangeGithubCode/fetchGithubProfile helpers the legacy callback
 *   uses), resolve or create a Slice 1 IdentityBinding for
 *   (issuer https://github.com, subject = GitHub numeric user id).
 *   The login is NEVER used as the subject: logins can change, user
 *   ids cannot. If the profile has no usable id, the login fails and
 *   no binding and no session are created.
 * - The profile fetch IS the proof of control for this binding
 *   (proofVerified: true): the caller has already validated the
 *   provider assertion by exchanging the code server-side and fetching
 *   the profile with the resulting token. No unproven linking happens.
 * - The session keeps every legacy field unchanged and adds only the
 *   optional Slice 1/2 fields: internalUserId, providerIssuer,
 *   providerSubject, authTimeMs (login time), sessionVersion (1).
 *   Old sessions without those fields keep working.
 * - Bindings are stored in the SessionStore DO via sessionStore(),
 *   under keys prefixed "iaaa-binding:", with NO expiry — a binding
 *   must outlive any one session. It shares the DO namespace with
 *   sessions but never collides with session keys (session keys are
 *   bare UUIDs; binding keys carry the prefix).
 *
 * What Phase 1 does NOT do (later phases, honestly stated):
 * - PDP, delegation, or audit wiring at routes. Those are later
 *   phases and are deliberately absent here.
 * - Provider-specific token/profile calls. Those live in the
 *   adapters (githubOAuth.ts, oidcProvider.ts); this module owns
 *   only the provider-agnostic tail (completeWiredLogin), which
 *   every adapter funnels through. See providers.ts for how a
 *   future adapter registers without changing server.ts dispatch.
 *
 * Phase 2a (this module, helpers + one audit integration point):
 * - Idle enforcement exists as a helper, not a live gate.
 *   getValidatedSession now also rejects sessions idle longer
 *   than the Slice 2 idle timeout (default 30 min, overridable),
 *   but ONLY for sessions that carry lastActivityMs; legacy and
 *   Phase 1 sessions without the field are exempt, preserving
 *   the Phase 1 contract. buildExtendedSessionData now sets
 *   lastActivityMs at login. server.ts requireAuth is NOT
 *   changed here: it still reads via getSessionCached without
 *   idle checks, and any future enforcement point MUST read
 *   fresh (getSession) — see iaaaSessionActivity.ts for why the
 *   60s isolate cache cannot enforce idle timeouts.
 * - Auth audit recording exists as a seam, not a production
 *   store. completeWiredLogin records a Slice 5 login
 *   success/failure event ONLY when the caller supplies an
 *   auditStore AND an auditTenantId; recording is best-effort
 *   and never changes the login outcome. (Phase 2a said there
 *   was deliberately no default tenant; the GitHub end-to-end
 *   slice resolves the tenant at the call site — IAAA_TENANT_ID
 *   else the documented default "primary" — see
 *   iaaaGithubEndToEnd.ts. The module itself still takes the
 *   tenant as an explicit argument and invents nothing.)
 * - Step-up remains a helper (iaaaSessionActivity.ts); no route
 *   calls it in this phase (Phase 2b).
 *
 * GitHub end-to-end (this module, wired callback only):
 * - When the caller passes postLoginEnabled, the wired callback
 *   runs runWiredPostLogin() after the session is created: the
 *   login alias is recorded and, if the user is listed in
 *   IAAA_BOOTSTRAP_ADMINS, bootstrap provisioning runs (including
 *   the platform-admin genesis rule). Best-effort throughout: no
 *   failure here changes the login outcome. server.ts dispatch
 *   passes postLoginEnabled (plus the audit store and the
 *   resolved tenant) for the wired GitHub callback, so login
 *   audit is switched on in production by the same call.
 *   Direct callers that omit the option get the previous
 *   behaviour exactly (no audit, no post-login work).
 *
 * Rollback: set IAAA_WIRING_ENABLED off (or remove "github" from
 * IAAA_ENABLED_PROVIDERS). No code change is needed, and sessions
 * created by the wired flow keep working afterwards because the new
 * fields are optional and the legacy fields are unchanged.
 */
import type { Env, SessionData } from "../types";
import {
  buildLoginFailureAuditEventInput,
  buildLoginSuccessAuditEventInput,
  recordWiredAuthAudit,
} from "./iaaaAuthAudit";
import type { AuditStore } from "./iaaaAudit";
import { IAAA_AUDIT_POLICY_VERSION } from "./iaaaAudit";
import type { KvLike } from "./kvResilience";
import { DEFAULT_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs } from "./sessionPolicy";
import {
  enforceSessionCap,
  sessionCap,
  SessionCapError,
} from "./sessionCap";
import { invalidateSessionCache } from "./sessionCache";
import {
  createMemoryIdentityBindingStore,
  deriveInternalUserId,
  getInternalUserId,
  resolveOrCreateBinding,
  type IdentityBinding,
  type IdentityBindingStore,
} from "./identityBinding";
import {
  createMembership,
  type Membership,
  type MembershipStore,
} from "./authorization";
import { ensureTenantMember } from "./iaaaAutoProvision";
import {
  recordIdMigration,
  repairStrandedPlatformAdmin,
} from "./iaaaMigration";
import {
  createSession,
  deleteSession,
  listSessionFamilyEntries,
  SESSION_MAX_TTL,
  SESSION_TTL,
  setSessionCookie,
} from "./session";
import {
  isSessionPortsEnabled,
  sessionFamilyPorts,
  sessionStore,
  wiredMembershipStore,
} from "./session";
import { setCsrfCookie } from "./csrf";
import {
  authOutcomeLoginUrl,
  type AuthOutcomeCode,
} from "./authOutcome";
import { buildPostLoginRedirect } from "./returnTarget";
import {
  parseBootstrapListWithGenesis,
  resolveIaaaTenant,
  runWiredPostLogin,
} from "./iaaaGithubEndToEnd";

export const GITHUB_ISSUER = "https://github.com";
export const IAAA_BINDING_KEY_PREFIX = "iaaa-binding:";
export const IAAA_SESSION_VERSION = 1;

/** GitHub profile shape the wired callback needs (id is the subject). */
export interface GithubProfile {
  id: number;
  login: string;
  avatar_url?: string;
  name?: string | null;
}

export type GithubBindingErrorCode = "MISSING_SUBJECT_ID" | "BINDING_FAILED";

export type GithubBindingResult =
  | { ok: true; binding: IdentityBinding }
  | { ok: false; code: GithubBindingErrorCode; error: string };

/**
 * Stores the login-time migration needs. Production callers
 * (completeWiredLogin) always supply these — defaulted from Env
 * when the caller omits them — so migration runs on every wired
 * login. Direct callers that omit them get resolution without
 * migration: a pre-existing minted binding is returned unchanged.
 */
export interface MigrationDeps {
  membershipStore: MembershipStore;
  aliasKv: KvLike;
}

export interface MigrationResult {
  migrated: boolean;
  binding: IdentityBinding;
  oldInternalUserId?: string;
}

/** True when two role-binding lists grant identically, in order. */
function sameRoleBindings(
  a: readonly { role: string; scope: string; workspaceId?: string; resourceId?: string; expiresAtMs?: number; grantedBy: string }[],
  b: readonly { role: string; scope: string; workspaceId?: string; resourceId?: string; expiresAtMs?: number; grantedBy: string }[],
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

function sameMembershipSignature(a: Membership, b: Membership): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.workspaceId === b.workspaceId &&
    sameRoleBindings(a.roleBindings, b.roleBindings)
  );
}

/**
 * #1182 — login-time migration of one binding to its derived id.
 *
 * Runs inside resolveProviderBinding, BEFORE post-login bootstrap
 * provisioning (completeWiredLogin resolves first, then runs
 * post-login work with the migrated id — so bootstrap entries
 * match the derived id, never the retired minted one).
 *
 * Semantics, in order — chosen so a failed login retries to the
 * same end state instead of locking the user out:
 *  1. Move memberships: for each membership under the old id,
 *     create an equivalent under the derived id (via the
 *     provisioning path, createMembership) unless an equivalent
 *     already exists there — that check is what makes a retry
 *     after a partial move converge instead of duplicating.
 *     A genuinely-revoked membership mirrors as revoked, with
 *     its original revocation timestamp: migration never
 *     resurrects access. Then revoke the old memberships that
 *     are still active (already-revoked ones keep their
 *     timestamp as evidence).
 *  2. Record the old→new alias in the alias layer.
 *  3. Rewrite the binding to the derived id (linkedAt and proof
 *     preserved) and drop the stale reverse index entry for the
 *     old id (best-effort: a failure there leaves a stale
 *     pointer, never a wrong grant — the migration record is
 *     the forward pointer).
 * A failure in steps 1–2 fails the login (BINDING_FAILED) with
 * the minted binding untouched or retryably half-moved; the
 * binding rewrite is the commit point, after which a re-login
 * is a no-op. Sessions, PDP, and authorization are untouched:
 * they consume internalUserId opaquely.
 */
export async function migrateBindingToDerivedId(
  bindingStore: IdentityBindingStore,
  deps: MigrationDeps,
  binding: IdentityBinding,
  nowMs: number,
): Promise<MigrationResult> {
  const derived = await deriveInternalUserId(
    binding.providerIssuer,
    binding.providerSubject,
  );
  if (derived === binding.internalUserId) {
    return { migrated: false, binding };
  }
  const oldId = binding.internalUserId;
  const olds = await deps.membershipStore.getMembershipsByUser(oldId);
  const news = await deps.membershipStore.getMembershipsByUser(derived);
  for (const old of olds) {
    if (!news.some((n) => sameMembershipSignature(old, n))) {
      const created = await createMembership(deps.membershipStore, {
        internalUserId: derived,
        tenantId: old.tenantId,
        workspaceId: old.workspaceId,
        roleBindings: old.roleBindings.map((b) => ({ ...b })),
        createdBy: old.createdBy,
        nowMs,
      });
      if (!created.ok) {
        throw new Error(`membership migration failed for ${oldId}: ${created.error}`);
      }
      if (old.revokedAtMs !== undefined) {
        await deps.membershipStore.put({
          ...created.membership,
          revokedAtMs: old.revokedAtMs,
        });
      }
      news.push(created.membership);
    }
    if (old.revokedAtMs === undefined) {
      await deps.membershipStore.revokeMembership(old.membershipId, nowMs);
    }
  }
  const alias = await recordIdMigration(deps.aliasKv, {
    oldInternalUserId: oldId,
    newInternalUserId: derived,
    nowMs,
  });
  if (!alias.ok) {
    throw new Error(`id-migration alias failed for ${oldId}: ${alias.error}`);
  }
  const migrated: IdentityBinding = { ...binding, internalUserId: derived };
  await bindingStore.put(migrated);
  try {
    await bindingStore.removeByUserAndIssuer(oldId, binding.providerIssuer);
  } catch {
    // Stale reverse index only; the binding and the migration
    // record are authoritative. Never fail a login over cleanup.
  }
  return { migrated: true, binding: migrated, oldInternalUserId: oldId };
}

/**
 * Resolve or create the Slice 1 binding for one provider subject.
 * Provider-agnostic: the caller supplies the validated issuer and
 * the provider-stable subject (never a login or email). The profile
 * fetch that produced the subject IS the proof of control
 * (proofVerified: true). A store failure maps to BINDING_FAILED.
 * When migration deps are supplied, a pre-existing minted binding
 * is migrated to its derived id first (see
 * migrateBindingToDerivedId); a migration failure also maps to
 * BINDING_FAILED.
 */
export async function resolveProviderBinding(
  store: IdentityBindingStore,
  issuer: string,
  subject: string,
  nowMs: number,
  migration?: MigrationDeps
): Promise<GithubBindingResult> {
  const result = await resolveOrCreateBinding(store, {
    providerIssuer: issuer,
    providerSubject: subject,
    proofVerified: true,
    nowMs,
  });
  if (!result.ok) {
    return { ok: false, code: "BINDING_FAILED", error: result.error };
  }
  if (migration) {
    try {
      const migrated = await migrateBindingToDerivedId(
        store,
        migration,
        result.binding,
        nowMs,
      );
      return { ok: true, binding: migrated.binding };
    } catch (err) {
      return {
        ok: false,
        code: "BINDING_FAILED",
        error: err instanceof Error ? err.message : "binding migration failed",
      };
    }
  }
  return { ok: true, binding: result.binding };
}

/**
 * Resolve or create the Slice 1 binding for a fetched GitHub profile.
 * Subject is String(profile.id); a missing/non-finite id fails the login
 * rather than binding by login. The profile fetch is the proof.
 */
export async function resolveGithubBinding(
  store: IdentityBindingStore,
  profile: GithubProfile,
  nowMs: number,
  migration?: MigrationDeps
): Promise<GithubBindingResult> {
  if (
    !profile ||
    typeof profile.id !== "number" ||
    !Number.isFinite(profile.id)
  ) {
    return {
      ok: false,
      code: "MISSING_SUBJECT_ID",
      error: "GitHub profile did not include a stable user id; login cannot be bound",
    };
  }
  return resolveProviderBinding(store, GITHUB_ISSUER, String(profile.id), nowMs, migration);
}

/**
 * IdentityBindingStore backed by a KvLike store (in production,
 * sessionStore(env)). Two keys per binding so both lookup directions
 * work: by provider (issuer+subject) and by user+issuer. No TTL.
 */
export function createKvBindingStore(kv: KvLike): IdentityBindingStore {
  const byProviderKey = (issuer: string, subject: string) =>
    `${IAAA_BINDING_KEY_PREFIX}${issuer}\0${subject}`;
  const byUserKey = (userId: string, issuer: string) =>
    `${IAAA_BINDING_KEY_PREFIX}user:${userId}\0${issuer}`;

  async function read(key: string): Promise<IdentityBinding | null> {
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdentityBinding;
    } catch {
      return null;
    }
  }

  return {
    async getByProvider(providerIssuer, providerSubject) {
      return read(byProviderKey(providerIssuer, providerSubject));
    },
    async getByUserAndIssuer(internalUserId, providerIssuer) {
      return read(byUserKey(internalUserId, providerIssuer));
    },
    async put(binding) {
      const value = JSON.stringify(binding);
      await kv.put(byProviderKey(binding.providerIssuer, binding.providerSubject), value);
      await kv.put(byUserKey(binding.internalUserId, binding.providerIssuer), value);
    },
    async removeByUserAndIssuer(internalUserId, providerIssuer) {
      await kv.delete(byUserKey(internalUserId, providerIssuer));
    },
  };
}

/** Test seam: the binding store used by the wired callback. Defaults to Kv-backed. */
export function createWiredBindingStore(env: Env): IdentityBindingStore {
  // #2433 (step 5b): flag-on composes through the session
  // family's binding port; flag-off is today's Kv store.
  if (isSessionPortsEnabled(env)) return sessionFamilyPorts(env).bindings;
  return createKvBindingStore(sessionStore(env));
}

/** Test seam: in-memory binding store (tests only). */
export function createTestBindingStore(): IdentityBindingStore {
  return createMemoryIdentityBindingStore();
}

/**
 * Build the extended session for a wired login: every legacy field
 * unchanged, plus the new optional fields. Never mutates `base`.
 */
export function buildExtendedSessionData(
  base: SessionData,
  binding: Pick<IdentityBinding, "internalUserId" | "providerIssuer" | "providerSubject">,
  nowMs: number
): SessionData {
  return {
    ...base,
    internalUserId: binding.internalUserId,
    providerIssuer: binding.providerIssuer,
    providerSubject: binding.providerSubject,
    authTimeMs: nowMs,
    // Phase 2a: login counts as activity, so idle tracking starts here.
    lastActivityMs: nowMs,
    // Sliding renewal preserves this; the 30-day hard cap is measured here.
    firstCreatedAt: base.firstCreatedAt ?? nowMs,
    sessionVersion: IAAA_SESSION_VERSION,
  };
}

export type ValidatedSessionResult =
  | { ok: true; session: SessionData }
  | {
      ok: false;
      code:
        | "SESSION_MISSING"
        | "SESSION_INVALID"
        | "SESSION_EXPIRED"
        | "SESSION_IDLE_EXPIRED";
      error: string;
    };

export interface ValidatedSessionOptions {
  /** Idle timeout in ms; an invalid value falls back to the Slice 2 default (30 min). */
  idleTimeoutMs?: number;
}

/**
 * Session validation: existence, absolute expiry
 * (createdAt + SESSION_TTL, expiry exclusive), then idle expiry.
 *
 * Phase 2a idle rule: a session is idle-expired when
 * nowMs >= lastActivityMs + idleTimeoutMs (deadline exclusive,
 * consistent with Slice 2). The timeout defaults to the Slice 2
 * default (30 min) and is caller-overridable via options.
 * Sessions WITHOUT a finite lastActivityMs (legacy sessions and
 * Phase 1 sessions, which predate activity tracking) are EXEMPT
 * from idle expiry — tightening them would silently break the
 * Phase 1 contract, and their activity was never recorded.
 * Absolute expiry is checked before idle expiry.
 *
 * This is a helper: no live route calls it yet (server.ts
 * requireAuth still uses getSessionCached without idle checks).
 * Any future enforcement point must read fresh — see
 * iaaaSessionActivity.ts on the 60s cache problem.
 */
export function getValidatedSession(
  session: SessionData | null,
  nowMs: number,
  options?: ValidatedSessionOptions
): ValidatedSessionResult {
  if (!session) {
    return { ok: false, code: "SESSION_MISSING", error: "no session exists for this id" };
  }
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) {
    return { ok: false, code: "SESSION_INVALID", error: "session has no valid createdAt" };
  }
  if (session.createdAt + SESSION_TTL * 1000 <= nowMs) {
    return { ok: false, code: "SESSION_EXPIRED", error: "session passed its absolute expiry" };
  }
  const firstCreatedAt =
    typeof session.firstCreatedAt === "number" && Number.isFinite(session.firstCreatedAt)
      ? session.firstCreatedAt
      : session.createdAt;
  if (firstCreatedAt + SESSION_MAX_TTL * 1000 <= nowMs) {
    return {
      ok: false,
      code: "SESSION_EXPIRED",
      error: "session passed its 30-day lifetime cap",
    };
  }
  const idleTimeoutMs =
    typeof options?.idleTimeoutMs === "number" &&
    Number.isFinite(options.idleTimeoutMs) &&
    options.idleTimeoutMs > 0
      ? options.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS;
  const lastActivityMs = session.lastActivityMs;
  if (
    typeof lastActivityMs === "number" &&
    Number.isFinite(lastActivityMs) &&
    nowMs >= lastActivityMs + idleTimeoutMs
  ) {
    return { ok: false, code: "SESSION_IDLE_EXPIRED", error: "session idle longer than the idle timeout" };
  }
  return { ok: true, session };
}

/**
 * #945 Google-as-plugin — normalized profile for the generic wired
 * login tail. Every provider adapter normalizes its fetched profile
 * to this shape BEFORE calling completeWiredLogin:
 * - subject: the provider-stable subject (GitHub numeric id as a
 *   string, Google `sub`). This is the Slice 1 identity. It is
 *   never a login or an email.
 * - loginKey: the legacy login-key field value (GitHub login,
 *   Google verified email). It fills the pre-existing
 *   githubLogin-keyed paths (DO routing, token keys, /api/me)
 *   and the login alias record. It is display/lookup data, NOT
 *   identity: a login-key change or reuse never moves the binding.
 * - displayName / avatarUrl: display fields for the session.
 */
export interface NormalizedLoginProfile {
  subject: string;
  loginKey: string;
  displayName: string;
  avatarUrl: string;
}

/**
 * #1210 — does the logging-in user match a `platform:` bootstrap entry?
 * Reuses the existing bootstrap parser (parseBootstrapListWithGenesis);
 * it does not reimplement entry parsing. A platform: entry matches
 * when it resolves to the logging-in user's id: a bare id compares
 * directly, an issuer:subject entry resolves through the binding
 * store (post-migration, so it yields the derived id). Rejected or
 * malformed entries never match, and a plain (non-platform:) entry
 * never counts.
 */
export async function isPlatformBootstrapListed(
  bindingStore: IdentityBindingStore,
  bootstrapRaw: string | undefined,
  targetInternalUserId: string,
): Promise<boolean> {
  if (bootstrapRaw === undefined || bootstrapRaw.trim() === "") return false;
  const parsed = parseBootstrapListWithGenesis(bootstrapRaw);
  for (const { genesis, entry } of parsed.entries) {
    if (!genesis) continue;
    if (entry.kind === "internalUserId") {
      if (entry.internalUserId === targetInternalUserId) return true;
    } else {
      const resolved = await getInternalUserId(
        bindingStore,
        entry.providerIssuer,
        entry.providerSubject,
      );
      if (resolved !== null && resolved === targetInternalUserId) return true;
    }
  }
  return false;
}

/** Options for the generic wired login tail (same shape as the GitHub delegate's). */
export interface WiredLoginOptions {
  bindingStore?: IdentityBindingStore;
  nowMs?: number;
  auditStore?: AuditStore;
  auditTenantId?: string;
  /** End-to-end: alias recording + bootstrap-on-login. Default off. */
  postLoginEnabled?: boolean;
  /**
   * #3015: return target recovered from the signed OAuth state
   * (or null). Validated once more at redirect time; null keeps
   * the default landing.
   */
  returnTarget?: string | null;
  /**
   * #1182 login-time migration stores. When omitted, they default
   * to the env-derived SessionStore DO stores — so production
   * logins always migrate. Tests pass explicit memory stores.
   */
  migration?: MigrationDeps;
}

/**
 * Generic wired login tail: binding + extended session + post-login
 * work + login audit, parameterized over a normalized profile and
 * its validated issuer. Every provider adapter (GitHub, Google via
 * the OIDC factory, future plugins) funnels through here, so the
 * fail-closed rules, the audit seam, and the post-login contract
 * are identical for all providers.
 *
 * Fail-closed, in order, before anything is persisted:
 * - a missing/blank subject → MISSING_SUBJECT_ID failure audit
 *   (when audit options are supplied) + error page; no binding,
 *   no session. This is the GitHub missing-id rule, generalized.
 * - a missing/blank login key → error page; no binding, no session.
 * - a binding store failure → BINDING_FAILED failure audit + error
 *   page; no session.
 * On success the session carries the legacy fields from the
 * normalized profile plus the Slice 1/2 fields, exactly as the
 * GitHub wired flow did; post-login work and the success audit
 * are best-effort and never change the login outcome.
 */
export async function completeWiredLogin(
  env: Env,
  issuer: string,
  profile: NormalizedLoginProfile,
  options?: WiredLoginOptions
): Promise<Response> {
  const nowMs = options?.nowMs ?? Date.now();
  const store = options?.bindingStore ?? createWiredBindingStore(env);

  const subjectValid =
    typeof profile?.subject === "string" && profile.subject.trim() !== "";
  if (!subjectValid) {
    if (options?.auditStore && options.auditTenantId) {
      await recordWiredAuthAudit(
        options.auditStore,
        buildLoginFailureAuditEventInput({
          code: "MISSING_SUBJECT_ID",
          tenantId: options.auditTenantId,
          timestamp: nowMs,
          correlationId: crypto.randomUUID(),
        })
      );
    }
    return errorPage("Provider profile did not include a stable subject id; login cannot be bound", 400);
  }
  if (typeof profile?.loginKey !== "string" || profile.loginKey.trim() === "") {
    return errorPage("Provider profile did not include a usable login key; login cannot be bound", 400);
  }

  // #1182: migration always runs on wired login (default stores
  // are the SessionStore DO ones, the same store the binding and
  // post-login work use in production). The session below carries
  // the migrated (derived) id, and post-login bootstrap matching
  // sees it too — migration precedes provisioning by construction.
  const migrationDeps: MigrationDeps = options?.migration ?? {
    membershipStore: wiredMembershipStore(env),
    aliasKv: sessionStore(env),
  };
  const bindingResult = await resolveProviderBinding(
    store,
    issuer,
    profile.subject,
    nowMs,
    migrationDeps,
  );
  if (!bindingResult.ok) {
    if (options?.auditStore && options.auditTenantId) {
      await recordWiredAuthAudit(
        options.auditStore,
        buildLoginFailureAuditEventInput({
          code: bindingResult.code,
          tenantId: options.auditTenantId,
          timestamp: nowMs,
          correlationId: crypto.randomUUID(),
        })
      );
    }
    return errorPage(bindingResult.error, 400);
  }

  // #1210: one-time repair of the stranded Oct 22 platform-admin
  // grant, at the same point as normal binding migration (before
  // post-login bootstrap, so bootstrap observes the repaired state
  // as already-admin). Best-effort: the repair never throws, and
  // this catch is belt-and-braces — a repair failure must never
  // change the login outcome.
  try {
    const platformListed = await isPlatformBootstrapListed(
      store,
      env.IAAA_BOOTSTRAP_ADMINS,
      bindingResult.binding.internalUserId,
    );
    await repairStrandedPlatformAdmin({
      membershipStore: migrationDeps.membershipStore,
      isPlatformListed: platformListed,
      targetInternalUserId: bindingResult.binding.internalUserId,
      nowMs,
    });
  } catch {
    // Repair is best-effort; login proceeds regardless.
  }

  const sessionData = buildExtendedSessionData(
    {
      githubLogin: profile.loginKey,
      githubAvatar: profile.avatarUrl,
      githubName: profile.displayName,
      createdAt: nowMs,
    },
    bindingResult.binding,
    nowMs
  );

  // #2840: per-user concurrent-session cap (oldest-out),
  // enforced BEFORE the new session is created, so a login
  // can never silently push a user over the cap. A listing or
  // eviction failure fails the login visibly (the
  // session_limit_unavailable outcome + a failure audit) rather
  // than creating over the cap. Evictions are audited
  // best-effort and the isolate cache is invalidated per
  // evicted id, so an evicted session stops serving at once;
  // the #2836 panel shows it gone.
  try {
    const capResult = await enforceSessionCap({
      listEntries: () => listSessionFamilyEntries(env, ""),
      deleteSession: (id) => deleteSession(env, id),
      internalUserId: bindingResult.binding.internalUserId,
      cap: sessionCap(),
      nowMs,
      idleTimeoutMs: resolveIdleTimeoutMs(env.SESSION_IDLE_TIMEOUT_MS),
      onEvicted: async (evictedId) => {
        invalidateSessionCache(evictedId);
        if (options?.auditStore && options.auditTenantId) {
          await recordWiredAuthAudit(options.auditStore, {
            timestamp: nowMs,
            type: "auth.session",
            actorPrincipalId: bindingResult.binding.internalUserId,
            actorType: "human",
            initiatingPrincipalId: bindingResult.binding.internalUserId,
            tenantId: options.auditTenantId,
            correlationId: evictedId,
            action: "session.evicted",
            decision: "deny",
            policyVersion: IAAA_AUDIT_POLICY_VERSION,
            outcome: "succeeded",
          });
        }
      },
    });
    if (capResult.evictedSessionIds.length > 0) {
      console.warn(
        `[auth] session cap: evicted ${capResult.evictedSessionIds.length} oldest session(s) before a new login`,
      );
    }
  } catch (err) {
    if (options?.auditStore && options.auditTenantId && err instanceof SessionCapError) {
      await recordWiredAuthAudit(options.auditStore, {
        timestamp: nowMs,
        type: "auth.login",
        actorPrincipalId: bindingResult.binding.internalUserId,
        actorType: "human",
        initiatingPrincipalId: bindingResult.binding.internalUserId,
        tenantId: options.auditTenantId,
        correlationId: crypto.randomUUID(),
        action: "auth.login",
        decision: "deny",
        policyVersion: IAAA_AUDIT_POLICY_VERSION,
        outcome: "failed",
        errorCode: err.code,
      });
    }
    return errorOutcomePage(
      `session cap enforcement failed: ${err instanceof Error ? err.message : String(err)}`,
      "session_limit_unavailable",
    );
  }

  const sessionId = await createSession(env, sessionData);
  // End-to-end post-login work (best-effort; never changes the login
  // outcome): alias recording + bootstrap-on-login. A failure here
  // is swallowed by runWiredPostLogin itself; the outer catch is
  // belt-and-braces for store construction.
  if (options?.postLoginEnabled) {
    try {
      const kv = sessionStore(env);
      await runWiredPostLogin(
        {
          kv,
          bindingStore: store,
          membershipStore: wiredMembershipStore(env),
          // #1760: post-login alias/bootstrap/genesis audit events
          // use the same audit store as the login-success event
          // below, when the caller supplied one.
          audit: options?.auditStore
            ? { store: options.auditStore, correlationId: sessionId }
            : undefined,
        },
        {
          githubLogin: profile.loginKey,
          internalUserId: bindingResult.binding.internalUserId,
          providerIssuer: bindingResult.binding.providerIssuer,
          providerSubject: bindingResult.binding.providerSubject,
          bootstrapRaw: env.IAAA_BOOTSTRAP_ADMINS,
          tenantId: options.auditTenantId ?? resolveIaaaTenant(env),
          nowMs,
        },
      );
    } catch {
      // Post-login work must never fail a login.
    }
  }
  // #1274: automatic member provisioning — best-effort, never changes
  // the login outcome. Runs for EVERY wired login (GitHub and generic
  // OIDC alike) in this provider-agnostic tail, AFTER bootstrap, so a
  // bootstrap-granted tenant-admin is observed as already-member and
  // never duplicated or downgraded. A provisioning failure is
  // swallowed here: the session above is already created and the
  // caller keeps whatever memberships they already hold.
  try {
    await ensureTenantMember(migrationDeps.membershipStore, {
      internalUserId: bindingResult.binding.internalUserId,
      tenantId: options?.auditTenantId ?? resolveIaaaTenant(env),
      nowMs,
    });
  } catch {
    // Auto-provisioning must never fail a login.
  }
  // Phase 2a audit seam (best-effort; never changes the outcome).
  if (options?.auditStore && options.auditTenantId) {
    await recordWiredAuthAudit(
      options.auditStore,
      buildLoginSuccessAuditEventInput({
        internalUserId: bindingResult.binding.internalUserId,
        tenantId: options.auditTenantId,
        timestamp: nowMs,
        correlationId: sessionId,
      })
    );
  }
  // #2402: the success outcome travels on the redirect so the app
  // boot can show a one-time "Signed in as …" confirmation. The /
  // handler turns a just-created-but-unreadable session (the #2280
  // loop) into the session_unreadable login notice instead.
  // #3015: a validated return target replaces the default landing
  // (the outcome still travels on it, so the boot toast still
  // shows and the parameter is still stripped on boot); an absent
  // or invalid target keeps exactly the default landing above.
  // Issue #3113 (#945 Q5): mint the CSRF token cookie alongside the
  // session cookie at login — every post-login mutation needs it.
  const loginHeaders = new Headers({
    Location: buildPostLoginRedirect(options?.returnTarget ?? null),
  });
  loginHeaders.append("Set-Cookie", setSessionCookie(sessionId));
  loginHeaders.append("Set-Cookie", setCsrfCookie(crypto.randomUUID()));
  return new Response(null, {
    status: 302,
    headers: loginHeaders,
  });
}

/**
 * #2402: a wired-tail failure no longer strands the user on a bare
 * error page. It redirects to the login page carrying the generic
 * signin_failed outcome; the technical message and status go to the
 * server log only. Fail-closed semantics are unchanged: no session,
 * no binding. (The legacy callback's error-page shape is retired
 * with this change; its audit recording above is untouched.)
 */
function errorPage(message: string, status = 400): Response {
  console.warn(`[auth] sign-in failed (status ${status}): ${message}`);
  return new Response(null, {
    status: 302,
    headers: { Location: authOutcomeLoginUrl("signin_failed") },
  });
}

/**
 * #2840: a login failure with its own outcome code, for
 * failures whose cause the user can act on distinctly from a
 * generic sign-in failure (here: the session-cap check could
 * not run). The notice text stays static and internal-free
 * (the #2402 rule); the technical cause goes to the log and
 * the failure audit at the call site.
 */
function errorOutcomePage(message: string, code: AuthOutcomeCode): Response {
  console.warn(`[auth] sign-in failed (${code}): ${message}`);
  return new Response(null, {
    status: 302,
    headers: { Location: authOutcomeLoginUrl(code) },
  });
}
