/**
 * src/data/repositoryPorts.ts — #2345 (#1976 step 3a, ADR 0022
 * D-A/D-E): the generic repository port the ORM core's 13 tables
 * sit behind, plus the SqlStorage seam type whose canonical home
 * moves here from src/orm (the src/orm modules are §22 re-export
 * shims from this slice on).
 *
 * The contract is the legacy Repository surface, declared:
 *  - findMany/findById/findOne/count are pure reads;
 *  - create INSERTs and returns the passed record; its conflict
 *    policy is insert-or-throw — a primary-key conflict surfaces
 *    as the store's own error, never a silent overwrite (D-E.1);
 *  - update applies the non-id fields and returns the RE-READ
 *    row, or null when the row does not exist; adapters verify
 *    the write landed (D-E.2);
 *  - upsert is check-then-act (findById → update | create),
 *    correct under the per-instance serialization the DO
 *    residency provides (D-0 property (b));
 *  - delete returns true ONLY when a row was actually removed
 *    (D-E.2 — the pre-port implementation returned true
 *    unconditionally; see ormRepositoryCore.ts);
 *  - boolean record fields map to 0/1 columns named is_*.
 *
 * #4385 (#4282 P6b): three predicate extensions, both legs
 * (DO Repository + InMemoryRepository, ADR 0032 Decision 6's
 * "use the mini-ORM wherever possible"):
 *  - updateWhere applies a set to every row matching a
 *    predicate and returns the rows written (rowsWritten when
 *    the store reports it, else a verified count — D-E.2);
 *  - deleteWhere removes every row matching a predicate and
 *    returns the rows written (same two-path rule);
 *  - createOrIgnore INSERTs OR IGNOREs and returns whether a
 *    row was inserted (first-write-wins, the IvHistory shape).
 *  Where values may be plain scalars (equality) or a
 *  comparison-operator object ({ $lt, $lte, $gt, $gte }) —
 *  one operator language shared by findMany/count/
 *  updateWhere/deleteWhere, so the prune shape (created_at < ?)
 *  is a Repository call, not a template.
 *
 * #4386 (#4282 P6c): createOrReplace INSERTs OR REPLACEs the
 * full record and returns it — the draft-payment write
 * (TransactionLedgerPort.replace) as a first-class Repository
 * method, on both legs. The DO leg's INSERT column order is
 * the column map's (absent optional fields bind NULL, the
 * #3182 replace() semantics); the twin stores the record
 * as-is, so an absent field stays absent there — the one
 * disclosed leg difference, pinned by
 * tests/orm_repository_create_or_replace_4386.test.ts.
 *
 * #4751 (#4282 P6c follow-on): the where language gains `$or`
 * (an array of where objects, OR-joined) and `$like`
 * (case-insensitive LIKE), on both legs — one language for
 * findMany/count/updateWhere/deleteWhere, so the table
 * browser's search (lower(col) LIKE ? OR-joined across TEXT
 * columns) is a findMany-style call, not an inline SELECT.
 * findMany also gains a `raw` read option (storage rows
 * unmapped) for the browser, which must return exactly what
 * storage holds.
 *
 * Port modules import no store client (ADR 0022 D-B): this file
 * is types + the seam interface only.
 *
 * #CDO-mha7
 */

/** The Durable Object SqlStorage seam (exec-only surface). */
export interface SqlStorage {
  exec: (query: string, ...args: unknown[]) => Iterable<unknown>;
}

/**
 * A where value: a plain scalar (equality — the legacy shape) or a
 * comparison-operator object. The `$` prefix distinguishes an
 * operator object from a plain record value. Multiple operators on
 * one column combine with AND ({ $gte: a, $lt: b }). #4751: `$like`
 * is a case-insensitive LIKE — the DO leg emits
 * `lower(col) LIKE ?` with the pattern lowered at bind time, the
 * twin lowercases both sides.
 */
export type RepositoryWhereValue =
  | unknown
  | { $lt?: unknown; $lte?: unknown; $gt?: unknown; $gte?: unknown; $like?: unknown };

/**
 * A where predicate: a conjunction of per-column values. #4751: a
 * `$or` key holds an array of where objects, each a conjunction;
 * the groups are OR-joined (each group parenthesised, so the AND
 * with the other top-level conditions stays correct).
 */
export type RepositoryWhere = Record<string, RepositoryWhereValue> & {
  $or?: RepositoryWhere[];
};

/** Read options for repository finds (the legacy QueryOptions). */
export interface RepositoryQueryOptions {
  where?: RepositoryWhere;
  orderBy?: string;
  limit?: number;
  offset?: number;
  /**
   * #4751: return storage rows unmapped — no camelCase renaming
   * and no is_* boolean coercion. For raw reads (the table
   * browser), which must return exactly what storage holds. The
   * in-memory twin stores records as-is, so raw is a no-op there.
   */
  raw?: boolean;
}

/** The generic per-aggregate repository contract (ADR 0022 D-E). */
export interface RepositoryPort<T extends Record<string, any>> {
  readonly tableName: string;
  findMany(options?: RepositoryQueryOptions): T[];
  findById(id: string): T | null;
  findOne(where: RepositoryWhere): T | null;
  create(record: T): T;
  update(id: string, updates: Partial<T>): T | null;
  upsert(record: T): T;
  delete(id: string): boolean;
  count(where?: RepositoryWhere): number;
  /** #4385: UPDATE … SET … WHERE <predicate>; returns rows written. */
  updateWhere(where: RepositoryWhere, set: Partial<T>): number;
  /** #4385: DELETE … WHERE <predicate>; returns rows written. */
  deleteWhere(where: RepositoryWhere): number;
  /** #4385: INSERT OR IGNORE; true when a row was inserted. */
  createOrIgnore(record: T): boolean;
  /** #4386: INSERT OR REPLACE the full record; returns the record. */
  createOrReplace(record: T): T;
}
