/**
 * Issue #6072 (#4437 slice 6d-a) — the D1-resident screener task
 * ledger: `ScreenerTaskStore` over the `agent_screener_task_entries`
 * table (migration 0079). The goal composition's ledger claim /
 * complete steps write here, so a goal run's ledger survives a
 * workflow eviction — the DO-storage ledger (screener-agent
 * `taskStore()`) does not, its rows living in the evicted instance's
 * storage. Same key shape as the DO implementation (`screener:` +
 * the ledger key, so a row copied between the two stores keeps its
 * key); the `screener:` namespace is stripped on read, so callers
 * see exactly the keys they wrote. `set` upserts — the ledger
 * overwrites a record on every transition. Follows the
 * D1JobRunRecordStore pattern (drizzle D1 db + `applyMigrations`
 * ensure, lazily applied once per store).
 */
import { eq, like } from "drizzle-orm";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";
import { agentScreenerTaskEntries } from "./drizzleSchema";
import type { ScreenerTaskStore } from "../services/screenerTaskLedger";
import { createDrizzleD1Db } from "./d1QueryLogger";
import {
  applyMigrations,
  MIGRATION_0079_SCREENER_TASK_ENTRIES,
  type MigrationDb,
} from "./migrationRunner";

/** Drizzle D1 database object carrying the task-entries schema. */
export type ScreenerTaskStoreDb = DrizzleD1Database<{
  agentScreenerTaskEntries: typeof agentScreenerTaskEntries;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ScreenerTaskStoreDb(d1: D1Database): ScreenerTaskStoreDb {
  return createDrizzleD1Db(d1, { schema: { agentScreenerTaskEntries } });
}

/** Idempotent schema-ensure: applies migration 0079 if unapplied. */
export async function ensureScreenerTaskEntriesSchema(
  db: ScreenerTaskStoreDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0079_SCREENER_TASK_ENTRIES,
  ]);
}

/** The `screener:` namespace the DO-storage implementation prefixes with. */
const KEY_NAMESPACE = "screener:";

function namespaced(key: string): string {
  return key.startsWith(KEY_NAMESPACE) ? key : `${KEY_NAMESPACE}${key}`;
}

function denamespaced(key: string): string {
  return key.startsWith(KEY_NAMESPACE) ? key.slice(KEY_NAMESPACE.length) : key;
}

export class D1ScreenerTaskStore implements ScreenerTaskStore {
  private ensured: Promise<void> | null = null;

  constructor(private readonly db: ScreenerTaskStoreDb) {}

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureScreenerTaskEntriesSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  async get(key: string): Promise<string | null> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(agentScreenerTaskEntries)
      .where(eq(agentScreenerTaskEntries.key, namespaced(key)))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensure();
    await this.db
      .insert(agentScreenerTaskEntries)
      .values({ key: namespaced(key), value })
      .onConflictDoUpdate({
        target: agentScreenerTaskEntries.key,
        set: { value },
      });
  }

  async list(prefix: string): Promise<Array<{ key: string; value: string }>> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(agentScreenerTaskEntries)
      .where(like(agentScreenerTaskEntries.key, `${namespaced(prefix)}%`));
    return rows.map((row) => ({ key: denamespaced(row.key), value: row.value }));
  }

  async delete(key: string): Promise<void> {
    await this.ensure();
    await this.db
      .delete(agentScreenerTaskEntries)
      .where(eq(agentScreenerTaskEntries.key, namespaced(key)));
  }
}

/** Build a D1-backed task store from a bound D1 client. */
export function createD1ScreenerTaskStore(d1: AnyD1Database): D1ScreenerTaskStore {
  return new D1ScreenerTaskStore(createD1ScreenerTaskStoreDb(d1 as D1Database));
}
