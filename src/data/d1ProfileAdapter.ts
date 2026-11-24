/**
 * Issue #3261 — Drizzle D1 adapter for the user profile port.
 * Issue #5160 — extended to the (internalUserId, tenantId) key,
 * the IDP attribute set, provenance, lookup, and retention.
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
 * write and a write never lands without its key. The sign-in
 * refresh lands the row upsert, the legacy-row delete, and the
 * lookup-index rewrite in ONE batch as well.
 *
 * Legacy rows (pre-0088, NULL keys) are re-keyed in place by the
 * sign-in refresh: the refresh reads the login-keyed row, stamps
 * provenance 'user' on its non-null user columns (pre-0088 those
 * columns held user-saved values only), and writes it back under
 * the (internalUserId, tenantId) key.
 *
 * Lookup reads agent_identity_attribute_index, never a scan:
 * one row per (tenant, attribute, normalized value, identity).
 * When the user-typed value equals the IDP value for the same
 * attribute, only the 'idp' row is written — the provider-
 * verified claim is the stronger one, and the lookup returns a
 * single match.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import {
  agentIdentityAttributeIndex,
  agentProfileIdempotencyKeys,
  agentUserProfiles,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0050_USER_PROFILES,
  MIGRATION_0068_USER_PROFILE_EMAIL,
  MIGRATION_0088_IDP_ATTRIBUTES_PROFILE,
  type MigrationDb,
} from "./migrationRunner";
import type {
  AttributeMatch,
  IdpRefreshInput,
  IdpRefreshResult,
  UserProfile,
  UserProfileStore,
} from "./profilePorts";
import {
  lookupCandidates,
  normalizeLookupValue,
  refreshStoredProfile,
  type FieldProvenance,
} from "../security/idpAttributes";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDml } from "./schemaComponent/dmlExecutor";

/** Drizzle D1 database object carrying the user profile tables. */
export type ProfileDb = DrizzleD1Database<{
  agentUserProfiles: typeof agentUserProfiles;
  agentProfileIdempotencyKeys: typeof agentProfileIdempotencyKeys;
  agentIdentityAttributeIndex: typeof agentIdentityAttributeIndex;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProfileDb(d1: D1Database): ProfileDb {
  return createDrizzleD1Db(d1, {
    schema: { agentUserProfiles, agentProfileIdempotencyKeys, agentIdentityAttributeIndex },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0050 (the
 * agent_user_profiles table + the agent_profile_idempotency_keys
 * table), migration 0068 (the contact email column), and
 * migration 0088 (the (internal_user_id, tenant_id) rebuild +
 * the lookup-index table). Re-ensure is a no-op (idempotent
 * creation plus the migration marker), so a later ensure never
 * overwrites a stored profile.
 */
export async function ensureUserProfileSchema(db: ProfileDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0050_USER_PROFILES,
    MIGRATION_0068_USER_PROFILE_EMAIL,
    MIGRATION_0088_IDP_ATTRIBUTES_PROFILE,
  ]);
}

const PROFILE_FIELDS = ["displayName", "phone", "email"] as const;

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseProvenance(raw: string | null): Record<string, FieldProvenance> {
  const parsed = parseJsonObject(raw);
  const out: Record<string, FieldProvenance> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ((value as Record<string, unknown>).source === "idp" ||
        (value as Record<string, unknown>).source === "user") &&
      typeof (value as Record<string, unknown>).updatedAtMs === "number"
    ) {
      out[key] = value as FieldProvenance;
    }
  }
  return out;
}

function toProfile(row: typeof agentUserProfiles.$inferSelect): UserProfile {
  return {
    userLogin: row.userLogin,
    displayName: row.displayName,
    phone: row.phone,
    email: row.email,
    updatedAtMs: row.updatedAtMs,
    internalUserId: row.internalUserId,
    tenantId: row.tenantId,
    idpIssuer: row.idpIssuer,
    idpAttributes: parseJsonObject(row.idpAttributes),
    provenance: parseProvenance(row.provenance),
    idpUpdatedAtMs: row.idpUpdatedAtMs,
  };
}

function toRow(profile: UserProfile): typeof agentUserProfiles.$inferInsert {
  return {
    userLogin: profile.userLogin,
    displayName: profile.displayName,
    phone: profile.phone,
    email: profile.email,
    updatedAtMs: profile.updatedAtMs,
    internalUserId: profile.internalUserId,
    tenantId: profile.tenantId,
    idpIssuer: profile.idpIssuer,
    idpAttributes:
      Object.keys(profile.idpAttributes).length > 0
        ? JSON.stringify(profile.idpAttributes)
        : null,
    provenance:
      Object.keys(profile.provenance).length > 0 ? JSON.stringify(profile.provenance) : null,
    idpUpdatedAtMs: profile.idpUpdatedAtMs,
  };
}

