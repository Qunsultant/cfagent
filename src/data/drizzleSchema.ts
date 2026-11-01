/**
 * Issue #1548 ([AGENTIC] Slice 0) — Drizzle schema mapping for
 * the data foundation layer.
 *
 * This schema MAPS tables; it does not create them. DDL authority
 * lives in exactly one migration file per table
 * (src/data/migrationRunner.ts, migration 0001); a test pins that
 * this mapping and that DDL agree on columns. If they ever drift,
 * the migration file wins and this mapping is fixed to match.
 */
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** Mirror of governance transitions (slice 0: halt rows only). */
export const agentGovernance = sqliteTable("agent_governance", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id"),
  state: text("state").notNull(),
  setBy: text("set_by").notNull(),
  setAtMs: integer("set_at_ms").notNull(),
  reason: text("reason").notNull(),
  version: integer("version").notNull(),
  provenance: text("provenance").notNull(),
});

/** Projection of a compiled chain (slice 1, issue #1651). */
export const agentChains = sqliteTable("agent_chains", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  chainId: text("chain_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  goal: text("goal").notNull(),
  stepsJson: text("steps_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  provenanceWriter: text("provenance_writer").notNull(),
  provenanceSourceDo: text("provenance_source_do").notNull(),
  provenanceSourceVersion: text("provenance_source_version").notNull(),
});

/** Projection of a synthesized schedule (slice 1, issue #1651). */
/**
 * Issue #1676: agent_shard_jobs projection table. Grain: one
 * row per (tenant, chain, job, version). Column names match
 * migration 0003 exactly; the test pins the two together.
 */
export const agentShardJobs = sqliteTable(
  "agent_shard_jobs",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    chainId: text("chain_id").notNull(),
    jobKey: text("job_key").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    stage: text("stage").notNull(),
    capabilityId: text("capability_id").notNull(),
    detail: text("detail").notNull(),
    resultJson: text("result_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    provenanceWriter: text("provenance_writer").notNull(),
    provenanceSourceDo: text("provenance_source_do").notNull(),
    provenanceSourceVersion: text("provenance_source_version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.chainId, table.jobKey, table.version],
    }),
  ],
);

export const agentSynthesizedSchedules = sqliteTable(
  "agent_synthesized_schedules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
    chainId: text("chain_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    kind: text("kind").notNull(),
    cron: text("cron"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    provenanceWriter: text("provenance_writer").notNull(),
    provenanceSourceDo: text("provenance_source_do").notNull(),
    provenanceSourceVersion: text("provenance_source_version").notNull(),
  },
);

/**
 * Issue #1688: agent_chain_audit projection table. Grain: one
 * row per lifecycle event (append-only; version is the
 * row-shape version, always 1, not a per-subject counter).
 * chain_id is nullable: tenant-wide events (reconcile, seed)
 * have no single chain subject. Column names match migration
 * 0004 exactly; the test pins the two together.
 */
export const agentChainAudit = sqliteTable("agent_chain_audit", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  chainId: text("chain_id"),
  eventKind: text("event_kind").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  actor: text("actor").notNull(),
  detailJson: text("detail_json").notNull(),
  occurredAtMs: integer("occurred_at_ms").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
  provenanceWriter: text("provenance_writer").notNull(),
  provenanceSourceDo: text("provenance_source_do").notNull(),
  provenanceSourceVersion: text("provenance_source_version").notNull(),
});

/**
 * Issue #1688: agent_reports projection table. Grain: one row
 * per (tenant, report, version). Canonical rows are written
 * only by the projection path; deletion happens only via
 * deleteCanonicalReport. Column names match migration 0004
 * exactly; the test pins the two together.
 */
export const agentReports = sqliteTable(
  "agent_reports",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    reportId: text("report_id").notNull(),
    runId: text("run_id").notNull(),
    generationId: text("generation_id"),
    title: text("title").notNull(),
    source: text("source").notNull(),
    summary: text("summary").notNull(),
    body: text("body").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    version: integer("version").notNull(),
    provenanceWriter: text("provenance_writer").notNull(),
    provenanceSourceDo: text("provenance_source_do").notNull(),
    provenanceSourceVersion: text("provenance_source_version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.reportId, table.version],
    }),
  ],
);

