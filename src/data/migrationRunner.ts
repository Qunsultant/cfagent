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
 */
import { sql, type SQL } from "drizzle-orm";

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
  sql: `
CREATE TABLE IF NOT EXISTS agent_governance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  state TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  version INTEGER NOT NULL,
  provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_governance_tenant_scope_idx ON agent_governance (tenant_id, scope, scope_id, set_at_ms DESC);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_chains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  goal TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_chains_tenant_chain_idx ON agent_chains (tenant_id, chain_id, version DESC);
CREATE TABLE IF NOT EXISTS agent_synthesized_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  cron TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_synthesized_schedules_tenant_schedule_idx ON agent_synthesized_schedules (tenant_id, schedule_id, version DESC);
`,
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
  sql: `CREATE TABLE IF NOT EXISTS agent_shard_jobs (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL,
    PRIMARY KEY (tenant_id, chain_id, job_key, version)
);`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_chain_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  chain_id TEXT,
  event_kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_chain_audit_tenant_chain_idx ON agent_chain_audit (tenant_id, chain_id, occurred_at_ms DESC);
CREATE INDEX IF NOT EXISTS agent_chain_audit_tenant_kind_idx ON agent_chain_audit (tenant_id, event_kind, occurred_at_ms DESC);
CREATE TABLE IF NOT EXISTS agent_reports (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation_id TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL,
  provenance_writer TEXT NOT NULL,
  provenance_source_do TEXT NOT NULL,
  provenance_source_version TEXT NOT NULL,
    PRIMARY KEY (tenant_id, report_id, version)
);
CREATE INDEX IF NOT EXISTS agent_reports_tenant_report_idx ON agent_reports (tenant_id, report_id, version DESC);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_market_nodes (
  tenant_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_key TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, node_type, node_key)
);
CREATE INDEX IF NOT EXISTS agent_market_nodes_tenant_type_idx ON agent_market_nodes (tenant_id, node_type, node_key);
CREATE TABLE IF NOT EXISTS agent_market_edges (
  tenant_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_key TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_key TEXT NOT NULL,
  weight REAL NOT NULL,
  provenance TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, from_type, from_key, relation, to_type, to_key)
);
CREATE INDEX IF NOT EXISTS agent_market_edges_tenant_from_idx ON agent_market_edges (tenant_id, from_type, from_key, relation);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_thesis_realizations (
  tenant_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  thesis TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  structure TEXT NOT NULL,
  regime TEXT NOT NULL,
  symbol TEXT NOT NULL,
  run_id TEXT NOT NULL,
  report_id TEXT,
  chain_id TEXT,
  predicted_direction TEXT NOT NULL,
  realized_direction TEXT NOT NULL,
  direction_correct INTEGER NOT NULL,
  falsified INTEGER NOT NULL,
  invalidated INTEGER NOT NULL,
  pnl_estimate_per_unit REAL,
  r_multiple REAL,
  evaluated_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, outcome_id)
);
CREATE INDEX IF NOT EXISTS agent_thesis_realizations_tenant_evaluated_idx ON agent_thesis_realizations (tenant_id, evaluated_at_ms DESC);
CREATE INDEX IF NOT EXISTS agent_thesis_realizations_tenant_thesis_idx ON agent_thesis_realizations (tenant_id, thesis);
CREATE TABLE IF NOT EXISTS agent_calibration_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  prompt_key TEXT NOT NULL,
  dimension TEXT NOT NULL,
  slice_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  falsifying_outcome_ids_json TEXT NOT NULL,
  calibration_note TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at_ms INTEGER,
  applied_by TEXT,
  applied_at_ms INTEGER,
  prior_note TEXT,
  superseded_by TEXT,
  expired_by TEXT,
  expired_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_calibration_decisions_tenant_actor_prompt_idx ON agent_calibration_decisions (tenant_id, actor_key, prompt_key, status);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_commercial_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  credits_usd REAL NOT NULL,
  included_runs INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tenant_settings (
  tenant_id TEXT PRIMARY KEY,
  ads_enabled INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_credit_claims (
  credit_run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  family TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_credit_claims_user_family_created_idx ON agent_credit_claims (user_id, family, created_at_ms);
CREATE TABLE IF NOT EXISTS agent_credit_redemptions (
  credit_run_id TEXT PRIMARY KEY,
  redeemed_by_run_id TEXT NOT NULL,
  redeemed_at_ms INTEGER NOT NULL
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_payment_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  period_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  canceled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_subscriptions_payment_ref_idx ON agent_subscriptions (provider_payment_ref);
CREATE INDEX IF NOT EXISTS agent_subscriptions_user_created_idx ON agent_subscriptions (user_id, created_at_ms);
CREATE TABLE IF NOT EXISTS agent_subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_usd REAL NOT NULL,
  period_days INTEGER NOT NULL,
  included_runs INTEGER NOT NULL,
  active INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
ALTER TABLE agent_commercial_accounts ADD COLUMN tier_source TEXT;
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_journal_accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_journal_entries (
  id TEXT PRIMARY KEY,
  transaction_ref TEXT NOT NULL,
  account_code TEXT NOT NULL,
  debit_usd REAL NOT NULL,
  credit_usd REAL NOT NULL,
  currency TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_request_id TEXT NOT NULL,
  family TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_journal_entries_tenant_account_idx ON agent_journal_entries (tenant_id, account_code);
CREATE INDEX IF NOT EXISTS agent_journal_entries_ref_idx ON agent_journal_entries (transaction_ref);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_paid_submissions (
  workflow_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_request_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_price_catalogue (
  family TEXT PRIMARY KEY,
  price_usd REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_native_ledger_rows (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  currency TEXT NOT NULL,
  customer TEXT NOT NULL,
  gateway TEXT NOT NULL,
  gateway_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  checkout_url TEXT NOT NULL,
  proposer_did TEXT NOT NULL,
  proof_signature TEXT NOT NULL,
  note TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  family TEXT NOT NULL,
  run_request_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_native_ledger_rows_session_action_idx ON agent_native_ledger_rows (session_id, action);
CREATE INDEX IF NOT EXISTS agent_native_ledger_rows_tenant_idx ON agent_native_ledger_rows (tenant_id);
CREATE INDEX IF NOT EXISTS agent_native_ledger_rows_run_idx ON agent_native_ledger_rows (run_request_id);
`,
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
  sql: `
ALTER TABLE agent_subscriptions ADD COLUMN stripe_session_id TEXT;
ALTER TABLE agent_subscriptions ADD COLUMN stripe_payment_intent_id TEXT;
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_billing_policy (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
ALTER TABLE agent_subscriptions ADD COLUMN provider_subscription_id TEXT;
ALTER TABLE agent_subscriptions ADD COLUMN provider_status TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS agent_subscriptions_provider_subscription_idx ON agent_subscriptions (provider_subscription_id);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_referral_rules (
  id TEXT PRIMARY KEY,
  earn_amount_usd REAL NOT NULL,
  vesting_delay_ms INTEGER NOT NULL,
  redemption_scope TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO agent_referral_rules (id, earn_amount_usd, vesting_delay_ms, redemption_scope, updated_at_ms) VALUES ('default', 0.5, 604800000, 'pay-per-run', 0);
CREATE TABLE IF NOT EXISTS agent_referral_earnings (
  id TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  redeemed_amount_usd REAL NOT NULL,
  earned_at_ms INTEGER NOT NULL,
  vested_at_ms INTEGER NOT NULL,
  redeemed_by_run_id TEXT,
  redeemed_at_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_referral_earnings_referred_idx ON agent_referral_earnings (referred_user_id);
CREATE INDEX IF NOT EXISTS agent_referral_earnings_referrer_idx ON agent_referral_earnings (referrer_user_id, earned_at_ms);
CREATE TABLE IF NOT EXISTS agent_notification_preferences (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  digest_enabled INTEGER NOT NULL,
  welcome_enabled INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_digest_sends (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_audit_policy_actions (
  action TEXT PRIMARY KEY,
  block_on_audit_failure INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_audit_policy_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_audit_chain (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_audit_chain_tenant_seq_idx ON agent_audit_chain (tenant_id, sequence);
CREATE INDEX IF NOT EXISTS agent_audit_chain_tenant_created_idx ON agent_audit_chain (tenant_id, created_at_ms);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_trace_records (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  acting_agent TEXT NOT NULL,
  principal TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome_code TEXT NOT NULL,
  latency_ms INTEGER,
  cost_units REAL,
  cost_detail_json TEXT,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_trace_records_correlation_idx ON agent_trace_records (correlation_id, occurred_at_ms);
CREATE INDEX IF NOT EXISTS agent_trace_records_agent_idx ON agent_trace_records (acting_agent, occurred_at_ms DESC);
CREATE TABLE IF NOT EXISTS agent_proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  proposer_agent TEXT NOT NULL,
  principal TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_proposals_state_idx ON agent_proposals (state, updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS agent_proposal_transitions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  gate_ref TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_proposal_transitions_proposal_idx ON agent_proposal_transitions (proposal_id, created_at_ms);
CREATE TABLE IF NOT EXISTS agent_fleet_registry (
  agent_key TEXT PRIMARY KEY,
  class_name TEXT NOT NULL,
  binding TEXT NOT NULL,
  instance_scheme TEXT NOT NULL,
  migration_tag TEXT,
  operations_json TEXT NOT NULL,
  identity_json TEXT,
  do_schema_version INTEGER,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_conformance_cells (
  agent_key TEXT NOT NULL,
  dimension TEXT NOT NULL,
  status TEXT NOT NULL,
  reference TEXT,
  updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (agent_key, dimension)
);
CREATE TABLE IF NOT EXISTS agent_work_item_events (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  actor TEXT,
  occurred_at_ms INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (source, external_id)
);
CREATE INDEX IF NOT EXISTS agent_work_item_events_kind_idx ON agent_work_item_events (kind, occurred_at_ms DESC);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_refund_policy (
  id TEXT PRIMARY KEY,
  window_days INTEGER NOT NULL,
  approver TEXT NOT NULL,
  allow_partial INTEGER NOT NULL,
  subscription_full_effect TEXT NOT NULL,
  subscription_partial_effect TEXT NOT NULL,
  pay_per_run_effect TEXT NOT NULL,
  credit_effect TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_refunds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  rail TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  original_payment_ref TEXT NOT NULL,
  subscription_id TEXT,
  payment_intent_id TEXT,
  family TEXT,
  original_amount_usd REAL NOT NULL,
  amount_usd REAL NOT NULL,
  original_paid_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  approver_login TEXT,
  decision_note TEXT,
  gateway_refund_id TEXT,
  executed_at_ms INTEGER,
  entitlement_consequence TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_data_providers (
  id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  precedence INTEGER NOT NULL,
  credential_ref TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_data_providers_precedence_idx ON agent_data_providers (precedence);
CREATE TABLE IF NOT EXISTS agent_data_provider_routes (
  capability TEXT PRIMARY KEY,
  primary_provider_id TEXT NOT NULL,
  gap_fill_provider_id TEXT,
  min_tier TEXT NOT NULL DEFAULT 'freemium',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_data_captures (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  request_params_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_login TEXT,
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_kind TEXT,
  raw_blob_ref TEXT,
  raw_byte_size INTEGER,
  raw_sha256 TEXT,
  normalized_digest TEXT,
  retention_class TEXT NOT NULL,
  failure_error TEXT,
  failure_kind TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_data_captures_run_idx ON agent_data_captures (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS agent_data_captures_provider_idx ON agent_data_captures (tenant_id, provider_id);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_iv_history (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  atm_iv REAL NOT NULL,
  spot REAL NOT NULL,
  expiry_date TEXT NOT NULL,
  dte INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS agent_iv_history_symbol_date_idx ON agent_iv_history (symbol, date DESC);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_referrals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL,
  reward_text TEXT NOT NULL,
  clicks INTEGER DEFAULT 0,
  signups INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_ads (
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
);
CREATE TABLE IF NOT EXISTS agent_external_ads (
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
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS quote_source_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_sql_ops (
  ts_ms INTEGER NOT NULL,
  ns TEXT NOT NULL,
  op TEXT NOT NULL,
  rows_read INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  caller TEXT,
  trigger TEXT,
  statement TEXT,
  tenant_id TEXT,
  run_id TEXT,
  session_ref TEXT
);
CREATE TABLE IF NOT EXISTS resource_daily_rollups (
  day TEXT NOT NULL,
  ns TEXT NOT NULL,
  op TEXT NOT NULL,
  caller TEXT NOT NULL,
  trigger TEXT NOT NULL,
  ops INTEGER NOT NULL,
  rows_read INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  PRIMARY KEY (day, ns, op, caller, trigger)
);
CREATE TABLE IF NOT EXISTS resource_alert_state (
  budget TEXT NOT NULL,
  day TEXT NOT NULL,
  alerted_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (budget, day)
);
CREATE TABLE IF NOT EXISTS resource_comparison_reports (
  day TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  report_json TEXT NOT NULL
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_mesh_trace_hops (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  operation TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  tenant_id TEXT,
  caller TEXT,
  agent_name TEXT,
  job_id TEXT,
  note TEXT,
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS agent_mesh_trace_hops_trace_idx ON agent_mesh_trace_hops (trace_id, timestamp_ms);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_mesh_eval_results (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  door TEXT NOT NULL,
  class_name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  refusal_code TEXT,
  failures_json TEXT NOT NULL,
  trace_id TEXT,
  trace_hop_kinds_json TEXT,
  trace_complete INTEGER,
  facts_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, task_id)
);
CREATE INDEX IF NOT EXISTS agent_mesh_eval_results_task_idx ON agent_mesh_eval_results (task_id, started_at_ms);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_mesh_proposals (
  id TEXT PRIMARY KEY,
  signal_key TEXT NOT NULL,
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  proposed_change TEXT NOT NULL,
  expected_effect TEXT NOT NULL,
  falsification_criterion TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  state TEXT NOT NULL,
  bar_verdict_json TEXT,
  filed_issue_number INTEGER,
  filed_issue_url TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_mesh_proposals_signal_idx ON agent_mesh_proposals (signal_key, created_at_ms);
CREATE INDEX IF NOT EXISTS agent_mesh_proposals_state_idx ON agent_mesh_proposals (state, created_at_ms);
`,
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
  sql: `
ALTER TABLE agent_tenant_settings ADD COLUMN data_provider_id TEXT NOT NULL DEFAULT 'etrade';
ALTER TABLE agent_tenant_settings ADD COLUMN broker_id TEXT NOT NULL DEFAULT 'etrade';
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_billing_customers (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_referral_attributions (
  referred_user_id TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_referral_attributions_referrer_idx ON agent_referral_attributions (referrer_user_id, created_at_ms);
`,
};

export const MIGRATION_0032_STORE_OPERATORS: DataMigration = {
  version: 32,
  name: "0032_store_operators",
  sql: `
CREATE TABLE IF NOT EXISTS agent_store_operators (
  login TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at_ms INTEGER NOT NULL
);
`,
};

export const MIGRATION_0033_DEAD_LETTER_STORE: DataMigration = {
  version: 33,
  name: "0033_dead_letter_store",
  sql: `
CREATE TABLE IF NOT EXISTS agent_dead_letter_records (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  reason TEXT NOT NULL,
  message_id TEXT,
  run_id TEXT,
  unit_id TEXT,
  actor_login TEXT,
  actor_kind TEXT,
  subscriber TEXT,
  detail TEXT,
  envelope_json TEXT,
  created_at_ms INTEGER NOT NULL,
  replayed_at_ms INTEGER,
  replay_outcome TEXT,
  replay_token TEXT
);
CREATE TABLE IF NOT EXISTS dlq_depth_state (
  id TEXT PRIMARY KEY,
  alerted_at_ms INTEGER,
  depth_at_alert INTEGER,
  claim_token TEXT
);
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_digest_subscriber_emails (
  user_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_digest_pass_days (
  day TEXT PRIMARY KEY,
  ran_at_ms INTEGER NOT NULL
);
`,
};

export const MIGRATION_0026_TENANT_AUTO_REFRESH: DataMigration = {
  version: 26,
  name: "0026_tenant_auto_refresh",
  sql: `
ALTER TABLE agent_tenant_settings ADD COLUMN auto_refresh_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tenant_settings ADD COLUMN auto_refresh_interval_s INTEGER NOT NULL DEFAULT 15;
`,
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
  sql: `
ALTER TABLE agent_price_catalogue ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE agent_price_catalogue ADD COLUMN approved_by TEXT;
ALTER TABLE agent_price_catalogue ADD COLUMN approved_at_ms INTEGER;
`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_payment_proof_redemptions (
  redemption_key TEXT PRIMARY KEY,
  run_request_id TEXT NOT NULL,
  rail TEXT NOT NULL,
  payer TEXT,
  redeemed_at_ms INTEGER NOT NULL
);
`,
};

export const MIGRATION_0034_BREAKER_STATE: DataMigration = {
  version: 34,
  name: "0034_breaker_state",
  sql: `
CREATE TABLE IF NOT EXISTS agent_breaker_state (
  provider_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL,
  opened_at_ms INTEGER,
  last_failure_at_ms INTEGER,
  total_calls INTEGER NOT NULL,
  total_successes INTEGER NOT NULL,
  total_failures INTEGER NOT NULL,
  total_trips INTEGER NOT NULL,
  total_fallbacks INTEGER NOT NULL,
  total_rejected INTEGER NOT NULL,
  transition_seq INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS breaker_trip_alerts (
  transition_id TEXT PRIMARY KEY,
  alerted_at_ms INTEGER,
  claim_token TEXT
);
`,
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
  sql: `
ALTER TABLE agent_refund_policy ADD COLUMN approved_kinds TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_refund_policy ADD COLUMN approved_by TEXT;
ALTER TABLE agent_refund_policy ADD COLUMN approved_at_ms INTEGER;
`,
};

export const MIGRATION_0037_CFPAY_CHANNEL: DataMigration = {
  version: 37,
  name: "0037_cfpay_channel",
  sql: `
CREATE TABLE IF NOT EXISTS agent_cfpay_channel_purchases (
  id TEXT PRIMARY KEY,
  user_login TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  family TEXT NOT NULL,
  expected_price_usd REAL NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  fulfilled_at_ms INTEGER,
  payment_intent_id TEXT,
  fulfil_skipped_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_cfpay_channel_user ON agent_cfpay_channel_purchases (user_login);
`,
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
  sql: `ALTER TABLE agent_shard_jobs ADD COLUMN workflow_run_id TEXT;`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_tenant_channels (
  tenant_id TEXT PRIMARY KEY,
  email_enabled INTEGER NOT NULL DEFAULT 1,
  slack_enabled INTEGER NOT NULL DEFAULT 1,
  webhook_enabled INTEGER NOT NULL DEFAULT 1,
  copilot_enabled INTEGER NOT NULL DEFAULT 1,
  docs_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at_ms INTEGER NOT NULL
);
`,
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
  sql: `
ALTER TABLE agent_commercial_accounts ADD COLUMN unlimited_free_granted_by TEXT;
ALTER TABLE agent_commercial_accounts ADD COLUMN unlimited_free_reason TEXT;
ALTER TABLE agent_commercial_accounts ADD COLUMN unlimited_free_expires_at_ms INTEGER;
`,
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
  sql: `ALTER TABLE agent_subscription_plans ADD COLUMN trial_days INTEGER;`,
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
  sql: `CREATE TABLE IF NOT EXISTS agent_onboarding_state (
  user_login TEXT PRIMARY KEY,
  tenant_id TEXT,
  current_step INTEGER NOT NULL DEFAULT 1,
  completed_at_ms INTEGER,
  trial_plan_id TEXT,
  trial_started_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);`,
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
  sql: `CREATE TABLE IF NOT EXISTS agent_free_run_allowances (
  family TEXT PRIMARY KEY,
  runs INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_free_run_counts (
  user_login TEXT NOT NULL,
  family TEXT NOT NULL,
  month TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_login, family, month)
);`,
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
  sql: `INSERT OR IGNORE INTO agent_free_run_allowances (family, runs, updated_at_ms) VALUES
  ('stock', 10, 0),
  ('goal', 10, 0),
  ('options', 10, 0),
  ('strategy', 10, 0);`,
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
  sql: `ALTER TABLE agent_iv_history ADD COLUMN broker TEXT NOT NULL DEFAULT 'etrade'`,
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
  sql: `CREATE TABLE IF NOT EXISTS job_pipeline_definitions (
      job_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_pipeline_instances (
      job_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      desired_state TEXT NOT NULL,
      current_run_id TEXT,
      run_started_at TEXT,
      run_trigger TEXT,
      checkpoint_json TEXT,
      stage_checkpoint_json TEXT,
      stage_desired_json TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_pipeline_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_pipeline_artifacts_run
      ON job_pipeline_artifacts (run_id, artifact_key)`,
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
  sql: `CREATE TABLE IF NOT EXISTS job_run_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system TEXT NOT NULL,
      job_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      started TEXT NOT NULL,
      finished TEXT NOT NULL,
      outcome TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      trigger_text TEXT,
      schedule_id TEXT,
      async_job_id TEXT,
      workflow_id TEXT,
      error_text TEXT,
      detail TEXT,
      descriptor TEXT,
      artifact_refs_json TEXT
    );
    CREATE INDEX IF NOT EXISTS job_run_records_job_idx
      ON job_run_records (job_id, started DESC, id DESC)`,
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
  sql: `ALTER TABLE agent_subscription_plans ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE agent_subscription_plans ADD COLUMN approved_by TEXT;
ALTER TABLE agent_subscription_plans ADD COLUMN approved_at_ms INTEGER;
UPDATE agent_subscription_plans SET approval_status = 'approved' WHERE approval_status = 'proposed';`,
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
  sql: `
CREATE TABLE IF NOT EXISTS agent_top_up_drafts (
  id TEXT PRIMARY KEY,
  user_login TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  rail TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  credited_at_ms INTEGER,
  payment_intent_id TEXT,
  checkout_session_id TEXT,
  challenge_nonce TEXT
);
CREATE INDEX IF NOT EXISTS idx_top_up_user ON agent_top_up_drafts (user_login);
`,
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
  sql: `CREATE TABLE IF NOT EXISTS agent_user_profiles (
  user_login TEXT PRIMARY KEY,
  display_name TEXT,
  phone TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_profile_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  user_login TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);`,
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
  sql: `CREATE TABLE IF NOT EXISTS job_enriched_datasets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      feed_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_enriched_datasets_job
      ON job_enriched_datasets (job_id, created_at DESC, id DESC)`,
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
  sql: `CREATE TABLE IF NOT EXISTS job_analyzed_datasets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      enrich_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_analyzed_datasets_job
      ON job_analyzed_datasets (job_id, created_at DESC, id DESC)`,
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
  sql: `CREATE TABLE IF NOT EXISTS agent_approved_free_quotas (
  family TEXT PRIMARY KEY,
  cap_runs INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS agent_approved_free_quota_counts (
  tenant_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  family TEXT NOT NULL,
  period TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_login, family, period)
);
CREATE TABLE IF NOT EXISTS agent_approved_free_quota_settings (
  id TEXT PRIMARY KEY,
  window_kind TEXT NOT NULL,
  at_limit_action TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  updated_by TEXT
);`,
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
  sql: `INSERT OR IGNORE INTO agent_approved_free_quotas (family, cap_runs, updated_at_ms, updated_by) VALUES
  ('stock', 10, 0, NULL),
  ('goal', 10, 0, NULL),
  ('options', 10, 0, NULL),
  ('strategy', 10, 0, NULL);
INSERT OR IGNORE INTO agent_approved_free_quota_settings (id, window_kind, at_limit_action, updated_at_ms, updated_by) VALUES
  ('default', 'month', 'upgrade_or_buy_credits', 0, NULL);`,};
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
  MIGRATION_0054_APPROVED_FREE_QUOTA,
  MIGRATION_0055_APPROVED_FREE_QUOTA_SEED,
];

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    const existing = await db.all<{ version: number }>(sql`
      SELECT version FROM _migrations WHERE version = ${migration.version}
    `);
    if (existing.length > 0) continue;
    for (const statement of splitStatements(migration.sql)) {
      await db.run(sql.raw(statement));
    }
    // Commit marker LAST (see header): no row means not applied.
    await db.run(sql`
      INSERT INTO _migrations (version, name, applied_at_ms)
      VALUES (${migration.version}, ${migration.name}, ${nowMs})
    `);
    applied.push(migration.version);
  }
  return applied;
}
