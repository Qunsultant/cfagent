/**
 * Issue #1548 ([AGENTIC] Slice 0) — portable versioned migration
 * runner (R3).
 *
 * Rules this runner enforces:
 *  - A table's DDL lives in exactly one migration file. The runner
 *    never invents DDL; it only executes listed migrations in
 *    version order.
 *  - The `_migrations` bookkeeping table is owned by the runner
 *    itself, not by any migration file.
 *  - Application is idempotent and re-runnable: a migration whose
 *    version is already recorded is skipped, and a migration's
 *    statements are all `IF NOT EXISTS` / `OR IGNORE` shaped, so a
 *    partial apply (crash between statements) converges on retry.
 *  - The `_migrations` row is written LAST for each migration, so
 *    the row is the commit marker: no row means "not applied",
 *    regardless of how many statements already landed.
 *  - Concurrent ensures can both observe a version as unrecorded
 *    before either writes that marker. The marker's PRIMARY KEY is
 *    the race arbiter: the caller whose insert loses re-reads the
 *    row, and only a row matching the migration's version and name
 *    reads as already applied by the winner; every other outcome
 *    (no row, or a row under a different name) still fails.
 *  - Deliberately NOT wrapped in a multi-statement transaction:
 *    drizzle-orm/d1 implements `db.transaction()` as sequential
 *    BEGIN/COMMIT statements, which is not Postgres-equivalent
 *    atomicity on D1's request-per-statement API. Slice 0 needs no
 *    multi-statement atomicity (every statement is idempotent and
 *    the marker is last); a future multi-statement need must use
 *    the store's atomic primitive (D1 `batch()`) explicitly, not
 *    `db.transaction()` on D1. See the ADR.
 *  - Migration SQL constraint: statements are split on `;`, so a
 *    migration file must not contain a semicolon inside a string
 *    literal. All slice-0 DDL satisfies this.
 *  - Delegation (#4282 P1): a migration's statement text lives in
 *    exactly one place — its catalogue entries in
 *    `src/data/schemaComponent/d1Catalogue.ts` — and each const below
 *    assembles its `sql` from those entries via `d1MigrationSql`.
 *    The runner still executes (version order, idempotent,
 *    marker-last) and still owns the `_migrations` table; only the
 *    text moved. P6e decision (recorded here): the inline seed copies
 *    do NOT remain — every seed line's text lives only in its
 *    catalogue entry, so P6e has nothing left to remove.
 */
import { sql, type SQL } from "drizzle-orm";
import { d1MigrationSql } from "./schemaComponent/d1Catalogue";

export interface DataMigration {
  version: number;
  name: string;
  sql: string;
}

/** Minimal structural surface the runner needs from a Drizzle DB. */
export interface MigrationDb {
  all<T>(query: SQL): Promise<T[]>;
  run(query: SQL): Promise<unknown>;
}

/**
 * Migration 0001 — agent_governance (halt rows only). Portable
 * subset (R2): `?` params only where params exist (DDL has none),
 * epoch-ms integers, no dialect date functions, no RETURNING.
 * The tenant/scope index serves the latest-row read; the
 * `set_at_ms DESC` ordering matches the read's ORDER BY.
 */
export const MIGRATION_0001_AGENT_GOVERNANCE: DataMigration = {
  version: 1,
  name: "0001_agent_governance",
  sql: d1MigrationSql(1),
};

/**
 * Migration 0002 — agent_chains + agent_synthesized_schedules
 * (slice 1, issue #1651). Portable subset (R2): epoch-ms
 * integers, no dialect date functions, no RETURNING. The `id`
 * column is the deterministic replay key
 * `<tenant_id>:<chain_or_schedule_id>:<version>`, so replaying
 * the same version conflicts on the primary key and is a no-op
 * under the adapters' onConflictDoNothing writes. The
 * tenant/chain/version indexes serve the latest-row reads.
 */
export const MIGRATION_0002_AGENT_CHAINS_SCHEDULES: DataMigration = {
  version: 2,
  name: "0002_agent_chains_schedules",
  sql: d1MigrationSql(2),
};

/**
 * Issue #1676: agent_shard_jobs. Grain: one row per (chain,
 * job, version). The PRIMARY KEY on (tenant_id, chain_id,
 * job_key, version) is the idempotency guarantee: replaying
 * the same version is ON CONFLICT DO NOTHING, so at-least-once
 * projection delivery is safe. Row shape mirrors the R4
 * columns: tenant/workspace/chain/version, timestamps,
 * provenance. The result_json column is capped by the
 * projector (see src/data/shardJobProjection.ts), never by
 * the database.
 */
export const MIGRATION_0003_AGENT_SHARD_JOBS: DataMigration = {
  version: 3,
  name: "0003_agent_shard_jobs",
  sql: d1MigrationSql(3),
};

/**
 * Issue #1688: agent_chain_audit + agent_reports. Grain:
 * agent_chain_audit is one row per lifecycle event (never a
 * log blob); agent_reports is one row per (tenant, report,
 * version). The PRIMARY KEY lines below use four-space
 * indent so the DDL/schema parity test's two-space column
 * matcher reads columns only, not the constraint line.
 */
export const MIGRATION_0004_AGENT_AUDIT_REPORTS: DataMigration = {
  version: 4,
  name: "0004_agent_audit_reports",
  sql: d1MigrationSql(4),
};

/**
 * Migration 0005 — agent_market_nodes + agent_market_edges
 * (issue #1740, Hybrid RAG). Portable subset (R2): epoch-ms
 * integers, no dialect date functions, no RETURNING. Grain:
 * one row per (tenant, node type, node key) / one row per
 * (tenant, from, relation, to). The 4-space PRIMARY KEY lines
 * are constraint lines, not columns, for the parity test's
 * two-space column matcher (same shape as migration 0004).
 */
export const MIGRATION_0005_AGENT_MARKET_GRAPH: DataMigration = {
  version: 5,
  name: "0005_agent_market_graph",
  sql: d1MigrationSql(5),
};

/**
 * Migration 0006 — agent_thesis_realizations +
 * agent_calibration_decisions (issue #1742, RSI telemetry &
 * calibration engine). Portable subset (R2): epoch-ms
 * integers, booleans as INTEGER 0/1, no dialect date
 * functions, no RETURNING. Grain: realizations one row per
 * (tenant, outcome) — the PRIMARY KEY is the idempotency
 * guarantee, so at-least-once projection delivery is safe
 * (adapters check-then-insert and report duplicates);
 * decisions one row per decision id, updated in place through
 * the governed lifecycle (the row IS the audit trail: frozen
 * snapshot + proposer/decider/applier actors + timestamps).
 * The 4-space PRIMARY KEY lines are constraint lines, not
 * columns, for the parity test's two-space column matcher
 * (same shape as migrations 0004/0005).
 */
export const MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION: DataMigration = {
  version: 6,
  name: "0006_agent_telemetry_calibration",
  sql: d1MigrationSql(6),
};

/**
 * Migration 0007 — commercial account store (#2015/#2020/#2022).
 * Portable subset (same rules as migrations 0001-0006): `?` params
 * only where params exist (DDL has none), epoch-ms integers, no
 * dialect date functions, no RETURNING. The claims index serves
 * the oldest-unredeemed lookup (user + family, FIFO by created).
 */
export const MIGRATION_0007_COMMERCIAL_STORE: DataMigration = {
  version: 7,
  name: "0007_commercial_store",
  sql: d1MigrationSql(7),
};

/**
 * Migration 0008 — subscriptions (#2020/#2127). Portable subset
 * (same rules as migrations 0001-0007): `?` params only where
 * params exist (DDL has none), epoch-ms integers, no dialect
 * date functions, no RETURNING. The tier_source column on the
 * accounts table records WHO granted a stored Subscribed tier:
 * pre-0008 rows have NULL, which the effective-tier helper reads
 * as "operator" (every pre-subscription row was operator-set).
 * The UNIQUE index on provider_payment_ref is the replay guard
 * for purchase: one verified checkout, one subscription.
 */
export const MIGRATION_0008_SUBSCRIPTIONS: DataMigration = {
  version: 8,
  name: "0008_subscriptions",
  sql: d1MigrationSql(8),
};

