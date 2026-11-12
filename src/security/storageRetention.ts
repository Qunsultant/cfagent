/**
 * Issue #255 (Assessment P1, part of #143): mas_messages retention.
 * Issue #786 (RSI-Data Tier 3, C6): the same nightly pass also prunes
 * mas_events and mas_memory, and this header is the recorded retention
 * decision for EVERY mas_* table.
 *
 * The `scheduled()` handler's nightly cron (`0 4 * * *`, see wrangler.jsonc)
 * triggers this pass through the Orchestrator agent's
 * `/schedules/trigger-retention` route. The pass deletes rows older than
 * their table's retention window, oldest first, in bounded batches, with a
 * per-run cap per table — and records one mas_events row per run summarizing
 * the work (plus a console.info line: pruning is never silent).
 *
 * Design notes:
 * - Windows are env-configurable (string or number): MAS_MESSAGES_RETENTION_DAYS
 *   (default 90 days, matching the retention the UI advertises),
 *   MAS_EVENTS_RETENTION_DAYS and MAS_MEMORY_RETENTION_DAYS (default 365
 *   days each, matching the run-store retention). A table window <= 0
 *   disables THAT table's prune; the messages window <= 0 disables the
 *   WHOLE pass (it is the pass's master switch, as in #255).
 * - `created_at` / `updated_at` are stored as ISO-8601 strings, so the
 *   cutoff comparison is a lexicographic `<` — correct for that format in
 *   both real SQLite and the test mock. The comparison is strict: a row
 *   exactly AT the cutoff survives.
 * - mas_memory ages by `updated_at`: an entry that keeps being written is
 *   live state however old its first write is.
 * - R2 archival-before-delete is deliberately NOT here (follow-on: no
 *   bucket exists yet). When it lands, this module is the hook point:
 *   archive the batch before deleting it.
 * - The module is SDK-free and pure against DatabaseORM, so the whole
 *   policy is unit-testable.
 *
 * Retention decision record (issue #786) — every mas_* table:
 * - mas_messages — PRUNE, 90d (MAS_MESSAGES_RETENTION_DAYS), nightly here (#255).
 * - mas_events — PRUNE, 365d (MAS_EVENTS_RETENTION_DAYS), nightly here (#786).
 *   Append-only audit/event log; every reader (audit route, MCP
 *   observability) is session-scoped and recent; 365d matches the run
 *   stores and preserves a year of audit history.
 * - mas_memory — PRUNE, 365d by updated_at (MAS_MEMORY_RETENTION_DAYS),
 *   nightly here (#786). Key/value store; rows are distinct keys, so growth
 *   is key-cardinality, and a key untouched for a year is residue. (A stale
 *   agentic-payments auto-approve limit key pruned this way reverts to the
 *   default limit — the safe direction.)
 * - mas_transactions — KEEP. Financial record (the #896 payment ledger).
 *   Bound: exactly one row per payment, created once and updated in place
 *   through its lifecycle (~≤1 KB/row); deletion would destroy the
 *   ledger BudgetGuard and payment history read from.
 * - mas_trades — KEEP. Financial order records; same caution as
 *   mas_transactions, one row per order.
 * - mas_reports — KEEP. One row per report generation; the rows ARE the
 *   user-visible retained run history surfaced by the reports UI
 *   (#125/#126 programme), so pruning is a product decision, not hygiene.
 *   Issue #338 note: report bodies may live in R2 behind the row's
 *   body_r2_key pointer, so IF a product decision ever enables pruning,
 *   rows must be deleted through deleteCanonicalReport
 *   (src/services/scheduledReports.ts), which deletes the R2 object in
 *   the same scope; a raw DELETE FROM mas_reports would strand objects.
 *   An orphan sweep for stranded reports/*.json objects is #338's named
 *   follow-up.
 * - mas_policy_verdicts — KEEP. Signed compliance ledger (signature +
 *   signing key id per row), one row per policy evaluation; pruning would
 *   break the verdict chain's evidentiary value. Revisit if evaluation
 *   volume ever makes it the largest table in an instance.
 * - mas_watchlists / mas_referrals — KEEP. User-owned data (watchlists;
 *   referral links with counters), bounded by what users create.
 * - mas_ads / mas_external_ads / mas_categories — KEEP. Seeded or
 *   admin-managed catalog/inventory, bounded by content count.
 * - mas_options_chain_cache — KEEP (inert). No writer exists in src/
 *   today; the table is created empty and stays empty.
 * - mas_job_outcomes — PRUNE, 90d + 500-row cap (issue #2294). The decision
 *   is recorded here; enforcement lives in pruneJobOutcomes
 *   (services/jobOutcomes.ts) at TWO call sites, because this nightly route
 *   runs only on the shared Orchestrator instance:
 *     1. this nightly pass, for the shared instance;
 *     2. listJobOutcomes itself, for every per-user agent — at most once per
 *        24h, guarded by the durable mas_job_outcomes_meta.pruned_at row.
 *   Not governed by the message-window master switch. The autopilot feed
 *   reads the newest 50 and the writer point-reads by id, so older rows have
 *   no reader; the table had no recorded decision before #2294 and its
 *   unindexed list scan is what exhausted the DO rows-read cap (#2280).
 * - mas_async_jobs — PRUNED at source (existing): terminal rows older
 *   than 30d plus a 500-row terminal cap per session, on job submit
 *   (OrchestratorAgent.submitAsyncJob).
 * - mas_report_confirmations — PARTIAL (existing): pending rows are swept
 *   at their TTL on create; decided rows are kept as the HITL decision
 *   record (one small row per human decision).
 * - mas_autopilot / mas_settings — KEEP. Per-key state tables; bounded
 *   by the fixed key set.
 * - mas_opportunity_scans / mas_discovery_runs — PRUNED at source
 *   (existing): 365d + hard row caps, pruned on save in their stores.
 * - RSI-loop record tables (mas_adaptation_audit,
 *   mas_candidate_evaluations, mas_improvement_candidates, mas_learnings,
 *   mas_promotion_approvals, mas_promotion_gate_verdicts, mas_promotions,
 *   mas_strategy_reviews) — KEEP. They are the governance decision record
 *   the collaboration protocol requires; rows accrue per improvement
 *   cycle, a deliberately paced (weekly-tick) process, not per request.
 * - RSI-loop state tables (mas_strategy_weights, mas_strategy_weight_caps,
 *   mas_strategy_gates) — KEEP. One row per strategy (strategy is the PK),
 *   upserted in place.
 * - agent_chains / agent_synthesized_schedules (AgentDB projections,
 *   slice 1, issue #1651) — KEEP. Versioned projection history of
 *   the chain lifecycle (one row per transition per chain); row
 *   count is bounded by transitions per chain, not per request,
 *   and old versions are the audit trail of pending → approved →
 *   killed. Pruning old versions would destroy exactly the
 *   history the status read and reconciliation reason about. The
 *   DO remains authoritative; these rows are never the sole
 *   record of anything.
 * - agent_shard_jobs (AgentDB projection, slice 2, issue #1676) —
 *   BOUNDED, mirroring the mas_async_jobs discipline it projects
 *   (terminal rows 30d + 500-row cap): job rows are operational
 *   run history, not lifecycle audit — unlike agent_chains, whose
 *   versions are the audit trail the status read reasons about,
 *   a pruned job version destroys no lifecycle fact (the chain
 *   row keeps it), and the rails source already discards the
 *   same rows at 30d, so an older projection row would outlive
 *   its source. Enforced by slice 6 (issue #1701): bounded
 *   purge via admin-gated POST /api/retention/purge plus the
 *   governed retention-purge job definition (nightly
 *   0 4 * * *, activation is an operator step).
 * - agent_chain_audit (AgentDB projection, slice 3, issue #1688) —
 *   KEEP. Row-per-event audit trail of projection lifecycle
 *   events (transitions, job projections, reconciles, seed);
 *   rows accrue per lifecycle event, not per request, and
 *   pruning them would destroy exactly the history the audit
 *   read reasons about. The DO remains authoritative; these
 *   rows are never the sole record of anything.
 * - agent_reports (AgentDB projection, slice 3, issue #1688) —
 *   KEEP, mirroring the mas_reports discipline it projects
 *   (mas_reports itself is KEEP: one row per report
 *   generation). Canonical rows are the durable report
 *   record; deletion happens only via deleteCanonicalReport.
 *   KEEP means no purge exists for this table; the retention
 *   slice (slice 6, issue #1701) enforces only the BOUNDED
 *   table (agent_shard_jobs).
 * - agent_async_jobs (AgentDB projection of mas_async_jobs,
 *   issue #4116, migration 0059) — KEEP, mirroring the
 *   mas_async_jobs discipline it projects. One row per async
 *   job, keyed on the job id; the projection is an idempotent
 *   upsert (a newer write lands, a stale write never
 *   overwrites), so pruning the projection would destroy the
 *   D1-only Workflow Runs read's job rows while the DO rows
 *   live on. The DO remains authoritative.
 * - agent_tenant_projection_carriers (tenant-scoped carrier
 *   config, issue #4116, migration 0059) — KEEP. One row per
 *   tenant (queues / ORM / sweep flags + readMode); the row
 *   IS the tenant's projection configuration, and deleting it
 *   would silently flip the tenant back to the merged view
 *   (unconfigured = merged). No purge exists for this table.
 * - agent_governance (AgentDB projection, slice 0, issue #1548) —
 *   KEEP, decided up front per R8 (line added by slice 6,
 *   issue #1701, which found it missing). Halt transition
 *   history: one row per halt set/clear, not per request, so
 *   volume is transitions, not traffic; pruning it would
 *   destroy the governance audit the halt read reasons
 *   about. The tick reads only the latest row, but the
 *   history is the record of who halted what and why.
 * - agent_market_nodes / agent_market_edges (AgentDB market
 *   graph, issue #1740, Hybrid RAG) — KEEP, decided up front
 *   per R8. Derived reference data, not per-request rows:
 *   nodes derive from the curated stock universe (161 symbols
 *   + sectors + explicitly supplied events) and edges from
 *   sector membership, same-sector peers, and supplied
 *   events; growth is bounded by universe × relations, and
 *   repopulation is idempotent. The universe JSON and the
 *   event sources remain authoritative, so these rows are
 *   never the sole record of anything; pruning would only
 *   force a repopulation, but no purge exists for them —
 *   the retention slice enforces only the BOUNDED table
 *   (agent_shard_jobs).
 * - agent_thesis_realizations / agent_calibration_decisions
 *   (AgentDB telemetry, issue #1742, RSI telemetry &
 *   calibration) — KEEP, decided up front per R8. Realizations
 *   accrue at evaluation pace (due-runs pass: capped runs,
 *   min-age gated — not per request), one row per evaluated
 *   idea; decisions accrue per proposal (trigger-gated, not
 *   per request). Both tables ARE the governance record the
 *   calibration engine reasons about (frozen snapshots +
 *   proposer/decider/applier actors); pruning realizations
 *   would rewrite history the metrics aggregate over, and
 *   pruning decisions would destroy the approval trail. The
 *   DO track record remains authoritative for evaluations;
 *   these rows are never the sole record of an evaluation,
 *   but they are the sole record of a calibration decision.
 *   No purge exists for them — the retention slice enforces
 *   only the BOUNDED table (agent_shard_jobs).
 * - usage_events (not a mas_* table) — PRUNE-CLASS, 365d, recorded here
 *   per issue #792's deferral, implementation deferred to its first
 *   production reader: rows are split across two DOs' databases
 *   (orchestrator + ResearchAgent), so a pass on one instance cannot
 *   prune the other copy; one small row per research run/evaluation
 *   until then.
 */

