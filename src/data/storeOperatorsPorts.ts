/**
 * Issue #2680 — store-backed commercial operator list port.
 *
 * Operator status today gates on env COMMERCIAL_STORE_OPERATORS
 * alone (a deployment-time login list, empty = deny all). This
 * port moves the MANAGED list into the commercial store (D1)
 * while keeping env as a bootstrap fallback: the effective
 * operator set is env UNION store. The port module is the ADR
 * 0002 R1 boundary: it imports no store client, references no
 * env binding, and writes no SQL. Only the adapters (Drizzle
 * D1, in-memory) touch a store, and only the composition root
 * (createStoreOperatorsPorts.ts) maps a Worker binding to an
 * adapter.
 *
 * Fail-closed contract: a login is an operator only when it is
 * in the env list or in the store list. The store list is never
 * consulted when AGENT_DB is unbound (composition root returns
 * null) — the gate then behaves exactly as today, env-only.
 * Removal must never leave zero effective operators through
 * the UI; that guard lives in the route handler, which sees
 * both the env list and the store list, not in this port.
 */

/** A login is a non-empty trimmed string; blank approves nothing. */
export function assertOperatorLogin(login: unknown): string {
  if (typeof login !== "string" || login.trim().length === 0) {
    throw new Error("operator login must be a non-empty string.");
  }
  return login.trim();
}

/** Where an effective operator entry comes from. */
export type OperatorSource = "env" | "store";

/** One row of the store-managed operator list. */
export interface StoreOperatorEntry {
  login: string;
  addedBy: string;
  addedAtMs: number;
}

/** One row of the effective operator list as the UI reads it. */
export interface EffectiveOperatorEntry {
  login: string;
  source: OperatorSource;
  /** Store rows only; null for env-managed rows. */
  addedBy: string | null;
  /** Store rows only; null for env-managed rows. */
  addedAtMs: number | null;
}

/**
 * The store-managed operator list surface. `listOperators`
 * returns store rows only — the env list is NOT store data and
 * is merged by the caller (the route handler), which owns the
 * env binding. `addOperator` is idempotent: adding a login
 * that is already a store operator returns the existing row
 * unchanged (no duplicate row, no new timestamp). Removing a
 * login that is not a store operator returns false.
 */
export interface StoreOperators {
  listOperators(): Promise<StoreOperatorEntry[]>;
  addOperator(input: { login: unknown; addedBy: unknown }): Promise<StoreOperatorEntry>;
  removeOperator(input: { login: unknown }): Promise<boolean>;
}