/**
 * Minimal double-entry journal (#2155, sub-issue of #2012). DDL
 * authority for the journal tables lives here; the Drizzle
 * mapping in drizzleSchema.ts must agree (pinned by test).
 * The chart accounts themselves are seeded by
 * ensureJournalSchema, not by DDL — seeding is data, not schema.
 */
export const MIGRATION_0009_JOURNAL: DataMigration = {
  version: 9,
  name: "0009_journal",
  sql: d1MigrationSql(9),
};

/**
 * Migration 0010 — paid-submission ownership (#2137 follow-ups).
 * Portable subset (same rules as migrations 0001-0009): `?` params
 * only where params exist (DDL has none), epoch-ms integers, no
 * dialect date functions, no RETURNING. One row per submitted
 * paid run; workflow_id is the primary key because the status
 * read is keyed by it.
 */
export const MIGRATION_0010_PAID_SUBMISSIONS: DataMigration = {
  version: 10,
  name: "0010_paid_submissions",
  sql: d1MigrationSql(10),
};

/**
 * Migration 0011 — externalized price catalogue (#2185, sub-issue
 * of #2012). Portable subset (same rules as migrations
 * 0001-0010): `?` params only where params exist (DDL has none),
 * epoch-ms integers, no dialect date functions, no RETURNING.
 * Seeding is data, not schema: the proposed seed rows are written
 * by ensurePriceCatalogueSchema (INSERT OR IGNORE), not by DDL,
 * so an operator-edited price survives re-ensure.
 */
export const MIGRATION_0011_PRICE_CATALOGUE: DataMigration = {
  version: 11,
  name: "0011_price_catalogue",
  sql: d1MigrationSql(11),
};

/**
 * Native ledger (#2192, sub-issue of #2012, umbrella #2146).
 * DDL authority for the native ledger table lives here; the
 * Drizzle mapping in drizzleSchema.ts must agree (pinned by
 * test). Migration number 0012 is KEPT from the superseded
 * PRs #2194/#2234 and was verified free on current main at
 * rebuild time (2026-10-29, main 3d90dfb2: migrations
 * 0001-0011 and 0015 are on main; 0012 is free on main).
 * The UNIQUE index on (session_id, action) is
 * the dedupe backstop: the adapters read-before-write, and
 * the unique index makes a racing second write a no-op
 * instead of a duplicate row.
 */
export const MIGRATION_0012_NATIVE_LEDGER: DataMigration = {
  version: 12,
  name: "0012_native_ledger",
  sql: d1MigrationSql(12),
};

/**
 * Migration 0013 — native subscription payment ids (#2198,
 * sub-issue of #2012, slice 2 of #2146). Number claimed
 * deliberately, not next-in-line: 0010 is claimed by #2187/#2188,
 * 0011 by the price catalogue (#2189, in this stack), and 0012 by
 * the native-ledger draft — so this slice claims 0013 to avoid a
 * merge-sequencing collision. Portable subset (same rules as
 * migrations 0001-0011): DDL only, no params, no dialect date
 * functions, no RETURNING. Both columns are nullable: pre-native
 * (cfpay-era) subscription rows have no Stripe ids, and the
 * replay guard stays the UNIQUE index on provider_payment_ref,
 * unchanged. The Drizzle mapping in drizzleSchema.ts must agree
 * with this DDL.
 */
export const MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS: DataMigration = {
  version: 13,
  name: "0013_subscription_stripe_ids",
  sql: d1MigrationSql(13),
};

/**
 * Migration 0014 — Billing (#2202, sub-issue of #2020,
 * implementation of design #2145). Number claimed
 * deliberately, not next-in-line in this stack alone:
 * 0010 is claimed by #2187/#2188, 0011 by the price
 * catalogue (#2189, in this stack), 0012 by the
 * native-ledger draft (#2194), and 0013 by the
 * subscription-routes slice (#2236, in this stack) — so
 * this slice claims 0014 to avoid a merge-sequencing
 * collision (no open draft claimed 0014 at check time).
 * Portable subset (same rules as migrations 0001-0013):
 * DDL only, no params, no dialect date functions, no
 * RETURNING. Both subscription columns are nullable:
 * repurchase rows have no provider subscription, and the
 * replay guard stays the UNIQUE index on
 * provider_payment_ref, unchanged. The policy table is
 * seeded by ensureBillingPolicySchema (INSERT OR
 * IGNORE), not by DDL, so operator edits survive
 * re-ensure. PREREQUISITE: migrations 0008 + 0013 must
 * be applied first (0014 alters agent_subscriptions).
 */
export const MIGRATION_0014_BILLING: DataMigration = {
  version: 14,
  name: "0014_billing",
  sql: d1MigrationSql(14),
};

/**
 * Migration 0015 — lifecycle email + referral credits (#2208,
 * sub-issue of #2012; advances #2021/#2020; source #1076).
 * Numbering (rebuild onto current main): main tops out at 0011;
 * 0010, 0012, 0013, 0014, 0016, 0017 are claimed by sibling
 * rebuilds in flight, so 0015 stays free for this slice.
 * Merge sequencing: this migration must land AFTER any lower
 * number it is rebased onto; the version column, not file
 * order, decides application order.
 *
 * Tables are referral-only: agent_referral_earnings is a
 * SEPARATE balance from the failure-credit claims
 * (agent_credit_claims) — the two are never joined, and a
 * referral earning never becomes a failure-credit claim.
 *
 * The rule seed below is DATA in the migration, not a code
 * constant: operators change it via the port's setRules with
 * no code deploy. Values are PROPOSED pending owner approval:
 * earn $0.50 on a referred user's first paid run, 7-day vesting
 * before redemption, pay-per-run redemption only (subscription
 * application deferred). The monetization flag stays OFF, so no
 * paid run exists to earn against until activation.
 */
export const MIGRATION_0015_LIFECYCLE_REFERRAL: DataMigration = {
  version: 15,
  name: "0015_lifecycle_referral",
  sql: d1MigrationSql(15),
};

/**
 * Migration 0016 — Q7 audit-policy mechanism (#2183, sub-issue
 * of #2012; proposal slice for CISO+CDO review under #945).
 * DDL authority for the audit-policy tables lives here; the
 * Drizzle mapping in drizzleSchema.ts must agree (pinned by
 * test). The policy rows are OPERATOR DATA, not code: the
 * blocking set, the enforcement mode, and the retention period
 * below are PROPOSED seeds (INSERT OR IGNORE semantics in the
 * ensure path — re-seeding never overwrites an operator edit),
 * pending CISO+CDO sign-off. Enforcement seeds to audit-only;
 * nothing in this migration enables blocking.
 */
export const MIGRATION_0016_AUDIT_POLICY: DataMigration = {
  version: 16,
  name: "0016_audit_policy",
  sql: d1MigrationSql(16),
};

/**
 * Migration 0017 — the #1976 intelligence substrate (issue
 * #2288, step 0 of ADR 0022; D-F + D-F2). Portable subset
 * (same rules as migrations 0001-0016): epoch-ms integers, no
 * dialect date functions, no RETURNING. Numbering: versions
 * 13/14 are absent from the registered sequence and are NOT
 * filled here — their disposition is gate G-3 (owner/CAIO);
 * this migration takes the next number after the highest
 * registered (16).
 *
 * Four families, all D1-native per the ratified R9 restatement:
 *  - agent_trace_records: one row per cross-agent call /
 *    workflow step (correlation + causation, acting agent +
 *    principal per G14, catalog outcome code, latency/cost).
 *    Append-only; retention is gate G-4 and deliberately NOT
 *    encoded here beyond the schema.
 *  - agent_proposals + agent_proposal_transitions: the
 *    proposal ledger state machine (proposed → approved →
 *    applied → verified). Transitions are append-only rows and
 *    carry the gate as data (actor + gate_ref); the port
 *    refuses a gated transition without one.
 *  - agent_fleet_registry + agent_conformance_cells: the
 *    fleet registry / conformance matrix read model. Tables +
 *    ports only in this slice — the production writer is
 *    gate G-6.
 *  - agent_work_item_events: the GitHub work-item projection
 *    (issues / PRs / check-runs) the Sentinel (#2279) reads;
 *    the (source, external_id) PRIMARY KEY is the redelivery
 *    idempotency guarantee, in the migration-0003 pattern.
 *    The 4-space PRIMARY KEY lines are constraint lines, not
 *    columns, for the parity test's two-space column matcher
 *    (same shape as migrations 0004/0005).
 */
