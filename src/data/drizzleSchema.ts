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
    workflowRunId: text("workflow_run_id"),
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
    /**
     * Issue #4116 — the D1 job run record this projected report is
     * the twin of (the #3946 twin-rows link, resolved at projection
     * time by generation_id + run window, only when unambiguous).
     * Null when no job record links to this report — the twin
     * survives as its own row, never merged by guesswork.
     */
    linkedJobRunId: text("linked_job_run_id"),
    /**
     * Issue #4116 — the projected report's owning login (the
     * DO row's user_login). The D1-only reads filter by it
     * exactly like the DO read filters by userLogin, so the
     * cutover preserves owner scoping. Null for rows projected
     * before this column landed (the seed backfills it).
     */
    userLogin: text("user_login"),
    /**
     * Issue #4116 (migration 0060) — the R2 pointer for
     * pointer rows (the DO row's body_r2_key). Null when the
     * body is inline. The D1-only read resolves it from R2,
     * read-only, so a projected pointer row stays readable
     * from D1 alone.
     */
    bodyR2Key: text("body_r2_key"),
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
  /** Issue #3245: unlimited-free grant (migration 0040). NULL = no grant. */
  unlimitedFreeGrantedBy: text("unlimited_free_granted_by"),
  unlimitedFreeReason: text("unlimited_free_reason"),
  unlimitedFreeExpiresAtMs: integer("unlimited_free_expires_at_ms"),
  /** Issue #3289: the customer's market/customer segment (migration 0058). Default "default"; a missing/null segment reads as "default". */
  segment: text("segment").notNull().default("default"),
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
  /** Per-tenant data-provider selection. Absent row = etrade. */
  dataProviderId: text("data_provider_id").notNull().default("etrade"),
  /** Per-tenant broker selection. Absent row = etrade. */
  brokerId: text("broker_id").notNull().default("etrade"),
});

/**
 * Issue #3169 — per-tenant delivery-channel enablement flags.
 * One row per tenant, one flag per channel. Absent row = every
 * channel enabled (the port's DEFAULT_TENANT_CHANNELS). Flags
 * ONLY: this table never holds a webhook URL, token, or
 * secret — those stay in worker bindings.
 */
