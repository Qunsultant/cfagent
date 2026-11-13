/**
 * Canonical schema for the shared mas_* tables — issue #782
 * (RSI-Data Tier 1, finding C2: dual DDL).
 *
 * Moved in #2345 (#1976 step 3a) from src/orm/schema.ts to
 * src/data/ormSchema.ts — the data layer is the canonical home
 * now; src/orm/schema.ts is a §22 re-export shim. The DDL
 * strings below are byte-identical to the pre-move module.
 *
 * These eight tables used to be defined TWICE with byte-identical DDL:
 * in DatabaseORM.initializeSchema() (src/orm/index.ts) and in
 * OrchestratorAgent.ensureTables() (src/agents/orchestrator.ts). With
 * CREATE TABLE IF NOT EXISTS semantics the first definition to run wins
 * per Durable Object instance, so any edit to one copy would silently
 * fork the schema by instance history. The DDL strings below are the
 * single source; they are byte-identical to both former copies (the
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
 *    initializeSchema. Its instances are guaranteed all eight shared
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

/** The eight mas_* tables shared by the ORM and the orchestrator. */
export const SHARED_MAS_TABLES = [
  "mas_messages",
  "mas_events",
  "mas_memory",
  "mas_referrals",
  "mas_ads",
  "mas_watchlists",
  "mas_transactions",
  "mas_promotions",
] as const;

export type SharedMasTable = (typeof SHARED_MAS_TABLES)[number];

const MAS_MESSAGES_DDL = `
      CREATE TABLE IF NOT EXISTS mas_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;

// Issue #792 determination (RSI-Data C9): mas_events is the
// session-scoped audit/observability log — single insert owner
// OrchestratorAgent.recordAudit (#270) — and deliberately NOT the
// usage-metering store. Tenant usage metering (user_login / run_id /
// category) lives in usage_events (src/services/scheduledReports.ts),
// whose attribution axis and indexed per-tenant reads do not fit this
// table's session_id shape. Keep the two logs distinct.
const MAS_EVENTS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        previous_event_hash TEXT,
        event_hash TEXT
      )
    `;

const MAS_MEMORY_DDL = `
      CREATE TABLE IF NOT EXISTS mas_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

const MAS_REFERRALS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_referrals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT NOT NULL,
        reward_text TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        signups INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `;

const MAS_ADS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_ads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tagline TEXT NOT NULL,
        sponsor TEXT NOT NULL,
        badge TEXT NOT NULL,
        url TEXT NOT NULL,
        cta_text TEXT NOT NULL,
        accent_color TEXT NOT NULL,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `;

const MAS_WATCHLISTS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_watchlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_login TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        items_json TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

const MAS_TRANSACTIONS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_transactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        customer TEXT NOT NULL,
        gateway TEXT NOT NULL,
        gateway_ref TEXT,
        status TEXT NOT NULL,
        checkout_url TEXT,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT,
        proof_signature TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

// Issue #4412 (#1257 fix): mas_promotions — the staged-promotion table
// from #760 (commit e60818fb). Its DDL below is verbatim from
// ensurePromotionsTable() in the retired src/services/stagedPromotion.ts
// (deleted by the #1257 retirement, 638fddf9): same columns, same
// defaults, same index, issued as two separate statements exactly as
// #760 did. The retirement removed the only creation path, so the live
// Orchestrator DO never got the table and the #1257 active-check route's
// SELECT threw "no such table" (owner hit 2026-11-13: 500
// FAILURE_PROMOTIONS_ACTIVE_CHECK_QUERY). Registering it here restores
// the table through the canonical shared-schema mechanism — no promotion
// logic is resurrected, and the check route is untouched.
const MAS_PROMOTIONS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_promotions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'shadow',
        stage_started_at TEXT NOT NULL,
        baseline_json TEXT NOT NULL DEFAULT '{}',
        applied_json TEXT NOT NULL DEFAULT '{}',
        last_check_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;

const MAS_PROMOTIONS_INDEX_DDL = `
      CREATE INDEX IF NOT EXISTS idx_promotions_candidate ON mas_promotions(candidate_id, created_at)
    `;

/** Canonical DDL per shared table, byte-identical to the former copies. */
export const SHARED_TABLE_DDL: Readonly<Record<SharedMasTable, string>> = {
  mas_messages: MAS_MESSAGES_DDL,
  mas_events: MAS_EVENTS_DDL,
  mas_memory: MAS_MEMORY_DDL,
  mas_referrals: MAS_REFERRALS_DDL,
  mas_ads: MAS_ADS_DDL,
  mas_watchlists: MAS_WATCHLISTS_DDL,
  mas_transactions: MAS_TRANSACTIONS_DDL,
  mas_promotions: MAS_PROMOTIONS_DDL,
};

/** Create one shared table (IF NOT EXISTS) from the canonical DDL. */
export function ensureSharedTable(sql: SqlStorage, table: SharedMasTable): void {
  sql.exec(SHARED_TABLE_DDL[table]);
}

/**
 * Issue #4412: create the mas_promotions candidate index (the second
 * #760 statement). Separate exec, like the #760 service's two calls
 * and the repo's adapter pattern — SqlStorage.exec takes one statement
 * at a time, so the index never rides inside the CREATE TABLE string.
 */
export function ensurePromotionsIndex(sql: SqlStorage): void {
  sql.exec(MAS_PROMOTIONS_INDEX_DDL);
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
    sql.exec(`ALTER TABLE mas_events ADD COLUMN previous_event_hash TEXT`);
  }
  if (!names.has("event_hash")) {
    sql.exec(`ALTER TABLE mas_events ADD COLUMN event_hash TEXT`);
  }
}

/** Create every shared table, in SHARED_MAS_TABLES order. */
export function ensureSharedTables(sql: SqlStorage): void {
  for (const table of SHARED_MAS_TABLES) {
    ensureSharedTable(sql, table);
  }
}