export const MIGRATION_0017_INTELLIGENCE_SUBSTRATE: DataMigration = {
  version: 17,
  name: "0017_intelligence_substrate",
  sql: d1MigrationSql(17),
};

/**
 * Migration 0018 — refund records + externalized refund policy
 * (#2204, sub-issue of #2012, implementation of #2147). Numbered
 * 0018: main already carries a different 0017 (intelligence
 * substrate, #2288), and 0014 is claimed by a sibling in flight,
 * so this slice takes max(registered)+1 at build time.
 * Portable subset (same
 * rules as migrations 0001-0013): DDL only, no params, no dialect
 * date functions, no RETURNING. Policy seeding is data, not
 * schema: the proposed policy row is written by
 * ensureRefundSchema (INSERT OR IGNORE), not by DDL, so an
 * operator-edited policy survives re-ensure. The Drizzle mapping
 * in drizzleSchema.ts must agree with this DDL.
 */
export const MIGRATION_0018_REFUNDS: DataMigration = {
  version: 18,
  name: "0018_refunds",
  sql: d1MigrationSql(18),
};

/**
 * Migration 0019 — the #1116 data-provider platform stores
 * (issue #2303, step 1 of ADR 0022; D-0 + D-I step 1).
 * Portable subset (same rules as migrations 0001-0018) with
 * ONE stated deviation: created_at / updated_at / fetched_at
 * are ISO-8601 TEXT, not epoch-ms integers — these tables
 * mirror an existing record contract (the platform stores'
 * ProviderConfigRecord / DataCaptureRecord carry ISO strings,
 * and the port's conformance suite requires the D1 and DO
 * adapters to return identical records), so the D1 columns
 * store the same strings the DO tables store today.
 *
 *  - agent_data_providers + agent_data_provider_routes: the
 *    provider-configuration family. ADR D-0 ruled it
 *    D1-sufficient (fleet-global records, no DO property
 *    consumed) — the programme's first D1 migration.
 *  - agent_data_captures: the capture log. The step-1 audit
 *    ruled D1 by read locality: the family's durable reader
 *    is provider health (a cross-run aggregation) while its
 *    writers are append-only single-row inserts that consume
 *    no DO serialization. Indexes mirror the DO table's
 *    (tenant_id, run_id) and (tenant_id, provider_id).
 */
export const MIGRATION_0019_DATA_PROVIDER_PLATFORM: DataMigration = {
  version: 19,
  name: "0019_data_provider_platform",
  sql: d1MigrationSql(19),
};

/**
 * Migration 0020 — the IV-history table on D1 (issue #2337,
 * step 2 of ADR 0022; D-0 + D-I step 2).
 *
 * The options/discovery family's only D1 residency: the table
 * is tenant-free market data keyed (symbol, date) — the same
 * columns and key as the DO table (mas_iv_history) — while its
 * durable read is a whole-series read whose correctness
 * depends on seeing ALL collected observations, which DO
 * residency silently fragments per collecting instance.
 *
 * CUTOVER GATE (R-2 on #2337): this migration creates the
 * table and the D1 adapter is conformance-proven, but
 * production composition defaults to the DO adapter; the
 * read/write cutover waits on the owner ruling recorded on
 * the issue (backfill vs warming-up restart). Creating an
 * empty table changes no production behaviour.
 */
export const MIGRATION_0020_IV_HISTORY: DataMigration = {
  version: 20,
  name: "0020_iv_history",
  sql: d1MigrationSql(20),
};

/**
 * Migration 0021 — the marketplace tables on D1 (issue #2345,
 * #1976 step 3a; ADR 0022 D-0 + D-I step 3a).
 *
 * mas_categories / mas_referrals / mas_ads / mas_external_ads
 * are fleet-global reference data: seeded identically into
 * every DO instance, with counters (clicks / impressions /
 * signups / earnings) that diverge per instance today. They
 * move to the shared database as agent_* tables with the
 * identical columns, so the marketplace counters become
 * fleet-wide (the disclosed counter-semantics change on
 * #2345). The DO tables are NOT dropped — the unbound
 * composition keeps serving them, and initializeSchema still
 * creates them; this migration only creates the D1 home.
 */
export const MIGRATION_0021_MARKETPLACE: DataMigration = {
  version: 21,
  name: "0021_marketplace",
  sql: d1MigrationSql(21),
};

/**
 * Migration 0022 — D1 regularization (issue #2362, #1976
 * step 4f; ADR 0022 D-A consequences). Five tables that were
 * self-created at runtime — absent from this runner and from
 * drizzleSchema.ts (step-4 audit R-8) — come under version
 * control:
 *
 * - quote_source_setting (src/services/quoteSourceSetting.ts,
 *   issue #2108): the deployment-wide quote source pick.
 * - resource_sql_ops (the #1819 D1 resource-usage adapter):
 *   the table ADR D-A named for early regularization when it
 *   was the only known violation.
 * - resource_daily_rollups / resource_alert_state /
 *   resource_comparison_reports (the #1819 rollup store).
 *
 * The DDL below is the modules' own self-create DDL, verbatim
 * in shape (characterization in
 * tests/d1_regularization_step4f_characterization_2362.test.ts
 * PRAGMA-pins the self-created shapes; the conformance suite
 * pins that this migration produces the identical shapes), so
 * applying 0022 against an instance that already self-created
 * the tables is a no-op (CREATE TABLE IF NOT EXISTS), and the
 * adapters' declared ensure-on-first-use stays a no-op where
 * the runner has already applied it. No data moves; no
 * residency changes.
 */
export const MIGRATION_0022_D1_REGULARIZATION: DataMigration = {
  version: 22,
  name: "0022_d1_regularization",
  sql: d1MigrationSql(22),
};

/**
 * Migration 0023 — agent_mesh_trace_hops (issue #2428, Agent
 * Mesh S17 / G13a unified traces). Portable subset (R2): no
 * dialect functions, epoch-ms integers. One row per recorded
 * trace hop; the (trace_id, span_id) primary key is the
 * idempotency rule — a durable-replay re-record of the same
 * deterministic span converges via ON CONFLICT DO NOTHING in
 * the adapter. The trace index serves the read surface's
 * ordered assembly. Retention: hops are diagnostic records,
 * bounded by the trace volume they observe; no purge contract
 * is declared in this slice (the table joins the retention
 * review with the other AgentDB tables, #1701's contract).
 */
export const MIGRATION_0023_AGENT_MESH_TRACE_HOPS: DataMigration = {
  version: 23,
  name: "0023_agent_mesh_trace_hops",
  sql: d1MigrationSql(23),
};

/**
 * Issue #2439 (Agent Mesh S18, G13b): one row per scored
 * golden-task result, written by the eval harness
 * (src/services/meshGoldenTasks.ts) through the eval result
 * store port and read back by S19's RSI proposal pipeline. The
 * (run_id, task_id) primary key is the recording idempotency
 * rule. Facts/failures/hop-kinds are JSON text carrying scalar
 * evidence only. Retention: eval results are small (one row per
 * task per run) and are the RSI loop's outcome history; no purge
 * contract is declared in this slice (the table joins the
 * retention review with the other AgentDB tables, #1701's
 * contract).
 */
export const MIGRATION_0024_AGENT_MESH_EVAL_RESULTS: DataMigration = {
  version: 24,
  name: "0024_agent_mesh_eval_results",
  sql: d1MigrationSql(24),
};

/**
 * Issue #2460 (Agent Mesh S19, G13c): one row per RSI proposal
 * record, written and advanced by the proposal pipeline
 * (src/services/meshProposalPipeline.ts) through the proposal
 * store port. Evidence refs and the bar verdict are JSON text
 * carrying scalar evidence only (run ids, trace ids, counts,
 * codes). Retention: proposals are the improvement loop's own
 * history — one row per drafted proposal, small by construction;
 * no purge contract is declared in this slice (the table joins
 * the retention review with the other AgentDB tables, #1701's
 * contract).
 */
