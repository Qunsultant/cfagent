/**
 * #6151 S3 — Drizzle D1 adapter for the saved-preset store port.
 * This module is the ONLY place preset-store code touches a store
 * client: all SQL-adjacent code (the Drizzle query builder) lives
 * here, behind the port interface.
 *
 * Every operation is a single statement — except deletePreset,
 * which deletes the row and then clears a stale active pointer in
 * the state row. The pair is sequential, not batched: a crash
 * between the two leaves a state row pointing at a deleted preset,
 * and the read path heals that on its own (a missing active preset
 * falls back to the stored map / persona default), so no partial
 * state is ever visible.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, asc, eq } from "drizzle-orm";
import { BusinessError } from "../outcomes/outcomeAspects";
import { agentNavPresets, agentNavPresetState } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0085_NAV_PRESETS,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertPresetName,
  newNavPresetId,
  normalizePresetMap,
  type NavPresetRecord,
  type NavPresetStateRecord,
  type NavPresetStore,
} from "./navPresetPorts";

/** Drizzle D1 database object carrying the preset schema. */
export type NavPresetDb = DrizzleD1Database<{
  agentNavPresets: typeof agentNavPresets;
  agentNavPresetState: typeof agentNavPresetState;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1NavPresetDb(d1: D1Database): NavPresetDb {
  return createDrizzleD1Db(d1, {
    schema: {
      agentNavPresets,
      agentNavPresetState,
    },
  });
}

/** Idempotent schema-ensure: applies migration 0085 if unapplied. */
export async function ensureNavPresetSchema(db: NavPresetDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0085_NAV_PRESETS]);
}

/** A corrupt stored map never breaks the nav — it reads as empty. */
function parseStoredMap(mapJson: string | null): Record<string, boolean> {
  if (mapJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(mapJson);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function toPreset(raw: typeof agentNavPresets.$inferSelect): NavPresetRecord {
  return {
    id: raw.id,
    userId: raw.userId,
    name: raw.name,
    map: normalizePresetMap(parseStoredMap(raw.mapJson)),
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toState(raw: typeof agentNavPresetState.$inferSelect): NavPresetStateRecord {
  return {
    userId: raw.userId,
    activePresetId: raw.activePresetId,
    map: raw.mapJson === null ? null : normalizePresetMap(parseStoredMap(raw.mapJson)),
    updatedAtMs: raw.updatedAtMs,
  };
}

export class D1NavPresetAdapter implements NavPresetStore {
  /** The Drizzle db (exposed so call sites can ensure the schema, the subscription-adapter idiom). */
  readonly db: NavPresetDb;

  constructor(db: NavPresetDb) {
    this.db = db;
  }

  async ensureSchema(): Promise<void> {
    await ensureNavPresetSchema(this.db);
  }

  async listPresets(userId: string): Promise<NavPresetRecord[]> {
    const rows = await this.db
      .select()
      .from(agentNavPresets)
      .where(eq(agentNavPresets.userId, userId))
      .orderBy(asc(agentNavPresets.createdAtMs), asc(agentNavPresets.id));
    return rows.map(toPreset);
  }

  async getPreset(userId: string, id: string): Promise<NavPresetRecord | null> {
    const rows = await this.db
      .select()
      .from(agentNavPresets)
      .where(
        and(eq(agentNavPresets.id, id), eq(agentNavPresets.userId, userId)),
      )
      .limit(1);
    return rows.length === 0 ? null : toPreset(rows[0]);
  }

  async createPreset(
    userId: string,
    name: string,
    map: Record<string, boolean>,
  ): Promise<NavPresetRecord> {
    const cleanName = assertPresetName(name);
    const normalized = normalizePresetMap(map);
    const clash = await this.db
      .select()
      .from(agentNavPresets)
      .where(
        and(
          eq(agentNavPresets.userId, userId),
          eq(agentNavPresets.name, cleanName),
        ),
      )
      .limit(1);
    if (clash.length > 0) throw new BusinessError("FAILURE_NAV_PRESET_CONFLICT");
    const now = Date.now();
    const record: NavPresetRecord = {
      id: newNavPresetId(),
      userId,
      name: cleanName,
      map: normalized,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.db.insert(agentNavPresets).values({
      id: record.id,
      userId: record.userId,
      name: record.name,
      mapJson: JSON.stringify(record.map),
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    return record;
  }

  async renamePreset(userId: string, id: string, name: string): Promise<NavPresetRecord> {
    const cleanName = assertPresetName(name);
    const existing = await this.getPreset(userId, id);
    if (!existing) throw new BusinessError("FAILURE_NAV_PRESET_NOT_FOUND");
    if (existing.name !== cleanName) {
      const clash = await this.db
        .select()
        .from(agentNavPresets)
        .where(
          and(
            eq(agentNavPresets.userId, userId),
            eq(agentNavPresets.name, cleanName),
          ),
        )
        .limit(1);
      if (clash.length > 0) throw new BusinessError("FAILURE_NAV_PRESET_CONFLICT");
    }
    const now = Date.now();
    await this.db
      .update(agentNavPresets)
      .set({ name: cleanName, updatedAtMs: now })
      .where(
        and(eq(agentNavPresets.id, id), eq(agentNavPresets.userId, userId)),
      );
    return { ...existing, name: cleanName, updatedAtMs: now };
  }

  async deletePreset(userId: string, id: string): Promise<boolean> {
    const existing = await this.getPreset(userId, id);
    if (!existing) return false;
    await this.db
      .delete(agentNavPresets)
      .where(
        and(eq(agentNavPresets.id, id), eq(agentNavPresets.userId, userId)),
      );
    // Deleting the ACTIVE preset does not yank the user's current
    // tabs: the selection keeps the deleted preset's map as a
    // custom selection (activePresetId cleared). The read path
    // heals a stale pointer the same way if this second write
    // never lands.
    const state = await this.getState(userId);
    if (state && state.activePresetId === id) {
      await this.setState(userId, {
        activePresetId: null,
        map: existing.map,
      });
    }
    return true;
  }

  async getState(userId: string): Promise<NavPresetStateRecord | null> {
    const rows = await this.db
      .select()
      .from(agentNavPresetState)
      .where(eq(agentNavPresetState.userId, userId))
      .limit(1);
    return rows.length === 0 ? null : toState(rows[0]);
  }

  async setState(
    userId: string,
    state: { activePresetId: string | null; map: Record<string, boolean> | null },
  ): Promise<NavPresetStateRecord> {
    const now = Date.now();
    const normalized =
      state.map === null ? null : normalizePresetMap(state.map);
    const existing = await this.getState(userId);
    if (existing) {
      await this.db
        .update(agentNavPresetState)
        .set({
          activePresetId: state.activePresetId,
          mapJson: normalized === null ? null : JSON.stringify(normalized),
          updatedAtMs: now,
        })
        .where(eq(agentNavPresetState.userId, userId));
    } else {
      await this.db.insert(agentNavPresetState).values({
        userId,
        activePresetId: state.activePresetId,
        mapJson: normalized === null ? null : JSON.stringify(normalized),
        updatedAtMs: now,
      });
    }
    return {
      userId,
      activePresetId: state.activePresetId,
      map: normalized,
      updatedAtMs: now,
    };
  }
}
