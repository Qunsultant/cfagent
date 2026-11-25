/**
 * src/data/asyncEventLogPorts.ts — #6102: the async twin of the
 * mas_events port (src/data/eventLogPorts.ts).
 *
 * The D1 adapter cannot literally implement the sync EventLogPort
 * (src/data/repositoryPorts.ts is fully synchronous because DO
 * SQLite is synchronous); D1 is async, so the replacement port is
 * async end to end. Same record shape (AuditEvent), same chained
 * create semantics (G-5 frozen: six fields hashed, envelope
 * columns NOT hashed), same retention selector — only the
 * asynchrony differs.
 *
 * Read contract (inherited from the DO port): `payload` reads back
 * as the stored JSON TEXT string, exactly as the DO repository
 * returned it (its fromDbRow never parsed payload) — every
 * consumer (audit list/detail projection, fiber checkpoint parse,
 * outcome-row parse, cfpay revenue payloads) already handles the
 * string form.
 *
 * #CDO-mha7
 */
import type { AuditEvent } from "../types";
import type { AuditChainRow } from "../security/auditChain";

/** Equality filters the D1 event-log reads support. */
export interface AuditEventWhere {
  id?: string;
  sessionId?: string;
  type?: string;
  agent?: string;
}

/** Read options for the async event-log finds. */
export interface AsyncAuditEventQueryOptions {
  where?: AuditEventWhere;
  /** "created_at DESC" | "created_at ASC" — the only orders the moved reads use. */
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/** One chain-window row: the AuditChainRow plus its insertion order. */
export interface AuditChainWindowRow extends AuditChainRow {
  rowid: number;
}

export interface AsyncEventLogPort {
  /**
   * Chained create: links the row onto the table's current tail
   * (previousEventHash + eventHash per G-5) and inserts it. The
   * insert is conditional on the tail still being the tail read,
   * retried on contention — two DO instances appending at once
   * cannot fork the chain. Throws on failure (a duplicate id, a
   * lost race after the retry bound, a D1 error).
   */
  create(record: AuditEvent): Promise<AuditEvent>;
  findMany(options?: AsyncAuditEventQueryOptions): Promise<AuditEvent[]>;
  findById(id: string): Promise<AuditEvent | null>;
  /** Ids with created_at < cutoffIso, oldest first, ≤ limit. */
  idsCreatedBefore(cutoffIso: string, limit: number): Promise<string[]>;
  /** Delete one row by id; true when a row was deleted. */
  delete(id: string): Promise<boolean>;
  /**
   * Chain-window read for the checkpointed verifier: rows with
   * rowid > afterRowId, in insertion order, ≤ limit when given.
   * rowid is the chain's insertion order — the builder cannot
   * express it, so this goes through the DML catalogue.
   */
  readChainWindow(afterRowId: number, limit?: number): Promise<AuditChainWindowRow[]>;
}
