/**
 * src/data/doSqliteOrmAdapters.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A/D-B): the DO-SQLite adapters for the ORM core's
 * DO-resident ports. Each adapter is the generic repository
 * core (ormRepositoryCore.ts) bound to one table's column
 * map (the maps live in ./ormColumnMaps) — plus the range/purge
 * methods its port adds.
 * All SQL for the 13 tables lives in this layer now (and in
 * ormRepositoryCore / ormSchema); nothing above it issues
 * statements against these tables.
 *
 * #CDO-mha7
 */
import type {
  AdRecord,
  AuditEvent,
  CategoryRecord,
  ExternalAdRecord,
  MemoryRecord,
  MessageRecord,
  OptionsChainCacheRecord,
  ReferralRecord,
  TradeRecord,
  TransactionRecord,
  WatchlistRecord,
  WebhookReplayNonce,
} from "../types";
import type { CanonicalReportRecord } from "./canonicalReportPorts";
import type { EventLogPort } from "./eventLogPorts";
import type { MemoryPort } from "./memoryPorts";
import type { MessagePort } from "./messagePorts";
import { ChainedAuditRepository, Repository } from "./ormRepositoryCore";
import { doTableSql } from "./schemaComponent/doCatalogue";
import { DO_DML_CATALOGUE } from "./schemaComponent/doDmlCatalogue";
import { executeDoDml } from "./schemaComponent/doDmlExecutor";
import type { SqlStorage } from "./repositoryPorts";
import type {
  SettingsPort,
  SettingsReadPort,
} from "./settingsReadPorts";

/** The mas_settings DDL — its single home is this adapter's
 *  ensureSchema (step 4g, G-7 ruling). */
export const MAS_SETTINGS_DDL = doTableSql("mas_settings");
import type {
  TransactionCompletionFields,
  TransactionLedgerPort,
  TransactionRejectionFields,
} from "./transactionLedgerPorts";

/* The column maps live in ./ormColumnMaps (leaf module — see its
 * header for why); re-exported here so existing import paths
 * keep working unchanged. */
import {
  AD_COLUMN_MAP,
  CANONICAL_REPORT_COLUMN_MAP,
  CATEGORY_COLUMN_MAP,
  EVENT_COLUMN_MAP,
  EXTERNAL_AD_COLUMN_MAP,
  MEMORY_COLUMN_MAP,
  MESSAGE_COLUMN_MAP,
  OPTIONS_CHAIN_CACHE_COLUMN_MAP,
  REFERRAL_COLUMN_MAP,
  TRADE_COLUMN_MAP,
  TRANSACTION_COLUMN_MAP,
  WATCHLIST_COLUMN_MAP,
  WEBHOOK_REPLAY_COLUMN_MAP,
} from "./ormColumnMaps";
export {
  AD_COLUMN_MAP,
  CANONICAL_REPORT_COLUMN_MAP,
  CATEGORY_COLUMN_MAP,
  EVENT_COLUMN_MAP,
  EXTERNAL_AD_COLUMN_MAP,
  MEMORY_COLUMN_MAP,
  MESSAGE_COLUMN_MAP,
  OPTIONS_CHAIN_CACHE_COLUMN_MAP,
  REFERRAL_COLUMN_MAP,
  TRADE_COLUMN_MAP,
  TRANSACTION_COLUMN_MAP,
  WATCHLIST_COLUMN_MAP,
  WEBHOOK_REPLAY_COLUMN_MAP,
};

/** mas_messages adapter: repository + retention selector + session purge. */
export class DoSqliteMessageAdapter
  extends Repository<MessageRecord>
  implements MessagePort
{
  constructor(sql: SqlStorage) {
    super(sql, "mas_messages", "id", MESSAGE_COLUMN_MAP);
  }

  idsCreatedBefore(cutoffIso: string, limit: number): string[] {
    const rows = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_messages.ids_created_before",
      { where: { createdAt: { $lt: cutoffIso } }, orderBy: "created_at ASC", limit },
    ) as Array<{ id?: unknown }>;
    return rows
      .map((r) => r?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  deleteBySessionId(sessionId: string): number {
    // The verified before/after count is kept (the executor's
    // deleteWhere return is discarded): the return is the rows
    // actually gone, under every storage, exactly as before.
    const before = this.count({ sessionId });
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_messages.delete_by_session", {
      where: { sessionId },
    });
    return before - this.count({ sessionId });
  }
}

