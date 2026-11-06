/**
 * Issue #3261 — user profile port (display name + phone).
 *
 * One row per verified login: the user's display name and phone
 * number, editable self-service from the account flow (#3256).
 * Keyed by login, never by a client-supplied tenant — no tenantId
 * is stored here at all; the tenant is derivable from the resolved
 * platform identity (#2219) and is never a scoping input.
 *
 * Storage home (decided, owner direction 2026-11-06): D1,
 * alongside account data — the `agent_user_profiles` table in the
 * same D1 database as the account rows (migration 0050). A
 * dedicated table, not columns on the commercial accounts row, so
 * billing upserts (subscription activation, refunds, referral
 * earn) can never clobber profile fields. Phone is an UNVERIFIED
 * contact field: it is never used for auth or recovery, and no
 * verification is claimed for it — verification is a follow-up,
 * not this slice. Email is NOT a field here: email change touches
 * IAAA / session / auth and needs CISO review first (#3261 comment
 * 6681436382, refs #945); until that review lands, email is
 * explicitly deferred and no email route exists.
 *
 * ADR 0002 port-first: domain code depends only on this interface.
 * Only the adapters (Drizzle D1, in-memory) touch a store, and
 * only the composition root (createProfilePorts.ts) maps a Worker
 * binding to an adapter. An absent row reads as null: no row means
 * the user never set a profile, and callers fall back to the login
 * as the display name (PROPOSED default, display-only).
 *
 * Idempotent Receiver (standards §7.2): a save carries a client
 * idempotency key, and the key is recorded with the write in ONE
 * batch (D1) or one synchronous step (in-memory), so a replayed
 * key can never write a second row. The key table
 * (`agent_profile_idempotency_keys`, migration 0050) keys globally
 * by the key itself: a key seen for any login is a replay.
 * Retention: keys carry createdAtMs but have NO expiry/cleanup in
 * this slice — a cleanup window is a follow-up on #3261.
 */
export interface UserProfile {
  userLogin: string;
  /** Null when never set — callers display the login instead. */
  displayName: string | null;
  /** Null when never set. Unverified contact field, never auth. */
  phone: string | null;
  updatedAtMs: number;
}

export interface UserProfileStore {
  /** The row for a login, or null when the user never set a profile. */
  getProfile(userLogin: string): Promise<UserProfile | null>;
  /** Upsert the row for its login and return it. */
  saveProfile(profile: UserProfile): Promise<UserProfile>;
  /**
   * Idempotent upsert: when the key was already recorded, nothing
   * is written and the result is a duplicate (replay → 409); the
   * profile is null in that case. Otherwise the row upsert and the
   * key record land atomically and the saved row is returned.
   * Exactly-once is NOT claimed from the key alone: the upsert is
   * keyed by login (one row per login), so a re-execution can only
   * converge to the same row, never duplicate it.
   */
  saveProfileOnce(
    profile: UserProfile,
    idempotencyKey: string,
    createdAtMs: number,
  ): Promise<{ duplicate: boolean; profile: UserProfile | null }>;
}
