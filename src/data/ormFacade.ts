/**
 * src/data/ormFacade.ts — #2345 (#1976 step 3a, ADR 0022 D-A):
 * the ORM core's composition facade, moved from src/orm/index.ts.
 *
 * DatabaseORM survives as the familiar accessor SHAPE — the
 * ~180 getOrm() call sites and the route ctx interfaces keep
 * working unchanged — but it is now a composition root over
 * the data layer: every repository property is a PORT
 * (src/data/*Ports.ts) backed by a DO-SQLite adapter
 * (doSqliteOrmAdapters.ts over ormRepositoryCore.ts), the
 * reports repository carries the completed column map
 * (canonicalReportPorts.ts), and the marketplace tables are
 * additionally reachable as async D1 ports through
 * marketplacePorts(env) (marketplacePorts.ts). src/orm/index.ts
 * is a §22 re-export shim over this module.
 *
 * The raw passthroughs (exec / execQuery / getSql) are
 * DEPRECATED below: they keep working for their remaining
 * non-13-table consumers (step 4's satellites) but have no
 * production callers left for the 13 tables in this slice.
 *
 * #CDO-mha7
 */

import type {
  CategoryRecord,
  ReferralRecord,
  AdRecord,
  ExternalAdRecord,
  TransactionRecord,
  MessageRecord,
  MemoryRecord,
  AuditEvent,
  WebhookReplayNonce,
  RevenueSummary,
  TradeRecord,
  WatchlistRecord,
  OptionsChainCacheRecord,
  ScheduledReportRecord,
} from "../types";
import {
  storeReportAtGeneration,
  ensureScheduledReportsTable,
  type ScheduledReportInput,
  type CanonicalStoreResult,
} from "../services/scheduledReports";
import type { IndexEnv } from "../services/reportSemanticIndex";
import { ensureSharedTable, ensureAuditChainColumns } from "./ormSchema";
import { ormTableSql } from "./schemaComponent/ormCatalogue";
import {
  createDoAdRepository,
  createDoCategoryRepository,
  createDoExternalAdRepository,
  createDoOptionsChainCacheRepository,
  createDoReferralRepository,
  createDoTradeRepository,
  createDoWatchlistRepository,
  createDoWebhookReplayRepository,
  DoSqliteCanonicalReportAdapter,
  DoSqliteEventLogAdapter,
  DoSqliteMemoryAdapter,
  DoSqliteMessageAdapter,
  DoSqliteTransactionLedgerAdapter,
} from "./doSqliteOrmAdapters";
import type { RepositoryPort } from "./repositoryPorts";
import type { MessagePort } from "./messagePorts";
import type { EventLogPort } from "./eventLogPorts";
import type { MemoryPort } from "./memoryPorts";
import type { TransactionLedgerPort } from "./transactionLedgerPorts";
import type {
  CanonicalReportPort,
} from "./canonicalReportPorts";
import {
  marketplaceSeedData,
  type MarketplacePorts,
} from "./marketplacePorts";
import { buildMarketplacePorts } from "./buildMarketplacePorts";
import { computeRevenueSummaryFromRows } from "./marketplacePorts";
import {
  diagnoseAuditChain,
  linkAuditRow,
  type AuditChainDiagnosis,
  type AuditChainRow,
} from "../security/auditChain";
import {
  fingerprintSql,
  type ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";

export type { SqlStorage } from "./repositoryPorts";
export type { RepositoryQueryOptions as QueryOptions } from "./repositoryPorts";
import type { SqlStorage } from "./repositoryPorts";

export interface TableMetadata {
  name: string;
  description: string;
  rowCount: number;
  columns: Array<{ name: string; type: string; isPrimary: boolean }>;
}

/**
 * Issue #781: thrown when a persistence-backed flow runs without an
 * injected DatabaseORM. This replaces the former stub-ORM fallback —
 * a DatabaseORM built on an exec stub that returns an empty array for
 * every query — under which reads silently came back empty and writes
 * silently vanished (the persistAudit failure class). Failing loud at
 * the point of use is the contract: a caller that cannot persist must
 * say so, never fabricate answers from an empty ledger.
 */
export class MissingOrmError extends Error {
  constructor(context: string) {
    super(
      `${context} requires a DatabaseORM, but none was injected. ` +
        `Refusing to run against a no-op ORM: reads would silently return empty and writes would silently vanish (issue #781).`
    );
    this.name = "MissingOrmError";
  }
}

/**
 * Issue #781: return the injected ORM or throw {@link MissingOrmError}.
 * `context` names the calling flow (e.g. "ETradeSlackTradingService.processSlackEvent")
 * so the failure identifies which wiring is missing.
 */
export function requireOrm(orm: DatabaseORM | undefined, context: string): DatabaseORM {
  if (!orm) throw new MissingOrmError(context);
  return orm;
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
 */
/**
 * Issue #2178 (Q7 S1): verify the stored mas_events chain in
 * insertion order. Pre-chain rows are a genesis boundary (see
 * verifyAuditChain); a bypass writer that inserts without chaining
 * after chaining started fails verification — loudly, by design.
 */
export function diagnoseStoredAuditChain(orm: DatabaseORM): AuditChainDiagnosis {
  const rows = orm.events.findMany({ orderBy: "rowid ASC" });
  const chainRows: AuditChainRow[] = rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    type: r.type,
    agent: r.agent,
    payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload ?? {}),
    createdAt: r.createdAt,
    previousEventHash: r.previousEventHash ?? null,
    eventHash: r.eventHash ?? "",
  }));
  return diagnoseAuditChain(chainRows);
}