/**
 * The lookup-index rows for one profile row: every top-level
 * string IDP attribute (source 'idp') plus the user-typed values
 * for the three profile fields (source 'user', mapped to their
 * IDP keys). An empty normalized value is never indexed. When a
 * user value equals the IDP value for the same attribute, only
 * the 'idp' row is written.
 */
function indexRowsFor(
  profile: UserProfile,
  nowMs: number,
): (typeof agentIdentityAttributeIndex.$inferInsert)[] {
  if (!profile.internalUserId || !profile.tenantId) return [];
  const rows: (typeof agentIdentityAttributeIndex.$inferInsert)[] = [];
  const idpNormalized = new Map<string, string>();
  for (const [name, value] of Object.entries(profile.idpAttributes)) {
    if (typeof value !== "string") continue;
    const normalized = normalizeLookupValue(name, value);
    if (!normalized) continue;
    idpNormalized.set(name, normalized);
    rows.push({
      tenantId: profile.tenantId,
      attributeName: name,
      attributeValueNormalized: normalized,
      internalUserId: profile.internalUserId,
      source: "idp",
      updatedAtMs: nowMs,
    });
  }
  for (const field of PROFILE_FIELDS) {
    const value = profile[field];
    if (typeof value !== "string") continue;
    const idpKey = field === "displayName" ? "name" : field === "phone" ? "phone_number" : "email";
    const normalized = normalizeLookupValue(idpKey, value);
    if (!normalized || idpNormalized.get(idpKey) === normalized) continue;
    rows.push({
      tenantId: profile.tenantId,
      attributeName: idpKey,
      attributeValueNormalized: normalized,
      internalUserId: profile.internalUserId,
      source: "user",
      updatedAtMs: nowMs,
    });
  }
  return rows;
}

/** User profiles over D1 via Drizzle (the idempotent write runs through the DML catalogue batch entry). */
export class D1ProfileAdapter implements UserProfileStore {
  constructor(readonly db: ProfileDb) {}

  async getProfile(internalUserId: string, tenantId: string): Promise<UserProfile | null> {
    const rows = await this.db
      .select()
      .from(agentUserProfiles)
      .where(
        and(
          eq(agentUserProfiles.internalUserId, internalUserId),
          eq(agentUserProfiles.tenantId, tenantId),
        ),
      );
    if (rows.length === 0) return null;
    return toProfile(rows[0]);
  }

  async getProfileByLogin(userLogin: string, tenantId: string): Promise<UserProfile | null> {
    const rows = await this.db
      .select()
      .from(agentUserProfiles)
      .where(eq(agentUserProfiles.userLogin, userLogin));
    if (rows.length === 0) return null;
    const keyed = rows.find((r) => r.tenantId === tenantId);
    if (keyed) return toProfile(keyed);
    // A keyed row exists in another tenant but not this one:
    // the identity has a profile, just not here — never show
    // another tenant's row as this tenant's.
    if (rows.some((r) => r.internalUserId !== null)) return null;
    const legacy = rows.find((r) => r.tenantId === null);
    return legacy ? toProfile(legacy) : null;
  }

  async getProfilesByInternalUserId(internalUserId: string): Promise<UserProfile[]> {
    const rows = await this.db
      .select()
      .from(agentUserProfiles)
      .where(eq(agentUserProfiles.internalUserId, internalUserId));
    return rows.map(toProfile);
  }

