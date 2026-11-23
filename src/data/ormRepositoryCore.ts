/**
 * src/data/ormRepositoryCore.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A/D-B): the DO-SQLite repository implementation the
 * ORM core's ports run on, moved from src/orm/index.ts. Raw
 * SQL lives behind the ports (D-B dialect ruling: DO-SQLite
 * adapters speak SQL; nothing above this layer does).
 *
 * DISCLOSED D-E FIXES (ADR 0022 D-E.2 — silently-wrong cases
 * only; enumerated on the PR):
 *  1. delete() returned true UNCONDITIONALLY — a caller
 *     summing deletions (retention accounting) counted rows
 *     that were never removed. It now verifies: the cursor's
 *     rowsWritten when the store reports it, otherwise an
 *     existence probe + post-delete re-read.
 *  2. update() re-read the row but never verified the write
 *     landed — a no-op UPDATE returned the stale row as if
 *     updated. It now checks every applied field against the
 *     re-read row and throws on divergence rather than
 *     returning a row that does not carry the update.
 * create()'s conflict policy is declared, not changed
 * (D-E.1): INSERT-or-throw — a PK conflict surfaces as the
 * store's error. upsert stays check-then-act, correct under
 * per-instance serialization (D-0 (b)).
 *
 * #4385 (#4282 P6b): predicate extensions — updateWhere /
 * deleteWhere / createOrIgnore + the $lt/$lte/$gt/$gte
 * operator where (one language for findMany/count/
 * updateWhere/deleteWhere). RowsWritten-or-verified-count
 * returns, following D-E.2: a store that reports rowsWritten
 * answers directly; a store that does not is verified by
 * re-read, never by assumption.
 *
 * Everything else is byte-for-byte the legacy behaviour:
 * camelCase ↔ snake_case mapping with is_* boolean coercion,
 * findMany/findOne/count statement shapes, create returning
 * the passed record.
 *
 * #CDO-mha7
 */
import type { AuditEvent } from "../types";
import {
  linkAuditRow,
} from "../security/auditChain";
import { ensureAttributionEnvelopeColumns, ensureAuditChainColumns } from "./ormSchema";
import type {
  RepositoryPort,
  RepositoryQueryOptions,
  RepositoryWhere,
  SqlStorage,
} from "./repositoryPorts";

/** The legacy QueryOptions name, kept for the shim's callers. */
export type QueryOptions = RepositoryQueryOptions;