/**
 * Issue #1740: agent_market_nodes projection table. Grain: one
 * row per (tenant, node type, node key). Column names match
 * migration 0005 exactly; the test pins the two together.
 */
export const agentMarketNodes = sqliteTable(
  "agent_market_nodes",
  {
    tenantId: text("tenant_id").notNull(),
    nodeType: text("node_type").notNull(),
    nodeKey: text("node_key").notNull(),
    label: text("label").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.nodeType, table.nodeKey],
    }),
  ],
);

/**
 * Issue #1740: agent_market_edges projection table. Grain: one
 * row per (tenant, from, relation, to). Column names match
 * migration 0005 exactly; the test pins the two together.
 */
export const agentMarketEdges = sqliteTable(
  "agent_market_edges",
  {
    tenantId: text("tenant_id").notNull(),
    fromType: text("from_type").notNull(),
    fromKey: text("from_key").notNull(),
    relation: text("relation").notNull(),
    toType: text("to_type").notNull(),
    toKey: text("to_key").notNull(),
    weight: real("weight").notNull(),
    provenance: text("provenance").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.fromType,
        table.fromKey,
        table.relation,
        table.toType,
        table.toKey,
      ],
    }),
  ],
);

/**
 * Issue #1742: agent_thesis_realizations projection table.
 * Grain: one row per (tenant, outcome). Booleans are INTEGER
 * 0/1 (portable subset); the adapter converts at the boundary.
 * Column names match migration 0006 exactly; the test pins the
 * two together.
 */
export const agentThesisRealizations = sqliteTable(
  "agent_thesis_realizations",
  {
    tenantId: text("tenant_id").notNull(),
    outcomeId: text("outcome_id").notNull(),
    thesis: text("thesis").notNull(),
    agentKey: text("agent_key").notNull(),
    structure: text("structure").notNull(),
    regime: text("regime").notNull(),
    symbol: text("symbol").notNull(),
    runId: text("run_id").notNull(),
    reportId: text("report_id"),
    chainId: text("chain_id"),
    predictedDirection: text("predicted_direction").notNull(),
    realizedDirection: text("realized_direction").notNull(),
    directionCorrect: integer("direction_correct").notNull(),
    falsified: integer("falsified").notNull(),
    invalidated: integer("invalidated").notNull(),
    pnlEstimatePerUnit: real("pnl_estimate_per_unit"),
    rMultiple: real("r_multiple"),
    evaluatedAtMs: integer("evaluated_at_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.outcomeId],
    }),
  ],
);

/**
 * Issue #1742: agent_calibration_decisions table. Grain: one
 * row per decision id, updated in place through the governed
 * lifecycle (proposed → approved/rejected → applied →
 * superseded/expired). The row IS the audit trail: frozen
 * snapshot JSON + proposer/decider/applier actors + prior
 * note. Column names match migration 0006 exactly; the test
 * pins the two together.
 */