import type { DatabaseORM } from "../orm";
// Issue #278: durable scheduled-run reports for the NextGenTP agent.

/** Default retention window, days — matches the 90d the UI advertises. */
export const STORAGE_RETENTION_DEFAULT_DAYS = 90;

/**
 * Consolidation C4 (issue #1329, epic #1151) — the ONE recorded
 * retention contract for run stores, replacing the prose-only
 * divergence (R6). The alignment rule behind it: a run kind's detail
 * row is never its sole record — every kind stores a canonical
 * mas_reports row (discovery gained one in C4), so a detail prune
 * can never erase a run from GET /api/runs entirely; the canonical
 * row (KEEP) is what the Runs surface serves. Detail windows:
 * mas_opportunity_scans / mas_discovery_runs prune at source, 365d +
 * hard row caps on save; mas_async_jobs terminal rows prune at
 * submit, 30d + 500-row terminal cap per session.
 */
export const RUN_STORE_RETENTION_CONTRACT = {
  mas_reports: "keep",
  mas_opportunity_scans: "365d+caps",
  mas_discovery_runs: "365d+caps",
  mas_async_jobs: "30d+500cap",
} as const;

/** Issue #786: default mas_events window — 365d, matching the run stores. */
export const MAS_EVENTS_RETENTION_DEFAULT_DAYS = 365;