export function verifyStoredAuditChain(orm: DatabaseORM): boolean {
  return diagnoseStoredAuditChain(orm).valid;
}

export class DatabaseORM {
  public categories: RepositoryPort<CategoryRecord>;
  public referrals: RepositoryPort<ReferralRecord>;
  public ads: RepositoryPort<AdRecord>;
  public externalAds: RepositoryPort<ExternalAdRecord>;
  public transactions: TransactionLedgerPort;
  public messages: MessagePort;
  public memory: MemoryPort;
  public events: EventLogPort;
  public webhookReplay: RepositoryPort<WebhookReplayNonce>;
  public trades: RepositoryPort<TradeRecord>;
  public watchlists: RepositoryPort<WatchlistRecord>;
  public optionsChainCache: RepositoryPort<OptionsChainCacheRecord>;
  /**
   * Scheduled-run reports (issue #278) — durable, searchable
   * later. #2345: the port carries the COMPLETED column map
   * (userLogin / bodyR2Key included — canonicalReportPorts).
   */
  public reports: CanonicalReportPort;

  /**
   * Issue #1378: the DO SqlStorage behind this ORM, for platform
   * route-bundle construction by services (the screenLive universe
   * seam). Zero behavior change — exposes an existing field; the
   * provider-config/capture tables are not ORM repositories, so
   * there is no repository-shaped way to reach them.
   */
  /**
   * @deprecated Superseded by the src/data composition roots
   * (createDataProviderPorts / buildDataProviderPorts for the
   * provider tables, #2345) — this passthrough remains only for
   * the step-1 provider seams that take a raw handle by design;
   * it has no callers for the ORM core's 13 tables. New code
   * takes a port, never this handle.
   */
  public getSql(): SqlStorage {
    return this.sql;
  }

  /**
   * Issue #2345 (#1976 step 3a): the marketplace ports for this
   * instance — D1 adapters over the fleet tables when AGENT_DB
   * is bound (migration 0021), DO-SQLite adapters over this
   * instance's own tables when it is not. Memoized per storage
   * handle by the builder, so repeat calls are free.
   */
  public marketplacePorts(env: { AGENT_DB?: unknown }): Promise<MarketplacePorts> {
    return buildMarketplacePorts(env ?? {}, this.sql);
  }

  /**
   * Issue #2280 (slice 5): optional measurement sink for raw reads. When
   * absent (no bindings, tests, other constructions), execQuery behaves
   * exactly as before — zero overhead, zero behavior change.
   */
  private readonly resourceSink?: ResourceUsagePort;

