/**
 * src/data/doSqliteOrmAdapters.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A/D-B): the DO-SQLite adapters for the ORM core's
 * DO-resident ports. Each adapter is the generic repository
 * core (ormRepositoryCore.ts) bound to one table's column
 * map — the maps moved verbatim from the pre-port DatabaseORM
 * constructor — plus the range/purge methods its port adds.
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
import type { SqlStorage } from "./repositoryPorts";
import type {
  SettingsPort,
  SettingsReadPort,
} from "./settingsReadPorts";

/** The mas_settings DDL — its single home is this adapter's
 *  ensureSchema (step 4g, G-7 ruling). */
export const MAS_SETTINGS_DDL =
  "CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)";
import type {
  TransactionCompletionFields,
  TransactionLedgerPort,
  TransactionRejectionFields,
} from "./transactionLedgerPorts";

/* Column maps — verbatim from the pre-port ORM constructor. */
export const CATEGORY_COLUMN_MAP = {
  id: "id",
  name: "name",
  slug: "slug",
  description: "description",
  icon: "icon",
  isActive: "is_active",
  sortOrder: "sort_order",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

export const REFERRAL_COLUMN_MAP = {
  id: "id",
  userLogin: "session_id",
  title: "title",
  url: "url",
  category: "category",
  rewardText: "reward_text",
  clicks: "clicks",
  signups: "signups",
  createdAt: "created_at",
} as const;

export const AD_COLUMN_MAP = {
  id: "id",
  title: "title",
  tagline: "tagline",
  sponsor: "sponsor",
  badge: "badge",
  url: "url",
  ctaText: "cta_text",
  accentColor: "accent_color",
  impressions: "impressions",
  clicks: "clicks",
  createdAt: "created_at",
} as const;

export const EXTERNAL_AD_COLUMN_MAP = {
  id: "id",
  name: "name",
  network: "network",
  placement: "placement",
  title: "title",
  tagline: "tagline",
  ctaText: "cta_text",
  targetUrl: "target_url",
  bannerImageUrl: "banner_image_url",
  cpmRate: "cpm_rate",
  cpcRate: "cpc_rate",
  impressions: "impressions",
  clicks: "clicks",
  earnings: "earnings",
  isActive: "is_active",
  createdAt: "created_at",
} as const;

export const TRANSACTION_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  action: "action",
  amount: "amount",
  currency: "currency",
  customer: "customer",
  gateway: "gateway",
  gatewayRef: "gateway_ref",
  status: "status",
  checkoutUrl: "checkout_url",
  proposerDid: "proposer_did",
  authorizerDid: "authorizer_did",
  proofSignature: "proof_signature",
  note: "note",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

export const MESSAGE_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  role: "role",
  content: "content",
  agent: "agent",
  createdAt: "created_at",
} as const;

export const MEMORY_COLUMN_MAP = {
  key: "key",
  value: "value",
  updatedAt: "updated_at",
} as const;

export const EVENT_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  type: "type",
  agent: "agent",
  payload: "payload",
  createdAt: "created_at",
  previousEventHash: "previous_event_hash",
  eventHash: "event_hash",
} as const;

/**
 * The COMPLETED reports map (#2345): the pre-port map's eight
 * columns plus user_login and body_r2_key, which the canonical
 * writer has stored all along (audit V-5).
 */
export const CANONICAL_REPORT_COLUMN_MAP = {
  id: "id",
  runId: "run_id",
  generationId: "generation_id",
  title: "title",
  source: "source",
  summary: "summary",
  body: "body",
  createdAt: "created_at",
  userLogin: "user_login",
  bodyR2Key: "body_r2_key",
  fanoutOutcome: "fanout_outcome",
} as const;

export const WEBHOOK_REPLAY_COLUMN_MAP = {
  nonce: "nonce",
  source: "source",
  createdAt: "created_at",
  expiresAt: "expires_at",
} as const;

