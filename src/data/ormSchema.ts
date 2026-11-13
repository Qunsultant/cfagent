/**
 * Canonical schema for the shared mas_* tables — issue #782
 * (RSI-Data Tier 1, finding C2: dual DDL).
 *
 * Moved in #2345 (#1976 step 3a) from src/orm/schema.ts to
 * src/data/ormSchema.ts — the data layer is the canonical home
 * now; src/orm/schema.ts is a §22 re-export shim. #4282 P2a moved
 * the DDL strings themselves into the schema catalogue
 * (src/data/schemaComponent/ormCatalogue.ts); this module re-exports
 * them by code (SHARED_TABLE_DDL below), so it stays the canonical
 * module every consumer imports while the catalogue is the single
 * home for the text.
 *
 * These seven tables used to be defined TWICE with byte-identical DDL:
 * in DatabaseORM.initializeSchema() (src/orm/index.ts) and in
 * OrchestratorAgent.ensureTables() (src/agents/orchestrator.ts). With
 * CREATE TABLE IF NOT EXISTS semantics the first definition to run wins
 * per Durable Object instance, so any edit to one copy would silently
 * fork the schema by instance history. The DDL strings below are the
 * single source by code; they are byte-identical to both former copies (the
 * drift pin in tests/schema_single_source.test.ts proves the effective
 * DDL of both initialization paths equals these strings). Never define
 * a shared table's DDL anywhere else — the same lesson as mas_reports
 * (issue #389), whose DDL lives only in
 * src/services/scheduledReports.ts for the same reason.
 *
 * Per-DO schema-initialization coverage (verified on main @ bf1534c0):
 *  - OrchestratorAgent (wrangler ORCHESTRATOR_AGENT binding, exported as
 *    SearchAgent): getOrm() runs ensureTables() AND
 *    DatabaseORM.initializeSchema() — the ONLY production call site of
 *    initializeSchema. Its instances are guaranteed all seven shared
 *    tables plus the five ORM-only tables below.
 *  - ORM-only tables (DDL stays in orm/index.ts initializeSchema, its
 *    only definition): mas_categories, mas_external_ads,
 *    webhook_replay_nonces, mas_trades, mas_options_chain_cache.
 *  - ResearchAgent (RESEARCH_AGENT binding): constructs a DatabaseORM
 *    over its own storage but its getOrm() is never invoked and it
 *    never calls initializeSchema; its tables are the research_* set
 *    from its own ensureTables. No reliance on ORM-only tables.
 *  - ScreenerAgent (SCREENER_AGENT binding): uses its DatabaseORM for
 *    ETradeService (ORM optional/guarded, issue #781). It writes no
 *    mas_reports rows: issue #783 removed its dead second copy (the
 *    canonical screener report is stored by OrchestratorAgent). It
 *    does not call initializeSchema and has no direct reliance on the
 *    ORM-only tables.
 *  - SlackAgent: exported but has NO wrangler Durable Object binding;
 *    production Slack traffic is served by OrchestratorAgent instances,
 *    whose getOrm() initializes the schema. The class itself reads
 *    orm.trades (mas_trades, ORM-only) without calling
 *    initializeSchema — if it were ever bound standalone, that table
 *    would not be guaranteed. Pre-existing state, documented here per
 *    issue #782; not changed by the single-sourcing.
 */

import type { SqlStorage } from "./repositoryPorts";
import {
  ormAuditChainAlterSql,
  ormTableSql,
} from "./schemaComponent/ormCatalogue";

/** The seven mas_* tables shared by the ORM and the orchestrator. */
export const SHARED_MAS_TABLES = [
  "mas_messages",
  "mas_events",
  "mas_memory",
  "mas_referrals",
  "mas_ads",
  "mas_watchlists",
  "mas_transactions",
] as const;

export type SharedMasTable = (typeof SHARED_MAS_TABLES)[number];

// Issue #792 determination (RSI-Data C9): mas_events is the
// session-scoped audit/observability log — single insert owner
// OrchestratorAgent.recordAudit (#270) — and deliberately NOT the
// usage-metering store. Tenant usage metering (user_login / run_id /
// category) lives in usage_events (src/services/scheduledReports.ts),
// whose attribution axis and indexed per-tenant reads do not fit this
// table's session_id shape. Keep the two logs distinct.

/**
 * Canonical DDL per shared table, byte-identical to the former copies.
 *
 * #4282 P2a: the DDL strings live in the schema catalogue
 * (src/data/schemaComponent/ormCatalogue.ts) — this record is the
 * same strings by code, so the drift pin's canonical-module
 * assertions and every SHARED_TABLE_DDL consumer keep working
 * unchanged. Never define a shared table's DDL anywhere else.
 */
export const SHARED_TABLE_DDL: Readonly<Record<SharedMasTable, string>> = {
  mas_messages: ormTableSql("mas_messages"),
  mas_events: ormTableSql("mas_events"),
  mas_memory: ormTableSql("mas_memory"),
  mas_referrals: ormTableSql("mas_referrals"),
  mas_ads: ormTableSql("mas_ads"),
  mas_watchlists: ormTableSql("mas_watchlists"),
  mas_transactions: ormTableSql("mas_transactions"),
};

/** Create one shared table (IF NOT EXISTS) from the canonical DDL. */
export function ensureSharedTable(sql: SqlStorage, table: SharedMasTable): void {
  sql.exec(SHARED_TABLE_DDL[table]);
}

/**
 * Issue #2178 (Q7 S1): chain columns for mas_events on tables created
 * before the columns existed. CREATE TABLE IF NOT EXISTS never
 * migrates, so each missing column is added explicitly (the
 * orchestrator.ts:1115 PRAGMA-check pattern). Idempotent: a table
 * that already has the columns is untouched.
 */
export function ensureAuditChainColumns(sql: SqlStorage): void {
  const info = Array.from(sql.exec(`PRAGMA table_info(mas_events)`)) as Array<{ name: string }>;
  const names = new Set(info.map((c) => c.name));
  if (!names.has("previous_event_hash")) {
    sql.exec(ormAuditChainAlterSql("previous_event_hash"));
  }
  if (!names.has("event_hash")) {
    sql.exec(ormAuditChainAlterSql("event_hash"));
  }
}

/** Create every shared table, in SHARED_MAS_TABLES order. */
export function ensureSharedTables(sql: SqlStorage): void {
  for (const table of SHARED_MAS_TABLES) {
    ensureSharedTable(sql, table);
  }
}