  constructor(
    private sql: SqlStorage,
    opts?: { resourceSink?: ResourceUsagePort },
  ) {
    this.resourceSink = opts?.resourceSink;
    this.categories = createDoCategoryRepository(sql);
    this.referrals = createDoReferralRepository(sql);
    this.ads = createDoAdRepository(sql);
    this.externalAds = createDoExternalAdRepository(sql);
    this.transactions = new DoSqliteTransactionLedgerAdapter(sql);
    this.messages = new DoSqliteMessageAdapter(sql);
    this.memory = new DoSqliteMemoryAdapter(sql);
    this.events = new DoSqliteEventLogAdapter(sql);
    // Issue #278: durable store for reports generated by scheduled
    // runs, so the NextGenTP agent can surface them later. #2345:
    // the adapter carries the completed column map.
    this.reports = new DoSqliteCanonicalReportAdapter(sql);
    // Issue #143 P0: inbound webhook replay protection. Nonces are
    // provider-derived event identities (see src/security/webhookReplay.ts);
    // rows expire WEBHOOK_REPLAY_TTL_MS after creation and are pruned
    // opportunistically on claim.
    this.webhookReplay = createDoWebhookReplayRepository(sql);
    this.trades = createDoTradeRepository(sql);
    this.watchlists = createDoWatchlistRepository(sql);
    this.optionsChainCache = createDoOptionsChainCacheRepository(sql);
  }

  /**
   * Initializes all SQLite tables and seeds initial data using the ORM.
   * The seven shared mas_* tables are created from the canonical DDL in
   * ./ormSchema (issue #782) — do not re-add their DDL here.
   */
  initializeSchema(sessionId: string): void {
    // 1. Categories Table
    this.sql.exec(ormTableSql("mas_categories"));

    // 2. Referrals Table
    ensureSharedTable(this.sql, "mas_referrals");

    // 3. Sponsored Marketplace Ads Table
    ensureSharedTable(this.sql, "mas_ads");

    // 4. External Ads & Network Inventory Table
    this.sql.exec(ormTableSql("mas_external_ads"));

    // 5. Transactions Table
    ensureSharedTable(this.sql, "mas_transactions");

    // 6. Messages Table
    ensureSharedTable(this.sql, "mas_messages");

    // 7. Memory Table
    ensureSharedTable(this.sql, "mas_memory");

    // 8. Events Table
    ensureSharedTable(this.sql, "mas_events");
    // Issue #2178 (Q7 S1): chain columns on pre-existing tables.
    ensureAuditChainColumns(this.sql);

    // 8b. Inbound webhook replay-protection nonces (issue #143 P0)
    this.sql.exec(ormTableSql("webhook_replay_nonces"));

    // 8c. Scheduled-run reports (issues #278, #308) — the DDL lives in
    // src/services/scheduledReports.ts ensureScheduledReportsTable(),
    // which is migration-safe on pre-#308 tables (PRAGMA-checked
    // ALTER for generation_id before the unique index).
    // Issue #389: the ORM used to carry its own duplicate DDL here,
    // creating the unique index WITHOUT the column guard — any DO
    // whose mas_reports predated #308 threw SQLITE_ERROR
    // "no such column: generation_id" on every schema init.
    // Never duplicate this DDL again; the service is the single source.
    ensureScheduledReportsTable(this.sql);

    // 9. Trades & E*TRADE Orders Table
    this.sql.exec(ormTableSql("mas_trades"));

    // Issue #3089: broker stamp on stored drafts. Pre-existing tables
    // lack the column (CREATE TABLE IF NOT EXISTS never alters), so
    // guard the ALTER with a PRAGMA check — the #308 generation_id
    // precedent: an unguarded DDL change throws on every schema init
    // for tables that predate it.
    // #4282 P3 owns these two guarded ALTERs (broker, price_source):
    // they stay inline here until the reconciliation catalogue lands.
    {
      const cols = Array.from(this.sql.exec("PRAGMA table_info(mas_trades)")) as Array<{ name?: unknown }>;
      if (!cols.some((c) => c.name === "broker")) {
        this.sql.exec("ALTER TABLE mas_trades ADD COLUMN broker TEXT");
      }
    }

    // Issue #3782: price provenance on stored drafts (JSON-encoded
    // OrderPriceSource). Same guarded-ALTER precedent as broker
    // above — pre-existing tables lack the column.
    {
      const cols = Array.from(this.sql.exec("PRAGMA table_info(mas_trades)")) as Array<{ name?: unknown }>;
      if (!cols.some((c) => c.name === "price_source")) {
        this.sql.exec("ALTER TABLE mas_trades ADD COLUMN price_source TEXT");
      }
    }

    // 10. Watchlists Table (E*TRADE & Local Agent Watchlists)
    ensureSharedTable(this.sql, "mas_watchlists");

    // 11. Options Chain Cache Table (Durable Options Storage)
    this.sql.exec(ormTableSql("mas_options_chain_cache"));

    // Seed Categories if table is empty
    if (this.categories.count() === 0) {
      const now = new Date().toISOString();
      const seedCategories = marketplaceSeedData(now).categories;

      for (const cat of seedCategories) {
        this.categories.create(cat);
      }
    }

    // Seed External Ads if table is empty
    if (this.externalAds.count() === 0) {
      const now = new Date().toISOString();
      const seedExternalAds = marketplaceSeedData(now).externalAds;

      for (const extAd of seedExternalAds) {
        this.externalAds.create(extAd);
      }
    }

    // Seed Sponsored Marketplace Ads if table is empty
    if (this.ads.count() === 0) {
      const now = new Date().toISOString();
      const seedAds = marketplaceSeedData(now).ads;

      for (const ad of seedAds) {
        this.ads.create(ad);
      }
    }
  }