export const MIGRATION_0025_AGENT_MESH_PROPOSALS: DataMigration = {
  version: 25,
  name: "0025_agent_mesh_proposals",
  sql: d1MigrationSql(25),
};

/**
 * Migration 0026 — per-tenant auto-refresh switch (#2481).
 *
 * Owner decision 2026-10-30: the auto-refresh switch is a
 * per-tenant setting whose source of truth is the tenant store,
 * edited via the dynamic panel. The columns ride the existing
 * agent_tenant_settings row (#2022) so the switch shares the
 * tenant row with the ads flag instead of inventing a second
 * tenant-settings table. Absent row = OFF (see the port
 * defaults); a fresh column default of 0 / 15 matches that.
 * Marker-gated like the other ALTER migrations (0010, 0013),
 * so a re-apply is skipped, never re-ALTERed.
 */
/**
 * Migration 0027 — per-tenant data-provider / broker selection.
 * Two independent selections on the existing agent_tenant_settings
 * row: data_provider_id and broker_id, both defaulting to 'etrade'
 * so an absent row, a pre-migration row, and a store read failure
 * all preserve the pre-existing E*TRADE behaviour. Marker-gated
 * like the other ALTER migrations, so a re-apply is skipped.
 */
export const MIGRATION_0028_TENANT_PROVIDERS: DataMigration = {
  version: 28,
  name: "0028_tenant_providers",
  sql: d1MigrationSql(28),
};

/**
 * Migration 0030 — Billing customer mapping (#2656, Phase 2.1
 * of #2405). Renumbered from 0029 during the rebase onto main
 * 80285a15: main's #2548 claimed 0029 (proof redemptions) while
 * this slice was in flight, so 0030 is the next free number.
 * Standalone table, no prerequisite migration: one
 * row per user (user_id PK), the provider customer id for that
 * user's Billing checkouts. First-wins is enforced by the port
 * (recordCustomer refuses a different id), not by DDL — a
 * UNIQUE index on stripe_customer_id would wrongly forbid two
 * users ever sharing a provider customer (e.g. an operator
 * correction), so none is declared.
 */
export const MIGRATION_0030_BILLING_CUSTOMERS: DataMigration = {
  version: 30,
  name: "0030_billing_customers",
  sql: d1MigrationSql(30),
};

/**
 * Migration 0031 — referral attribution store (#2657, sub-issue of #2405).
 * The ledger itself is #2208 (migration 0015); this migration adds ONLY the
 * missing link #2208 named as follow-up: which referrer a user came from.
 * One row per referred user (referred_user_id PRIMARY KEY = the set-once
 * backstop). Column names match the Drizzle mapping in drizzleSchema.ts
 * (pinned by test). No seed rows: without an operator-recorded attribution
 * the store records nothing and grants nothing (fail closed). The table is
 * referral-only: it never joins agent_credit_claims (failure credits).
 */
export const MIGRATION_0031_REFERRAL_ATTRIBUTION: DataMigration = {
  version: 31,
  name: "0031_referral_attribution",
  sql: d1MigrationSql(31),
};

export const MIGRATION_0032_STORE_OPERATORS: DataMigration = {
  version: 32,
  name: "0032_store_operators",
  sql: d1MigrationSql(32),
};

export const MIGRATION_0033_DEAD_LETTER_STORE: DataMigration = {
  version: 33,
  name: "0033_dead_letter_store",
  sql: d1MigrationSql(33),
};

/**
 * Migration 0035 — scheduled digest pass (#2659, monetization
 * Phase 2.4; renumbered from 0032 during the d768ed02 rebase
 * because #2680 claimed 0032 for store operators, again from
 * 0033 during the 8476478b rebase because #2000 Phase 5 slice 1
 * claimed 0033 for the dead-letter store, and again from 0034
 * during the d7f6057b rebase because #2000 Phase 5 slice 2
 * claimed 0034 for breaker state). Two new
 * tables, no changes to existing tables:
 * - agent_digest_subscriber_emails: the address mail was last
 *   successfully sent to for a subscriber, recorded by the send
 *   routes. Never guessed, never derived from a login; a
 *   subscriber with no row is reported `no-email-on-file` by the
 *   pass and never sent to. Tenant-scoped on write (see
 *   setSubscriberEmail's #1761 fail-closed rule); the pass JOIN
 *   is tenant-aware so an address never leaks across tenants.
 * - agent_digest_pass_days: the once-per-UTC-day marker for the
 *   scheduled pass (written only after a completed pass, so a
 *   thrown pass retries on the next tick; per-user day guards
 *   make the retry idempotent).
 */
export const MIGRATION_0035_DIGEST_PASS: DataMigration = {
  version: 35,
  name: "0035_digest_pass",
  sql: d1MigrationSql(35),
};

export const MIGRATION_0026_TENANT_AUTO_REFRESH: DataMigration = {
  version: 26,
  name: "0026_tenant_auto_refresh",
  sql: d1MigrationSql(26),
};

/**
 * Migration 0027 — price catalogue approval state (#2547, from
 * the #2013 review). Existing rows take the column default
 * 'proposed': every price stored before this migration is a
 * proposal until an operator approves it, which is exactly the
 * fail-closed direction. The approval columns are written only
 * by the catalogue adapters' approvePrice path.
 */
export const MIGRATION_0027_PRICE_CATALOGUE_APPROVAL: DataMigration = {
  version: 27,
  name: "0027_price_catalogue_approval",
  sql: d1MigrationSql(27),
};

/**
 * Migration 0029 — durable payment-proof redemptions (#2548,
 * from the #2013 review). One row per redemption key; the
 * PRIMARY KEY is the cross-instance replay backstop for the
 * native gate's proof redemption (the in-memory byClaim maps
 * remain a per-instance fast path). Numbering: 0027 is #2547's
 * price-catalogue approval migration and 0028 was taken by
 * #2594's tenant-providers migration, both landed ahead of
 * this slice.
 */
export const MIGRATION_0029_PROOF_REDEMPTIONS: DataMigration = {
  version: 29,
  name: "0029_proof_redemptions",
  sql: d1MigrationSql(29),
};

export const MIGRATION_0034_BREAKER_STATE: DataMigration = {
  version: 34,
  name: "0034_breaker_state",
  sql: d1MigrationSql(34),
};

/**
 * Migration 0036 — refund policy owner approval per kind (#2662,
 * monetization Phase 2.7). Mirrors the #2547 price-catalogue approval
 * pattern (migration 0027): approval is operator data, never a code
 * constant. approved_kinds is a JSON array of kinds whose CURRENT
 * values an operator has explicitly approved; approved_by/at record
 * who approved and when. A fresh column defaults to '[]' (nothing
 * approved): pre-#2662 stores read as unapproved, so refunds refuse
 * fail-closed until an operator approves — a seeded PROPOSED value is
 * never an approval. Portable subset: ALTER TABLE ADD COLUMN only,
 * no params, no dialect date functions.
 */
export const MIGRATION_0036_REFUND_POLICY_APPROVAL: DataMigration = {
  version: 36,
  name: "0036_refund_policy_approval",
  sql: d1MigrationSql(36),
};

export const MIGRATION_0037_CFPAY_CHANNEL: DataMigration = {
  version: 37,
  name: "0037_cfpay_channel",
  sql: d1MigrationSql(37),
};

/**
 * Issue #2989: the Cloudflare workflow run-id on shard job rows.
 * Additive only (nullable TEXT, no backfill): rows projected
 * before #2989 keep correlating via the derived id, and the
 * seam's resolveWorkflowRunId prefers a stored id when present.
 * A separate migration (never an edit to 0003, which is already
 * applied): 0003 still owns the table's CREATE DDL.
 */
export const MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID: DataMigration = {
  version: 38,
  name: "0038_agent_shard_jobs_workflow_run_id",
  sql: d1MigrationSql(38),
};

/**
 * Migration 0039 — per-tenant delivery-channel enablement flags
 * (#3169, program #2218). One row per tenant, one flag per
 * channel (email, Slack, webhook, Copilot card, Docs). Absent
 * row = every channel enabled (the port default). Flags ONLY:
 * no URL, token, or secret column — secrets stay in worker
 * bindings. Portable subset: CREATE TABLE IF NOT EXISTS only,
 * no params, no dialect date functions.
 */