  async saveProfile(profile: UserProfile): Promise<UserProfile> {
    const row = toRow(profile);
    if (profile.internalUserId && profile.tenantId) {
      // The row upsert, the legacy-row delete, and the index
      // rewrite land in ONE batch: a batch failure rolls all
      // three back, so the row and its index can never disagree.
      // The set writes the FULL row (the save carries the merged
      // row the caller read first — see the DML entry's note).
      type BatchStatement = Parameters<ProfileDb["batch"]>[0][number];
      const statements: BatchStatement[] = [
        this.db
          .delete(agentUserProfiles)
          .where(
            and(
              eq(agentUserProfiles.userLogin, profile.userLogin),
              isNull(agentUserProfiles.internalUserId),
            ),
          ),
        this.db
          .insert(agentUserProfiles)
          .values(row)
          .onConflictDoUpdate({
            target: [agentUserProfiles.internalUserId, agentUserProfiles.tenantId],
            set: {
              userLogin: row.userLogin,
              displayName: row.displayName,
              phone: row.phone,
              email: row.email,
              updatedAtMs: row.updatedAtMs,
              idpIssuer: row.idpIssuer,
              idpAttributes: row.idpAttributes,
              provenance: row.provenance,
              idpUpdatedAtMs: row.idpUpdatedAtMs,
            },
          }),
        this.db
          .delete(agentIdentityAttributeIndex)
          .where(
            and(
              eq(agentIdentityAttributeIndex.tenantId, profile.tenantId),
              eq(agentIdentityAttributeIndex.internalUserId, profile.internalUserId),
            ),
          ),
      ];
      const indexRows = indexRowsFor(profile, profile.updatedAtMs);
      if (indexRows.length > 0) {
        statements.push(this.db.insert(agentIdentityAttributeIndex).values(indexRows));
      }
      await this.db.batch(statements as unknown as Parameters<ProfileDb["batch"]>[0]);
    } else {
      // A legacy (NULL-keyed) save replaces the legacy row for
      // the login — the delete runs first in the same batch, so
      // a second legacy save can never duplicate it.
      await this.db.batch([
        this.db
          .delete(agentUserProfiles)
          .where(
            and(
              eq(agentUserProfiles.userLogin, profile.userLogin),
              isNull(agentUserProfiles.internalUserId),
            ),
          ),
        this.db.insert(agentUserProfiles).values(row),
      ]);
    }
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
      await executeDml(DML_CATALOGUE, this.db, "dml.d1.agent_user_profiles.save_once", {
        values: toRow(profile),
        idempotencyKey,
        createdAtMs,
        indexRows: indexRowsFor(profile, createdAtMs),
      });
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

  async refreshFromIdp(input: IdpRefreshInput): Promise<IdpRefreshResult> {
    let row = await this.getProfile(input.internalUserId, input.tenantId);
    let rekeyedLegacy = false;
    if (!row) {
      const legacyRows = await this.db
        .select()
        .from(agentUserProfiles)
        .where(
          and(
            eq(agentUserProfiles.userLogin, input.userLogin),
            isNull(agentUserProfiles.internalUserId),
          ),
        );
      if (legacyRows.length > 0) {
        row = toProfile(legacyRows[0]);
        rekeyedLegacy = true;
        // Legacy columns hold user-saved values by definition
        // (pre-0088 nothing else ever wrote them): stamp them
        // 'user' so the refresh below cannot clobber them.
        for (const field of PROFILE_FIELDS) {
          if (row[field] !== null && !row.provenance[field]) {
            row.provenance[field] = { source: "user", updatedAtMs: row.updatedAtMs };
          }
        }
      }
    }
    if (!row) {
      row = {
        userLogin: input.userLogin,
        displayName: null,
        phone: null,
        email: null,
        updatedAtMs: input.nowMs,
        internalUserId: input.internalUserId,
        tenantId: input.tenantId,
        idpIssuer: input.idpIssuer,
        idpAttributes: {},
        provenance: {},
        idpUpdatedAtMs: null,
      };
    }
    const refreshed = refreshStoredProfile(row, input.attributes, input.nowMs);
    const next: UserProfile = {
      ...row,
      userLogin: input.userLogin,
      internalUserId: input.internalUserId,
      tenantId: input.tenantId,
      idpIssuer: input.idpIssuer,
      idpAttributes: refreshed.idpAttributes,
      provenance: refreshed.provenance,
      idpUpdatedAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    const diverged = refreshed.diverged;
    // The row upsert, the legacy-row delete, and the index
    // rewrite land in ONE batch: a batch failure rolls all three
    // back, so the row and its index can never disagree.
    type BatchStatement = Parameters<ProfileDb["batch"]>[0][number];
    const statements: BatchStatement[] = [];
    if (rekeyedLegacy) {
      statements.push(
        this.db
          .delete(agentUserProfiles)
          .where(
            and(
              eq(agentUserProfiles.userLogin, input.userLogin),
              isNull(agentUserProfiles.internalUserId),
            ),
          ),
      );
    }
    statements.push(
      this.db
        .delete(agentIdentityAttributeIndex)
        .where(
          and(
            eq(agentIdentityAttributeIndex.tenantId, input.tenantId),
            eq(agentIdentityAttributeIndex.internalUserId, input.internalUserId),
          ),
        ),
    );
    statements.push(
      this.db
        .insert(agentUserProfiles)
        .values(toRow(next))
        .onConflictDoUpdate({
          target: [agentUserProfiles.internalUserId, agentUserProfiles.tenantId],
          set: {
            userLogin: next.userLogin,
            displayName: next.displayName,
            phone: next.phone,
            email: next.email,
            updatedAtMs: next.updatedAtMs,
            idpIssuer: next.idpIssuer,
            idpAttributes:
              Object.keys(next.idpAttributes).length > 0
                ? JSON.stringify(next.idpAttributes)
                : null,
            provenance:
              Object.keys(next.provenance).length > 0 ? JSON.stringify(next.provenance) : null,
            idpUpdatedAtMs: next.idpUpdatedAtMs,
          },
        }),
    );
    const indexRows = indexRowsFor(next, input.nowMs);
    if (indexRows.length > 0) {
      statements.push(this.db.insert(agentIdentityAttributeIndex).values(indexRows));
    }
    await this.db.batch(statements as unknown as Parameters<ProfileDb["batch"]>[0]);
    return { profile: { ...next }, diverged };
  }

  async syncFromProvider(
    internalUserId: string,
    tenantId: string,
    nowMs: number,
  ): Promise<UserProfile | null> {
    const row = await this.getProfile(internalUserId, tenantId);
    if (!row) return null;
    const next: UserProfile = { ...row, updatedAtMs: nowMs };
    for (const field of PROFILE_FIELDS) {
      if (next.provenance[field]?.source === "user") {
        next[field] = null;
        next.provenance[field] = { source: "idp", updatedAtMs: nowMs };
      }
    }
    await this.saveProfile(next);
    return { ...next };
  }

  async seedTenantProfile(
    internalUserId: string,
    tenantId: string,
    userLogin: string,
    nowMs: number,
  ): Promise<UserProfile> {
    const existing = await this.getProfile(internalUserId, tenantId);
    if (existing) return existing;
    const home = (await this.getProfilesByInternalUserId(internalUserId)).find(
      (r) => Object.keys(r.idpAttributes).length > 0,
    );
    const seeded: UserProfile = {
      userLogin,
      displayName: null,
      phone: null,
      email: null,
      updatedAtMs: nowMs,
      internalUserId,
      tenantId,
      idpIssuer: home?.idpIssuer ?? null,
      idpAttributes: home ? JSON.parse(JSON.stringify(home.idpAttributes)) : {},
      provenance: home
        ? Object.fromEntries(
            Object.keys(home.idpAttributes).map((k) => [
              k,
              { source: "idp" as const, updatedAtMs: nowMs },
            ]),
          )
        : {},
      idpUpdatedAtMs: home?.idpUpdatedAtMs ?? null,
    };
    await this.saveProfile(seeded);
    return { ...seeded };
  }

  async lookupByAttribute(
    tenantId: string | null,
    attributeName: string,
    queryValue: string,
  ): Promise<AttributeMatch[]> {
    // The lookup normalizes the query value itself (a caller
    // passes the value as typed, not pre-normalized) and, for
    // phones, tries the country-code variants — a 10-digit query
    // matches a stored +1 number and vice versa.
    const candidates = lookupCandidates(
      attributeName,
      normalizeLookupValue(attributeName, queryValue),
    );
    const conditions = [
      eq(agentIdentityAttributeIndex.attributeName, attributeName),
      inArray(agentIdentityAttributeIndex.attributeValueNormalized, candidates),
    ];
    if (tenantId !== null) {
      conditions.push(eq(agentIdentityAttributeIndex.tenantId, tenantId));
    }
    const rows = await this.db
      .select()
      .from(agentIdentityAttributeIndex)
      .where(and(...conditions));
    return rows.map((r) => ({
      internalUserId: r.internalUserId,
      tenantId: r.tenantId,
      source: r.source as "idp" | "user",
    }));
  }

  async purgeExpiredProfiles(input: {
    cutoffMs: number;
    hasLiveMembership: (internalUserId: string, tenantId: string) => Promise<boolean>;
  }): Promise<{ deleted: number }> {
    // Stale = the effective last-touch (IDP refresh when present,
    // else the profile's own update) is before the cutoff. The
    // builder form below is exactly coalesce(idp_updated_at_ms,
    // updated_at_ms) < cutoff (updated_at_ms is NOT NULL); a raw
    // sql` template is forbidden here by the #4384 DML pin.
    const stale = await this.db
      .select()
      .from(agentUserProfiles)
      .where(
        or(
          and(
            isNotNull(agentUserProfiles.idpUpdatedAtMs),
            lt(agentUserProfiles.idpUpdatedAtMs, input.cutoffMs),
          ),
          and(
            isNull(agentUserProfiles.idpUpdatedAtMs),
            lt(agentUserProfiles.updatedAtMs, input.cutoffMs),
          ),
        ),
      );
    let deleted = 0;
    for (const row of stale) {
      if (!row.internalUserId || !row.tenantId) continue;
      if (await input.hasLiveMembership(row.internalUserId, row.tenantId)) continue;
      await this.db.batch([
        this.db
          .delete(agentIdentityAttributeIndex)
          .where(
            and(
              eq(agentIdentityAttributeIndex.tenantId, row.tenantId),
              eq(agentIdentityAttributeIndex.internalUserId, row.internalUserId),
            ),
          ),
        this.db
          .delete(agentUserProfiles)
          .where(
            and(
              eq(agentUserProfiles.internalUserId, row.internalUserId),
              eq(agentUserProfiles.tenantId, row.tenantId),
            ),
          ),
      ]);
      deleted += 1;
    }
    return { deleted };
  }
}