export const agentTenantChannels = sqliteTable("agent_tenant_channels", {
  tenantId: text("tenant_id").primaryKey(),
  emailEnabled: integer("email_enabled").notNull().default(1),
  slackEnabled: integer("slack_enabled").notNull().default(1),
  webhookEnabled: integer("webhook_enabled").notNull().default(1),
  copilotEnabled: integer("copilot_enabled").notNull().default(1),
  docsEnabled: integer("docs_enabled").notNull().default(1),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Issue #4116 — per-tenant run-ledger projection carrier flags.
 * One row per tenant, one flag per carrier (queues / ORM / sweep)
 * plus the read mode the surfaces use. NO defaults anywhere: the
 * columns carry no `.default()` (contrast agentTenantChannels,
 * whose absent row means "everything enabled" — the wrong
 * direction here). Absent row = unconfigured: the tenant projects
 * nothing and the read names it, never silently degrades to a
 * default carrier. readMode is "merged" (today's Option B view)
 * or "d1-only"; it is set explicitly by the operator — the read
 * seam treats an absent row as merged (the documented pre-cutover
 * state) and reports the mode in the response, never silently.
 */
export const agentTenantProjectionCarriers = sqliteTable("agent_tenant_projection_carriers", {
  tenantId: text("tenant_id").primaryKey(),
  queuesEnabled: integer("queues_enabled").notNull(),
  ormEnabled: integer("orm_enabled").notNull(),
  sweepEnabled: integer("sweep_enabled").notNull(),
  readMode: text("read_mode").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Issue #3256 — server-side onboarding state: one row per verified
 * login. currentStep is 1..5 (1 account, 2 trial, 3 brokerage, 4
 * preferences, 5 summary); completedAtMs is set server-side when
 * the user finishes; trialPlanId/trialStartedAtMs record the trial
 * started from the flow, if any. tenantId is stamped server-side
 * from the resolved platform identity — informational only, never
 * a scoping input. This schema MAPS the table; DDL authority lives
 * in migration 0042 (src/data/migrationRunner.ts).
 */
export const agentOnboardingState = sqliteTable("agent_onboarding_state", {
  userLogin: text("user_login").primaryKey(),
  tenantId: text("tenant_id"),
  currentStep: integer("current_step").notNull().default(1),
  completedAtMs: integer("completed_at_ms"),
  trialPlanId: text("trial_plan_id"),
  trialStartedAtMs: integer("trial_started_at_ms"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Issue #3261 — user profile: display name + phone, one row per
 * verified login. A dedicated table, not columns on the commercial
 * accounts row, so billing upserts can never clobber profile
 * fields. Phone is an UNVERIFIED contact field, never used for
 * auth or recovery. No email column: email change touches IAAA /
 * session / auth and needs CISO review first (#3261 comment
 * 6681436382, refs #945). This schema MAPS the table; DDL
 * authority lives in migration 0050 (src/data/migrationRunner.ts).
 */
export const agentUserProfiles = sqliteTable("agent_user_profiles", {
  userLogin: text("user_login").primaryKey(),
  displayName: text("display_name"),
  phone: text("phone"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Profile idempotency keys (#3261, standards §7.2 Idempotent
 * Receiver). One row per save attempt, keyed globally by the
 * client-supplied key: a replayed key is a duplicate, for any
 * login. This schema MAPS the table; DDL authority lives in
 * migration 0050 (src/data/migrationRunner.ts). Keys carry
 * createdAtMs but have no expiry/cleanup in this slice — a
 * cleanup window is a follow-up on #3261.
 */
export const agentProfileIdempotencyKeys = sqliteTable("agent_profile_idempotency_keys", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  userLogin: text("user_login").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Free-run allowance per family (#3305, sub-issue of #3241). One
 * row per screener family with the current allowance (runs per
 * UTC calendar month), operator data seeded at 10. This schema
 * MAPS the table; DDL authority lives in migration 0043
 * (src/data/migrationRunner.ts).
 */
export const agentFreeRunAllowances = sqliteTable("agent_free_run_allowances", {
  family: text("family").primaryKey(),
  runs: integer("runs").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Free runs consumed per account, product, and month (#3305).
 * One row per (login, family, UTC calendar month "YYYY-MM");
 * a missing row reads as 0 consumed. This schema MAPS the
 * table; DDL authority lives in migration 0043
 * (src/data/migrationRunner.ts).
 */
export const agentFreeRunCounts = sqliteTable(
  "agent_free_run_counts",
  {
    userLogin: text("user_login").notNull(),
    family: text("family").notNull(),
    month: text("month").notNull(),
    used: integer("used").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userLogin, t.family, t.month] })],
);

/**
 * Approved-free per-service quota caps (#3263). One row per family
 * with the current cap (runs per period); operator data seeded at 10
 * by migration 0055. This schema MAPS the table; DDL authority lives
 * in migration 0054 (src/data/migrationRunner.ts).
 */
export const agentApprovedFreeQuotas = sqliteTable("agent_approved_free_quotas", {
  family: text("family").primaryKey(),
  capRuns: integer("cap_runs").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  updatedBy: text("updated_by"),
});

/**
 * Approved-free quota runs consumed (#3263). One row per (tenant,
 * login, family, period); a missing row reads as 0 consumed. The
 * tenant_id is part of the key (#1069 §10): usage in Tenant A never
 * leaks to Tenant B. This schema MAPS the table; DDL authority lives
 * in migration 0054 (src/data/migrationRunner.ts).
 */
export const agentApprovedFreeQuotaCounts = sqliteTable(
  "agent_approved_free_quota_counts",
  {
    tenantId: text("tenant_id").notNull(),
    userLogin: text("user_login").notNull(),
    family: text("family").notNull(),
    period: text("period").notNull(),
    used: integer("used").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userLogin, t.family, t.period] })],
);

/**
 * Approved-free quota settings (#3263). One row (id 'default') with
 * the window kind ('month' | 'week') and the at-limit action
 * ('upgrade_or_buy_credits' | 'stop'); operator data seeded by
 * migration 0055 (month + upgrade_or_buy_credits, i.e. #3241
 * decision 4). This schema MAPS the table; DDL authority lives in
 * migration 0054 (src/data/migrationRunner.ts).
 */
export const agentApprovedFreeQuotaSettings = sqliteTable("agent_approved_free_quota_settings", {
  id: text("id").primaryKey(),
  windowKind: text("window_kind").notNull(),
  atLimitAction: text("at_limit_action").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  updatedBy: text("updated_by"),
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
  /** Issue #3289: the product/version/price of the charge this claim reverses (migration 0058). NULL on legacy claims. */
  productId: text("product_id"),
  versionId: text("version_id"),
  priceUSD: real("price_usd"),
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
  approvedKinds: text("approved_kinds").notNull(),
  approvedBy: text("approved_by"),
  approvedAtMs: integer("approved_at_ms"),
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
 * cfpay channel purchase drafts (#2945, Phase 2.17 of #2405) on D1.
 * One row per channel purchase: the draft id IS the cfpay checkout
 * request id (also the replay guard). This schema MAPS the table; it
 * does not create it — DDL authority lives in migration 0037
 * (src/data/migrationRunner.ts).
 */
export const agentCfpayChannelPurchases = sqliteTable("agent_cfpay_channel_purchases", {
  id: text("id").primaryKey(),
  userLogin: text("user_login").notNull(),
  tenantId: text("tenant_id").notNull(),
  email: text("email").notNull(),
  family: text("family").notNull(),
  expectedPriceUSD: real("expected_price_usd").notNull(),
  status: text("status").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  fulfilledAtMs: integer("fulfilled_at_ms"),
  paymentIntentId: text("payment_intent_id"),
  fulfilSkippedReason: text("fulfil_skipped_reason"),
});

/**
 * Self-service top-up drafts (#3262). This schema MAPS the table;
 * it does not create it — DDL authority lives in migration 0048
 * (src/data/migrationRunner.ts).
 */
export const agentTopUpDrafts = sqliteTable("agent_top_up_drafts", {
  id: text("id").primaryKey(),
  userLogin: text("user_login").notNull(),
  tenantId: text("tenant_id").notNull(),
  email: text("email").notNull(),
  amountUSD: real("amount_usd").notNull(),
  rail: text("rail").notNull(),
  status: text("status").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  creditedAtMs: integer("credited_at_ms"),
  paymentIntentId: text("payment_intent_id"),
  checkoutSessionId: text("checkout_session_id"),
  challengeNonce: text("challenge_nonce"),
});

/**
 * Billing customer mapping (#2656, Phase 2.1 of #2405) on D1.
 * One row per user: the provider customer id for that user's
 * Billing checkouts (first-wins — see billingCustomerPorts.ts).
 * This schema MAPS the table; it does not create it — DDL
 * authority lives in migration 0030
 * (src/data/migrationRunner.ts).
 */
export const agentBillingCustomers = sqliteTable("agent_billing_customers", {
  userId: text("user_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
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
  /** Issue #3289: per-charge product/version/price recording (migration 0058). NULL on legacy rows; the mapping layer requires them for new per-run events. */
  productId: text("product_id"),
  versionId: text("version_id"),
  priceUSD: real("price_usd"),
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
/**
 * Durable payment-proof redemptions (#2548, from the #2013
 * review). One row per redemption key (claim id, x402
 * nonce+payer, or proof-payload hash); the PRIMARY KEY is the
 * replay backstop — the first run to record a key owns the
 * proof. This schema MAPS the table; DDL authority lives in
 * migration 0029 (src/data/migrationRunner.ts).
 */
export const agentPaymentProofRedemptions = sqliteTable("agent_payment_proof_redemptions", {
  redemptionKey: text("redemption_key").primaryKey(),
  runRequestId: text("run_request_id").notNull(),
  rail: text("rail").notNull(),
  payer: text("payer"),
  redeemedAtMs: integer("redeemed_at_ms").notNull(),
});

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
  /** Issue #3289: per-charge product/version/price recording (migration 0058). NULL on legacy rows; the price is the charge price. */
  productId: text("product_id"),
  versionId: text("version_id"),
  priceUSD: real("price_usd"),
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

/**
 * Referrer→referred attribution rows (#2657, migration 0031). One row per
 * referred user, ever — the PRIMARY KEY is the referred user, which is the
 * set-once backstop (a racing second attribution for the same user hits a
 * PK conflict and is reconciled from the row, never a duplicate).
 * SEPARATE from agent_referral_earnings (the link, not the money) and from
 * agent_credit_claims (failure credits) — never joined.
 */
export const agentReferralAttributions = sqliteTable("agent_referral_attributions", {
  referredUserId: text("referred_user_id").primaryKey(),
  referrerUserId: text("referrer_user_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  source: text("source").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Store-managed commercial operator list (#2680). One row per
 * store operator login; operator data, never code. This schema
 * MAPS the table; it does not create it — DDL authority lives
 * in migration 0032 (src/data/migrationRunner.ts). The env list
 * (COMMERCIAL_STORE_OPERATORS) is NOT in this table: env
 * operators are bootstrap fallback, merged at read time by the
 * route handler, and never written here.
 */
export const agentStoreOperators = sqliteTable("agent_store_operators", {
  login: text("login").primaryKey(),
  addedBy: text("added_by").notNull(),
  addedAtMs: integer("added_at_ms").notNull(),
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

/** Issue #2659: addresses recorded from successful sends (see migration 0035). */
export const agentDigestSubscriberEmails = sqliteTable("agent_digest_subscriber_emails", {
  userId: text("user_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  email: text("email").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** Issue #2659: once-per-UTC-day marker for the scheduled digest pass. */
export const agentDigestPassDays = sqliteTable("agent_digest_pass_days", {
  day: text("day").primaryKey(),
  ranAtMs: integer("ran_at_ms").notNull(),
});

/**
 * Per-run price catalogue (#2185, sub-issue of #2012) on D1.
 * One row per family; operator data, never code. This schema MAPS
 * the table; it does not create it — DDL authority lives in
 * migration 0011 (src/data/migrationRunner.ts), and a test pins
 * that this mapping and that DDL agree on columns.
 */
export const agentPriceCatalogue = sqliteTable("agent_price_catalogue", {
  /**
   * Issue #3289: the catalogue is versioned (migration 0058
   * rebuilds the table). The PRIMARY KEY is the version id
   * (`cat-<family>-<segment>-v<version>`); `family` is no longer
   * the key — one family has many versions across segments.
   * This schema MAPS the table; it does not create it — DDL
   * authority lives in migration 0058
   * (src/data/migrationRunner.ts), and a test pins that this
   * mapping and that DDL agree on columns.
   */
  id: text("id").primaryKey(),
  family: text("family").notNull(),
  priceUSD: real("price_usd").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  // Approval state (#2547): migration 0027 adds these columns to
  // the 0011 table; existing rows default to 'proposed'. Migration
  // 0058 rebuilds the table and carries them into the new DDL.
  approvalStatus: text("approval_status").notNull().default("proposed"),
  approvedBy: text("approved_by"),
  approvedAtMs: integer("approved_at_ms"),
  // Version columns (#3289, migration 0058): the product this
  // version belongs to, the segment it is sellable to, the
  // per-product per-segment version number, and the effective
  // window (effectiveToMs null = open-ended).
  productId: text("product_id").notNull(),
  segment: text("segment").notNull().default("default"),
  version: integer("version").notNull(),
  effectiveFromMs: integer("effective_from_ms").notNull(),
  effectiveToMs: integer("effective_to_ms"),
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
  // Trial length in days (#3243, migration 0041): null = the
  // plan offers no trial. This schema MAPS the table; it does
  // not create it — DDL authority lives in migration 0041
  // (src/data/migrationRunner.ts).
  trialDays: integer("trial_days"),
  // Price approval (#3357, migration 0049): mirrors the #2547
  // catalogue columns. Pre-0049 rows are grandfathered as
  // approved with a NULL approver (see the migration comment).
  // This schema MAPS the table; it does not create it — DDL
  // authority lives in migration 0049 (src/data/migrationRunner.ts).
  approvalStatus: text("approval_status").notNull().default("proposed"),
  approvedBy: text("approved_by"),
  approvedAtMs: integer("approved_at_ms"),
  active: integer("active").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  // Product versions (#3289, migration 0058): the plan row IS
  // the version. productId is the product it belongs to;
  // segment is the market it is sellable to (default "default");
  // version is the per-product per-segment number from 1;
  // effectiveFromMs/effectiveToMs are the launch window
  // (effectiveToMs null = open-ended); billingPeriod is
  // monthly|annual; featuresJson is a display-only JSON array;
  // stripePriceId is the Stripe Price object for this version.
  productId: text("product_id").notNull().default(""),
  segment: text("segment").notNull().default("default"),
  version: integer("version").notNull().default(1),
  effectiveFromMs: integer("effective_from_ms").notNull().default(0),
  effectiveToMs: integer("effective_to_ms"),
  billingPeriod: text("billing_period").notNull().default("monthly"),
  featuresJson: text("features_json"),
  stripePriceId: text("stripe_price_id"),
});

/**
 * Products (#3289, migration 0058): product identity. A product
 * is the thing customers buy; its versions (plan rows for
 * subscriptions, catalogue rows for per-run) are the immutable
 * terms snapshots. This schema MAPS the table; DDL authority
 * lives in migration 0058 (src/data/migrationRunner.ts).
 */
export const agentProducts = sqliteTable("agent_products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  description: text("description"),
  /**
   * Issue #3246 (migration 0062) — the explicit ladder position:
   * 1 = the lowest rung, larger = higher; NULL = unranked (the
   * derived order applies). prod-free is seeded to rank 1.
   */
  rank: integer("rank"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Offer-dismissal suppressions (#3246 §4.4, migration 0062):
 * one row per (login, trigger) — a dismissed trigger stays
 * suppressed until suppressed_until_ms. Expired rows are inert
 * (read as absent). This schema MAPS the table; DDL authority
 * lives in migration 0062.
 */
export const agentOfferSuppressions = sqliteTable(
  "agent_offer_suppressions",
  {
    login: text("login").notNull(),
    trigger: text("trigger").notNull(),
    suppressedUntilMs: integer("suppressed_until_ms").notNull(),
    dismissedAtMs: integer("dismissed_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.login, t.trigger] })],
);

/**
 * Runs-pack versions (#3246 slice 3, migration 0063): one row per
 * pack version — the approval-gated (runs, price) terms for a
 * runs_pack product. This schema MAPS the table; DDL authority
 * lives in migration 0063.
 */
export const agentRunsPackVersions = sqliteTable("agent_runs_pack_versions", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  version: integer("version").notNull(),
  segment: text("segment").notNull(),
  runs: integer("runs").notNull(),
  priceUSD: real("price_usd").notNull(),
  approvalStatus: text("approval_status").notNull(),
  approvedBy: text("approved_by"),
  approvedAtMs: integer("approved_at_ms"),
  active: integer("active").notNull().default(1),
  effectiveFromMs: integer("effective_from_ms").notNull(),
  effectiveToMs: integer("effective_to_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Runs-pack balances (#3246 slice 3, migration 0063): one row per
 * login — the dedicated pack balance. This schema MAPS the table;
 * DDL authority lives in migration 0063.
 */
export const agentRunsPackBalances = sqliteTable("agent_runs_pack_balances", {
  login: text("login").primaryKey(),
  runsRemaining: integer("runs_remaining").notNull().default(0),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Runs-pack drafts (#3246 slice 3, migration 0063): one row per
 * pack checkout — the mint/confirm binding. This schema MAPS the
 * table; DDL authority lives in migration 0063.
 */
export const agentRunsPackDrafts = sqliteTable("agent_runs_pack_drafts", {
  id: text("id").primaryKey(),
  userLogin: text("user_login").notNull(),
  tenantId: text("tenant_id").notNull(),
  email: text("email").notNull(),
  versionId: text("version_id").notNull(),
  productId: text("product_id").notNull(),
  runs: integer("runs").notNull(),
  priceUSD: real("price_usd").notNull(),
  rail: text("rail").notNull(),
  status: text("status").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  creditedAtMs: integer("credited_at_ms"),
  paymentIntentId: text("payment_intent_id"),
  checkoutSessionId: text("checkout_session_id"),
  challengeNonce: text("challenge_nonce"),
});

/**
 * Free-access grants (#3247 slice 1, migration 0064): one row
 * per grant — the durable, auditable, revocable record of free
 * access for one login. Expired and revoked rows stay as
 * history; no tenant column (keyed by login; the audit event
 * carries the tenant from the account row). This schema MAPS
 * the table; DDL authority lives in migration 0064.
 */
export const agentFreeAccessGrants = sqliteTable("agent_free_access_grants", {
  id: text("id").primaryKey(),
  login: text("login").notNull(),
  kind: text("kind").notNull(),
  grantedBy: text("granted_by").notNull(),
  grantedAtMs: integer("granted_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms"),
  revokedAtMs: integer("revoked_at_ms"),
  reason: text("reason").notNull(),
});

/**
 * Per-customer version moves (#3289 §3.8, migration 0058): one
 * row per customer moved — the audit that answers "what
 * happened to customer X". bulkMoveId is null for a
 * per-customer move; productId is null for a segment-only move
 * by a customer holding no version. This schema MAPS the
 * table; DDL authority lives in migration 0058.
 */
export const agentVersionMoves = sqliteTable("agent_version_moves", {
  id: text("id").primaryKey(),
  bulkMoveId: text("bulk_move_id"),
  userId: text("user_id").notNull(),
  productId: text("product_id"),
  fromVersionId: text("from_version_id"),
  toVersionId: text("to_version_id"),
  segment: text("segment").notNull(),
  movedBy: text("moved_by").notNull(),
  reason: text("reason"),
  movedAtMs: integer("moved_at_ms").notNull(),
});

/**
 * Bulk-move summaries (#3289 §3.8, migration 0058): one row per
 * bulk move (the "move all customers to current pricing"
 * action, slice 2). This schema MAPS the table; DDL authority
 * lives in migration 0058.
 */
export const agentBulkMoves = sqliteTable("agent_bulk_moves", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  segmentScope: text("segment_scope"),
  targetVersionIdsJson: text("target_version_ids_json").notNull(),
  movedBy: text("moved_by").notNull(),
  reason: text("reason"),
  status: text("status").notNull(),
  movedCount: integer("moved_count").notNull(),
  skippedCount: integer("skipped_count").notNull(),
  failedCount: integer("failed_count").notNull(),
  startedAtMs: integer("started_at_ms").notNull(),
  finishedAtMs: integer("finished_at_ms"),
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
    /** Issue #3326: broker whose chain produced the observation (migration 0045). */
    broker: text("broker").notNull().default("etrade"),
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

/**
 * Phase 5 Slice 1 (issue #2000) — one row per persisted
 * terminal drop, plus the single depth-incident row. The
 * envelope is JSON text (parse before reading fields); the
 * replay mark is the guarded claim (replayed_at_ms NULL
 * guard + replay_token check). DDL lives in MIGRATION_0033.
 */
export const agentDeadLetterRecords = sqliteTable("agent_dead_letter_records", {
  id: text("id").primaryKey(),
  queue: text("queue").notNull(),
  reason: text("reason").notNull(),
  messageId: text("message_id"),
  runId: text("run_id"),
  unitId: text("unit_id"),
  actorLogin: text("actor_login"),
  actorKind: text("actor_kind"),
  subscriber: text("subscriber"),
  detail: text("detail"),
  envelopeJson: text("envelope_json"),
  createdAtMs: integer("created_at_ms").notNull(),
  replayedAtMs: integer("replayed_at_ms"),
  replayOutcome: text("replay_outcome"),
  replayToken: text("replay_token"),
});

export const dlqDepthState = sqliteTable("dlq_depth_state", {
  id: text("id").primaryKey(),
  alertedAtMs: integer("alerted_at_ms"),
  depthAtAlert: integer("depth_at_alert"),
  claimToken: text("claim_token"),
});

/** Phase 5 Slice 2 (#2000) — durable breaker state, one row per provider. */
export const agentBreakerState = sqliteTable("agent_breaker_state", {
  providerId: text("provider_id").primaryKey(),
  state: text("state").notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull(),
  openedAtMs: integer("opened_at_ms"),
  lastFailureAtMs: integer("last_failure_at_ms"),
  totalCalls: integer("total_calls").notNull(),
  totalSuccesses: integer("total_successes").notNull(),
  totalFailures: integer("total_failures").notNull(),
  totalTrips: integer("total_trips").notNull(),
  totalFallbacks: integer("total_fallbacks").notNull(),
  totalRejected: integer("total_rejected").notNull(),
  transitionSeq: integer("transition_seq").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** Phase 5 Slice 2 (#2000) — trip-alert claims, one row per transition id. */
export const breakerTripAlerts = sqliteTable("breaker_trip_alerts", {
  transitionId: text("transition_id").primaryKey(),
  alertedAtMs: integer("alerted_at_ms"),
  claimToken: text("claim_token"),
});

/**
 * Pipeline J1 (#3534, ORM conformance #3548) — the job pipeline's
 * contribution to the foundation: job definitions, one row per
 * job id. The definition persists as whole JSON (it is a
 * configuration value, resolved by the config layer); name and
 * version ride as columns for listing. DDL authority:
 * migration 0046. Timestamps are ISO text — residency parity
 * with the authoritative DO table (the pipeline's records are
 * ISO-timestamped end to end), not the epoch-ms projection
 * convention.
 */
export const jobPipelineDefinitions = sqliteTable("job_pipeline_definitions", {
  jobId: text("job_id").primaryKey(),
  name: text("name").notNull(),
  definitionJson: text("definition_json").notNull(),
  version: integer("version").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Pipeline J1 (#3534, #3548) — live job instance state, one row
 * per job id: management state, the resume-cursor view, and the
 * stage-runner checkpoint ledger (#3549). DDL: migration 0046;
 * `run_schedule_id` (#3310) arrives via D1 migration 0059 and
 * the DO probed additive column in ensureSchema.
 */
export const jobPipelineInstances = sqliteTable("job_pipeline_instances", {
  jobId: text("job_id").primaryKey(),
  state: text("state").notNull(),
  desiredState: text("desired_state").notNull(),
  currentRunId: text("current_run_id"),
  runStartedAt: text("run_started_at"),
  runTrigger: text("run_trigger"),
  runScheduleId: text("run_schedule_id"),
  checkpointJson: text("checkpoint_json"),
  stageCheckpointJson: text("stage_checkpoint_json"),
  stageDesiredJson: text("stage_desired_json"),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Pipeline J1 (#3534, #3548) — persisted step hand-off artifacts,
 * one row per (run, artifact key); the `id` column is the
 * surrogate composite key the ORM Repository core addresses
 * (run id + separator + artifact key). The migration's DDL also
 * carries the (run_id, artifact_key) index. DDL: migration 0046.
 */
export const jobPipelineArtifacts = sqliteTable("job_pipeline_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  artifactKey: text("artifact_key").notNull(),
  valueJson: text("value_json").notNull(),
});

/**
 * Pipeline J1 (#3534, #3548) — terminal job run records, the
 * #2964/#3121 run-record family's table (system column carries
 * "job-pipeline" for pipeline runs). Until this mapping the
 * family lived only in its DO adapter's DDL; the D1 residency
 * the workflow substrate needs is declared here, with the
 * (job_id, started DESC, id DESC) history index in the DDL.
 * Timestamps are ISO text — the record family's own shape.
 * DDL: migration 0047.
 */
export const jobRunRecords = sqliteTable("job_run_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  system: text("system").notNull(),
  jobId: text("job_id").notNull(),
  operation: text("operation").notNull(),
  started: text("started").notNull(),
  finished: text("finished").notNull(),
  outcome: text("outcome").notNull(),
  triggeredBy: text("triggered_by").notNull(),
  triggerText: text("trigger_text"),
  scheduleId: text("schedule_id"),
  asyncJobId: text("async_job_id"),
  workflowId: text("workflow_id"),
  errorText: text("error_text"),
  detail: text("detail"),
  descriptor: text("descriptor"),
  artifactRefsJson: text("artifact_refs_json"),
});

/**
 * Issue #4116 — the D1 projection of the DO mas_async_jobs ledger.
 * One row per async job (natural key job_id), mirroring the DO
 * columns the Workflow Runs read consumes, plus the tenant that
 * owns the projection and the twin link. The DO row stays
 * authoritative; this table is the projection — a failed
 * projection never fails the DO write, and a stale projection
 * write never overwrites a newer row (the adapter's conditional
 * upsert compares updated_at). Timestamps stay ISO text, the
 * async-job family's own shape; projectedAtMs is when this D1
 * row was last written by the projector.
 */
export const agentAsyncJobs = sqliteTable("agent_async_jobs", {
  jobId: text("job_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  sessionId: text("session_id").notNull(),
  capability: text("capability").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  resultJson: text("result_json"),
  responseStatus: text("response_status"),
  error: text("error"),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  parentJobId: text("parent_job_id"),
  jobKind: text("job_kind"),
  channel: text("channel"),
  notBefore: text("not_before"),
  stage: text("stage"),
  chainId: text("chain_id"),
  stuckAlertedAt: text("stuck_alerted_at"),
  trigger: text("trigger"),
  triggeredBy: text("triggered_by"),
  scheduleId: text("schedule_id"),
  lastActivityAt: text("last_activity_at"),
  projectedAtMs: integer("projected_at_ms").notNull(),
});

/**
 * Pipeline J3 (#3536) — the enriched-dataset store's table: one
 * row per enrich run, keyed by enrich job id (the derived
 * product's precise identity — no (source, dataset) bucket
 * sharing). The full artifact rides in artifact_json (the
 * feed-dataset family's pattern); status and row count are
 * denormalized columns so latestUsable can filter without
 * parsing every row. The migration's DDL also carries the
 * (job_id, created_at DESC, id DESC) history index.
 * Timestamps are ISO text — residency parity with the feed
 * family's records. DDL authority: migration 0051.
 */
export const jobEnrichedDatasets = sqliteTable("job_enriched_datasets", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  jobId: text("job_id").notNull(),
  feedJobId: text("feed_job_id").notNull(),
  sourceId: text("source_id").notNull(),
  dataset: text("dataset").notNull(),
  runId: text("run_id").notNull(),
  status: text("status").notNull(),
  asOf: text("as_of").notNull(),
  rowsPersisted: integer("rows_persisted").notNull(),
  artifactJson: text("artifact_json").notNull(),
});

/**
 * Pipeline J4 (#3537) — the analyzed-dataset store's table: one
 * row per analyze run, keyed by analyze job id (the analysis
 * product's precise identity — no (source, dataset) bucket
 * sharing). The full artifact rides in artifact_json (the
 * feed/enriched families' pattern); status and row count are
 * denormalized columns so latestUsable can filter without
 * parsing every row. The migration's DDL also carries the
 * (job_id, created_at DESC, id DESC) history index.
 * Timestamps are ISO text — residency parity with the feed
 * family's records. DDL authority: migration 0052.
 */
export const jobAnalyzedDatasets = sqliteTable("job_analyzed_datasets", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  jobId: text("job_id").notNull(),
  enrichJobId: text("enrich_job_id").notNull(),
  sourceId: text("source_id").notNull(),
  dataset: text("dataset").notNull(),
  runId: text("run_id").notNull(),
  status: text("status").notNull(),
  asOf: text("as_of").notNull(),
  rowsPersisted: integer("rows_persisted").notNull(),
  artifactJson: text("artifact_json").notNull(),
});

/**
 * Pipeline J5 (#3538) — the generated-dataset store's table:
 * one row per generate run, keyed by generate job id (the
 * generation product's precise identity). The full artifact
 * rides in artifact_json (the feed/enriched/analyzed families'
 * pattern); status and the generated-format count are
 * denormalized columns so latestUsable can filter without
 * parsing every row (rows_persisted carries the count of
 * format bodies the run generated). The migration's DDL also
 * carries the (job_id, created_at DESC, id DESC) history
 * index. Timestamps are ISO text — residency parity with the
 * sibling families. DDL authority: migration 0056.
 */
export const jobGeneratedDatasets = sqliteTable("job_generated_datasets", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  jobId: text("job_id").notNull(),
  analyzeJobId: text("analyze_job_id").notNull(),
  sourceId: text("source_id").notNull(),
  dataset: text("dataset").notNull(),
  runId: text("run_id").notNull(),
  status: text("status").notNull(),
  asOf: text("as_of").notNull(),
  rowsPersisted: integer("rows_persisted").notNull(),
  artifactJson: text("artifact_json").notNull(),
});

/**
 * Pipeline J6 (#3539) — the delivery-dataset store's table:
 * one row per deliver run, keyed by deliver job id (the
 * delivery product's precise identity). The full artifact
 * rides in artifact_json (the sibling families' pattern);
 * status and the delivered-channel count are denormalized
 * columns so latestUsable can filter without parsing every
 * row (rows_persisted carries the count of channel pairs the
 * run itself delivered), and the consumed generated
 * artifact's id is denormalized (input_artifact_id) so the
 * resume lookup — what was already delivered for this exact
 * input — is an exact query, never a scan. The migration's
 * DDL also carries the (job_id, created_at DESC, id DESC)
 * history index. Timestamps are ISO text — residency parity
 * with the sibling families. DDL authority: migration 0057.
 */
export const jobDeliveryDatasets = sqliteTable("job_delivery_datasets", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  jobId: text("job_id").notNull(),
  generateJobId: text("generate_job_id").notNull(),
  sourceId: text("source_id").notNull(),
  dataset: text("dataset").notNull(),
  runId: text("run_id").notNull(),
  status: text("status").notNull(),
  asOf: text("as_of").notNull(),
  rowsPersisted: integer("rows_persisted").notNull(),
  inputArtifactId: text("input_artifact_id").notNull(),
  artifactJson: text("artifact_json").notNull(),
});
