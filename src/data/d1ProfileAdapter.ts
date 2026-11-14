/**
 * Issue #3261 — Drizzle D1 adapter for the user profile port.
 * This module is the ONLY place profile code touches a store
 * client: all SQL-adjacent code (the Drizzle query builder, plus
 * the raw-SQL batch for the idempotent write) lives here, behind
 * the port interface. A read never creates a row: an absent row
 * reads as null, and callers fall back to the login as the display
 * name.
 *
 * Atomicity (standards §7.2 Idempotent Receiver): the plain
 * saveProfile is a single Drizzle upsert; saveProfileOnce lands
 * the profile upsert AND the idempotency-key record in ONE
 * d1.batch (the d1ProposalLedgerAdapter precedent) — a batch
 * failure rolls both back, so a key is never recorded without its
 * write and a write never lands without its key.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { agentProfileIdempotencyKeys, agentUserProfiles } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0050_USER_PROFILES,
  type MigrationDb,
} from "./migrationRunner";
import type { UserProfile, UserProfileStore } from "./profilePorts";

/** Drizzle D1 database object carrying the user profile tables. */
export type ProfileDb = DrizzleD1Database<{
  agentUserProfiles: typeof agentUserProfiles;
  agentProfileIdempotencyKeys: typeof agentProfileIdempotencyKeys;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProfileDb(d1: D1Database): ProfileDb {
  return drizzle(d1, {
    schema: { agentUserProfiles, agentProfileIdempotencyKeys },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0050 (the
 * agent_user_profiles table + the agent_profile_idempotency_keys
 * table). Re-ensure is a no-op (idempotent creation plus
 * the migration marker), so a later ensure never overwrites a
 * stored profile.
 */
export async function ensureUserProfileSchema(db: ProfileDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0050_USER_PROFILES]);
}

function toProfile(row: typeof agentUserProfiles.$inferSelect): UserProfile {
  return {
    userLogin: row.userLogin,
    displayName: row.displayName,
    phone: row.phone,
    updatedAtMs: row.updatedAtMs,
  };
}

/** User profiles over D1 via Drizzle (+ raw-SQL batch for the idempotent write). */
export class D1ProfileAdapter implements UserProfileStore {
  constructor(
    readonly db: ProfileDb,
    private readonly d1: D1Database,
  ) {}

  async getProfile(userLogin: string): Promise<UserProfile | null> {
    const rows = await this.db
      .select()
      .from(agentUserProfiles)
      .where(eq(agentUserProfiles.userLogin, userLogin));
    if (rows.length === 0) return null;
    return toProfile(rows[0]);
  }

  async saveProfile(profile: UserProfile): Promise<UserProfile> {
    await this.db
      .insert(agentUserProfiles)
      .values({
        userLogin: profile.userLogin,
        displayName: profile.displayName,
        phone: profile.phone,
        updatedAtMs: profile.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentUserProfiles.userLogin,
        set: {
          displayName: profile.displayName,
          phone: profile.phone,
          updatedAtMs: profile.updatedAtMs,
        },
      });
    return { ...profile };
  }

  private async hasKey(idempotencyKey: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(agentProfileIdempotencyKeys)
      .where(eq(agentProfileIdempotencyKeys.idempotencyKey, idempotencyKey));
    return rows.length > 0;
  }

  async saveProfileOnce(
    profile: UserProfile,
    idempotencyKey: string,
    createdAtMs: number,
  ): Promise<{ duplicate: boolean; profile: UserProfile | null }> {
    if (await this.hasKey(idempotencyKey)) {
      return { duplicate: true, profile: null };
    }
    try {
      await this.d1.batch([
        this.d1
          .prepare(
            `INSERT INTO agent_user_profiles (user_login, display_name, phone, updated_at_ms) VALUES (?, ?, ?, ?) ` +
              `ON CONFLICT(user_login) DO UPDATE SET display_name = excluded.display_name, phone = excluded.phone, updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(profile.userLogin, profile.displayName, profile.phone, profile.updatedAtMs),
        this.d1
          .prepare(
            `INSERT INTO agent_profile_idempotency_keys (idempotency_key, user_login, created_at_ms) VALUES (?, ?, ?)`,
          )
          .bind(idempotencyKey, profile.userLogin, createdAtMs),
      ]);
    } catch (err) {
      // Race: another delivery recorded the key between the check
      // and the batch (the key PK refused the second insert). A
      // re-check separates that duplicate from a genuine store
      // failure — the failure re-throws for the coded 503, never a
      // parsed error string.
      if (await this.hasKey(idempotencyKey)) {
        return { duplicate: true, profile: null };
      }
      throw err;
    }
    return { duplicate: false, profile: { ...profile } };
  }
}