/** Issue #786: default mas_memory window (by updated_at) — 365d. */
export const MAS_MEMORY_RETENTION_DEFAULT_DAYS = 365;

/** Rows fetched + deleted per batch (keeps each DELETE bounded). */
export const STORAGE_RETENTION_DEFAULT_BATCH_SIZE = 500;

/** Safety cap: maximum rows deleted in a single run. */
export const STORAGE_RETENTION_DEFAULT_MAX_PER_RUN = 5000;

/** Nightly cron for the retention pass (must match wrangler.jsonc). */
export const STORAGE_RETENTION_CRON = "0 4 * * *";

export interface StorageRetentionOptions {
  /** Window in days; string or number. <= 0 disables pruning. */
  retentionDays?: number | string | null;
  /**
   * Issue #786: mas_events window (env MAS_EVENTS_RETENTION_DAYS).
   * Defaults to MAS_EVENTS_RETENTION_DEFAULT_DAYS; <= 0 disables only
   * the events prune.
   */
  eventsRetentionDays?: number | string | null;
  /**
   * Issue #786: mas_memory window by updated_at (env
   * MAS_MEMORY_RETENTION_DAYS). Defaults to
   * MAS_MEMORY_RETENTION_DEFAULT_DAYS; <= 0 disables only the memory prune.
   */
  memoryRetentionDays?: number | string | null;
  /** Batch size per DELETE round. Defaults to STORAGE_RETENTION_DEFAULT_BATCH_SIZE. */
  batchSize?: number;
  /** Max rows deleted per run. Defaults to STORAGE_RETENTION_DEFAULT_MAX_PER_RUN. */
  maxPerRun?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * Owning tenant for the pass's canonical report row. Required for the
   * row; without it the pass still prunes, but writes no mas_reports
   * row (there is no "default" tenant to file it under).
   */
  userLogin?: string;
}

