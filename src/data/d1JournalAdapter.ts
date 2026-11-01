/**
 * Issue #2155 — Drizzle D1 adapter for the journal port. This
 * module is the ONLY place journal code touches a store client:
 * all SQL-adjacent code (the Drizzle query builder) lives here,
 * behind the port interface (ADR 0002 R2).
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT), which is atomic on any store. No
 * multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1). The replay guard is a
 * read-before-write on transactionRef: a replayed post returns
 * the existing entries without writing. A crash between the two
 * statements of one post leaves a partial set, which
 * reconcileJournal reports (never silently corrects).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import {
  bindTenantScope,
  tenantEq,
  TenantScopeError,
} from "./tenantScope";
import { agentJournalAccounts, agentJournalEntries } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0009_JOURNAL,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertBalancedPost,
  journalEntryId,
  MINIMAL_CHART,
  type JournalAccount,
  type JournalEntry,
  type JournalEntryInput,
  type JournalPort,
} from "./journalPorts";

/** Drizzle D1 database object carrying the journal schema. */
export type JournalDb = DrizzleD1Database<{
  agentJournalAccounts: typeof agentJournalAccounts;
  agentJournalEntries: typeof agentJournalEntries;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1JournalDb(d1: D1Database): JournalDb {
  return drizzle(d1, {
    schema: {
      agentJournalAccounts,
      agentJournalEntries,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0009 if unapplied,
 * then seeds the minimal chart (INSERT OR IGNORE — re-seeding is
 * a no-op). Money paths ensure; read paths may skip ensure when
 * the caller already ensured.
 */
export async function ensureJournalSchema(db: JournalDb): Promise<number[]> {
  const applied = await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0009_JOURNAL]);
  const now = Date.now();
  for (const account of MINIMAL_CHART) {
    await db
      .insert(agentJournalAccounts)
      .values({ code: account.code, name: account.name, type: account.type, createdAtMs: now })
      .onConflictDoNothing();
  }
  return applied;
}

function toEntry(raw: typeof agentJournalEntries.$inferSelect): JournalEntry {
  return {
    id: raw.id,
    transactionRef: raw.transactionRef,
    accountCode: raw.accountCode,
    debitUSD: raw.debitUSD,
    creditUSD: raw.creditUSD,
    currency: raw.currency,
    tenantId: raw.tenantId,
    runRequestId: raw.runRequestId,
    family: raw.family,
    createdAtMs: raw.createdAtMs,
  };
}

/** Journal over D1 via Drizzle. */
export class D1JournalAdapter implements JournalPort {
  constructor(readonly db: JournalDb) {}

  async postEntries(entries: JournalEntryInput[]): Promise<JournalEntry[]> {
    assertBalancedPost(entries);
    const ref = entries[0].transactionRef;
    // #1761: the idempotency probe is tenant-scoped — a replay in
    // another tenant must write, never inherit the first tenant's rows.
    const existing = await this.getEntriesByRef(ref, entries[0].tenantId);
    if (existing.length > 0) return existing;
    const now = Date.now();
    const written: JournalEntry[] = [];
    for (const e of entries) {
      const record: JournalEntry = {
        id: journalEntryId(e.transactionRef, e.accountCode),
        transactionRef: e.transactionRef,
        accountCode: e.accountCode,
        debitUSD: e.debitUSD,
        creditUSD: e.creditUSD,
        currency: e.currency,
        tenantId: e.tenantId,
        runRequestId: e.runRequestId,
        family: e.family,
        createdAtMs: now,
      };
      await this.db
        .insert(agentJournalEntries)
        .values({
          id: record.id,
          transactionRef: record.transactionRef,
          accountCode: record.accountCode,
          debitUSD: record.debitUSD,
          creditUSD: record.creditUSD,
          currency: record.currency,
          tenantId: record.tenantId,
          runRequestId: record.runRequestId,
          family: record.family,
          createdAtMs: record.createdAtMs,
        })
        .onConflictDoNothing();
      written.push(record);
    }
    // #1761: the entry id is tenant-blind (`ref:account`), so a
    // post under another tenant for an already-posted ref would
    // silently no-op on the id conflict and return phantom rows
    // that were never stored. Fail closed instead: if the scoped
    // re-read finds nothing the post landed, the ref belongs to
    // another tenant — throw rather than report a write that
    // did not happen (posting is best-effort upstream, so the
    // ledger write itself is unaffected).
    const landed = await this.getEntriesByRef(ref, entries[0].tenantId);
    if (landed.length === 0) {
      throw new TenantScopeError(
        `Journal post for transactionRef ${ref} did not land for tenant ${entries[0].tenantId}: the ref is already posted under another tenant; refusing cross-tenant replay (issue #1761).`,
      );
    }
    return written;
  }

  async listEntries(tenantId: string): Promise<JournalEntry[]> {
    const rows = await this.db
      .select()
      .from(agentJournalEntries)
      .where(eq(agentJournalEntries.tenantId, tenantId))
      .orderBy(asc(agentJournalEntries.createdAtMs), asc(agentJournalEntries.id));
    return rows.map(toEntry);
  }

  async getEntriesByRef(
    transactionRef: string,
    tenantId: string,
  ): Promise<JournalEntry[]> {
    // #1761: tenant-scoped via the bound scope — a blank tenant
    // throws (fail closed) and a mismatched tenant reads empty.
    const scope = bindTenantScope(tenantId);
    const rows = await this.db
      .select()
      .from(agentJournalEntries)
      .where(
        and(
          eq(agentJournalEntries.transactionRef, transactionRef),
          tenantEq(agentJournalEntries, scope),
        ),
      )
      .orderBy(asc(agentJournalEntries.id));
    return rows.map(toEntry);
  }

  async listAccounts(): Promise<JournalAccount[]> {
    const rows = await this.db
      .select()
      .from(agentJournalAccounts)
      .orderBy(asc(agentJournalAccounts.code));
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type as JournalAccount["type"],
    }));
  }
}