export const MIGRATION_0039_TENANT_CHANNELS: DataMigration = {
  version: 39,
  name: "0039_tenant_channels",
  sql: d1MigrationSql(39),
};

/**
 * Migration 0040 — unlimited-free grant columns on the commercial
 * account row (#3245, slice 1 of #3241). Additive only (nullable,
 * no backfill): pre-grant rows read as "no grant", so configuring
 * nothing changes nothing. The three columns are the grant: who
 * granted it (session-verified operator login), why, and the
 * optional expiry epoch-ms (NULL = no expiry). Portable subset:
 * ALTER TABLE ADD COLUMN only, no params, no dialect date
 * functions. A separate migration (never an edit to 0007, which
 * is already applied): 0007 still owns the table's CREATE DDL.
 */
export const MIGRATION_0040_UNLIMITED_FREE_GRANT: DataMigration = {
  version: 40,
  name: "0040_unlimited_free_grant",
  sql: d1MigrationSql(40),
};

/**
 * Migration 0041 — trial days on subscription plans (#3243,
 * slice 3 of #3241). One nullable column: how many days a
 * trial of the plan runs, as OPERATOR DATA. A null/absent
 * trialDays means the plan offers no trial; no trial length
 * is hardcoded anywhere. Additive only (nullable INTEGER,
 * no backfill): existing plans keep no trial. Portable
 * subset: ALTER TABLE only, no params, no dialect date
 * functions. NOTE: 0040 landed first (#3267); 0041 sits
 * after it in ALL_MIGRATIONS (rebuilt as a fresh PR).
 */
export const MIGRATION_0041_PLAN_TRIAL_DAYS: DataMigration = {
  version: 41,
  name: "0041_plan_trial_days",
  sql: d1MigrationSql(41),
};

/**
 * Migration 0042 — server-side onboarding state (#3256, sub-issue
 * of #3241). One row per verified login: the current step (1..5),
 * completion, and the trial plan started from the flow. The
 * tenantId is stamped server-side from the resolved platform
 * identity at write time; it is informational only, never a
 * scoping input. Additive only (new table, no backfill): users
 * who finished the #2471 localStorage-only flow have no row and
 * keep the localStorage fallback.
 */
export const MIGRATION_0042_ONBOARDING_STATE: DataMigration = {
  version: 42,
  name: "0042_onboarding_state",
  sql: d1MigrationSql(42),
};

/**
 * Migration 0043 — free-run counter (#3305, sub-issue of #3241).
 * The agreed Free allowance (10 runs per product per month,
 * operator-managed, changeable) needs durable per-account
 * counts: agent_free_run_counts holds one row per (login,
 * family, UTC calendar month) with the runs consumed in that
 * month (a missing row reads as 0), and
 * agent_free_run_allowances holds one row per family with the
 * current allowance (seeded by migration 0044, INSERT OR
 * IGNORE, so an operator edit survives re-ensure). Additive
 * only (new tables, no backfill): accounts with no rows have
 * consumed nothing.
 */
export const MIGRATION_0043_FREE_RUN_COUNTER: DataMigration = {
  version: 43,
  name: "0043_free_run_counter",
  sql: d1MigrationSql(43),
};

/**
 * Migration 0044 — free-run allowance seed rows (#3315,
 * sub-issue of #3241). The seed value is operator-managed
 * seeded DATA, never a code constant: these INSERT OR IGNORE
 * rows are the only place the decided allowance (10 runs per
 * product per month, entitlements-01.md §4.1) is written for a
 * fresh store. An operator edit survives (INSERT OR IGNORE
 * never overwrites), and a family with no row stays
 * fail-closed — the gate reads the store only and treats a
 * missing row as "no free runs for that family". updated_at_ms
 * 0 marks a seed row no operator has touched yet.
 */
export const MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED: DataMigration = {
  version: 44,
  name: "0044_free_run_allowance_seed",
  sql: d1MigrationSql(44),
};

/**
 * Migration 0045 — IV-history provenance (#3326, programme #3292).
 *
 * `agent_iv_history` was keyed (symbol, date) with no record of which broker's
 * chain produced the observation, so serving an "Alpaca" series would have
 * meant relabelling E*TRADE rows. This adds the provenance column; every
 * pre-existing row defaults to `etrade`, which is what actually produced it.
 * One observation per (symbol, date) is unchanged: the day has one value, and
 * the column says who measured it.
 */
export const MIGRATION_0045_IV_HISTORY_BROKER: DataMigration = {
  version: 45,
  name: "0045_iv_history_broker",
  sql: d1MigrationSql(45),
};

/**
 * #3534/#3548 — the job pipeline's tables, added to the
 * foundation (the pipeline's contribution to it, not a parallel
 * track): definitions, live instances (management state, the
 * resume cursor, and the #3549 stage-runner checkpoint ledger),
 * and persisted step hand-off artifacts. The same DDL is the DO
 * residency's declared v1 schema migration — one table shape in
 * every residency.
 */
export const MIGRATION_0046_JOB_PIPELINE: DataMigration = {
  version: 46,
  name: "0046_job_pipeline",
  sql: d1MigrationSql(46),
};

/**
 * #3534/#3548 — the run-record family's table (job_run_records),
 * declared for the D1 residency: until now the family lived only
 * in its DO adapter's DDL, and workflow-hosted runs had no D1
 * residency to record into. Same columns, same history index.
 */
export const MIGRATION_0047_JOB_RUN_RECORDS: DataMigration = {
  version: 47,
  name: "0047_job_run_records",
  sql: d1MigrationSql(47),
};

/**
 * Migration 0049 — plan price approval (#3357, sub-issue of
 * #2012). Extends the #2547 approval discipline (which covers
 * the per-run price catalogue only) to subscription plan prices:
 * new columns on agent_subscription_plans, mirroring the
 * catalogue's approval_status / approved_by / approved_at_ms.
 * Pre-existing rows are grandfathered as approved: the owner
 * states today's monthly prices (Basic $49.99, Premium $59.99)
 * are approved, so a legacy row must stay chargeable — with
 * approved_by / approved_at_ms NULL, because no approval was
 * recorded for it and none is invented. Any plan created after
 * this migration lands as PROPOSED (the adapter inserts it
 * explicitly) until an operator approves it.
 */
export const MIGRATION_0049_PLAN_PRICE_APPROVAL: DataMigration = {
  version: 49,
  name: "0049_plan_price_approval",
  sql: d1MigrationSql(49),
};

/**
 * Migration 0048 — self-service top-up drafts (#3262).
 *
 * One row per minted top-up: the amount bound at mint, the rail, and
 * the provider evidence needed to verify the payment. The draft id
 * (`topup-<uuid>`) is the replay guard: a draft credits exactly once.
 *
 * Renumbered 0046 → 0048 on the rebase onto main 651d1a9a: #3534
 * landed migrations 0046 (job pipeline) and 0047 (job run records)
 * first. This migration never shipped, so no store has applied
 * the old number.
 */
export const MIGRATION_0048_TOP_UP_DRAFTS: DataMigration = {
  version: 48,
  name: "0048_top_up_drafts",
  sql: d1MigrationSql(48),
};

/**
 * Migration 0050 — user profiles (#3261, sub-issue of #3256).
 * One row per verified login: the display name and phone number
 * the user sets from the account flow. Additive only (new table,
 * no backfill): users with no row have no profile, and callers
 * fall back to the login as the display name (PROPOSED default,
 * display-only). Phone is an UNVERIFIED contact field. No email
 * column: email change needs CISO review first (#3261 comment
 * 6681436382, refs #945).
 */
export const MIGRATION_0050_USER_PROFILES: DataMigration = {
  version: 50,
  name: "0050_user_profiles",
  sql: d1MigrationSql(50),
};

/**
 * Migration 0051 — enriched datasets (#3536, Pipeline J3).
 *
 * The enrich stage's persisted output: one row per enrich run,
 * keyed by enrich job id, the full artifact in artifact_json
 * (the feed-dataset family's pattern) with status and row count
 * denormalized for the latestUsable filter. Declared in the
 * foundation's Drizzle schema (jobEnrichedDatasets) — the same
 * shape in every residency (the DO residency's declared v1
 * schema migration carries the identical DDL).
 */