export interface StorageRetentionResult {
  /** True when the pass was disabled (window <= 0) — nothing touched. */
  skipped: boolean;
  /** Rows actually deleted. */
  pruned: number;
  /** ISO cutoff used, or null when skipped. */
  cutoffIso: string | null;
  /** Resolved window in days. */
  windowDays: number;
  /** True when the per-run cap stopped the pass early. */
  capped: boolean;
  /** Issue #786: mas_events rows deleted this run. */
  eventsPruned: number;
  /** Issue #786: ISO cutoff used for mas_events, or null when its prune was disabled. */
  eventsCutoffIso: string | null;
  /** Issue #786: resolved mas_events window in days. */
  eventsWindowDays: number;
  /** Issue #786: true when the per-run cap stopped the events prune early. */
  eventsCapped: boolean;
  /** Issue #786: true when the events prune was disabled (window <= 0, or the whole pass was). */
  eventsSkipped: boolean;
  /** Issue #786: mas_memory rows deleted this run. */
  memoryPruned: number;
  /** Issue #786: ISO cutoff used for mas_memory, or null when its prune was disabled. */
  memoryCutoffIso: string | null;
  /** Issue #786: resolved mas_memory window in days. */
  memoryWindowDays: number;
  /** Issue #786: true when the per-run cap stopped the memory prune early. */
  memoryCapped: boolean;
  /** Issue #786: true when the memory prune was disabled (window <= 0, or the whole pass was). */
  memorySkipped: boolean;
}

/**
 * Resolve a configured window against a per-table default.
 * Missing/blank/unparseable -> default. A resolved window <= 0 is
 * intentional and means "disabled".
 */
