/**
 * #6151 S4 — Drizzle D1 adapter for the admin-config store port.
 * This module is the ONLY place admin-config-store code touches a
 * store client: all SQL-adjacent code (the Drizzle query builder)
 * lives here, behind the port interface.
 *
 * Every operation is a single statement. The tenant-allowance cap
 * is enforced in setUserAllowlist (read the allowance, refuse an
 * exceeding write) — the same invariant the in-memory adapter
 * holds, so the two adapters never disagree about what a write
 * may do.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { asc, eq } from "drizzle-orm";
import { BusinessError } from "../outcomes/outcomeAspects";
import {
  agentNavPersonaDefaults,
  agentNavTenantAllowances,
  agentNavUserAllowlists,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0087_NAV_ADMIN_CONFIG,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertNavAdminId,
  assertPersonaPresetKey,
  normalizeNavIdList,
  type NavAdminConfigStore,
  type PersonaDefaultRecord,
  type TenantAllowanceRecord,
  type UserAllowlistRecord,
} from "./navAdminConfigPorts";

/** Drizzle D1 database object carrying the admin-config schema. */
export type NavAdminConfigDb = DrizzleD1Database<{
  agentNavTenantAllowances: typeof agentNavTenantAllowances;
  agentNavUserAllowlists: typeof agentNavUserAllowlists;
  agentNavPersonaDefaults: typeof agentNavPersonaDefaults;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1NavAdminConfigDb(d1: D1Database): NavAdminConfigDb {
  return createDrizzleD1Db(d1, {
    schema: {
      agentNavTenantAllowances,
      agentNavUserAllowlists,
      agentNavPersonaDefaults,
    },
  });
}

/** Idempotent schema-ensure: applies migration 0087 if unapplied. */
export async function ensureNavAdminConfigSchema(db: NavAdminConfigDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0087_NAV_ADMIN_CONFIG]);
}