export const MIGRATION_0051_JOB_ENRICHED_DATASETS: DataMigration = {
  version: 51,
  name: "0051_job_enriched_datasets",
  sql: d1MigrationSql(51),
};

/**
/**
 * Migration 0052 — analyzed datasets (#3537, Pipeline J4).
 *
 * The analyze stage's persisted output: one row per analyze
 * run, keyed by analyze job id, the full artifact in
 * artifact_json (the feed/enriched families' pattern) with
 * status and row count denormalized for the latestUsable
 * filter. Declared in the foundation's Drizzle schema
 * (jobAnalyzedDatasets) — the same shape in every residency
 * (the DO residency's declared v1 schema migration carries
 * the identical DDL).
 */
export const MIGRATION_0052_JOB_ANALYZED_DATASETS: DataMigration = {
  version: 52,
  name: "0052_job_analyzed_datasets",
  sql: d1MigrationSql(52),
};

/**
 * Migration 0054 — approved-free per-service quota (#3263, sub-issue
 * of #3256; ownership COO-spr9).
 *
 * The #3245 unlimited-free grant needs a bound: a per-service cap per
 * period, counted per account. agent_approved_free_quota_counts holds
 * one row per (tenant, login, family, period) with the runs consumed
 * in that period (a missing row reads as 0); the tenant_id is part of
 * the key (#1069 §10 — usage in Tenant A never leaks to Tenant B).
 * agent_approved_free_quotas holds one row per family with the current
 * cap (seeded by migration 0055, INSERT OR IGNORE, so an operator edit
 * survives re-ensure). agent_approved_free_quota_settings holds the
 * single settings row (window kind + at-limit action). Additive only
 * (new tables, no backfill): accounts with no rows have consumed
 * nothing, and a family with no cap row reads as unconfigured.
 */
export const MIGRATION_0054_APPROVED_FREE_QUOTA: DataMigration = {
  version: 54,
  name: "0054_approved_free_quota",
  sql: d1MigrationSql(54),
};

/**
 * Migration 0055 — approved-free quota seed rows (#3263).
 *
 * The seed values are operator-managed seeded DATA, never a code
 * constant: these INSERT OR IGNORE rows are the only place the
 * decided defaults are written for a fresh store — 10 runs per
 * service per period (owner direction 2026-11-06, matching the live
 * #3308 free-run allowance), monthly window, at-limit per #3241
 * decision 4 (upgrade or buy credits). An operator edit survives
 * (INSERT OR IGNORE never overwrites), and a family with no row
 * stays fail-closed — the gate reads the store only and treats a
 * missing row as "no quota configured". updated_at_ms 0 marks a
 * seed row no operator has touched yet.
 */
export const MIGRATION_0055_APPROVED_FREE_QUOTA_SEED: DataMigration = {
  version: 55,
  name: "0055_approved_free_quota_seed",
  sql: d1MigrationSql(55),};

/**
 * Migration 0056 — generated datasets (#3538, Pipeline J5).
 *
 * The generate stage's persisted output: one row per generate
 * run, keyed by generate job id, the full artifact in
 * artifact_json (the feed-dataset family's pattern) with status
 * and the generated-format count denormalized for the
 * latestUsable filter. Declared in the foundation's Drizzle
 * schema (jobGeneratedDatasets) — the same shape in every
 * residency (the DO residency's declared v1 schema migration
 * carries the identical DDL).
 *
 * Version note: 0053 was skipped by the #3263 line before J4
 * landed (its migrations are 0054/0055), so this family takes
 * the next version above the current maximum rather than
 * backfilling a number another lane may have reserved.
 */
export const MIGRATION_0056_JOB_GENERATED_DATASETS: DataMigration = {
  version: 56,
  name: "0056_job_generated_datasets",
  sql: d1MigrationSql(56),
};

/**
 * Migration 0057 — delivery datasets (#3539, Pipeline J6).
 *
 * The deliver stage's persisted output: one row per deliver
 * run, keyed by deliver job id, the full artifact in
 * artifact_json (the sibling families' pattern) with status,
 * the delivered-channel count, and the consumed generated
 * artifact's id denormalized (the resume lookup is an exact
 * query). Declared in the foundation's Drizzle schema
 * (jobDeliveryDatasets) — the same shape in every residency
 * (the DO residency's declared v1 schema migration carries
 * the identical DDL).
 */
export const MIGRATION_0057_JOB_DELIVERY_DATASETS: DataMigration = {
  version: 57,
  name: "0057_job_delivery_datasets",
  sql: d1MigrationSql(57),
};
/**
 * Migration 0058 — product versions (#3289 slice 1, sub-issue of
 * #3241). Products are identity; versions are immutable terms
 * snapshots; plan rows ARE versions and catalogue rows ARE
 * versions (design docs/architecture — #3289 §3).
 *
 * What it does:
 * - agent_products: the product identity table, seeded with the
 *   four per-run products (stock/goal/options/strategy) and the
 *   read-only Free baseline, plus one product per distinct
 *   existing plan name (dynamic backfill — the live store's plan
 *   rows are operator data, never assumed here).
 * - agent_subscription_plans gains the version columns
 *   (product_id, segment, version, effective_from_ms,
 *   effective_to_ms, billing_period, features_json,
 *   stripe_price_id). Every existing row becomes version 1 of
 *   its name-derived product in segment "default", keeping its
 *   approval status; effective_from_ms is the row's own
 *   created_at_ms (the row is already live, so it must be
 *   effective — see the date-function note below).
 * - agent_price_catalogue is REBUILT: its PRIMARY KEY was
 *   `family` (one row per family), which cannot hold versions.
 *   The rebuild renames the old table aside, creates the new
 *   table with a surrogate `id` PK (deterministic
 *   `cat-<family>-default-v1`), copies every row as v1 of its
 *   family product in segment "default" (approval status
 *   preserved), then drops the old table. The (product, segment,
 *   version) unique index makes the version number unambiguous.
 *   There is deliberately NO unique index on (product, segment,
 *   effective_from_ms): two versions may share a start instant
 *   (same-millisecond creation is a race, not a caller error —
 *   the design's "duplicate effectiveFromMs rejected" is
 *   superseded here), and the resolver tiebreaks ties by
 *   greatest version, so the pick stays total and a version
 *   created "effective now" is effective now, never 1ms in the
 *   future (a +1ms bump broke setPrice→approvePrice in the
 *   same millisecond: the bumped version was not yet effective
 *   when approvePrice ran, so it approved the old version).
 * - agent_commercial_accounts gains `segment` (default
 *   "default"); agent_journal_entries, agent_native_ledger_rows
 *   and agent_credit_claims gain product_id / version_id /
 *   price_usd (nullable in DDL — legacy rows predate
 *   versioning; the mapping layer requires them for new per-run
 *   events, fail-closed).
 * - agent_version_moves + agent_bulk_moves: the move audit
 *   (§3.8). The (bulk_move_id, user_id) unique index is the
 *   bulk-job idempotency backstop; SQLite treats NULLs as
 *   distinct, so per-customer moves (bulk_move_id NULL) never
 *   collide on it. DEVIATION from the design's §3.8 table:
 *   to_version_id is NULLABLE here (the design shows it NOT
 *   NULL) — a segment-only move by a customer holding no
 *   version has no version to record, and the audit row must
 *   still exist (the segment change is the audited fact).
 *   product_id was already nullable in the design for the same
 *   case.
 *
 * Deviations from the design, recorded not hidden:
 * - effective_from_ms is the row's own created_at_ms /
 *   updated_at_ms, not "migration time": the portable-subset
 *   rule (no dialect date functions) forbids strftime('now')
 *   in migration SQL, and the row's recorded instant is the
 *   more accurate "live since" value anyway.
 * - The catalogue rebuild is the one statement sequence in
 *   this repo that is not crash-convergent: a crash between the
 *   RENAME and the CREATE leaves the old table as
 *   agent_price_catalogue_legacy and a re-run fails at the
 *   RENAME. Recovery is one statement —
 *   `ALTER TABLE agent_price_catalogue_legacy RENAME TO
 *   agent_price_catalogue` — before re-running the ensure.
 *   The window is two adjacent statements; every other
 *   statement here is IF NOT EXISTS / OR IGNORE shaped.
 * - The product id for a plan is derived from its name
 *   (`prod-sub-` + lowercase, spaces to hyphens) so the
 *   backfill is deterministic in pure SQL; the same derivation
 *   lives in src/data/productPorts.ts
 *   (subscriptionProductIdForName) and the two must agree.
 *   Duplicate plan names share one product and are numbered
 *   by creation order (version = rank, effective_from_ms
 *   staggered by rank-1 ms so the effective ordering matches
 *   creation order — the (product, segment, effective_from_ms)
 *   unique index was dropped; ties are allowed and resolve by
 *   greatest version, see the rebuild note above).
 * - The four per-run catalogue prices are NOT seeded here:
 *   the ensure-time seed (PROPOSED_SEED_PRICES in
 *   ensurePriceCatalogueSchema) stays the seed, because the
 *   fail-closed empty-catalogue test needs a seed-free path
 *   and the #2185 pin is "an operator edit survives re-ensure".
 *   The products seeded here are identity rows, not prices.
 *
 * Prerequisites: any ensure path that applies 0058 must have
 * applied 0007 (accounts/claims), 0008 (plans), 0009
 * (journal), 0011 (catalogue), 0012 (native ledger) and 0027
 * (catalogue approval columns) first — the backfill reads the
 * plans table, the rebuild copies the approval columns, and
 * the account/journal/ledger/claim ALTERs need their tables.
 * The six ensure lists that include 0058 (product,
 * subscription, catalogue, commercial, journal, native ledger)
 * carry those prerequisites (applyMigrations sorts by version,
 * so list order does not matter).
 */
