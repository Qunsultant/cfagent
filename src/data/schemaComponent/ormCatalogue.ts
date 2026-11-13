/**
 * #4282 P2a — catalogue ORM + index-schema section: the shared mas_*
 * tables, the ORM-only tables, and the index-schema modules.
 *
 * This module is the ORM/index plane's single home for statement
 * text. `src/data/ormSchema.ts` (ensureSharedTable /
 * ensureAuditChainColumns), `src/data/ormFacade.ts`
 * (DatabaseORM.initializeSchema's five ORM-only tables), and the four
 * index-schema modules assemble their DDL from the codes here and
 * remain the executors — delegation, not absorption.
 *
 * Contents (measured from the base helpers at 4161aaad, before the
 * delegation): 22 statements — 12 CREATE TABLE (7 shared + 5
 * ORM-only), 2 ALTER TABLE (the mas_events audit-chain columns),
 * 8 CREATE INDEX (3 framework-queue + 3 retention + 1
 * unified-schedule + 1 job-run-record). The filing said "~15
 * statements (7 + 5 real TABLE, 12 INDEX)"; the re-measurement
 * corrects it: the 12 INDEX is a grep count (4 of the 12 lines are
 * comment mentions — the executable count is 8), and the filing
 * never counted the 2 audit-chain ALTERs that
 * ensureAuditChainColumns executes.
 *
 * NOT catalogued here (P3 owns them): the 2 guarded ALTER TABLEs
 * on mas_trades in ormFacade.initializeSchema (broker,
 * price_source) — they stay inline until P3's reconciliation
 * catalogue. The mas_reports DDL stays in
 * src/services/scheduledReports.ts via ensureScheduledReportsTable
 * (issue #389 single-source rule); it is not an ORM-table entry.
 *
 * Code naming (`<kind>.<plane>.<table>.<action>`):
 *  - CREATE TABLE: `create_table` (plane "orm").
 *  - ALTER TABLE ADD COLUMN: `alter_table_add_column_<column>`.
 *  - CREATE INDEX: `create_index_<index-name>` (plane "index").
 *
 * Statement text is byte-identical to the base helpers' executed
 * strings — including the leading/trailing whitespace of the
 * ormSchema/ormFacade template literals — so delegation changes no
 * executed byte (pinned by the sha256 test in
 * tests/schema_component_orm_catalogue.test.ts).
 *
 * This file was GENERATED from the base helpers by
 * ~/workspace/w4282/evidence-p2a/gen-orm-catalogue.ts (run as a
 * temporary vitest file against the base tree, then deleted) —
 * re-run the generator to change it, and review the emitted diff;
 * do not hand-edit the entries.
 */
import { createCatalogue, type SchemaCatalogue } from "./catalogue";
import type { CatalogueEntry } from "./catalogueTypes";