  /**
   * Introspects database schema and returns metadata for all tables.
   */
  listTables(includeExtensions: boolean = false): TableMetadata[] {
    const tableDescriptions: Record<string, string> = {
      mas_categories: "Referral categories taxonomy for partner links",
      mas_referrals: "User-submitted affiliate and community referral links",
      mas_ads: "Direct sponsored offers and partner marketplace promotions",
      mas_external_ads: "External ad network inventory, placements, and live earnings",
      mas_transactions: "Financial ledger with Agent DID signatures across Stripe, PayPal, Lemon Squeezy",
      mas_messages: "Persistent conversation history and multi-turn prompt transcripts",
      mas_memory: "Session facts and long-term user preferences key-value store",
      mas_events: "Real-time audit log of router decisions, HITL approvals, and agent executions",
      webhook_replay_nonces: "Inbound webhook replay-protection nonces (provider-derived event identities, 24h TTL)",
      mas_trades: "E*TRADE brokerage trading orders with cryptographic Agent DID attestation",
      mas_reports: "Durable reports generated by scheduled runs (screener, IV collection, retention), searchable by the NextGenTP agent",
    };

    if (includeExtensions) {
      tableDescriptions.mas_watchlists = "E*TRADE and local durable watchlists with saved screen results and stock ticker sets";
    }

    const tables = Object.keys(tableDescriptions);
    const result: TableMetadata[] = [];

    for (const tbl of tables) {
      try {
        const countRaw = Array.from(this.sql.exec(`SELECT COUNT(*) AS count FROM ${tbl}`)) as Array<{ count: number }>;
        const rowCount = countRaw[0]?.count ?? 0;

        const infoRaw = Array.from(this.sql.exec(`PRAGMA table_info(${tbl})`)) as Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: any;
          pk: number;
        }>;

        const columns = infoRaw.map((col) => ({
          name: col.name,
          type: col.type,
          isPrimary: Boolean(col.pk),
        }));

        result.push({
          name: tbl,
          description: tableDescriptions[tbl],
          rowCount,
          columns,
        });
      } catch {
        // Table may not exist yet
      }
    }