/** D1 migration 0061 (#3310) — the dispatching schedule id on the pipeline instance. */
export const MIGRATION_0061_JOB_PIPELINE_RUN_SCHEDULE_ID: DataMigration = {
  version: 61,
  name: "0061_job_pipeline_run_schedule_id",
  sql: d1MigrationSql(61),
};

/**
 * Issue #4357 — the join key: the engine instance carries the id of
 * the async job that dispatched its run, so the terminal D1 run
 * record links to the bridge row. Additive column only; existing
 * rows read back as NULL (unlinked, rendered as today).
 */
export const MIGRATION_0065_JOB_PIPELINE_RUN_ASYNC_JOB_ID: DataMigration = {
  version: 65,
  name: "0065_job_pipeline_run_async_job_id",
  sql: d1MigrationSql(65),
};

export const MIGRATION_0058_PRODUCT_VERSIONS: DataMigration = {
  version: 58,
  name: "0058_product_versions",
  sql: d1MigrationSql(58),
};

/**
 * Migration 0059 — run ledger projection (#4116, sub-issue of #3946).
 * D1 becomes the system of record for run history: the DO run
 * ledgers (mas_reports, mas_async_jobs) project here.
 * - agent_async_jobs: the D1 mirror of mas_async_jobs (one row
 *   per async job, natural key job_id), plus the owning tenant
 *   and the twin link to the engine's job_run_records.
 * - agent_tenant_projection_carriers: per-tenant carrier flags
 *   (queues / ORM / sweep) + read mode. NO defaults on any
 *   column: an absent row is unconfigured, never a default
 *   carrier (the #1069 rule; contrast agent_tenant_settings,
 *   whose broker_id carries a built-in default).
 * - agent_reports.linked_job_run_id: the twin link for projected
 *   canonical reports (nullable; the ALTER is idempotent — the
 *   migration runner applies each version once, and the column
 *   addition is guarded by the runner's applied-set).
 * Prerequisites: 0004 (agent_reports) and 0047 (job_run_records).
 */
export const MIGRATION_0059_RUN_LEDGER: DataMigration = {
  version: 59,
  name: "0059_run_ledger",
  sql: d1MigrationSql(59),
};

/**
 * Migration 0060 — run ledger projection, owner scope + body
 * pointer (#4116). agent_reports.user_login: the projected
 * report's owning login (the DO row's user_login). The D1-only
 * reads filter by it exactly like the DO read filters by
 * userLogin, so the cutover preserves owner scoping. Nullable:
 * rows projected before this column landed carry NULL (the
 * sweep backfills them on its next pass — the projector
 * upgrades a null owner to a known owner as a new version).
 * agent_reports.body_r2_key: the R2 pointer for pointer rows
 * (the DO row's body_r2_key). Without it a D1-only read of an
 * R2-backed row would see an empty body — the pointer is what
 * makes the projected row readable from D1 alone.
 */
export const MIGRATION_0060_RUN_LEDGER_OWNER: DataMigration = {
  version: 60,
  name: "0060_run_ledger_owner",
  sql: d1MigrationSql(60),
};

/**
 * Migration 0062 — upgrade-offer dismissal suppressions + product
 * ladder rank (#3246 slice 1, sub-issue of #3241).
 * - agent_offer_suppressions: one row per (login, trigger) — a
 *   dismissed offer trigger stays suppressed until
 *   suppressed_until_ms. Expired rows are inert (read as
 *   absent); no deletion sweeper exists in v1.
 * - agent_products.rank: the nullable explicit ladder position
 *   (1 = the lowest rung, larger = higher; NULL = unranked, and
 *   the derived order applies). `rank` is safe unquoted in
 *   SQLite DDL/DML (verified against node:sqlite); Drizzle
 *   quotes the identifier in generated queries.
 * - The Free baseline row (prod-free) is seeded to rank 1: it is
 *   the definitional ladder floor and its rank is not editable.
 * Prerequisites: 0058 (agent_products).
 */
export const MIGRATION_0062_OFFER_SUPPRESSIONS_RANK: DataMigration = {
  version: 62,
  name: "0062_offer_suppressions_rank",
  sql: d1MigrationSql(62),
};

/**
 * Migration 0063 — runs packs (#3246 slice 3, sub-issue of #3241).
 * - agent_runs_pack_versions: one row per pack version — the
 *   approval-gated (runs, price) terms for a runs_pack product.
 *   A version lands PROPOSED; only an operator approval makes
 *   its price buyable. The version NUMBER is server-assigned
 *   (max existing + 1 for the product+segment), mirroring the
 *   plan versions of migration 0058.
 * - agent_runs_pack_balances: one row per login — the dedicated
 *   pack balance (runs_remaining). The gate spends it AFTER
 *   subscription included runs and BEFORE credits; included
 *   runs spend only when Subscribed, so the pack balance is
 *   never the included-runs counter.
 * - agent_runs_pack_drafts: one row per pack checkout — the
 *   mint/confirm binding, mirroring the top-up drafts of
 *   migration 0041 (draft id `pack-<uuid>` is the Stripe
 *   client_reference_id / x402 checkout id and the replay guard).
 * Prerequisites: 0058 (agent_products).
 */
export const MIGRATION_0063_RUNS_PACKS: DataMigration = {
  version: 63,
  name: "0063_runs_packs",
  sql: d1MigrationSql(63),
};

/**
 * Migration 0064 — free-access grants (#3247 slice 1, sub-issue of #3241).
 * - agent_free_access_grants: one row per grant — the durable,
 *   auditable, revocable record of free access for one login
 *   (kind lifetime|limited, grantedBy, grantedAtMs, expiresAtMs,
 *   revokedAtMs, reason). Expired and revoked rows stay as
 *   history; no seed rows; no tenant column (keyed by login —
 *   the audit event carries the tenant from the account row).
 *   The login index serves the per-login history reads.
 *   No prerequisites: a standalone table.
 */
export const MIGRATION_0064_FREE_ACCESS_GRANTS: DataMigration = {
  version: 64,
  name: "0064_free_access_grants",
  sql: d1MigrationSql(64),
};

