/**
 * Issue #3261 — user profile port (display name + phone + contact email).
 * Issue #5160 — the profile now also carries the full IDP attribute
 * set, per-tenant, with per-field provenance.
 *
 * One row per (internal user id, tenant): the user's display name,
 * phone number, and contact email, editable self-service from the
 * account flow (#3256), PLUS the sanitized IDP userinfo doc
 * captured at sign-in. Keyed by (internalUserId, tenantId) —
 * migration 0088 rebuilt the table (its old key was the login
 * alone, which cannot hold one row per tenant for the same user).
 * The login stays as a column (backfill + compat reads) but is
 * never the key: logins change and recycle, the internal id does
 * not.
 *
 * Storage home (decided, owner direction 2026-11-06): D1,
 * alongside account data — the `agent_user_profiles` table in the
 * same D1 database as the account rows (migration 0050; email
 * column added by migration 0068; IDP attributes + tenant key by
 * migration 0088). A dedicated table, not columns on the
 * commercial accounts row, so billing upserts (subscription
 * activation, refunds, referral earn) can never clobber profile
 * fields. Phone and email are UNVERIFIED contact fields: they are
 * never used for auth or recovery, and no verification is claimed
 * for them — verification is a follow-up, not this slice. Email is
 * a contact email ONLY: it never changes the login (the login IS
 * the verified identity — platformIdentity.ts carries no email).
 * The email column was added owner-directed 2026-11-16, the
 * CISO-review deferral lifted by explicit owner direction; no
 * CISO review happened and none is claimed.
 *
 * The three emails stay distinct: the IDP email (a provider-
 * verified identifying attribute, in idpAttributes.email), the
 * contact email (user-typed, unverified, the `email` column), and
 * the mail delivery address (#488, in the SessionStore DO — a
 * delivery preference, not identity).
 *
 * ADR 0002 port-first: domain code depends only on this interface.
 * Only the adapters (Drizzle D1, in-memory) touch a store, and
 * only the composition root (createProfilePorts.ts) maps a Worker
 * binding to an adapter. An absent row reads as null: no row means
 * the user never set a profile and never signed in with attributes
 * in this tenant, and callers fall back to the login as the display
 * name (PROPOSED default, display-only).
 *
 * Idempotent Receiver (standards §7.2): a save carries a client
 * idempotency key, and the key is recorded with the write in ONE
 * batch (D1) or one synchronous step (in-memory), so a replayed
 * key can never write a second row. The key table
 * (`agent_profile_idempotency_keys`, migration 0050) keys globally
 * by the key itself: a key seen for any login is a replay.
 * Retention: keys carry createdAtMs but have NO expiry/cleanup in
 * this slice — a cleanup window is a follow-up on #3261.
 *
 * Provenance (#5160): each stored field carries {source:
 * 'idp'|'user', updatedAtMs}. The three user-editable fields are
 * keyed by profile field name (displayName/phone/email); every
 * other IDP attribute is keyed by its own IDP name. A sign-in
 * refresh writes only IDP-sourced (or unset) fields; a user edit
 * marks its field 'user' and later sign-ins leave it alone. The
 * `displayName`/`phone`/`email` columns hold USER-EDITED values
 * only (NULL when never edited) — effective values are derived at
 * read (see src/services/userProfile.ts), never materialized
 * twice.
 */
import type { FieldProvenance } from "../security/idpAttributes";

export interface UserProfile {
  userLogin: string;
  /** Null when never set — callers display the login instead. */
  displayName: string | null;
  /** Null when never set. Unverified contact field, never auth. */
  phone: string | null;
  /**
   * Null when never set. Contact email only: it never changes the
   * login and is never used for auth or recovery. Unverified.
   */
  email: string | null;
  updatedAtMs: number;
  /**
   * #5160 — the internal user id (derived from (issuer, subject)).
   * Null for legacy rows written before migration 0088 that have
   * not been re-keyed by a sign-in yet.
   */
  internalUserId: string | null;
  /** #5160 — the tenant this row belongs to. Null on legacy rows. */
  tenantId: string | null;
  /** #5160 — the issuer the attributes came from (e.g. https://github.com). */
  idpIssuer: string | null;
  /** #5160 — the full sanitized IDP userinfo doc (JSON values only, never tokens). */
  idpAttributes: Record<string, unknown>;
  /** #5160 — per-field provenance: profile field name → source. */
  provenance: Record<string, FieldProvenance>;
  /** #5160 — when the IDP attributes were last refreshed, or null. */
  idpUpdatedAtMs: number | null;
}