export class Repository<T extends Record<string, any>>
  implements RepositoryPort<T>
{
  constructor(
    protected sql: SqlStorage,
    public readonly tableName: string,
    protected idField: string = "id",
    protected columnMap: Record<keyof T & string, string>
  ) {}

  private toDbCol(key: string): string {
    return this.columnMap[key] || key;
  }

  /**
   * #4385: is this where value a comparison-operator object?
   * A plain object with at least one $lt/$lte/$gt/$gte key —
   * the `$` prefix is what distinguishes it from a plain
   * record value (which binds as equality, as before).
   * #4751: `$like` joins the operator set (case-insensitive LIKE).
   */
  private static isOperatorValue(val: unknown): val is {
    $lt?: unknown;
    $lte?: unknown;
    $gt?: unknown;
    $gte?: unknown;
    $like?: unknown;
  } {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
    const keys = Object.keys(val);
    return (
      keys.length > 0 &&
      keys.every((k) => k === "$lt" || k === "$lte" || k === "$gt" || k === "$gte" || k === "$like")
    );
  }

  /**
   * #4385: one where language for findMany/count/updateWhere/deleteWhere.
   * #4751: `$or` groups (each branch a conjunction, OR-joined as one
   * parenthesised clause) and `$like` (case-insensitive LIKE — the
   * column lowered by SQLite, the pattern lowered at bind time).
   * Each `$or` branch is built by the same group builder, so the
   * language is one language at every depth. An empty branch
   * contributes nothing (it is skipped); a malformed `$or`
   * (non-array, non-object branch) or a non-string `$like` throws
   * rather than binding a shape the store cannot honour.
   */
  private buildWhereGroup(where: RepositoryWhere): { clauses: string[]; args: unknown[] } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    const operators: Array<[string, string]> = [
      ["$lt", "<"],
      ["$lte", "<="],
      ["$gt", ">"],
      ["$gte", ">="],
    ];
    for (const [key, val] of Object.entries(where)) {
      if (val === undefined || val === null) continue;
      if (key === "$or") {
        if (!Array.isArray(val)) {
          throw new Error(
            `Repository where $or must be an array of where objects on ${this.tableName}`,
          );
        }
        const groups: string[] = [];
        for (const branch of val) {
          if (branch === null || typeof branch !== "object" || Array.isArray(branch)) {
            throw new Error(
              `Repository where $or branch must be a where object on ${this.tableName}`,
            );
          }
          const sub = this.buildWhereGroup(branch as RepositoryWhere);
          if (sub.clauses.length === 0) continue;
          groups.push(`(${sub.clauses.join(" AND ")})`);
          args.push(...sub.args);
        }
        if (groups.length > 0) clauses.push(`(${groups.join(" OR ")})`);
        continue;
      }
      const col = this.toDbCol(key);
      if (Repository.isOperatorValue(val)) {
        for (const [op, sqlOp] of operators) {
          const opVal = (val as Record<string, unknown>)[op];
          if (opVal === undefined || opVal === null) continue;
          clauses.push(`${col} ${sqlOp} ?`);
          args.push(typeof opVal === "boolean" ? (opVal ? 1 : 0) : opVal);
        }
        const likeVal = (val as Record<string, unknown>)["$like"];
        if (likeVal !== undefined && likeVal !== null) {
          if (typeof likeVal !== "string") {
            throw new Error(
              `Repository where $like pattern must be a string on ${this.tableName}.${key}`,
            );
          }
          // #4751: case-insensitive LIKE — the column is lowered
          // by SQLite, the pattern is lowered at bind time, so
          // the emitted shape is `lower(col) LIKE ?` (the shape
          // the pre-#4751 browse query used, and the shape the
          // test double understands). A pattern the caller already
          // lowered binds unchanged.
          clauses.push(`lower(${col}) LIKE ?`);
          args.push(likeVal.toLowerCase());
        }
        continue;
      }
      clauses.push(`${col} = ?`);
      args.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
    }
    return { clauses, args };
  }

  /** #4385: one where language for findMany/count/updateWhere/deleteWhere. */
  private buildWhereClause(where: RepositoryWhere): { clauses: string[]; args: unknown[] } {
    return this.buildWhereGroup(where);
  }

  /** #4385: drain a write cursor, returning its rowsWritten when reported. */
  private static rowsWrittenOf(cursor: Iterable<unknown>): number | null {
    Array.from(cursor);
    const rowsWritten = (cursor as { rowsWritten?: unknown }).rowsWritten;
    return typeof rowsWritten === "number" ? rowsWritten : null;
  }

  private fromDbRow(row: any): T {
    const obj: any = {};
    const reverseMap: Record<string, string> = {};
    for (const [prop, col] of Object.entries(this.columnMap)) {
      reverseMap[col] = prop;
    }

    for (const [key, val] of Object.entries(row)) {
      const propName = reverseMap[key] || key;
      // Handle boolean SQLite mapping (0/1 to boolean)
      if (typeof val === "number" && (key.startsWith("is_") || key === "is_active")) {
        obj[propName] = Boolean(val);
      } else {
        obj[propName] = val;
      }
    }
    return obj as T;
  }

  findMany(options: RepositoryQueryOptions = {}): T[] {
    const { clauses, args } = this.buildWhereClause(options.where ?? {});

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderClause = options.orderBy ? `ORDER BY ${options.orderBy}` : "";
    const limitClause = options.limit ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset ? `OFFSET ${options.offset}` : "";

    const query = `SELECT * FROM ${this.tableName} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim();
    const rows = Array.from(this.sql.exec(query, ...args)) as any[];
    // #4751: a raw read returns storage rows unmapped — the table
    // browser's contract (byte-identical to the inline SELECT it
    // replaces, including numeric is_* values the record mapping
    // would coerce to booleans).
    if (options.raw) return rows as T[];
    return rows.map((r) => this.fromDbRow(r));
  }

  findById(id: string): T | null {
    const query = `SELECT * FROM ${this.tableName} WHERE ${this.idField} = ? LIMIT 1`;
    const rows = Array.from(this.sql.exec(query, id)) as any[];
    if (rows.length === 0) return null;
    return this.fromDbRow(rows[0]);
  }

  findOne(where: RepositoryWhere): T | null {
    const results = this.findMany({ where, limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  /** #4385: the single INSERT shape — create(), createOrIgnore()
   *  and createOrReplace() differ only in the OR clause and, for
   *  OR REPLACE, in the column source (the map, not the record). */
  private insertRecord(
    record: T,
    mode: "insert" | "orIgnore" | "orReplace" = "insert",
  ): Iterable<unknown> {
    // #4386: OR REPLACE is a full-row replace — the column map
    // drives the columns (map order, absent fields bind NULL),
    // the legacy replace() semantics (#3182). Plain and OR IGNORE
    // keep the record's own keys, exactly as before.
    const props: string[] =
      mode === "orReplace"
        ? [
            ...Object.keys(this.columnMap),
            ...Object.keys(record).filter((k) => !(k in this.columnMap)),
          ]
        : Object.keys(record);
    const cols: string[] = [];
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (const prop of props) {
      const val = (record as Record<string, unknown>)[prop];
      cols.push(this.toDbCol(prop));
      placeholders.push("?");
      values.push(
        val === undefined && mode === "orReplace"
          ? null
          : typeof val === "boolean"
            ? val
              ? 1
              : 0
            : val,
      );
    }

    const orClause =
      mode === "orIgnore" ? " OR IGNORE" : mode === "orReplace" ? " OR REPLACE" : "";
    const query = `INSERT${orClause} INTO ${this.tableName} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    return this.sql.exec(query, ...values);
  }

  create(record: T): T {
    this.insertRecord(record);
    return record;
  }

  /**
   * #4385: INSERT OR IGNORE — first-write-wins. Returns true when a row
   * was inserted. RowsWritten when the store reports it; otherwise the
   * total-count delta (an ignored insert changes the count by 0, an
   * inserted row by exactly 1 — no key shape is assumed, so composite
   * keys work).
   */
  createOrIgnore(record: T): boolean {
    const before = this.count();
    const rowsWritten = Repository.rowsWrittenOf(this.insertRecord(record, "orIgnore"));
    if (rowsWritten !== null) return rowsWritten > 0;
    return this.count() - before > 0;
  }

  /**
   * #4386: INSERT OR REPLACE the full record — the draft-payment
   * write as a first-class Repository method. Returns the record.
   * The column map drives the INSERT (map order, absent optional
   * fields bind NULL), the legacy replace() semantics (#3182).
   */
  createOrReplace(record: T): T {
    this.insertRecord(record, "orReplace");
    return record;
  }

  /**
   * #4385: UPDATE … SET … WHERE <predicate>. Returns the rows
   * written — the number of matched rows VERIFIED to carry the
   * update. RowsWritten when the store reports it; otherwise each
   * matched row is re-read by id and counted only when it carries
   * every set field (D-E.2 — the count never claims a row the
   * write did not land on). A row that does not verify is NOT
   * counted, and the caller — not this method — decides whether
   * that is an error: the adapter keeps its own read-back
   * verification (e.g. StrategyProfile.verifyWrittenRow), whose
   * message the port's contract pins. Throwing here would mask
   * that message. A matched row with no idField value cannot be
   * re-read, so verification fails closed rather than assuming
   * the write landed.
   */
  updateWhere(where: RepositoryWhere, set: Partial<T>): number {
    const matched = this.findMany({ where });
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [prop, val] of Object.entries(set)) {
      if (prop !== this.idField && val !== undefined) {
        sets.push(`${this.toDbCol(prop)} = ?`);
        values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
      }
    }
    if (sets.length === 0) return 0;
    const { clauses, args } = this.buildWhereClause(where);
    if (clauses.length === 0) {
      throw new Error(
        `Repository.updateWhere refused on ${this.tableName}: an empty predicate would update every row`,
      );
    }
    const whereClause = `WHERE ${clauses.join(" AND ")}`;
    const query = `UPDATE ${this.tableName} SET ${sets.join(", ")} ${whereClause}`.trim();
    const rowsWritten = Repository.rowsWrittenOf(this.sql.exec(query, ...values, ...args));
    if (rowsWritten !== null) return rowsWritten;
    let verified = 0;
    for (const row of matched) {
      const id = (row as Record<string, unknown>)[this.idField];
      if (typeof id !== "string" && typeof id !== "number") {
        throw new Error(
          `Repository.updateWhere verification failed on ${this.tableName}: matched row has no ${this.idField} to re-read`,
        );
      }
      const after = this.findById(String(id));
      if (!after) continue;
      let carries = true;
      for (const [prop, val] of Object.entries(set)) {
        if (prop === this.idField || val === undefined) continue;
        if ((after as Record<string, unknown>)[prop] !== val) {
          carries = false;
          break;
        }
      }
      if (carries) verified++;
    }
    return verified;
  }

  /**
   * #4385: DELETE … WHERE <predicate>. Returns the rows written.
   * RowsWritten when the store reports it; otherwise the
   * before-count minus the after-count.
   */
  deleteWhere(where: RepositoryWhere): number {
    const before = this.count(where);
    const { clauses, args } = this.buildWhereClause(where);
    if (clauses.length === 0) {
      throw new Error(
        `Repository.deleteWhere refused on ${this.tableName}: an empty predicate would delete every row`,
      );
    }
    const whereClause = `WHERE ${clauses.join(" AND ")}`;
    const query = `DELETE FROM ${this.tableName} ${whereClause}`.trim();
    const rowsWritten = Repository.rowsWrittenOf(this.sql.exec(query, ...args));
    if (rowsWritten !== null) return rowsWritten;
    return before - this.count(where);
  }

  update(id: string, updates: Partial<T>): T | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [prop, val] of Object.entries(updates)) {
      if (prop !== this.idField && val !== undefined) {
        sets.push(`${this.toDbCol(prop)} = ?`);
        values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
      }
    }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const query = `UPDATE ${this.tableName} SET ${sets.join(", ")} WHERE ${this.idField} = ?`;
    this.sql.exec(query, ...values);
    const after = this.findById(id);
    if (!after) return null;
    // D-E.2 (disclosed fix #2345): verify the re-read row
    // carries every applied field — previously a no-op UPDATE
    // returned the stale row as if the write had landed.
    for (const [prop, val] of Object.entries(updates)) {
      if (prop === this.idField || val === undefined) continue;
      if ((after as Record<string, unknown>)[prop] !== val) {
        throw new Error(
          `Repository.update verification failed on ${this.tableName}: field ${prop} did not read back as written`
        );
      }
    }
    return after;
  }

  upsert(record: T): T {
    const id = record[this.idField];
    if (id && this.findById(id)) {
      this.update(id, record);
      return record;
    }
    return this.create(record);
  }

  delete(id: string): boolean {
    // D-E.2 (disclosed fix #2345): verify the removal —
    // previously this returned true unconditionally.
    const existed = this.findById(id) !== null;
    const query = `DELETE FROM ${this.tableName} WHERE ${this.idField} = ?`;
    const cursor = this.sql.exec(query, id) as Iterable<unknown> & {
      rowsWritten?: number;
    };
    Array.from(cursor);
    if (typeof cursor.rowsWritten === "number") {
      return cursor.rowsWritten > 0;
    }
    if (!existed) return false;
    return this.findById(id) === null;
  }

  count(where?: RepositoryWhere): number {
    const { clauses, args } = this.buildWhereClause(where ?? {});

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const query = `SELECT COUNT(*) AS count FROM ${this.tableName} ${whereClause}`;
    const raw = Array.from(this.sql.exec(query, ...args)) as Array<{ count: number }>;
    return Number(raw[0]?.count || 0);
  }
}

