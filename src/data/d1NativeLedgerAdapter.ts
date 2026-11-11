/**
 * Issue #2192 — Drizzle D1 adapter for the native ledger port.
 * This module is the ONLY place native-ledger code touches a
 * store client: all SQL-adjacent code (the Drizzle query
 * builder) lives here, behind the port interface (ADR 0002 R2).
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT), which is atomic on any store. No
 * multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1). The replay guard is a
 * read-before-write on (session_id, action), backed by the
 * UNIQUE index from migration 0012: a replayed record returns
 * the existing row without writing, and a racing second write
 * is swallowed by onConflictDoNothing and re-read.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { agentNativeLedgerRows } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0058_PRODUCT_VERSIONS,
  type MigrationDb,
} from "./migrationRunner";
import {
  buildNativeChargeTransaction,
  buildNativeCreditTransaction,
  nativeLedgerSessionId,
  type NativeLedgerPort,
  type NativeLedgerRow,
  type NativeLedgerRowInput,
} from "./nativeLedgerPorts";

/** Drizzle D1 database object carrying the native ledger schema. */
export type NativeLedgerDb = DrizzleD1Database<{
  agentNativeLedgerRows: typeof agentNativeLedgerRows;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1NativeLedgerDb(d1: D1Database): NativeLedgerDb {
  return drizzle(d1, {
    schema: {
      agentNativeLedgerRows,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0012 if
 * unapplied. Money paths ensure; read paths may skip ensure
 * when the caller already ensured. Issue #3289: 0058 adds the
 * per-charge recording columns to the ledger rows, so its
 * prerequisites (0007 accounts, 0008 plans, 0009 journal,
 * 0011 + 0027 catalogue) ride along.
 */
export async function ensureNativeLedgerSchema(db: NativeLedgerDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0058_PRODUCT_VERSIONS,
  ]);
}

function toRow(raw: typeof agentNativeLedgerRows.$inferSelect): NativeLedgerRow {
  return {
    id: raw.id,
    sessionId: raw.sessionId,
    action: raw.action as "charge" | "credit",
    amount: raw.amount,
    currency: raw.currency as "USD",
    customer: raw.customer,
    gateway: raw.gateway as "stripe" | "x402",
    gatewayRef: raw.gatewayRef,
    status: raw.status as "completed",
    checkoutUrl: raw.checkoutUrl,
    proposerDid: raw.proposerDid,
    proofSignature: raw.proofSignature,
    note: raw.note,
    tenantId: raw.tenantId,
    family: raw.family,
    runRequestId: raw.runRequestId,
    // Issue #3289: null on legacy rows (written before 0058).
    productId: raw.productId ?? null,
    versionId: raw.versionId ?? null,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toValues(row: NativeLedgerRow): typeof agentNativeLedgerRows.$inferInsert {
  return {
    id: row.id,
    sessionId: row.sessionId,
    action: row.action,
    amount: row.amount,
    currency: row.currency,
    customer: row.customer,
    gateway: row.gateway,
    gatewayRef: row.gatewayRef,
    status: row.status,
    checkoutUrl: row.checkoutUrl,
    proposerDid: row.proposerDid,
    proofSignature: row.proofSignature,
    note: row.note,
    tenantId: row.tenantId,
    family: row.family,
    runRequestId: row.runRequestId,
    productId: row.productId ?? null,
    versionId: row.versionId ?? null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

/** Native ledger over D1 via Drizzle. */
export class D1NativeLedgerAdapter implements NativeLedgerPort {
  constructor(readonly db: NativeLedgerDb) {}

  async recordRow(
    input: NativeLedgerRowInput,
  ): Promise<{ row: NativeLedgerRow; duplicate: boolean }> {
    const existing = await this.findRow(input.runRequestId, input.kind);
    if (existing) return { row: existing, duplicate: true };
    const built =
      input.kind === "charge"
        ? buildNativeChargeTransaction(input)
        : buildNativeCreditTransaction(input);
    await this.db
      .insert(agentNativeLedgerRows)
      .values(toValues(built))
      .onConflictDoNothing({
        target: [agentNativeLedgerRows.sessionId, agentNativeLedgerRows.action],
      });
    // A racing writer may have won the unique index; either way
    // exactly one row exists for (session, action) afterwards.
    const stored = await this.findRow(input.runRequestId, input.kind);
    if (!stored) throw new Error("native ledger: record write did not persist");
    return { row: stored, duplicate: stored.id !== built.id };
  }

  async findRow(
    runRequestId: string,
    kind: "charge" | "credit",
  ): Promise<NativeLedgerRow | undefined> {
    const rows = await this.db
      .select()
      .from(agentNativeLedgerRows)
      .where(
        and(
          eq(agentNativeLedgerRows.sessionId, nativeLedgerSessionId(runRequestId)),
          eq(agentNativeLedgerRows.action, kind),
        ),
      );
    return rows.length > 0 ? toRow(rows[0]) : undefined;
  }

  async listRowsForRun(runRequestId: string): Promise<NativeLedgerRow[]> {
    const rows = await this.db
      .select()
      .from(agentNativeLedgerRows)
      .where(eq(agentNativeLedgerRows.sessionId, nativeLedgerSessionId(runRequestId)))
      .orderBy(asc(agentNativeLedgerRows.createdAtMs), asc(agentNativeLedgerRows.id));
    return rows.map(toRow);
  }

  async listRowsForTenant(tenantId: string): Promise<NativeLedgerRow[]> {
    const rows = await this.db
      .select()
      .from(agentNativeLedgerRows)
      .where(eq(agentNativeLedgerRows.tenantId, tenantId))
      .orderBy(asc(agentNativeLedgerRows.createdAtMs), asc(agentNativeLedgerRows.id));
    return rows.map(toRow);
  }
}