    return result;
  }

  /**
   * Reads raw table data with optional limit, offset, and keyword filter.
   */
  getTableData(tableName: string, options: { limit?: number; offset?: number; search?: string } = {}): {
    tableName: string;
    total: number;
    rows: any[];
  } {
    const cleanTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    const limit = Math.min(Math.max(options.limit || 50, 1), 200);
    const offset = Math.max(options.offset || 0, 0);

    const countRaw = Array.from(this.sql.exec(`SELECT COUNT(*) AS count FROM ${cleanTable}`)) as Array<{ count: number }>;
    const total = countRaw[0]?.count ?? 0;

    let query = `SELECT * FROM ${cleanTable}`;
    const args: unknown[] = [];

    // #1968: the column inventory is read for every browse, not just for
    // search — a table with a created_at column reads newest-first, so a
    // keyword search surfaces recent matches instead of arbitrary
    // first-N insertion order (the pre-fix browse had no ORDER BY, so a
    // search over a large table could miss recent rows entirely behind
    // the limit). Tables without created_at keep their previous
    // unspecified order rather than erroring on a missing column.
    const infoRaw = Array.from(this.sql.exec(`PRAGMA table_info(${cleanTable})`)) as Array<{ name: string; type: string }>;
    const hasCreatedAt = infoRaw.some((c) => c.name === "created_at");

    if (options.search && options.search.trim()) {
      // Find text columns to filter
      const textCols = infoRaw.filter((c) => c.type.toUpperCase().includes("CHAR") || c.type.toUpperCase().includes("TEXT"));

      if (textCols.length > 0) {
        const searchClauses = textCols.map((c) => `lower(${c.name}) LIKE ?`);
        query += ` WHERE ${searchClauses.join(" OR ")}`;
        for (let i = 0; i < textCols.length; i++) {
          args.push(`%${options.search.trim().toLowerCase()}%`);
        }
      }
    }

    if (hasCreatedAt) {
      query += ` ORDER BY created_at DESC`;
    }
    query += ` LIMIT ${limit} OFFSET ${offset}`;
    const rows = Array.from(this.sql.exec(query, ...args)) as any[];

    return {
      tableName: cleanTable,
      total,
      rows,
    };
  }

  /**
   * Computes comprehensive platform revenue analytics across all streams.
   */
  getRevenueSummary(): RevenueSummary {
    // #2345: the computation is the shared pure core in
    // data/marketplacePorts (computeRevenueSummaryFromRows) so
    // the sync facade summary and the async ports summary can
    // never drift; this method only supplies the rows from this
    // instance's own repositories, as before.
    return computeRevenueSummaryFromRows({
      externalAds: this.externalAds.findMany(),
      ads: this.ads.findMany(),
      transactions: this.transactions.findMany(),
      referrals: this.referrals.findMany(),
    });
  }

  // =========================================================================
  // Watchlist Persistence Layer (Durable SQLite)
  // =========================================================================

  saveWatchlist(params: {
    id?: string;
    name: string;
    userLogin: string;
    symbols: string[];
    items?: any[];
    source?: string;
  }): WatchlistRecord {
    const now = new Date().toISOString();
    const id = params.id || `wl_${crypto.randomUUID().slice(0, 10)}`;
    const existing = this.watchlists.findById(id);

    const record: WatchlistRecord = {
      id,
      name: params.name.trim(),
      userLogin: params.userLogin,
      symbolsJson: JSON.stringify(Array.from(new Set(params.symbols.map((s) => s.toUpperCase().trim())))),
      itemsJson: params.items ? JSON.stringify(params.items) : undefined,
      source: params.source || "local_durable_sqlite",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    if (existing) {
      this.watchlists.update(id, record);
    } else {
      this.watchlists.create(record);
    }

    return record;
  }

  getWatchlists(userLogin?: string): WatchlistRecord[] {
    if (userLogin) {
      return this.watchlists.findMany({
        where: { userLogin },
        orderBy: "updated_at DESC",
      });
    }
    return this.watchlists.findMany({ orderBy: "updated_at DESC" });
  }

  getWatchlistById(id: string): WatchlistRecord | null {
    return this.watchlists.findById(id);
  }

  getWatchlistByName(name: string, userLogin?: string): WatchlistRecord | null {
    const cleanName = name.trim().toLowerCase();
    const all = this.getWatchlists(userLogin);
    return all.find((w) => w.name.toLowerCase() === cleanName) || null;
  }

  deleteWatchlist(id: string): boolean {
    return this.watchlists.delete(id);
  }

  // =========================================================================
  // Options Chain Persistence & Caching Layer (Durable SQLite)
  // =========================================================================

  getOptionsChain(symbol: string): { expirations: any[]; chains: any[]; fetchedAt: number; contractCount: number } | null {
    const sym = symbol.toUpperCase().trim();
    const record = this.optionsChainCache.findById(sym);
    if (!record) return null;
    if (Date.now() > record.expiresAt) return null;
    try {
      return {
        expirations: JSON.parse(record.expirationsJson),
        chains: JSON.parse(record.chainsJson),
        fetchedAt: record.fetchedAt,
        contractCount: record.contractCount,
      };
    } catch {
      return null;
    }
  }

  setOptionsChain(symbol: string, expirations: any[], chains: any[], ttlSeconds: number = 600): void {
    const sym = symbol.toUpperCase().trim();
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const contractCount = chains.reduce(
      (count: number, chain: any) =>
        count +
        (chain.pairs || []).reduce(
          (pairCount: number, pair: any) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)),
          0
        ),
      0
    );
    this.optionsChainCache.upsert({
      id: sym,
      symbol: sym,
      expirationsJson: JSON.stringify(expirations),
      chainsJson: JSON.stringify(chains),
      fetchedAt: now,
      expiresAt,
      contractCount,
    });
  }

  /**
   * Issue #255: raw read escape hatch for comparisons the Repository
   * helpers can't express (e.g. `created_at < ?` for retention pruning).
   * All values still travel as bound args — never interpolate into the SQL.
   *
   * @deprecated Superseded by the port range reads (#2345):
   * MessagePort.idsCreatedBefore, EventLogPort.idsCreatedBefore,
   * and MemoryPort.keysUpdatedBefore cover the retention
   * selectors that were this method's last 13-table callers
   * (storageRetention). Retained for the #2280 resource
   * measurement contract (tests/ormExecQueryMeasurement) and
   * non-13-table reads; new code takes a port.
   */
  execQuery(query: string, ...args: unknown[]): any[] {
    const startedAt = Date.now();
    const cursor = this.sql.exec(query, ...args) as Iterable<unknown> & {
      rowsRead?: number;
      rowsWritten?: number;
    };
    // The cursor must be fully consumed before rowsRead/rowsWritten are
    // final (sessionStore.ts execCounted pattern) — Array.from does that.
    const rows = Array.from(cursor);
    const sink = this.resourceSink;
    if (sink) {
      try {
        const res = sink.record({
          ns: "orm",
          op: "query",
          rowsRead: cursor.rowsRead ?? 0,
          rowsWritten: cursor.rowsWritten ?? 0,
          // Template only, never bound values (port contract).
          statement: fingerprintSql(query),
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt,
        });
        if (res instanceof Promise) res.catch(() => {});
      } catch (error) {
        // Recording never throws (port contract); a failing sink must not
        // fail the read. Warn, mirroring durableKv's sink-failure handling.
        console.warn(
          "[orm] resource sink failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return rows;
  }

  /**
   * @deprecated Superseded by the src/data ports (#2345) for the
   * ORM core's 13 tables — this passthrough remains only for
   * the step-4 satellite services (learnings, reflection,
   * strategy reviews, adaptation audit) whose own tables are
   * not among the 13; their port migration is step 4 (#1976).
   * New code takes a port, never this passthrough.
   *
   * Issue #887: SqlStorage passthrough. SqlStorage-style services
   * (learnings, strategy reviews, reflection, adaptation) call
   * `sql.exec(...)` and are handed `ctx.getOrm()` by routes — without
   * this method every such call threw `sql.exec is not a function`
   * (the production reflection job computed no findings and recorded
   * no learnings). Delegating to the wrapped storage makes a
   * DatabaseORM satisfy the SqlStorage interface those services
   * expect. Returns the storage's own cursor (with row iteration and
   * change counts), exactly as a raw SqlStorage would.
   */
  exec(query: string, ...args: unknown[]): Iterable<unknown> {
    return this.sql.exec(query, ...args) as Iterable<unknown>;
  }

  /**
   * Issue #308: single generate→store seam for reports, reached through
   * the ORM. Idempotent on input.generationId — one canonical row per
   * generation, no matter how many channels deliver it. Never throws.
   * Issue #1169 S4-1: the optional env threads the AI/Vectorize
   * bindings to the index hook; callers without bindings omit it and
   * their rows are covered by the backfill route instead.
   */
  storeCanonicalReport(
    input: ScheduledReportInput,
    env?: IndexEnv
  ): CanonicalStoreResult | null {
    return storeReportAtGeneration(this.sql, input, env);
  }
}
