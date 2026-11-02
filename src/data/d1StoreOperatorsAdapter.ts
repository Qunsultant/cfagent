/**
 * Issue #2680 — Drizzle D1 adapter for the store operator
 * list port. This module is the ONLY place store-operator code
 * touches a store client: all SQL-adjacent code (the Drizzle
 * query builder) lives here, behind the port interface.
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT, one DELETE), which is atomic on any
 * store. No multi-statement transaction is used here, for the
 * reason recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { agentStoreOperators } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0032_STORE_OPERATORS,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertOperatorLogin,
  type StoreOperatorEntry,
  type StoreOperators,
} from "./storeOperatorsPorts";

/** Drizzle D1 database object carrying the store operators schema. */
export type StoreOperatorsDb = DrizzleD1Database<{
  agentStoreOperators: typeof agentStoreOperators;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1StoreOperatorsDb(d1: D1Database): StoreOperatorsDb {
  return drizzle(d1, {
    schema: {
      agentStoreOperators,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0032 if
 * unapplied. No seeding: unlike the price catalogue, there is
 * no default operator set — an empty store list plus an empty
 * env list means no operator at all, which is the fail-closed
 * state the gate already enforces (deny all).
 */
export async function ensureStoreOperatorsSchema(db: StoreOperatorsDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0032_STORE_OPERATORS]);
}

/** Store-managed operator list over D1 via Drizzle. */
export class D1StoreOperatorsAdapter implements StoreOperators {
  constructor(readonly db: StoreOperatorsDb) {}

  async listOperators(): Promise<StoreOperatorEntry[]> {
    const rows = await this.db
      .select()
      .from(agentStoreOperators)
      .orderBy(asc(agentStoreOperators.login));
    return rows.map((row) => ({
      login: row.login,
      addedBy: row.addedBy,
      addedAtMs: row.addedAtMs,
    }));
  }

  async addOperator(input: { login: unknown; addedBy: unknown }): Promise<StoreOperatorEntry> {
    const login = assertOperatorLogin(input.login);
    const addedBy = assertOperatorLogin(input.addedBy);
    const existing = await this.db
      .select()
      .from(agentStoreOperators)
      .where(eq(agentStoreOperators.login, login))
      .limit(1);
    // Idempotent: re-adding an existing store operator returns
    // the existing row unchanged — no duplicate row, no new
    // timestamp, no new audit claim from the port layer.
    if (existing.length > 0) {
      return { login: existing[0].login, addedBy: existing[0].addedBy, addedAtMs: existing[0].addedAtMs };
    }
    const record: StoreOperatorEntry = { login, addedBy, addedAtMs: Date.now() };
    await this.db.insert(agentStoreOperators).values(record);
    return record;
  }

  async removeOperator(input: { login: unknown }): Promise<boolean> {
    const login = assertOperatorLogin(input.login);
    // Existence-checked delete (not .returning()): the delete's
    // row count is not portable across the D1 client and the
    // node:sqlite test stand-in, and the existence read is what
    // the route's guards already re-check before calling here.
    const existing = await this.db
      .select()
      .from(agentStoreOperators)
      .where(eq(agentStoreOperators.login, login))
      .limit(1);
    if (existing.length === 0) return false;
    await this.db.delete(agentStoreOperators).where(eq(agentStoreOperators.login, login));
    return true;
  }
}
