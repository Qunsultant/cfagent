/**
 * Issue #3261 — in-memory user profile store.
 *
 * A test double with the same port semantics as the D1 adapter. It
 * is NOT a production store and NOT a second source of truth — it
 * exists so the port contract is testable without any store at all,
 * and so route tests can run without a D1 binding. A read never
 * materializes a row. saveProfileOnce mirrors the D1 batch
 * atomically (single-threaded: check + write + key record with no
 * await between them).
 */
import type { UserProfile, UserProfileStore } from "./profilePorts";

export class InMemoryProfileAdapter implements UserProfileStore {
  private rows = new Map<string, UserProfile>();
  private keys = new Set<string>();

  async getProfile(userLogin: string): Promise<UserProfile | null> {
    const row = this.rows.get(userLogin);
    return row ? { ...row } : null;
  }

  async saveProfile(profile: UserProfile): Promise<UserProfile> {
    const next = { ...profile };
    this.rows.set(profile.userLogin, next);
    return { ...next };
  }

  async saveProfileOnce(
    profile: UserProfile,
    idempotencyKey: string,
    _createdAtMs: number,
  ): Promise<{ duplicate: boolean; profile: UserProfile | null }> {
    if (this.keys.has(idempotencyKey)) {
      return { duplicate: true, profile: null };
    }
    const next = { ...profile };
    this.rows.set(profile.userLogin, next);
    this.keys.add(idempotencyKey);
    return { duplicate: false, profile: { ...next } };
  }
}