export const agentCalibrationDecisions = sqliteTable("agent_calibration_decisions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  actorKey: text("actor_key").notNull(),
  promptKey: text("prompt_key").notNull(),
  dimension: text("dimension").notNull(),
  sliceKey: text("slice_key").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  falsifyingOutcomeIdsJson: text("falsifying_outcome_ids_json").notNull(),
  calibrationNote: text("calibration_note").notNull(),
  proposedBy: text("proposed_by").notNull(),
  proposedAtMs: integer("proposed_at_ms").notNull(),
  status: text("status").notNull(),
  decidedBy: text("decided_by"),
  decidedAtMs: integer("decided_at_ms"),
  appliedBy: text("applied_by"),
  appliedAtMs: integer("applied_at_ms"),
  priorNote: text("prior_note"),
  supersededBy: text("superseded_by"),
  expiredBy: text("expired_by"),
  expiredAtMs: integer("expired_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Runner bookkeeping, owned by the migration runner — not a
 * domain table, and not part of any migration file's DDL.
 */
export const dataMigrations = sqliteTable("_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAtMs: integer("applied_at_ms").notNull(),
});

/**
 * Minimal commercial account store (#2015/#2020) on D1. One row per
 * user (id = userId), operator-managed in v1. This schema MAPS
 * tables; it does not create them — DDL authority lives in
 * migration 0007 (src/data/migrationRunner.ts), and a test pins
 * that this mapping and that DDL agree on columns.
 */
export const agentCommercialAccounts = sqliteTable("agent_commercial_accounts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tier: text("tier").notNull(),
  tierSource: text("tier_source"),
  creditsUSD: real("credits_usd").notNull(),
  includedRuns: integer("included_runs").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** Per-tenant system settings (#2022): the ads flag. Absent = ads enabled. */
export const agentTenantSettings = sqliteTable("agent_tenant_settings", {
  tenantId: text("tenant_id").primaryKey(),
  adsEnabled: integer("ads_enabled").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  /** Issue #2481: per-tenant auto-refresh switch. Absent row = OFF. */
  autoRefreshEnabled: integer("auto_refresh_enabled").notNull().default(0),
  /** Issue #2481: auto-refresh cadence in seconds. Absent row = 15. */
  autoRefreshIntervalS: integer("auto_refresh_interval_s").notNull().default(15),
});

/**
 * Redeemable failure-credit claims (#2019). One row per failed paid
 * run, written by the payment adapter alongside the DO ledger
 * credit row (the ledger row is the financial audit record; this
 * row is the redeemable claim and carries family natively, so
 * redemption never needs an audit-payload family join).
 */
export const agentCreditClaims = sqliteTable("agent_credit_claims", {
  creditRunId: text("credit_run_id").primaryKey(),
  userId: text("user_id").notNull(),
  family: text("family").notNull(),
  amountUSD: real("amount_usd").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Paid-submission ownership (#2137 follow-ups). One row per
 * submitted paid run, keyed by the workflowId the submit route
 * returns, so submission-status can enforce owner-only reads.
 * This schema MAPS tables; it does not create them — DDL
 * authority lives in migration 0010
 * (src/data/migrationRunner.ts).
 */
export const agentPaidSubmissions = sqliteTable("agent_paid_submissions", {
  workflowId: text("workflow_id").primaryKey(),
  userId: text("user_id").notNull(),
  runRequestId: text("run_request_id").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/** One-time redemption of a credit claim: the PK makes a second redemption impossible. */
export const agentCreditRedemptions = sqliteTable("agent_credit_redemptions", {
  creditRunId: text("credit_run_id").primaryKey(),
  redeemedByRunId: text("redeemed_by_run_id").notNull(),
  redeemedAtMs: integer("redeemed_at_ms").notNull(),
});

/**
 * Subscription object (#2020/#2127) on D1. One row per purchase:
 * a paid-through period, not a provider-managed recurring
 * billing object (cfpay is one-time-only; renewal is repurchase).
 * The UNIQUE index on provider_payment_ref is the replay guard:
 * one verified checkout activates at most one subscription.
 * This schema MAPS tables; it does not create them — DDL
 * authority lives in migration 0008
 * (src/data/migrationRunner.ts).
 */
/**
 * Refund records + externalized refund policy (#2204, sub-issue
 * of #2012, implementation of #2147). This schema MAPS tables;
 * it does not create them — DDL authority lives in migration
 * 0017 (src/data/migrationRunner.ts), and a test pins that this
 * mapping and that DDL agree on columns. The policy table holds
 * exactly one row (id "default"); the refunds table holds one row
 * per refund request through its lifecycle.
 */
export const agentRefundPolicy = sqliteTable("agent_refund_policy", {
  id: text("id").primaryKey(),
  windowDays: integer("window_days").notNull(),
  approver: text("approver").notNull(),
  allowPartial: integer("allow_partial").notNull(),
  subscriptionFullEffect: text("subscription_full_effect").notNull(),
  subscriptionPartialEffect: text("subscription_partial_effect").notNull(),
  payPerRunEffect: text("pay_per_run_effect").notNull(),
  creditEffect: text("credit_effect").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentRefunds = sqliteTable("agent_refunds", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  rail: text("rail").notNull(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  originalPaymentRef: text("original_payment_ref").notNull(),
  subscriptionId: text("subscription_id"),
  paymentIntentId: text("payment_intent_id"),
  family: text("family"),
  originalAmountUSD: real("original_amount_usd").notNull(),
  amountUSD: real("amount_usd").notNull(),
  originalPaidAtMs: integer("original_paid_at_ms").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  approverLogin: text("approver_login"),
  decisionNote: text("decision_note"),
  gatewayRefundId: text("gateway_refund_id"),
  executedAtMs: integer("executed_at_ms"),
  entitlementConsequence: text("entitlement_consequence"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentSubscriptions = sqliteTable("agent_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  planId: text("plan_id").notNull(),
  provider: text("provider").notNull(),
  providerPaymentRef: text("provider_payment_ref").notNull(),
  stripeSessionId: text("stripe_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  providerStatus: text("provider_status"),
  status: text("status").notNull(),
  periodStartMs: integer("period_start_ms").notNull(),
  periodEndMs: integer("period_end_ms").notNull(),
  canceledAtMs: integer("canceled_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Billing policy (#2202, sub-issue of #2020, implementation
 * of design #2145) on D1. One row per policy key; the value
 * is JSON. This schema MAPS the table; it does not create
 * it — DDL authority lives in migration 0014
 * (src/data/migrationRunner.ts).
 */
export const agentBillingPolicy = sqliteTable("agent_billing_policy", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Minimal double-entry journal (#2155, sub-issue of #2012). This
 * schema MAPS tables; it does not create them — DDL authority
 * lives in migration 0009 (src/data/migrationRunner.ts), and a
 * test pins that this mapping and that DDL agree on columns.
 * The chart is global (same codes for all tenants); entries are
 * tenant-scoped. This is a projection of the DO ledger, not a
 * second financial record.
 */
export const agentJournalAccounts = sqliteTable("agent_journal_accounts", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const agentJournalEntries = sqliteTable("agent_journal_entries", {
  id: text("id").primaryKey(),
  transactionRef: text("transaction_ref").notNull(),
  accountCode: text("account_code").notNull(),
  debitUSD: real("debit_usd").notNull(),
  creditUSD: real("credit_usd").notNull(),
  currency: text("currency").notNull(),
  tenantId: text("tenant_id").notNull(),
  runRequestId: text("run_request_id").notNull(),
  family: text("family").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Native ledger rows (#2192, sub-issue of #2012, umbrella
 * #2146). This schema MAPS the table; it does not create it
 * — DDL authority lives in migration 0012
 * (src/data/migrationRunner.ts), and a test pins that this
 * mapping and that DDL agree on columns. Row shape mirrors
 * the cfpay twin (src/services/cfpayLedger.ts) with the
 * native session prefix, a truthful per-rail gateway, and
 * tenantId + family carried natively. Unlike the cfpay rows
 * (DO mas_transactions), native rows live in D1, never in
 * mas_transactions, so BudgetGuard cannot see them.
 */
export const agentNativeLedgerRows = sqliteTable("agent_native_ledger_rows", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  action: text("action").notNull(),
  amount: real("amount_usd").notNull(),
  currency: text("currency").notNull(),
  customer: text("customer").notNull(),
  gateway: text("gateway").notNull(),
  gatewayRef: text("gateway_ref").notNull(),
  status: text("status").notNull(),
  checkoutUrl: text("checkout_url").notNull(),
  proposerDid: text("proposer_did").notNull(),
  proofSignature: text("proof_signature").notNull(),
  note: text("note").notNull(),
  tenantId: text("tenant_id").notNull(),
  family: text("family").notNull(),
  runRequestId: text("run_request_id").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Referral-credit + lifecycle tables (#2208, migration 0015).
 * Column names match migration 0015 exactly; the test pins the
 * two together. agent_referral_earnings is a SEPARATE balance
 * from agent_credit_claims (failure credits) — never joined.
 */
export const agentReferralRules = sqliteTable("agent_referral_rules", {
  id: text("id").primaryKey(),
  earnAmountUSD: real("earn_amount_usd").notNull(),
  vestingDelayMs: integer("vesting_delay_ms").notNull(),
  redemptionScope: text("redemption_scope").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentReferralEarnings = sqliteTable("agent_referral_earnings", {
  id: text("id").primaryKey(),
  referrerUserId: text("referrer_user_id").notNull(),
  referredUserId: text("referred_user_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  amountUSD: real("amount_usd").notNull(),
  redeemedAmountUSD: real("redeemed_amount_usd").notNull(),
  earnedAtMs: integer("earned_at_ms").notNull(),
  vestedAtMs: integer("vested_at_ms").notNull(),
  redeemedByRunId: text("redeemed_by_run_id"),
  redeemedAtMs: integer("redeemed_at_ms"),
});

export const agentNotificationPreferences = sqliteTable("agent_notification_preferences", {
  userId: text("user_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  digestEnabled: integer("digest_enabled").notNull(),
  welcomeEnabled: integer("welcome_enabled").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentDigestSends = sqliteTable(
  "agent_digest_sends",
  {
    userId: text("user_id").notNull(),
    day: text("day").notNull(),
    sentAtMs: integer("sent_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/**
 * Per-run price catalogue (#2185, sub-issue of #2012) on D1.
 * One row per family; operator data, never code. This schema MAPS
 * the table; it does not create it — DDL authority lives in
 * migration 0011 (src/data/migrationRunner.ts), and a test pins
 * that this mapping and that DDL agree on columns.
 */
export const agentPriceCatalogue = sqliteTable("agent_price_catalogue", {
  family: text("family").primaryKey(),
  priceUSD: real("price_usd").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  // Approval state (#2547): migration 0027 adds these columns to
  // the 0011 table; existing rows default to 'proposed'.
  approvalStatus: text("approval_status").notNull().default("proposed"),
  approvedBy: text("approved_by"),
  approvedAtMs: integer("approved_at_ms"),
});

/**
 * Subscription plans (#2020/#2127) as OPERATOR DATA, not code:
 * operators create plans; no price is hardcoded anywhere, because
 * no subscription price is owner-approved. Active plans are what
 * users can buy; deactivation stops new purchases without
 * touching existing subscriptions.
 */
export const agentSubscriptionPlans = sqliteTable("agent_subscription_plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceUSD: real("price_usd").notNull(),
  periodDays: integer("period_days").notNull(),
  includedRuns: integer("included_runs").notNull(),
  active: integer("active").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Q7 audit-policy mechanism (#2183, sub-issue of #2012).
 * This schema MAPS tables; it does not create them — DDL
 * authority lives in migration 0016 (src/data/migrationRunner.ts),
 * and a test pins that this mapping and that DDL agree on
 * columns. Policy rows are global OPERATOR DATA (the proposed
 * blocking set, enforcement mode, retention period — all pending
 * CISO+CDO sign-off); chain rows are tenant-scoped tamper
 * evidence for audit payloads (the payload itself stays in DO
 * mas_events; only its hash is chained here).
 */
export const agentAuditPolicyActions = sqliteTable("agent_audit_policy_actions", {
  action: text("action").primaryKey(),
  blockOnAuditFailure: integer("block_on_audit_failure").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentAuditPolicySettings = sqliteTable("agent_audit_policy_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentAuditChain = sqliteTable("agent_audit_chain", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  sequence: integer("sequence").notNull(),
  action: text("action").notNull(),
  payloadHash: text("payload_hash").notNull(),
  prevHash: text("prev_hash").notNull(),
  entryHash: text("entry_hash").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Intelligence substrate (#1976 step 0, issue #2288; ADR 0022
 * D-F). This schema MAPS the tables; it does not create them —
 * DDL authority lives in migration 0017
 * (src/data/migrationRunner.ts), and a test pins that this
 * mapping and that DDL agree on columns. All four families are
 * D1-native under the ratified R9 restatement: the trace family
 * and the work-item projection are append/upsert substrate the
 * loop reads; the proposal ledger is a state machine whose
 * transitions carry their gate as data; the registry/matrix is
 * a read model whose production writer is gate G-6 (unbuilt).
 */
export const agentTraceRecords = sqliteTable("agent_trace_records", {
  id: text("id").primaryKey(),
  correlationId: text("correlation_id").notNull(),
  causationId: text("causation_id"),
  actingAgent: text("acting_agent").notNull(),
  principal: text("principal").notNull(),
  operation: text("operation").notNull(),
  outcomeCode: text("outcome_code").notNull(),
  latencyMs: integer("latency_ms"),
  costUnits: real("cost_units"),
  costDetailJson: text("cost_detail_json"),
  occurredAtMs: integer("occurred_at_ms").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const agentProposals = sqliteTable("agent_proposals", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  proposerAgent: text("proposer_agent").notNull(),
  principal: text("principal").notNull(),
  state: text("state").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentProposalTransitions = sqliteTable("agent_proposal_transitions", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actor: text("actor").notNull(),
  gateRef: text("gate_ref"),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const agentFleetRegistry = sqliteTable("agent_fleet_registry", {
  agentKey: text("agent_key").primaryKey(),
  className: text("class_name").notNull(),
  binding: text("binding").notNull(),
  instanceScheme: text("instance_scheme").notNull(),
  migrationTag: text("migration_tag"),
  operationsJson: text("operations_json").notNull(),
  identityJson: text("identity_json"),
  doSchemaVersion: integer("do_schema_version"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentConformanceCells = sqliteTable(
  "agent_conformance_cells",
  {
    agentKey: text("agent_key").notNull(),
    dimension: text("dimension").notNull(),
    status: text("status").notNull(),
    reference: text("reference"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentKey, t.dimension] })],
);

export const agentWorkItemEvents = sqliteTable(
  "agent_work_item_events",
  {
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    actor: text("actor"),
    occurredAtMs: integer("occurred_at_ms").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.externalId] })],
);

/**
 * Data-provider platform (#1976 step 1, issue #2303; ADR 0022
 * D-0/D-I step 1). This schema MAPS the tables; it does not
 * create them — DDL authority lives in migration 0019
 * (src/data/migrationRunner.ts), and a test pins that this
 * mapping and that DDL agree on columns. The timestamp columns
 * are ISO-8601 TEXT by stated deviation (see the migration's
 * header): the platform record contract carries ISO strings.
 */
export const agentDataProviders = sqliteTable("agent_data_providers", {
  id: text("id").primaryKey(),
  adapterKind: text("adapter_kind").notNull(),
  lifecycleState: text("lifecycle_state").notNull(),
  enabled: integer("enabled").notNull().default(0),
  precedence: integer("precedence").notNull(),
  credentialRef: text("credential_ref"),
  configJson: text("config_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentDataProviderRoutes = sqliteTable(
  "agent_data_provider_routes",
  {
    capability: text("capability").primaryKey(),
    primaryProviderId: text("primary_provider_id").notNull(),
    gapFillProviderId: text("gap_fill_provider_id"),
    minTier: text("min_tier").notNull().default("freemium"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const agentDataCaptures = sqliteTable("agent_data_captures", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  capability: text("capability").notNull(),
  requestParamsJson: text("request_params_json").notNull().default("{}"),
  runId: text("run_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  userLogin: text("user_login"),
  fetchedAt: text("fetched_at").notNull(),
  status: text("status").notNull(),
  rawKind: text("raw_kind"),
  rawBlobRef: text("raw_blob_ref"),
  rawByteSize: integer("raw_byte_size"),
  rawSha256: text("raw_sha256"),
  normalizedDigest: text("normalized_digest"),
  retentionClass: text("retention_class").notNull(),
  failureError: text("failure_error"),
  failureKind: text("failure_kind"),
  failureMessage: text("failure_message"),
  createdAt: text("created_at").notNull(),
});


/**
 * IV history (#1976 step 2, issue #2337; ADR 0022 D-I step 2).
 * This schema MAPS the table; it does not create it — DDL
 * authority lives in migration 0020 (src/data/migrationRunner
 * .ts), and a test pins that this mapping and that DDL agree
 * on columns. The family's only tenant-free table: keyed
 * (symbol, date), first-write-wins. Dates are ISO TEXT (the
 * record contract's own shape — IvHistoryRecord.date is an ISO
 * day string), mirroring the DO table's columns exactly.
 */
export const agentIvHistory = sqliteTable(
  "agent_iv_history",
  {
    symbol: text("symbol").notNull(),
    date: text("date").notNull(),
    atmIv: real("atm_iv").notNull(),
    spot: real("spot").notNull(),
    expiryDate: text("expiry_date").notNull(),
    dte: integer("dte").notNull(),
    collectedAt: text("collected_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.date] }),
  ],
);

/**
 * Issue #2345 (#1976 step 3a) — the marketplace tables, moved
 * from per-DO mas_* storage to the shared D1 database
 * (migration 0021). Column-for-column mirrors of the DO tables
 * (mas_categories / mas_referrals / mas_ads / mas_external_ads)
 * so the same records flow over both residencies; the DDL
 * authority is migration 0021 and a parity pin holds the two
 * together.
 */
export const agentCategories = sqliteTable("agent_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull(),
  icon: text("icon").notNull(),
  isActive: integer("is_active").default(1),
  sortOrder: integer("sort_order").default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentReferrals = sqliteTable("agent_referrals", {
  id: text("id").primaryKey(),
  userLogin: text("session_id").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  category: text("category").notNull(),
  rewardText: text("reward_text").notNull(),
  clicks: integer("clicks").default(0),
  signups: integer("signups").default(0),
  createdAt: text("created_at").notNull(),
});

export const agentAds = sqliteTable("agent_ads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  tagline: text("tagline").notNull(),
  sponsor: text("sponsor").notNull(),
  badge: text("badge").notNull(),
  url: text("url").notNull(),
  ctaText: text("cta_text").notNull(),
  accentColor: text("accent_color").notNull(),
  impressions: integer("impressions").default(0),
  clicks: integer("clicks").default(0),
  createdAt: text("created_at").notNull(),
});

export const agentExternalAds = sqliteTable("agent_external_ads", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  network: text("network").notNull(),
  placement: text("placement").notNull(),
  title: text("title").notNull(),
  tagline: text("tagline").notNull(),
  ctaText: text("cta_text").notNull(),
  targetUrl: text("target_url").notNull(),
  bannerImageUrl: text("banner_image_url"),
  cpmRate: real("cpm_rate").default(15.0),
  cpcRate: real("cpc_rate").default(1.25),
  impressions: integer("impressions").default(0),
  clicks: integer("clicks").default(0),
  earnings: real("earnings").default(0.0),
  isActive: integer("is_active").default(1),
  createdAt: text("created_at").notNull(),
});

/**
 * D1 regularization (#1976 step 4f, issue #2362; ADR 0022
 * D-A consequences). These five tables were self-created at
 * runtime by their modules (step-4 audit R-8); migration 0022
 * is now their DDL authority and this schema MAPS them — it
 * does not create them. A parity pin holds each mapping and
 * the 0022 DDL together on columns, and a shape pin holds
 * both against the shapes the legacy self-create produced.
 * Table names keep their runtime names (no agent_ prefix):
 * the regularization versions the existing tables in place —
 * renaming would orphan live data for zero behaviour gain.
 */
export const quoteSourceSetting = sqliteTable("quote_source_setting", {
  id: integer("id").primaryKey(),
  source: text("source").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const resourceSqlOps = sqliteTable("resource_sql_ops", {
  tsMs: integer("ts_ms").notNull(),
  ns: text("ns").notNull(),
  op: text("op").notNull(),
  rowsRead: integer("rows_read").notNull(),
  rowsWritten: integer("rows_written").notNull(),
  caller: text("caller"),
  trigger: text("trigger"),
  statement: text("statement"),
  tenantId: text("tenant_id"),
  runId: text("run_id"),
  sessionRef: text("session_ref"),
});

export const resourceDailyRollups = sqliteTable(
  "resource_daily_rollups",
  {
    day: text("day").notNull(),
    ns: text("ns").notNull(),
    op: text("op").notNull(),
    caller: text("caller").notNull(),
    trigger: text("trigger").notNull(),
    ops: integer("ops").notNull(),
    rowsRead: integer("rows_read").notNull(),
    rowsWritten: integer("rows_written").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.ns, table.op, table.caller, table.trigger] }),
  ],
);

export const resourceAlertState = sqliteTable(
  "resource_alert_state",
  {
    budget: text("budget").notNull(),
    day: text("day").notNull(),
    alertedAt: integer("alerted_at").notNull(),
    delivered: integer("delivered").notNull(),
    note: text("note"),
  },
  (table) => [primaryKey({ columns: [table.budget, table.day] })],
);

export const resourceComparisonReports = sqliteTable("resource_comparison_reports", {
  day: text("day").primaryKey(),
  generatedAt: integer("generated_at").notNull(),
  reportJson: text("report_json").notNull(),
});

/**
 * Issue #2428 (Agent Mesh S17, G13a) — one row per recorded
 * mesh trace hop. The (trace_id, span_id) primary key is the
 * recording idempotency rule (durable replay converges).
 * tenant_id is nullable by design: a hop emitted at a boundary
 * with no tenant scope records null, never a fabricated tenant
 * (the #1743 scope rule). DDL lives in MIGRATION_0023.
 */
export const agentMeshTraceHops = sqliteTable(
  "agent_mesh_trace_hops",
  {
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    kind: text("kind").notNull(),
    operation: text("operation").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    tenantId: text("tenant_id"),
    caller: text("caller"),
    agentName: text("agent_name"),
    jobId: text("job_id"),
    note: text("note"),
  },
  (table) => [
    primaryKey({ columns: [table.traceId, table.spanId] }),
  ],
);

/**
 * Issue #2439 (Agent Mesh S18, G13b) — one row per scored
 * golden-task result. The (run_id, task_id) primary key is the
 * recording idempotency rule (the first record of a run wins).
 * Facts and failures are JSON text: scalar evidence only (codes,
 * ids, counts, booleans) — never payloads or free text from a
 * door response. DDL lives in MIGRATION_0024.
 */
export const agentMeshEvalResults = sqliteTable(
  "agent_mesh_eval_results",
  {
    runId: text("run_id").notNull(),
    taskId: text("task_id").notNull(),
    door: text("door").notNull(),
    className: text("class_name").notNull(),
    seq: integer("seq").notNull(),
    passed: integer("passed").notNull(),
    outcome: text("outcome").notNull(),
    refusalCode: text("refusal_code"),
    failuresJson: text("failures_json").notNull(),
    traceId: text("trace_id"),
    traceHopKindsJson: text("trace_hop_kinds_json"),
    traceComplete: integer("trace_complete"),
    factsJson: text("facts_json").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.taskId] }),
  ],
);

/**
 * Issue #2460 (Agent Mesh S19, G13c) — one row per RSI proposal
 * record drafted by the proposal pipeline. Evidence refs and the
 * evidence-bar verdict are JSON text: scalar evidence only (run
 * ids, trace ids, counts, codes) — never payloads. The proposal
 * text fields are the pipeline's own drafted prose (problem,
 * change, expected effect, falsification criterion), not door
 * output. DDL lives in MIGRATION_0025.
 */
export const agentMeshProposals = sqliteTable("agent_mesh_proposals", {
  id: text("id").primaryKey(),
  signalKey: text("signal_key").notNull(),
  title: text("title").notNull(),
  problem: text("problem").notNull(),
  proposedChange: text("proposed_change").notNull(),
  expectedEffect: text("expected_effect").notNull(),
  falsificationCriterion: text("falsification_criterion").notNull(),
  evidenceRefsJson: text("evidence_refs_json").notNull(),
  state: text("state").notNull(),
  barVerdictJson: text("bar_verdict_json"),
  filedIssueNumber: integer("filed_issue_number"),
  filedIssueUrl: text("filed_issue_url"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});