/** The ORM + index-schema section's entries, in execution order. */
export const ORM_CATALOGUE_ENTRIES: CatalogueEntry[] = [
  {
    code: "schema.orm.mas_messages.create_table",
    plane: "orm",
    table: "mas_messages",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_events.create_table",
    plane: "orm",
    table: "mas_events",
    statement: `
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
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_memory.create_table",
    plane: "orm",
    table: "mas_memory",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_referrals.create_table",
    plane: "orm",
    table: "mas_referrals",
    statement: `
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
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_ads.create_table",
    plane: "orm",
    table: "mas_ads",
    statement: `
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
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_watchlists.create_table",
    plane: "orm",
    table: "mas_watchlists",
    statement: `
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
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_transactions.create_table",
    plane: "orm",
    table: "mas_transactions",
    statement: `
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
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_events.alter_table_add_column_previous_event_hash",
    plane: "orm",
    table: "mas_events",
    statement: `ALTER TABLE mas_events ADD COLUMN previous_event_hash TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_events.alter_table_add_column_event_hash",
    plane: "orm",
    table: "mas_events",
    statement: `ALTER TABLE mas_events ADD COLUMN event_hash TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_categories.create_table",
    plane: "orm",
    table: "mas_categories",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL,
        icon TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_external_ads.create_table",
    plane: "orm",
    table: "mas_external_ads",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_external_ads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        network TEXT NOT NULL,
        placement TEXT NOT NULL,
        title TEXT NOT NULL,
        tagline TEXT NOT NULL,
        cta_text TEXT NOT NULL,
        target_url TEXT NOT NULL,
        banner_image_url TEXT,
        cpm_rate REAL DEFAULT 15.0,
        cpc_rate REAL DEFAULT 1.25,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        earnings REAL DEFAULT 0.0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.webhook_replay_nonces.create_table",
    plane: "orm",
    table: "webhook_replay_nonces",
    statement: `
      CREATE TABLE IF NOT EXISTS webhook_replay_nonces (
        nonce TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_trades.create_table",
    plane: "orm",
    table: "mas_trades",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_trades (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        order_type TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        total_value REAL NOT NULL,
        status TEXT NOT NULL,
        order_ref TEXT,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT,
        proof_signature TEXT NOT NULL,
        preview_notes TEXT,
        expiration_schedule_id TEXT,
        broker TEXT,
        price_source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_options_chain_cache.create_table",
    plane: "orm",
    table: "mas_options_chain_cache",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_options_chain_cache (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        expirations_json TEXT NOT NULL,
        chains_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        contract_count INTEGER NOT NULL DEFAULT 0
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.cf_agents_jobs.create_index_idx_cf_agents_jobs_time",
    plane: "index",
    table: "cf_agents_jobs",
    index: "idx_cf_agents_jobs_time",
    statement: `CREATE INDEX IF NOT EXISTS idx_cf_agents_jobs_time ON cf_agents_jobs(time)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.cf_agents_jobs.create_index_idx_cf_agents_jobs_exclusive_time",
    plane: "index",
    table: "cf_agents_jobs",
    index: "idx_cf_agents_jobs_exclusive_time",
    statement: `CREATE INDEX IF NOT EXISTS idx_cf_agents_jobs_exclusive_time ON cf_agents_jobs(exclusive, time)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.cf_agents_jobs.create_index_idx_cf_agents_jobs_singleflight_running",
    plane: "index",
    table: "cf_agents_jobs",
    index: "idx_cf_agents_jobs_singleflight_running",
    statement: `CREATE INDEX IF NOT EXISTS idx_cf_agents_jobs_singleflight_running ON cf_agents_jobs(singleflight, running, execution_started_at, hung_timeout_seconds)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_messages.create_index_idx_mas_messages_created",
    plane: "index",
    table: "mas_messages",
    index: "idx_mas_messages_created",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_messages_created ON mas_messages(created_at, id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_events.create_index_idx_mas_events_created",
    plane: "index",
    table: "mas_events",
    index: "idx_mas_events_created",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_events_created ON mas_events(created_at, id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_events.create_index_idx_mas_events_session_type",
    plane: "index",
    table: "mas_events",
    index: "idx_mas_events_session_type",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_events_session_type ON mas_events(session_id, type, created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.unified_schedules.create_index_unified_schedules_created_idx",
    plane: "index",
    table: "unified_schedules",
    index: "unified_schedules_created_idx",
    statement: `CREATE INDEX IF NOT EXISTS unified_schedules_created_idx ON unified_schedules (created_at ASC, id ASC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_run_records.create_index_job_run_records_recent_idx",
    plane: "index",
    table: "job_run_records",
    index: "job_run_records_recent_idx",
    statement: `CREATE INDEX IF NOT EXISTS job_run_records_recent_idx ON job_run_records (started DESC, id DESC)`,
    kind: "schema",
    form: "literal",
  },
];

/** Build a fresh catalogue holding the ORM + index-schema section. */
export function buildOrmCatalogue(): SchemaCatalogue {
  const catalogue = createCatalogue();
  for (const entry of ORM_CATALOGUE_ENTRIES) {
    catalogue.register(entry);
  }
  return catalogue;
}

/** The ORM + index-schema section as a registered catalogue (built once at import). */
export const ORM_CATALOGUE: SchemaCatalogue = buildOrmCatalogue();

/** The CREATE TABLE statement for one ORM table (shared or ORM-only), byte-identical to the base. */
export function ormTableSql(table: string): string {
  return ORM_CATALOGUE.get(`schema.orm.${table}.create_table`).statement;
}

/** The ALTER TABLE ADD COLUMN statement for one mas_events audit-chain column, byte-identical to the base. */
export function ormAuditChainAlterSql(column: string): string {
  return ORM_CATALOGUE.get(
    `schema.orm.mas_events.alter_table_add_column_${column}`,
  ).statement;
}

/** The CREATE INDEX statement for one index-schema index, byte-identical to the base. */
export function ormIndexSql(indexName: string): string {
  const entry = ORM_CATALOGUE.entries().find((e) => e.index === indexName);
  if (!entry) {
    throw new Error(`no ORM catalogue entry for index ${indexName}`);
  }
  return entry.statement;
}