/** A corrupt stored id list never breaks the nav — it reads as empty. */
function parseStoredIds(idsJson: string | null): string[] {
  if (idsJson === null) return [];
  try {
    const parsed: unknown = JSON.parse(idsJson);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function toAllowance(
  raw: typeof agentNavTenantAllowances.$inferSelect,
): TenantAllowanceRecord {
  return {
    tenantId: raw.tenantId,
    allowedIds: normalizeNavIdList(parseStoredIds(raw.allowedIdsJson)),
    updatedAtMs: raw.updatedAtMs,
    updatedBy: raw.updatedBy,
  };
}

function toAllowlist(
  raw: typeof agentNavUserAllowlists.$inferSelect,
): UserAllowlistRecord {
  return {
    userId: raw.userId,
    tenantId: raw.tenantId,
    allowedIds: normalizeNavIdList(parseStoredIds(raw.allowedIdsJson)),
    savedPresetsAllowed: raw.savedPresetsAllowed !== 0,
    updatedAtMs: raw.updatedAtMs,
    updatedBy: raw.updatedBy,
  };
}

function toPersonaDefault(
  raw: typeof agentNavPersonaDefaults.$inferSelect,
): PersonaDefaultRecord {
  return {
    persona: raw.persona as PersonaDefaultRecord["persona"],
    presetKey: raw.presetKey,
    updatedAtMs: raw.updatedAtMs,
    updatedBy: raw.updatedBy,
  };
}

export class D1NavAdminConfigAdapter implements NavAdminConfigStore {
  /** The Drizzle db (exposed so call sites can ensure the schema, the subscription-adapter idiom). */
  readonly db: NavAdminConfigDb;

  constructor(db: NavAdminConfigDb) {
    this.db = db;
  }

  async ensureSchema(): Promise<void> {
    await ensureNavAdminConfigSchema(this.db);
  }

  async getTenantAllowance(tenantId: string): Promise<TenantAllowanceRecord | null> {
    const rows = await this.db
      .select()
      .from(agentNavTenantAllowances)
      .where(eq(agentNavTenantAllowances.tenantId, tenantId))
      .limit(1);
    return rows.length === 0 ? null : toAllowance(rows[0]);
  }

  async setTenantAllowance(
    tenantId: string,
    allowedIds: string[],
    updatedBy: string,
  ): Promise<TenantAllowanceRecord> {
    const cleanTenant = assertNavAdminId(tenantId);
    const now = Date.now();
    const record: TenantAllowanceRecord = {
      tenantId: cleanTenant,
      allowedIds: normalizeNavIdList(allowedIds),
      updatedAtMs: now,
      updatedBy,
    };
    const existing = await this.getTenantAllowance(cleanTenant);
    if (existing) {
      await this.db
        .update(agentNavTenantAllowances)
        .set({
          allowedIdsJson: JSON.stringify(record.allowedIds),
          updatedAtMs: now,
          updatedBy,
        })
        .where(eq(agentNavTenantAllowances.tenantId, cleanTenant));
    } else {
      await this.db.insert(agentNavTenantAllowances).values({
        tenantId: record.tenantId,
        allowedIdsJson: JSON.stringify(record.allowedIds),
        updatedAtMs: now,
        updatedBy,
      });
    }
    return { ...record, allowedIds: [...record.allowedIds] };
  }

  async listTenantAllowances(): Promise<TenantAllowanceRecord[]> {
    const rows = await this.db
      .select()
      .from(agentNavTenantAllowances)
      .orderBy(asc(agentNavTenantAllowances.tenantId));
    return rows.map(toAllowance);
  }

  async getUserAllowlist(userId: string): Promise<UserAllowlistRecord | null> {
    const rows = await this.db
      .select()
      .from(agentNavUserAllowlists)
      .where(eq(agentNavUserAllowlists.userId, userId))
      .limit(1);
    return rows.length === 0 ? null : toAllowlist(rows[0]);
  }

  async setUserAllowlist(
    userId: string,
    input: {
      tenantId: string | null;
      allowedIds: string[];
      savedPresetsAllowed?: boolean;
    },
    updatedBy: string,
  ): Promise<UserAllowlistRecord> {
    const cleanUser = assertNavAdminId(userId);
    const allowedIds = normalizeNavIdList(input.allowedIds);
    // The cap: a tenant allowance, when present, is the ceiling —
    // a write whose ids exceed it is refused, never clipped.
    if (input.tenantId !== null) {
      const allowance = await this.getTenantAllowance(input.tenantId);
      if (allowance) {
        const allowed = new Set(allowance.allowedIds);
        if (allowedIds.some((id) => !allowed.has(id))) {
          throw new BusinessError("FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE");
        }
      }
    }
    const now = Date.now();
    const record: UserAllowlistRecord = {
      userId: cleanUser,
      tenantId: input.tenantId,
      allowedIds,
      savedPresetsAllowed: input.savedPresetsAllowed !== false,
      updatedAtMs: now,
      updatedBy,
    };
    const existing = await this.getUserAllowlist(cleanUser);
    if (existing) {
      await this.db
        .update(agentNavUserAllowlists)
        .set({
          tenantId: record.tenantId,
          allowedIdsJson: JSON.stringify(record.allowedIds),
          savedPresetsAllowed: record.savedPresetsAllowed ? 1 : 0,
          updatedAtMs: now,
          updatedBy,
        })
        .where(eq(agentNavUserAllowlists.userId, cleanUser));
    } else {
      await this.db.insert(agentNavUserAllowlists).values({
        userId: record.userId,
        tenantId: record.tenantId,
        allowedIdsJson: JSON.stringify(record.allowedIds),
        savedPresetsAllowed: record.savedPresetsAllowed ? 1 : 0,
        updatedAtMs: now,
        updatedBy,
      });
    }
    return { ...record, allowedIds: [...record.allowedIds] };
  }

  async listUserAllowlists(tenantId?: string): Promise<UserAllowlistRecord[]> {
    const rows =
      tenantId === undefined
        ? await this.db
            .select()
            .from(agentNavUserAllowlists)
            .orderBy(asc(agentNavUserAllowlists.userId))
        : await this.db
            .select()
            .from(agentNavUserAllowlists)
            .where(eq(agentNavUserAllowlists.tenantId, tenantId))
            .orderBy(asc(agentNavUserAllowlists.userId));
    return rows.map(toAllowlist);
  }

  async getPersonaDefault(
    persona: PersonaDefaultRecord["persona"],
  ): Promise<PersonaDefaultRecord | null> {
    const rows = await this.db
      .select()
      .from(agentNavPersonaDefaults)
      .where(eq(agentNavPersonaDefaults.persona, persona))
      .limit(1);
    return rows.length === 0 ? null : toPersonaDefault(rows[0]);
  }

  async setPersonaDefault(
    persona: PersonaDefaultRecord["persona"],
    presetKey: string,
    updatedBy: string,
  ): Promise<PersonaDefaultRecord> {
    const cleanKey = assertPersonaPresetKey(presetKey);
    const now = Date.now();
    const record: PersonaDefaultRecord = {
      persona,
      presetKey: cleanKey,
      updatedAtMs: now,
      updatedBy,
    };
    const existing = await this.getPersonaDefault(persona);
    if (existing) {
      await this.db
        .update(agentNavPersonaDefaults)
        .set({ presetKey: cleanKey, updatedAtMs: now, updatedBy })
        .where(eq(agentNavPersonaDefaults.persona, persona));
    } else {
      await this.db.insert(agentNavPersonaDefaults).values({
        persona,
        presetKey: cleanKey,
        updatedAtMs: now,
        updatedBy,
      });
    }
    return { ...record };
  }

  async deletePersonaDefault(
    persona: PersonaDefaultRecord["persona"],
  ): Promise<boolean> {
    const existing = await this.getPersonaDefault(persona);
    if (!existing) return false;
    await this.db
      .delete(agentNavPersonaDefaults)
      .where(eq(agentNavPersonaDefaults.persona, persona));
    return true;
  }

  async listPersonaDefaults(): Promise<PersonaDefaultRecord[]> {
    const rows = await this.db
      .select()
      .from(agentNavPersonaDefaults)
      .orderBy(asc(agentNavPersonaDefaults.persona));
    return rows.map(toPersonaDefault);
  }
}