/**
 * Migration 0066 — referral / invite codes (#3307 slice 1, sub-issue of #3241).
 * - agent_referral_code_rules: one row per (productId, issuer) — the ONLY
 *   source of issuance/redemption terms. A missing or inactive rule
 *   disables codes for that (product, issuer) entirely (fail-closed).
 * - agent_referral_codes: one row per issued code. The code VALUE is
 *   never stored — only its SHA-256 hash + display prefix. Terms
 *   (runs, reusable, expiry) are snapshotted at issuance; caps are
 *   read live from the rule at redemption.
 * - agent_code_redemptions: one row per redemption (the audit +
 *   idempotency record for one-time replay).
 * - agent_code_redemption_counts: one row per (code, login) — the
 *   per-login cap's conditional-increment counter (the cap is
 *   enforced by the counter, NOT by counting redemption rows).
 * - agent_code_run_balances: one row per login — the family-agnostic
 *   code-runs balance (mirrors agent_runs_pack_balances).
 * Seeds (INSERT OR IGNORE, inactive): one rule row per per-run
 * product x platform_admin issuer, with PROPOSED defaults (5 runs,
 * one-time, 30-day expiry, attribution ledger, caps 1/1, no global
 * cap, active 0). No seed codes, no seed balances. Prerequisite:
 * 0058 (agent_products, for the seed product ids).
 */
export const MIGRATION_0066_REFERRAL_CODES: DataMigration = {
  version: 66,
  name: "0066_referral_codes",
  sql: d1MigrationSql(66),
};

/**
 * Migration 0053 — commercial product bundles (#2781,
 * Monetization Phase 2.15). Three tables, additive only:
 *   agent_product_bundles — one row per operator-defined bundle
 *     (member_product_ids is a JSON array of catalog product ids,
 *     `family:PayPerUse`, ≥2, unique; approval columns mirror
 *     the #3357 plan-price approval columns — a bundle is
 *     PROPOSED until an operator approves it).
 *   agent_bundle_purchases — one row per verified Billing
 *     checkout; provider_subscription_id is UNIQUE (the replay
 *     guard, mirroring agent_subscriptions).
 *   agent_bundle_entitlements — one row per member product per
 *     purchase; written in the SAME atomic batch as the purchase
 *     row (no partial entitlement, ever).
 * Number 0053: 0051/0052 are reserved for #3263 (settled
 * assignment, 2026-11-06). No bundles are seeded: bundles exist
 * only when an operator creates one.
 */
export const MIGRATION_0053_PRODUCT_BUNDLES: DataMigration = {
  version: 53,
  name: "0053_product_bundles",
  sql: d1MigrationSql(53),
};

export const ALL_MIGRATIONS: DataMigration[] = [  MIGRATION_0001_AGENT_GOVERNANCE,
  MIGRATION_0002_AGENT_CHAINS_SCHEDULES,
  MIGRATION_0003_AGENT_SHARD_JOBS,
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
  MIGRATION_0005_AGENT_MARKET_GRAPH,
  MIGRATION_0006_AGENT_TELEMETRY_CALIBRATION,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0010_PAID_SUBMISSIONS,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS,
  MIGRATION_0014_BILLING,
  MIGRATION_0015_LIFECYCLE_REFERRAL,
  MIGRATION_0016_AUDIT_POLICY,
  MIGRATION_0017_INTELLIGENCE_SUBSTRATE,
  MIGRATION_0018_REFUNDS,
  MIGRATION_0019_DATA_PROVIDER_PLATFORM,
  MIGRATION_0020_IV_HISTORY,
  MIGRATION_0021_MARKETPLACE,
  MIGRATION_0022_D1_REGULARIZATION,
  MIGRATION_0023_AGENT_MESH_TRACE_HOPS,
  MIGRATION_0024_AGENT_MESH_EVAL_RESULTS,
  MIGRATION_0025_AGENT_MESH_PROPOSALS,
  MIGRATION_0026_TENANT_AUTO_REFRESH,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0028_TENANT_PROVIDERS,
  MIGRATION_0029_PROOF_REDEMPTIONS,
  MIGRATION_0030_BILLING_CUSTOMERS,
  MIGRATION_0031_REFERRAL_ATTRIBUTION,
  MIGRATION_0032_STORE_OPERATORS,
  MIGRATION_0033_DEAD_LETTER_STORE,
  MIGRATION_0034_BREAKER_STATE,
  MIGRATION_0035_DIGEST_PASS,
  MIGRATION_0036_REFUND_POLICY_APPROVAL,
  MIGRATION_0037_CFPAY_CHANNEL,
  MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID,
  MIGRATION_0039_TENANT_CHANNELS,
  MIGRATION_0040_UNLIMITED_FREE_GRANT,
  MIGRATION_0041_PLAN_TRIAL_DAYS,
  MIGRATION_0042_ONBOARDING_STATE,
  MIGRATION_0043_FREE_RUN_COUNTER,
  MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED,
  MIGRATION_0045_IV_HISTORY_BROKER,
  MIGRATION_0046_JOB_PIPELINE,
  MIGRATION_0047_JOB_RUN_RECORDS,
  MIGRATION_0048_TOP_UP_DRAFTS,
  MIGRATION_0049_PLAN_PRICE_APPROVAL,
  MIGRATION_0050_USER_PROFILES,
  MIGRATION_0051_JOB_ENRICHED_DATASETS,
  MIGRATION_0052_JOB_ANALYZED_DATASETS,
  MIGRATION_0053_PRODUCT_BUNDLES,
  MIGRATION_0054_APPROVED_FREE_QUOTA,
  MIGRATION_0055_APPROVED_FREE_QUOTA_SEED,
  MIGRATION_0056_JOB_GENERATED_DATASETS,
  MIGRATION_0057_JOB_DELIVERY_DATASETS,
  MIGRATION_0058_PRODUCT_VERSIONS,
  MIGRATION_0059_RUN_LEDGER,
  MIGRATION_0060_RUN_LEDGER_OWNER,
  MIGRATION_0061_JOB_PIPELINE_RUN_SCHEDULE_ID,
  MIGRATION_0062_OFFER_SUPPRESSIONS_RANK,
  MIGRATION_0063_RUNS_PACKS,
  MIGRATION_0064_FREE_ACCESS_GRANTS,
  MIGRATION_0065_JOB_PIPELINE_RUN_ASYNC_JOB_ID,
  MIGRATION_0066_REFERRAL_CODES,
];

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface MigrationMarkerRow {
  version: number;
  name: string;
}

function migrationMarkerMismatchError(
  migration: DataMigration,
  recordedName: string,
): Error {
  return new Error(
    `Migration ${migration.version} is recorded in _migrations with a different name ("${recordedName}") than expected ("${migration.name}").`,
  );
}

async function readMigrationMarker(
  db: MigrationDb,
  migration: DataMigration,
): Promise<MigrationMarkerRow | undefined> {
  const rows = await db.all<MigrationMarkerRow>(sql`
    SELECT version, name FROM _migrations WHERE version = ${migration.version}
  `);
  return rows[0];
}

/** Apply every unapplied migration in version order. Idempotent. */
export async function applyMigrations(
  db: MigrationDb,
  migrations: DataMigration[],
  nowMs: number = Date.now(),
): Promise<number[]> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )
  `);
  const applied: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const existing = await readMigrationMarker(db, migration);
    if (existing) {
      if (existing.name !== migration.name) {
        throw migrationMarkerMismatchError(migration, existing.name);
      }
      continue;
    }
    for (const statement of splitStatements(migration.sql)) {
      await db.run(sql.raw(statement));
    }
    // Commit marker LAST (see header): no row means not applied.
    let markerError: unknown;
    let markerInserted = true;
    try {
      await db.run(sql`
        INSERT INTO _migrations (version, name, applied_at_ms)
        VALUES (${migration.version}, ${migration.name}, ${nowMs})
      `);
    } catch (err) {
      markerInserted = false;
      markerError = err;
    }
    if (!markerInserted) {
      // A concurrent ensure may have won the PRIMARY KEY race after
      // this caller's initial read. Verify the winning row before
      // treating that loss as "already applied": no row means this
      // insert failed for another reason, and a row under another
      // name is bookkeeping drift, not this migration.
      const recorded = await readMigrationMarker(db, migration);
      if (!recorded) throw markerError;
      if (recorded.name !== migration.name) {
        throw migrationMarkerMismatchError(migration, recorded.name);
      }
      continue;
    }
    applied.push(migration.version);
  }
  return applied;
}