/** mas_events adapter: the chained repository + retention selector. */
export class DoSqliteEventLogAdapter
  extends ChainedAuditRepository
  implements EventLogPort
{
  constructor(sql: SqlStorage) {
    super(sql, "mas_events", "id", EVENT_COLUMN_MAP);
  }

  idsCreatedBefore(cutoffIso: string, limit: number): string[] {
    const rows = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_events.ids_created_before",
      { where: { createdAt: { $lt: cutoffIso } }, orderBy: "created_at ASC", limit },
    ) as Array<{ id?: unknown }>;
    return rows
      .map((r) => r?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
}

/** mas_memory adapter: repository + clear + retention selector + recall reads. */
export class DoSqliteMemoryAdapter
  extends Repository<MemoryRecord>
  implements MemoryPort
{
  constructor(sql: SqlStorage) {
    super(sql, "mas_memory", "key", MEMORY_COLUMN_MAP);
  }

  clear(): number {
    const removed = this.count();
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_memory.clear", {});
    return removed;
  }

  keysUpdatedBefore(cutoffIso: string, limit: number): string[] {
    const rows = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_memory.keys_updated_before",
      { where: { updatedAt: { $lt: cutoffIso } }, orderBy: "updated_at ASC", limit },
    ) as Array<{ key?: unknown }>;
    return rows
      .map((r) => r?.key)
      .filter((k): k is string => typeof k === "string" && k.length > 0);
  }

  search(term: string, limit: number): MemoryRecord[] {
    const like = `%${term.toLowerCase()}%`;
    const rows = executeDoDml<Array<{ key: string; value: string; updated_at: string }>>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_memory.search",
      { like, limit },
    );
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }

  listRecent(limit: number): MemoryRecord[] {
    // findMany returns mapped records (updatedAt), not raw rows —
    // the mapping reads the record field, the returned shape is
    // identical to before.
    const rows = executeDoDml<MemoryRecord[]>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_memory.list_recent",
      { orderBy: "updated_at DESC", limit },
    );
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt }));
  }
}

/** mas_transactions adapter: repository + INSERT OR REPLACE drafts. */
export class DoSqliteTransactionLedgerAdapter
  extends Repository<TransactionRecord>
  implements TransactionLedgerPort
{
  constructor(sql: SqlStorage) {
    super(sql, "mas_transactions", "id", TRANSACTION_COLUMN_MAP);
  }

  replace(record: TransactionRecord): TransactionRecord {
    return executeDoDml<TransactionRecord>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_transactions.replace",
      { record },
    );
  }

  /** #3182: tenant-scoped read. `tenant_id = ?` excludes
   *  null-tenant legacy rows by construction — see the port. */
  findByTenant(tenantId: string): TransactionRecord[] {
    return this.findMany({ where: { tenantId }, orderBy: "created_at DESC" });
  }

  /** #2360: the route's four status transitions, field sets and
   *  WHERE shapes verbatim from routes/payments.ts (single-line
   *  form per the MockSqlStorage lesson). No status guard on any
   *  of them — the legacy UPDATEs have none. The three
   *  updateWhere entries return rows written (rowsWritten when
   *  the store reports it, else the verified matched count —
   *  identical under a reporting store; see the pin test and the
   *  #2360 conformance suite). The OR-disjunction entry is a
   *  template whose "run" return is rowsWritten-or-null, so the
   *  legacy rowsWritten-or-0 is preserved with ?? 0. */
  completeWithGateway(id: string, fields: TransactionCompletionFields): number {
    return executeDoDml<number>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_transactions.complete_with_gateway",
      {
        where: { id },
        set: {
          status: "completed",
          gatewayRef: fields.gatewayRef,
          checkoutUrl: fields.checkoutUrl,
          authorizerDid: fields.authorizerDid,
          note: fields.note,
          updatedAt: fields.updatedAt,
        },
      },
    );
  }

  rejectWithNote(id: string, fields: TransactionRejectionFields): number {
    return executeDoDml<number>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_transactions.reject_with_note",
      {
        where: { id },
        set: {
          status: "rejected",
          authorizerDid: fields.authorizerDid,
          note: fields.note,
          updatedAt: fields.updatedAt,
        },
      },
    );
  }

  completeByIdOrGatewayRef(ref: string, updatedAt: string): number {
    const result = executeDoDml<number | null>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_transactions.complete_by_gateway_ref",
      { updatedAt, ref },
    );
    return result ?? 0;
  }

  completeById(id: string, updatedAt: string): number {
    return executeDoDml<number>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_transactions.complete_by_id",
      { where: { id }, set: { status: "completed", updatedAt } },
    );
  }
}