export function resolveRetentionWindowDays(
  raw: number | string | null | undefined,
  defaultDays: number
): number {
  if (raw === undefined || raw === null || raw === "") {
    return defaultDays;
  }
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : defaultDays;
}

/**
 * Resolve the configured window. Missing/blank/unparseable -> default.
 * A resolved window <= 0 is intentional and means "disabled".
 */
export function resolveRetentionDays(
  raw: number | string | null | undefined
): number {
  return resolveRetentionWindowDays(raw, STORAGE_RETENTION_DEFAULT_DAYS);
}

/**
 * Delete rows older than the cutoff, oldest first, in bounded batches,
 * with a per-run cap — the one pruning loop every table in the pass
 * shares. `selectAgedIds` must return up to `limit` row ids with
 * timestamp < cutoffIso, oldest first; `deleteById` removes one row.
 */
function pruneAgedRows(
  selectAgedIds: (cutoffIso: string, limit: number) => string[],
  deleteById: (id: string) => void,
  cutoffIso: string,
  batchSize: number,
  maxPerRun: number
): { pruned: number; capped: boolean } {
  let pruned = 0;
  let capped = false;
  for (;;) {
    const remaining = maxPerRun - pruned;
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const limit = Math.min(batchSize, remaining);
    const ids = selectAgedIds(cutoffIso, limit);
    if (ids.length === 0) break;
    for (const id of ids) {
      deleteById(id);
    }
    pruned += ids.length;
    if (ids.length < limit) break;
  }
  return { pruned, capped };
}

/**
 * Run one retention pass. Oldest rows first, batched, capped per table;
 * one mas_events audit record is written per run (even when nothing was
 * pruned, so the pass is observable). Never throws for missing data — a
 * disabled or zero-row pass returns a summary instead.
 *
 * The pass covers mas_messages (#255) plus mas_events and mas_memory
 * (#786), each under its own window; every other mas_* table's decision
 * is recorded in the module header.
 */
