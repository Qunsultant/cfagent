/**
 * Issue #2680 — in-memory store operator list.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any
 * store at all. No migration concept applies here (there is no
 * SQL to migrate).
 *
 * Seeding: `initial` entries are stored exactly as given, so a
 * test can build a list with any operator set, including empty.
 */
import {
  assertOperatorLogin,
  type StoreOperatorEntry,
  type StoreOperators,
} from "./storeOperatorsPorts";

export class InMemoryStoreOperatorsAdapter implements StoreOperators {
  private operators = new Map<string, StoreOperatorEntry>();

  constructor(initial?: StoreOperatorEntry[]) {
    for (const entry of initial ?? []) {
      this.operators.set(assertOperatorLogin(entry.login), {
        login: assertOperatorLogin(entry.login),
        addedBy: assertOperatorLogin(entry.addedBy),
        addedAtMs: entry.addedAtMs,
      });
    }
  }

  async listOperators(): Promise<StoreOperatorEntry[]> {
    return [...this.operators.values()]
      .sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0))
      .map((entry) => ({ ...entry }));
  }

  async addOperator(input: { login: unknown; addedBy: unknown }): Promise<StoreOperatorEntry> {
    const login = assertOperatorLogin(input.login);
    const addedBy = assertOperatorLogin(input.addedBy);
    const existing = this.operators.get(login);
    if (existing) return { ...existing };
    const record: StoreOperatorEntry = { login, addedBy, addedAtMs: Date.now() };
    this.operators.set(login, record);
    return { ...record };
  }

  async removeOperator(input: { login: unknown }): Promise<boolean> {
    return this.operators.delete(assertOperatorLogin(input.login));
  }
}