export const TRADE_COLUMN_MAP = {
  id: "id",
  sessionId: "session_id",
  symbol: "symbol",
  action: "action",
  orderType: "order_type",
  quantity: "quantity",
  price: "price",
  totalValue: "total_value",
  status: "status",
  orderRef: "order_ref",
  proposerDid: "proposer_did",
  authorizerDid: "authorizer_did",
  proofSignature: "proof_signature",
  previewNotes: "preview_notes",
  expirationScheduleId: "expiration_schedule_id",
  broker: "broker",
  priceSourceJson: "price_source",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

export const WATCHLIST_COLUMN_MAP = {
  id: "id",
  name: "name",
  userLogin: "user_login",
  symbolsJson: "symbols_json",
  itemsJson: "items_json",
  source: "source",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

export const OPTIONS_CHAIN_CACHE_COLUMN_MAP = {
  id: "id",
  symbol: "symbol",
  expirationsJson: "expirations_json",
  chainsJson: "chains_json",
  fetchedAt: "fetched_at",
  expiresAt: "expires_at",
  contractCount: "contract_count",
} as const;

/** mas_messages adapter: repository + retention selector + session purge. */
export class DoSqliteMessageAdapter
  extends Repository<MessageRecord>
  implements MessagePort
{
  constructor(sql: SqlStorage) {
    super(sql, "mas_messages", "id", MESSAGE_COLUMN_MAP);
  }

  idsCreatedBefore(cutoffIso: string, limit: number): string[] {
    const rows = Array.from(
      this.sql.exec(
        "SELECT id FROM mas_messages WHERE created_at < ? ORDER BY created_at ASC LIMIT ?",
        cutoffIso,
        limit,
      ),
    ) as Array<{ id?: unknown }>;
    return rows
      .map((r) => r?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  deleteBySessionId(sessionId: string): number {
    const before = this.count({ sessionId });
    this.sql.exec("DELETE FROM mas_messages WHERE session_id = ?", sessionId);
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
    const rows = Array.from(
      this.sql.exec(
        "SELECT id FROM mas_events WHERE created_at < ? ORDER BY created_at ASC LIMIT ?",
        cutoffIso,
        limit,
      ),
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
    this.sql.exec("DELETE FROM mas_memory");
    return removed;
  }

  keysUpdatedBefore(cutoffIso: string, limit: number): string[] {
    const rows = Array.from(
      this.sql.exec(
        "SELECT key FROM mas_memory WHERE updated_at < ? ORDER BY updated_at ASC LIMIT ?",
        cutoffIso,
        limit,
      ),
    ) as Array<{ key?: unknown }>;
    return rows
      .map((r) => r?.key)
      .filter((k): k is string => typeof k === "string" && k.length > 0);
  }

  search(term: string, limit: number): MemoryRecord[] {
    const like = `%${term.toLowerCase()}%`;
    const rows = Array.from(
      this.sql.exec(
        "SELECT key, value, updated_at FROM mas_memory WHERE lower(key) LIKE ? OR lower(value) LIKE ? ORDER BY updated_at DESC LIMIT ?",
        like,
        like,
        limit,
      ),
    ) as Array<{ key: string; value: string; updated_at: string }>;
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }

  listRecent(limit: number): MemoryRecord[] {
    const rows = Array.from(
      this.sql.exec(
        "SELECT key, value, updated_at FROM mas_memory ORDER BY updated_at DESC LIMIT ?",
        limit,
      ),
    ) as Array<{ key: string; value: string; updated_at: string }>;
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }
}

/** Rows matched by an UPDATE cursor (the async-job adapter's
 *  idiom: consume the cursor, then read rowsWritten). */
function updateRowsWritten(cursor: unknown): number {
  const c = cursor as { rowsWritten?: number };
  return typeof c.rowsWritten === "number" ? c.rowsWritten : 0;
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
    const cols = Object.keys(TRANSACTION_COLUMN_MAP) as Array<
      keyof typeof TRANSACTION_COLUMN_MAP
    >;
    const values = cols.map((prop) => {
      const val = record[prop];
      return typeof val === "boolean" ? (val ? 1 : 0) : val;
    });
    this.sql.exec(
      `INSERT OR REPLACE INTO mas_transactions (${cols
        .map((c) => TRANSACTION_COLUMN_MAP[c])
        .join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...values,
    );
    return record;
  }

  /** #2360: the route's four status transitions, statements
   *  verbatim from routes/payments.ts (single-line form per
   *  the MockSqlStorage lesson). No status guard on any of
   *  them — the legacy UPDATEs have none. */
  completeWithGateway(id: string, fields: TransactionCompletionFields): number {
    const cursor = this.sql.exec(
      "UPDATE mas_transactions SET status = 'completed', gateway_ref = ?, checkout_url = ?, authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
      fields.gatewayRef,
      fields.checkoutUrl,
      fields.authorizerDid,
      fields.note,
      fields.updatedAt,
      id,
    );
    Array.from(cursor as Iterable<unknown>);
    return updateRowsWritten(cursor);
  }

  rejectWithNote(id: string, fields: TransactionRejectionFields): number {
    const cursor = this.sql.exec(
      "UPDATE mas_transactions SET status = 'rejected', authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
      fields.authorizerDid,
      fields.note,
      fields.updatedAt,
      id,
    );
    Array.from(cursor as Iterable<unknown>);
    return updateRowsWritten(cursor);
  }

  completeByIdOrGatewayRef(ref: string, updatedAt: string): number {
    const cursor = this.sql.exec(
      "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ? OR gateway_ref = ?",
      updatedAt,
      ref,
      ref,
    );
    Array.from(cursor as Iterable<unknown>);
    return updateRowsWritten(cursor);
  }

  completeById(id: string, updatedAt: string): number {
    const cursor = this.sql.exec(
      "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ?",
      updatedAt,
      id,
    );
    Array.from(cursor as Iterable<unknown>);
    return updateRowsWritten(cursor);
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
    const rows = Array.from(
      this.sql.exec("SELECT value FROM mas_settings WHERE key = ?", key),
    ) as Array<{ value?: unknown }>;
    const value = rows[0]?.value;
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
    this.sql.exec("DELETE FROM mas_settings WHERE key = ?", key);
    this.sql.exec(
      "INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      value,
      updatedAt ?? new Date().toISOString(),
    );
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM mas_settings WHERE key = ?", key);
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
