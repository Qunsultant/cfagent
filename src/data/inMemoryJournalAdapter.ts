/**
 * Issue #2155 — in-memory journal.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate); the chart is seeded on construction.
 */
import {
  assertBalancedPost,
  journalEntryId,
  MINIMAL_CHART,
  type JournalAccount,
  type JournalEntry,
  type JournalEntryInput,
  type JournalPort,
} from "./journalPorts";
import { bindTenantScope, TenantScopeError } from "./tenantScope";

export class InMemoryJournalAdapter implements JournalPort {
  private entries = new Map<string, JournalEntry>();
  private accounts: JournalAccount[] = [...MINIMAL_CHART];

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
      // #1761: mirror the D1 adapter — the entry id is
      // tenant-blind, so overwriting another tenant's row here
      // would be the in-memory form of the same cross-tenant
      // clobber. Fail closed instead.
      const clash = this.entries.get(record.id);
      if (clash && clash.tenantId !== record.tenantId) {
        throw new TenantScopeError(
          `Journal post for transactionRef ${ref} collides with an entry posted under another tenant; refusing cross-tenant replay (issue #1761).`,
        );
      }
      this.entries.set(record.id, record);
      written.push(record);
    }
    return written;
  }

  async listEntries(tenantId: string): Promise<JournalEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) =>
        a.createdAtMs !== b.createdAtMs
          ? a.createdAtMs - b.createdAtMs
          : a.id < b.id
            ? -1
            : 1,
      );
  }

  async getEntriesByRef(
    transactionRef: string,
    tenantId: string,
  ): Promise<JournalEntry[]> {
    // #1761: tenant-scoped, mirroring the D1 adapter — a blank
    // tenant throws (fail closed) and a mismatched tenant reads empty.
    bindTenantScope(tenantId);
    return [...this.entries.values()]
      .filter((e) => e.transactionRef === transactionRef && e.tenantId === tenantId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async listAccounts(): Promise<JournalAccount[]> {
    return [...this.accounts].sort((a, b) => (a.code < b.code ? -1 : 1));
  }
}