/**
 * Issue #2178 (Q7 S1): mas_events inserts chain. Every create links
 * onto the table's current tail (last row by insertion order) and
 * stores the link + own hash, so verification can detect tampering,
 * reordering, or a gap. The payload is stored as JSON text: direct
 * Record inserts previously coerced to "[object Object]" in some
 * paths, which is exactly what made payloads unreadable (#1968).
 * The chain step is synchronous (no await between the tail read and
 * the insert), so within one DO instance — mas_events is
 * per-instance storage — appends cannot interleave and fork.
 *
 * Moved unchanged in #2345 (gate G-5: the chain's shape, hash
 * inputs, and verification rules are frozen).
 */
export class ChainedAuditRepository extends Repository<AuditEvent> {
  override create(record: AuditEvent): AuditEvent {
    ensureAuditChainColumns(this.sql);
    // Issue #6100: envelope columns on pre-existing tables.
    ensureAttributionEnvelopeColumns(this.sql);
    const tail = Array.from(
      this.sql.exec(`SELECT event_hash FROM mas_events ORDER BY rowid DESC LIMIT 1`),
    ) as Array<{ event_hash?: string | null }>;
    const previousEventHash = tail[0]?.event_hash ?? null;
    const payloadText =
      typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload ?? {});
    // G-5 frozen: the hash input is exactly these six fields —
    // the envelope columns are NOT hashed, so adding them changes
    // neither the hash nor verification.
    const chained = linkAuditRow(
      {
        id: record.id,
        sessionId: record.sessionId,
        type: record.type,
        agent: record.agent,
        payload: payloadText,
        createdAt: record.createdAt,
      },
      previousEventHash,
    );
    return super.create({
      ...record,
      payload: payloadText as unknown as Record<string, unknown>,
      previousEventHash: chained.previousEventHash,
      eventHash: chained.eventHash,
      // Issue #6100: envelope dimensions bind explicitly — null when
      // unresolvable at the boundary, never undefined, never invented.
      platformId: record.platformId ?? null,
      tenantId: record.tenantId ?? null,
      principalId: record.principalId ?? null,
      correlationId: record.correlationId ?? null,
      traceId: record.traceId ?? null,
    });
  }
}