/** Sign-in refresh input (#5160): the sanitized IDP doc + identity. */
export interface IdpRefreshInput {
  internalUserId: string;
  tenantId: string;
  userLogin: string;
  idpIssuer: string;
  attributes: Record<string, unknown>;
  nowMs: number;
}

/** Sign-in refresh result (#5160). */
export interface IdpRefreshResult {
  profile: UserProfile;
  /**
   * Profile field names whose user-owned value hid a different
   * provider value at this refresh (displayName/phone/email, or
   * an IDP key for non-profile fields). The caller audits these
   * and surfaces them as "From your provider" hints.
   */
  diverged: string[];
}

/** One lookup match (#5160): which identity, in which tenant, from which source. */
export interface AttributeMatch {
  internalUserId: string;
  tenantId: string;
  source: "idp" | "user";
}

export interface UserProfileStore {
  /**
   * #5160 — the row for (internalUserId, tenantId), or null when
   * the identity has no profile in this tenant.
   */
  getProfile(internalUserId: string, tenantId: string): Promise<UserProfile | null>;
  /**
   * #5160 — the row for a login in a tenant: resolves login → id
   * via the alias record, then the primary read; falls back to
   * the legacy login-keyed row (pre-0088, NULL keys) when the
   * identity has not been re-keyed yet. Backfill + admin compat.
   */
  getProfileByLogin(userLogin: string, tenantId: string): Promise<UserProfile | null>;
  /** #5160 — every tenant row for one identity (provisioning seed reads the home row). */
  getProfilesByInternalUserId(internalUserId: string): Promise<UserProfile[]>;
  /** Upsert the row for its (internalUserId, tenantId) and return it. */
  saveProfile(profile: UserProfile): Promise<UserProfile>;
  /**
   * Idempotent upsert: when the key was already recorded, nothing
   * is written and the result is a duplicate (replay → 409); the
   * profile is null in that case. Otherwise the row upsert and the
   * key record land atomically and the saved row is returned.
   * Exactly-once is NOT claimed from the key alone: the upsert is
   * keyed by (internalUserId, tenantId) (one row per identity +
   * tenant), so a re-execution can only converge to the same row,
   * never duplicate it.
   */
  saveProfileOnce(
    profile: UserProfile,
    idempotencyKey: string,
    createdAtMs: number,
  ): Promise<{ duplicate: boolean; profile: UserProfile | null }>;
  /**
   * #5160 — the sign-in refresh: upserts the (internalUserId,
   * tenantId) row applying IDP-sourced fields only where
   * provenance is 'idp' or unset; rewrites the lookup-index rows
   * for changed attributes in the same batch; re-keys a legacy
   * login row (same login, NULL keys) in place when one exists.
   * Returns the merged row + the diverged profile fields.
   */
  refreshFromIdp(input: IdpRefreshInput): Promise<IdpRefreshResult>;
  /**
   * #5160 — the "Sync from provider" reset: user-owned fields go
   * back to their IDP values (provenance 'idp'), user-cleared
   * fields are re-filled from the provider. Returns the row, or
   * null when the identity has no profile in this tenant.
   */
  syncFromProvider(
    internalUserId: string,
    tenantId: string,
    nowMs: number,
  ): Promise<UserProfile | null>;
  /**
   * #5160 — seed a second-tenant row at provisioning time from
   * the identity's home row: IDP-sourced fields ONLY, user edits
   * NEVER copy across tenants. Returns the seeded row.
   */
  seedTenantProfile(
    internalUserId: string,
    tenantId: string,
    userLogin: string,
    nowMs: number,
  ): Promise<UserProfile>;
  /**
   * #5160 — exact-match lookup within one tenant (tenantId null
   * = cross-tenant, platform-admin only; the caller scopes it).
   * Returns ALL matching identities in scope — never a silent
   * winner. The lookup normalizes the query value itself (email
   * case, phone formatting, phone country-code variants), so a
   * caller passes the value as typed.
   */
  lookupByAttribute(
    tenantId: string | null,
    attributeName: string,
    normalizedValue: string,
  ): Promise<AttributeMatch[]>;
  /**
   * #5160 — retention enforcement: deletes profile rows (and
   * their index rows) whose last IDP refresh predates cutoffMs
   * AND whose identity holds no live membership (the caller
   * supplies the liveness predicate — the port never reads
   * memberships itself). Returns how many rows were deleted.
   */
  purgeExpiredProfiles(input: {
    cutoffMs: number;
    hasLiveMembership: (internalUserId: string, tenantId: string) => Promise<boolean>;
  }): Promise<{ deleted: number }>;
}
