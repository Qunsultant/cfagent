/**
 * Phase 5 Slice 2 (issue #2000) — Drizzle D1 adapter for the
 * breaker state store port. This module is the ONLY place
 * breaker code touches a store client: all SQL-adjacent code
 * (the Drizzle query builder) lives here, behind the port.
 *
 * Transactions: every operation is a single statement, atomic
 * on any store (the migrationRunner note on drizzle-orm/d1
 * transaction semantics applies here too).
 *
 * Guarded claims (claimTripAlert) never rely on affected-row
 * counts — not portable across the D1 client and the
 * node:sqlite test stand-in. Each claim writes a caller token
 * under a NULL guard, then re-reads the row: the claim won
 * iff the stored token is the caller's (the slice-1 pattern).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, isNull } from "drizzle-orm";
import { agentBreakerState, breakerTripAlerts } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0034_BREAKER_STATE,
  type MigrationDb,
} from "./migrationRunner";
import type {
  BreakerPersistedState,
  BreakerStateStore,
} from "../breakers/breakerStateStorePorts";
import type { BreakerState } from "../breakers/breakerPorts";

/** Drizzle D1 database object carrying the breaker schema. */
export type BreakerStateStoreDb = DrizzleD1Database<{
  agentBreakerState: typeof agentBreakerState;
  breakerTripAlerts: typeof breakerTripAlerts;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1BreakerStateStoreDb(d1: D1Database): BreakerStateStoreDb {
  return drizzle(d1, {
    schema: {
      agentBreakerState,
      breakerTripAlerts,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0034 if
 * unapplied. No seeding: an empty store means no trips yet,
 * which is the normal state.
 */
export async function ensureBreakerStateSchema(db: BreakerStateStoreDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0034_BREAKER_STATE]);
}

function toState(row: typeof agentBreakerState.$inferSelect): BreakerPersistedState {
  return {
    providerId: row.providerId,
    state: row.state as BreakerState,
    consecutiveFailures: row.consecutiveFailures,
    openedAtMs: row.openedAtMs,
    lastFailureAtMs: row.lastFailureAtMs,
    totalCalls: row.totalCalls,
    totalSuccesses: row.totalSuccesses,
    totalFailures: row.totalFailures,
    totalTrips: row.totalTrips,
    totalFallbacks: row.totalFallbacks,
    totalRejected: row.totalRejected,
    transitionSeq: row.transitionSeq,
    updatedAtMs: row.updatedAtMs,
  };
}

/** Breaker state store over D1 via Drizzle. */
export class D1BreakerStateStoreAdapter implements BreakerStateStore {
  constructor(readonly db: BreakerStateStoreDb) {}

  async load(providerId: string): Promise<BreakerPersistedState | null> {
    const rows = await this.db
      .select()
      .from(agentBreakerState)
      .where(eq(agentBreakerState.providerId, providerId))
      .limit(1);
    return rows.length > 0 ? toState(rows[0]) : null;
  }

  async save(state: BreakerPersistedState): Promise<void> {
    await this.db
      .insert(agentBreakerState)
      .values({
        providerId: state.providerId,
        state: state.state,
        consecutiveFailures: state.consecutiveFailures,
        openedAtMs: state.openedAtMs,
        lastFailureAtMs: state.lastFailureAtMs,
        totalCalls: state.totalCalls,
        totalSuccesses: state.totalSuccesses,
        totalFailures: state.totalFailures,
        totalTrips: state.totalTrips,
        totalFallbacks: state.totalFallbacks,
        totalRejected: state.totalRejected,
        transitionSeq: state.transitionSeq,
        updatedAtMs: state.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentBreakerState.providerId,
        set: {
          state: state.state,
          consecutiveFailures: state.consecutiveFailures,
          openedAtMs: state.openedAtMs,
          lastFailureAtMs: state.lastFailureAtMs,
          totalCalls: state.totalCalls,
          totalSuccesses: state.totalSuccesses,
          totalFailures: state.totalFailures,
          totalTrips: state.totalTrips,
          totalFallbacks: state.totalFallbacks,
          totalRejected: state.totalRejected,
          transitionSeq: state.transitionSeq,
          updatedAtMs: state.updatedAtMs,
        },
      });
  }

  async claimTripAlert(transitionId: string, atMs: number, token: string): Promise<boolean> {
    await this.db
      .insert(breakerTripAlerts)
      .values({ transitionId, alertedAtMs: null, claimToken: null })
      .onConflictDoNothing();
    await this.db
      .update(breakerTripAlerts)
      .set({ alertedAtMs: atMs, claimToken: token })
      .where(
        and(
          eq(breakerTripAlerts.transitionId, transitionId),
          isNull(breakerTripAlerts.claimToken),
        ),
      );
    const rows = await this.db
      .select()
      .from(breakerTripAlerts)
      .where(eq(breakerTripAlerts.transitionId, transitionId))
      .limit(1);
    return rows.length > 0 && rows[0].claimToken === token;
  }
}