/** mas_reports adapter: the repository with the completed map. */
export class DoSqliteCanonicalReportAdapter extends Repository<CanonicalReportRecord> {
  constructor(sql: SqlStorage) {
    super(sql, "mas_reports", "id", CANONICAL_REPORT_COLUMN_MAP);
  }
}

/** mas_settings read adapter (step 3a; the read half of the family). */
export class DoSqliteSettingsReadAdapter implements SettingsReadPort {
  constructor(protected readonly sql: SqlStorage) {}

  get(key: string): string | null {
    const row = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_settings.get",
      { id: key },
    );
    const value = row?.value;
    return typeof value === "string" ? value : value == null ? null : String(value);
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }
}

/**
 * mas_settings adapter (#2390, step 4g — the G-7 ruling): the
 * dedicated settings port's DO implementation and the table's
 * single owner. It is the ONLY module that writes mas_settings
 * values or creates the table; the four former writers
 * (reportDispatch, screeningFlags, governedHalt, the enrichment
 * adapter) call this port. Reads share the step-3a adapter's
 * exact semantics by extension.
 */
export class DoSqliteSettingsAdapter
  extends DoSqliteSettingsReadAdapter
  implements SettingsPort
{
  ensureSchema(): void {
    this.sql.exec(MAS_SETTINGS_DDL);
  }

  set(key: string, value: string, updatedAt?: string): void {
    // DELETE+INSERT (not INSERT OR REPLACE) so
    // MockSqlStorage-shaped stores stay compatible — the
    // incumbent idiom of all four legacy writers.
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_settings.delete", { id: key });
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_settings.insert", {
      record: { key, value, updated_at: updatedAt ?? new Date().toISOString() },
    });
  }

  delete(key: string): void {
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_settings.delete", { id: key });
  }
}

/* Plain repository factories for the aggregates whose port is
 * the generic contract (no extra methods). */
export function createDoCategoryRepository(sql: SqlStorage): Repository<CategoryRecord> {
  return new Repository<CategoryRecord>(sql, "mas_categories", "id", CATEGORY_COLUMN_MAP);
}
export function createDoReferralRepository(sql: SqlStorage): Repository<ReferralRecord> {
  return new Repository<ReferralRecord>(sql, "mas_referrals", "id", REFERRAL_COLUMN_MAP);
}
export function createDoAdRepository(sql: SqlStorage): Repository<AdRecord> {
  return new Repository<AdRecord>(sql, "mas_ads", "id", AD_COLUMN_MAP);
}
export function createDoExternalAdRepository(sql: SqlStorage): Repository<ExternalAdRecord> {
  return new Repository<ExternalAdRecord>(sql, "mas_external_ads", "id", EXTERNAL_AD_COLUMN_MAP);
}
export function createDoWebhookReplayRepository(sql: SqlStorage): Repository<WebhookReplayNonce> {
  return new Repository<WebhookReplayNonce>(sql, "webhook_replay_nonces", "nonce", WEBHOOK_REPLAY_COLUMN_MAP);
}
export function createDoTradeRepository(sql: SqlStorage): Repository<TradeRecord> {
  return new Repository<TradeRecord>(sql, "mas_trades", "id", TRADE_COLUMN_MAP);
}
export function createDoWatchlistRepository(sql: SqlStorage): Repository<WatchlistRecord> {
  return new Repository<WatchlistRecord>(sql, "mas_watchlists", "id", WATCHLIST_COLUMN_MAP);
}
export function createDoOptionsChainCacheRepository(sql: SqlStorage): Repository<OptionsChainCacheRecord> {
  return new Repository<OptionsChainCacheRecord>(sql, "mas_options_chain_cache", "id", OPTIONS_CHAIN_CACHE_COLUMN_MAP);
}

export type { AuditEvent };
