/**
 * src/data/inMemoryOrmAdapters.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A): the in-memory adapters for the ORM core's
 * DO-resident ports — the conformance twin every port is
 * proven against alongside the DO-SQLite adapter. Semantics
 * mirror the repository core exactly, including the D-E
 * rules: create throws on a PK conflict, update returns the
 * re-read row or null, delete returns true only when a row
 * was removed. Rows are stored as record objects keyed by
 * the port's id field; where/orderBy/limit apply in JS with
 * the same equality + raw-order-string semantics (the order
 * strings used against these ports are `<column> ASC|DESC`
 * forms over record fields or their snake_case columns —
 * both spellings resolve).
 *
 * #CDO-mha7
 */
import type {
  AuditEvent,
  MemoryRecord,
  MessageRecord,
  TransactionRecord,
} from "../types";
import { linkAuditRow } from "../security/auditChain";
import type { CanonicalReportRecord } from "./canonicalReportPorts";
import type { EventLogPort } from "./eventLogPorts";
import type { MemoryPort } from "./memoryPorts";
import type { MessagePort } from "./messagePorts";
import type {
  RepositoryPort,
  RepositoryQueryOptions,
  RepositoryWhere,
} from "./repositoryPorts";
import type {
  SettingsPort,
  SettingsReadPort,
} from "./settingsReadPorts";
import type {
  TransactionCompletionFields,
  TransactionLedgerPort,
  TransactionRejectionFields,
} from "./transactionLedgerPorts";

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export class InMemoryRepository<T extends Record<string, any>>
  implements RepositoryPort<T>
{
  protected rows = new Map<string, T>();

  constructor(
    public readonly tableName: string,
    protected idField: string = "id",
  ) {}

  protected fieldOf(row: T, key: string): unknown {
    if (key in row) return row[key];
    // Accept snake_case spellings of camelCase record fields.
    for (const prop of Object.keys(row)) {
      if (toSnake(prop) === key) return row[prop];
    }
    return undefined;
  }

  /**
   * #4385: one comparison for the operator where — numbers
   * numerically, everything else as strings (mirrors the mock
   * storage's comparator and SQLite TEXT ordering for ISO
   * timestamps). Shared by findMany/count/updateWhere/
   * deleteWhere so both legs agree on the same predicate.
   */
  private static compareForOperator(a: unknown, b: unknown): number {
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
    const as = String(a ?? "");
    const bs = String(b ?? "");
    return as < bs ? -1 : as > bs ? 1 : 0;
  }

  /** #4385: does one row satisfy one where value (equality or operator object)? */
  private matchesValue(fieldVal: unknown, val: unknown): boolean {
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      return fieldVal === val;
    }
    const ops = val as Record<string, unknown>;
    const hasOp = ["$lt", "$lte", "$gt", "$gte"].some((k) => k in ops);
    if (!hasOp) return fieldVal === val;
    for (const [op, bound] of Object.entries(ops)) {
      if (bound === undefined || bound === null) continue;
      const cmp = InMemoryRepository.compareForOperator(fieldVal, bound);
      if (op === "$lt" && !(cmp < 0)) return false;
      if (op === "$lte" && !(cmp <= 0)) return false;
      if (op === "$gt" && !(cmp > 0)) return false;
      if (op === "$gte" && !(cmp >= 0)) return false;
    }
    return true;
  }

  /** #4385: the shared where predicate — a conjunction of per-column values. */
  protected matchesWhere(row: T, where: RepositoryWhere): boolean {
    for (const [key, val] of Object.entries(where)) {
      if (val === undefined || val === null) continue;
      if (!this.matchesValue(this.fieldOf(row, key), val)) return false;
    }
    return true;
  }

  findMany(options: RepositoryQueryOptions = {}): T[] {
    let out = Array.from(this.rows.values());
    if (options.where) {
      out = out.filter((r) => this.matchesWhere(r, options.where!));
    }
    if (options.orderBy) {
      const parts = options.orderBy.split(",").map((p) => p.trim());
      out = [...out].sort((a, b) => {
        for (const part of parts) {
          const [col, dir] = part.split(/\s+/);
          const av = this.fieldOf(a, col);
          const bv = this.fieldOf(b, col);
          if (av === bv) continue;
          const cmp = String(av ?? "") < String(bv ?? "") ? -1 : 1;
          return dir?.toUpperCase() === "DESC" ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (options.offset) out = out.slice(options.offset);
    if (options.limit) out = out.slice(0, options.limit);
    return out.map((r) => ({ ...r }));
  }

  findById(id: string): T | null {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  findOne(where: RepositoryWhere): T | null {
    const results = this.findMany({ where, limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  create(record: T): T {
    const id = String(record[this.idField]);
    if (this.rows.has(id)) {
      throw new Error(`UNIQUE constraint failed: ${this.tableName}.${this.idField}`);
    }
    this.rows.set(id, { ...record });
    return record;
  }

  /**
   * #4385: INSERT OR IGNORE — first-write-wins on the idField.
   * The twin keys rows by idField only, so the conflict it can
   * see is the idField's; the DO leg's OR IGNORE covers every
   * unique constraint (including composite keys) — the two agree
   * on the idField-keyed shape the conformance suite pins.
   */
  createOrIgnore(record: T): boolean {
    const id = String(record[this.idField]);
    if (this.rows.has(id)) return false;
    this.rows.set(id, { ...record });
    return true;
  }

  update(id: string, updates: Partial<T>): T | null {
    const existing = this.rows.get(id);
    if (!existing) {
      // Mirror the SQL path: an UPDATE over a missing row is a
      // no-op whose re-read is null — unless there is nothing
      // to apply, in which case the re-read still rules.
      return null;
    }
    const next = { ...existing };
    for (const [prop, val] of Object.entries(updates)) {
      if (prop !== this.idField && val !== undefined) {
        (next as Record<string, unknown>)[prop] = val;
      }
    }
    this.rows.set(id, next);
    return { ...next };
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
    return this.rows.delete(id);
  }

  /**
   * #4385: does this where carry an effective predicate — a plain
   * non-null value, or an operator object with at least one non-null
   * operator? Mirrors the DO leg's clause builder: a where whose
   * values all skip produces no clause, and an empty clause set is
   * refused by updateWhere/deleteWhere on both legs.
   */
  private static hasEffectivePredicate(where: RepositoryWhere): boolean {
    for (const val of Object.values(where)) {
      if (val === undefined || val === null) continue;
      if (typeof val === "object" && !Array.isArray(val)) {
        const ops = val as Record<string, unknown>;
        const hasOp = ["$lt", "$lte", "$gt", "$gte"].some(
          (k) => k in ops && ops[k] !== undefined && ops[k] !== null,
        );
        if (hasOp) return true;
        // A plain object with no operator key binds as equality.
        if (!["$lt", "$lte", "$gt", "$gte"].some((k) => k in ops)) return true;
        continue;
      }
      return true;
    }
    return false;
  }

  /** #4385: UPDATE … WHERE <predicate>; returns the rows written. */
  updateWhere(where: RepositoryWhere, set: Partial<T>): number {
    // An empty predicate would update every row — refuse, exactly
    // like the DO leg.
    if (!InMemoryRepository.hasEffectivePredicate(where)) {
      throw new Error(
        `InMemoryRepository.updateWhere refused on ${this.tableName}: an empty predicate would update every row`,
      );
    }
    const matched = Array.from(this.rows.values()).filter((r) => this.matchesWhere(r, where));
    if (matched.length === 0) return 0;
    const hasSet = Object.entries(set).some(
      ([prop, val]) => prop !== this.idField && val !== undefined,
    );
    if (!hasSet) return 0;
    for (const row of matched) {
      const id = String(row[this.idField]);
      const next = { ...row };
      for (const [prop, val] of Object.entries(set)) {
        if (prop !== this.idField && val !== undefined) {
          (next as Record<string, unknown>)[prop] = val;
        }
      }
      this.rows.set(id, next);
    }
    return matched.length;
  }

  /** #4385: DELETE … WHERE <predicate>; returns the rows written. */
  deleteWhere(where: RepositoryWhere): number {
    // An empty predicate would delete every row — refuse, exactly
    // like the DO leg.
    if (!InMemoryRepository.hasEffectivePredicate(where)) {
      throw new Error(
        `InMemoryRepository.deleteWhere refused on ${this.tableName}: an empty predicate would delete every row`,
      );
    }
    let removed = 0;
    for (const [id, row] of Array.from(this.rows.entries())) {
      if (this.matchesWhere(row, where)) {
        this.rows.delete(id);
        removed++;
      }
    }
    return removed;
  }

  count(where?: RepositoryWhere): number {
    return this.findMany({ where }).length;
  }
}

export class InMemoryMessageAdapter
  extends InMemoryRepository<MessageRecord>
  implements MessagePort
{
  constructor() {
    super("mas_messages", "id");
  }

  idsCreatedBefore(cutoffIso: string, limit: number): string[] {
    return this.findMany({ orderBy: "createdAt ASC" })
      .filter((r) => r.createdAt < cutoffIso)
      .slice(0, limit)
      .map((r) => r.id);
  }

  deleteBySessionId(sessionId: string): number {
    let removed = 0;
    for (const row of Array.from(this.rows.values())) {
      if (row.sessionId === sessionId) {
        this.rows.delete(row.id);
        removed++;
      }
    }
    return removed;
  }
}

export class InMemoryEventLogAdapter
  extends InMemoryRepository<AuditEvent>
  implements EventLogPort
{
  constructor() {
    super("mas_events", "id");
  }

  override create(record: AuditEvent): AuditEvent {
    const all = Array.from(this.rows.values());
    const tail = all[all.length - 1];
    const payloadText =
      typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload ?? {});
    const chained = linkAuditRow(
      {
        id: record.id,
        sessionId: record.sessionId,
        type: record.type,
        agent: record.agent,
        payload: payloadText,
        createdAt: record.createdAt,
      },
      tail?.eventHash ?? null,
    );
    return super.create({
      ...record,
      payload: payloadText as unknown as Record<string, unknown>,
      previousEventHash: chained.previousEventHash,
      eventHash: chained.eventHash,
    });
  }

  idsCreatedBefore(cutoffIso: string, limit: number): string[] {
    return this.findMany({ orderBy: "createdAt ASC" })
      .filter((r) => r.createdAt < cutoffIso)
      .slice(0, limit)
      .map((r) => r.id);
  }
}

export class InMemoryMemoryAdapter
  extends InMemoryRepository<MemoryRecord>
  implements MemoryPort
{
  constructor() {
    super("mas_memory", "key");
  }

  clear(): number {
    const removed = this.rows.size;
    this.rows.clear();
    return removed;
  }

  keysUpdatedBefore(cutoffIso: string, limit: number): string[] {
    return this.findMany({ orderBy: "updatedAt ASC" })
      .filter((r) => r.updatedAt < cutoffIso)
      .slice(0, limit)
      .map((r) => r.key);
  }

  search(term: string, limit: number): MemoryRecord[] {
    const needle = term.toLowerCase();
    return this.findMany({ orderBy: "updatedAt DESC" })
      .filter(
        (r) =>
          r.key.toLowerCase().includes(needle) ||
          r.value.toLowerCase().includes(needle),
      )
      .slice(0, limit);
  }

  listRecent(limit: number): MemoryRecord[] {
    return this.findMany({ orderBy: "updatedAt DESC" }).slice(0, limit);
  }
}

export class InMemoryTransactionLedgerAdapter
  extends InMemoryRepository<TransactionRecord>
  implements TransactionLedgerPort
{
  constructor() {
    super("mas_transactions", "id");
  }

  replace(record: TransactionRecord): TransactionRecord {
    this.rows.set(record.id, { ...record });
    return record;
  }

  /** #3182: tenant-scoped read — same null-exclusion as the DO
   *  adapter (findMany's `=` filter drops null-tenant rows). */
  findByTenant(tenantId: string): TransactionRecord[] {
    return this.findMany({ where: { tenantId }, orderBy: "createdAt DESC" });
  }

  /** #2360: the route's four status transitions with the
   *  same field sets and WHERE shapes as the DO adapter —
   *  no status guard on any of them (the legacy UPDATEs
   *  have none). Each returns the rows matched. */
  completeWithGateway(
    id: string,
    fields: TransactionCompletionFields
  ): number {
    const row = this.rows.get(id);
    if (!row) return 0;
    this.rows.set(id, {
      ...row,
      status: "completed",
      gatewayRef: fields.gatewayRef,
      checkoutUrl: fields.checkoutUrl,
      authorizerDid: fields.authorizerDid,
      note: fields.note,
      updatedAt: fields.updatedAt,
    });
    return 1;
  }

  rejectWithNote(id: string, fields: TransactionRejectionFields): number {
    const row = this.rows.get(id);
    if (!row) return 0;
    this.rows.set(id, {
      ...row,
      status: "rejected",
      authorizerDid: fields.authorizerDid,
      note: fields.note,
      updatedAt: fields.updatedAt,
    });
    return 1;
  }

  completeByIdOrGatewayRef(ref: string, updatedAt: string): number {
    let matched = 0;
    for (const [id, row] of this.rows) {
      if (row.id === ref || row.gatewayRef === ref) {
        this.rows.set(id, { ...row, status: "completed", updatedAt });
        matched++;
      }
    }
    return matched;
  }

  completeById(id: string, updatedAt: string): number {
    const row = this.rows.get(id);
    if (!row) return 0;
    this.rows.set(id, { ...row, status: "completed", updatedAt });
    return 1;
  }
}

export class InMemoryCanonicalReportAdapter extends InMemoryRepository<CanonicalReportRecord> {
  constructor() {
    super("mas_reports", "id");
  }
}

export class InMemorySettingsReadAdapter implements SettingsReadPort {
  constructor(private readonly values = new Map<string, string>()) {}

  /** Test/conformance helper: seed a setting value. */
  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

/**
 * In-memory settings port (#2390, step 4g) — the conformance
 * twin of DoSqliteSettingsAdapter. ensureSchema is a no-op
 * (there is no table); the map is the store.
 */
export class InMemorySettingsAdapter implements SettingsPort {
  constructor(private readonly values = new Map<string, string>()) {}

  ensureSchema(): void {
    // No DDL in memory: the map exists from construction.
  }

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}