export function runStorageRetention(
  orm: DatabaseORM,
  options: StorageRetentionOptions = {}
): StorageRetentionResult {
  const windowDays = resolveRetentionDays(options.retentionDays);
  const eventsWindowDays = resolveRetentionWindowDays(
    options.eventsRetentionDays,
    MAS_EVENTS_RETENTION_DEFAULT_DAYS
  );
  const memoryWindowDays = resolveRetentionWindowDays(
    options.memoryRetentionDays,
    MAS_MEMORY_RETENTION_DEFAULT_DAYS
  );
  const nowMs = options.now ? options.now() : Date.now();

  if (!(windowDays > 0)) {
    // The messages window is the pass's master switch (#255 semantics):
    // disabled means NOTHING is pruned and no audit row is written.
    return {
      skipped: true,
      pruned: 0,
      cutoffIso: null,
      windowDays,
      capped: false,
      eventsPruned: 0,
      eventsCutoffIso: null,
      eventsWindowDays,
      eventsCapped: false,
      eventsSkipped: true,
      memoryPruned: 0,
      memoryCutoffIso: null,
      memoryWindowDays,
      memoryCapped: false,
      memorySkipped: true,
    };
  }

  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? STORAGE_RETENTION_DEFAULT_BATCH_SIZE)
  );
  const maxPerRun = Math.max(
    1,
    Math.floor(options.maxPerRun ?? STORAGE_RETENTION_DEFAULT_MAX_PER_RUN)
  );
  const cutoffIso = new Date(nowMs - windowDays * 86_400_000).toISOString();

  const { pruned, capped } = pruneAgedRows(
    // #2345: the retention selectors are port range reads now
    // (MessagePort.idsCreatedBefore) — execQuery has no
    // 13-table callers left.
    (cutoff, limit) => orm.messages.idsCreatedBefore(cutoff, limit),
    (id) => orm.messages.delete(id),
    cutoffIso,
    batchSize,
    maxPerRun
  );

  // Issue #786: mas_events — prune BEFORE writing this run's audit row
  // below (the row is fresh and would survive anyway; ordering keeps the
  // intent obvious). Aged STORAGE_RETENTION rows from earlier runs are
  // pruned here like any other aged event.
  let eventsPruned = 0;
  let eventsCapped = false;
  let eventsSkipped = false;
  let eventsCutoffIso: string | null = null;
  if (eventsWindowDays > 0) {
    eventsCutoffIso = new Date(nowMs - eventsWindowDays * 86_400_000).toISOString();
    const r = pruneAgedRows(
      (cutoff, limit) => orm.events.idsCreatedBefore(cutoff, limit),
      (id) => orm.events.delete(id),
      eventsCutoffIso,
      batchSize,
      maxPerRun
    );
    eventsPruned = r.pruned;
    eventsCapped = r.capped;
  } else {
    eventsSkipped = true;
  }

  // Issue #786: mas_memory — ages by updated_at, keyed by `key`.
  let memoryPruned = 0;
  let memoryCapped = false;
  let memorySkipped = false;
  let memoryCutoffIso: string | null = null;
  if (memoryWindowDays > 0) {
    memoryCutoffIso = new Date(nowMs - memoryWindowDays * 86_400_000).toISOString();
    const r = pruneAgedRows(
      (cutoff, limit) => orm.memory.keysUpdatedBefore(cutoff, limit),
      (key) => orm.memory.delete(key),
      memoryCutoffIso,
      batchSize,
      maxPerRun
    );
    memoryPruned = r.pruned;
    memoryCapped = r.capped;
  } else {
    memorySkipped = true;
  }

  orm.events.create({
    id: `retention_${crypto.randomUUID().slice(0, 8)}`,
    sessionId: "system",
    type: "STORAGE_RETENTION",
    // Attributed to the Orchestrator agent, which owns the scheduled route;
    // the STORAGE_RETENTION type distinguishes the pass.
    agent: "orchestrator",
    payload: {
      pruned,
      cutoffIso,
      windowDays,
      batchSize,
      maxPerRun,
      capped,
      eventsPruned,
      eventsCutoffIso,
      eventsWindowDays,
      eventsCapped,
      eventsSkipped,
      memoryPruned,
      memoryCutoffIso,
      memoryWindowDays,
      memoryCapped,
      memorySkipped,
      note: "Nightly retention pass: mas_messages (issue #255), mas_events + mas_memory (issue #786). R2 archival is a follow-on; rows are deleted directly.",
    } as Record<string, unknown>,
    createdAt: new Date(nowMs).toISOString(),
  });

  // Never prune silently (issue #786): the audit row above is the durable
  // record; this line is the operator-visible one.
  console.info(
    `[storage-retention] mas_messages pruned ${pruned} (window ${windowDays}d, cutoff ${cutoffIso}); ` +
      `mas_events pruned ${eventsPruned} (window ${eventsWindowDays}d, cutoff ${eventsCutoffIso ?? "disabled"}); ` +
      `mas_memory pruned ${memoryPruned} (window ${memoryWindowDays}d, cutoff ${memoryCutoffIso ?? "disabled"})`
  );

  // Issue #278: persist the scheduled run's summary as a durable report
  // (mas_reports) so the NextGenTP agent can surface it later.
  // Issue #308: through the single generate→store seam — one canonical
  // row per generation (generationId = run id).
  try {
    if (!options.userLogin) {
      console.warn("[storage-retention] No owning userLogin: pruning is recorded in mas_events, no report row written.");
    } else {
    orm.storeCanonicalReport({
      runId: `retention:${cutoffIso}`,
      generationId: `retention:${cutoffIso}`,
      title: `Nightly storage retention — ${windowDays}d window`,
      source: "retention",
      summary: `Pruned ${pruned} mas_messages rows older than ${cutoffIso} (${windowDays}d window${capped ? ", capped at per-run max" : ""}).`,
      body: { pruned, cutoffIso, windowDays, batchSize, maxPerRun, capped },
      createdAt: new Date(nowMs).toISOString(),
      userLogin: options.userLogin,
    });
    }
  } catch {
    // Non-critical report persistence error
  }

  return {
    skipped: false,
    pruned,
    cutoffIso,
    windowDays,
    capped,
    eventsPruned,
    eventsCutoffIso,
    eventsWindowDays,
    eventsCapped,
    eventsSkipped,
    memoryPruned,
    memoryCutoffIso,
    memoryWindowDays,
    memoryCapped,
    memorySkipped,
  };
}
