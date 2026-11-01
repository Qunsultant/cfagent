/**
 * #1765 (parent #1717, F-41 / PRV-001–PRV-004 / PRV-006): Privacy/DSAR
 * port — erasure cascade, data export, ADMT notice/opt-out, Sec-GPC,
 * and the SHARED retention registry.
 *
 * Pure module: no Cloudflare imports, no I/O, no network. The port
 * is the contract; the routes in ./privacyRoutes.ts consume it and
 * src/server.ts wires it to the session store. Port-first, per the
 * blueprint restated by #1795/#1798 (cloud-native but
 * cloud-agnostic): nothing here knows about Durable Objects, KV,
 * or Vectorize — adapters do, and they are registered by the
 * caller, never invented by this module.
 *
 * VERIFIED AGAINST CURRENT MAIN (2026-11-01, head 3a55498c):
 *  - No Sec-GPC parsing exists anywhere in src/ (grep: zero hits).
 *  - No /api/privacy route exists in src/server.ts.
 *  - No per-subject delete exists on any DO class (grep for
 *    deleteUser/erase/purgeUser across src/agents: zero hits).
 *  - Session deletion exists (deleteSession in
 *    src/security/session.ts); the cascade's session leg is the
 *    one leg with a verified production mechanism, and it deletes
 *    the subject's privacy record + clears the session cookie —
 *    it cannot enumerate the subject's OTHER sessions, because
 *    KvLike has no list operation (src/security/kvResilience.ts).
 *    That enumeration gap is recorded in the §15 report, not
 *    papered over.
 *  - Vectorize has no per-subject vector key on current main:
 *    vectors are keyed by report/plan/outcome id
 *    (src/agents/aiSearchPaths.ts, src/agentic/compositionMemory.ts),
 *    never by subject. A Vectorize erasure leg therefore cannot be
 *    implemented honestly in this slice; it is registered as
 *    `deferred` by the server wiring and reported as such, never
 *    silently omitted and never claimed erased.
 *  - Retention on current main: the nightly mas_messages pass
 *    (src/server.ts scheduled handler, issue #255) plus the #635
 *    task-ledger prunes (ResearchAgent/ScreenerAgent
 *    pruneExpired*Tasks, driven by OrchestratorAgent maintenance).
 *    The registry below is the SHARED extension point for the
 *    #1766 slice: #1766 adds its tables/rules to this registry
 *    and its snapshot/orphan/audit work around it — it does not
 *    build a second retention mechanism.
 *
 * SECURITY GUARD: none of these switches lets a caller disable
 * their own enforcement. The ADMT opt-out changes which decision
 * path serves the subject (ADMT vs deterministic static rules);
 * it never disables an IAAA gate, a payment HITL gate, or an
 * audit write. GPC can only ADD opt-outs (applyGpcToPreferences
 * is monotone: it never clears an existing opt-out).
 */

import { resolvePrivacyModeScoped } from "../config/privacyModes";

/** Legacy env-only resolver (kept for env-level parity). */
export function resolvePrivacyDsarMode(envValue: unknown): {
  mode: "standard" | "strict";
  invalid: boolean;
} {
  const resolved = resolvePrivacyModeScoped({ env: envValue });
  return { mode: resolved.mode, invalid: resolved.invalid };
}

/** Re-exported for route/call-site convenience. */
export const PRIVACY_DSAR_MODE_SWITCH = "PRIVACY_DSAR_MODE" as const;

// ---------------------------------------------------------------- Sec-GPC

/**
 * PRV-004: parse the Sec-GPC header (Global Privacy Control).
 * Only the exact value "1" (ignoring surrounding whitespace)
 * opts out. Anything else — "0", "yes", garbage, absent — is
 * not an opt-out. A malformed signal must never be read as
 * consent in either direction; absent means "no signal".
 */
export function parseSecGpc(header: string | null | undefined): boolean {
  return typeof header === "string" && header.trim() === "1";
}

export interface PrivacyPreferences {
  saleSharingOptOut: boolean;
  admtOptOut: boolean;
}

/**
 * PRV-004 enforcement, monotone: a GPC opt-out forces both
 * opt-outs ON. GPC absent never clears an existing opt-out,
 * and GPC present never turns an opt-out off. The subject's
 * stored record can therefore never contradict a live GPC
 * signal the subject just sent.
 */
export function applyGpcToPreferences(
  prefs: PrivacyPreferences,
  gpcOptOut: boolean,
): PrivacyPreferences {
  if (!gpcOptOut) return { ...prefs };
  return { saleSharingOptOut: true, admtOptOut: true };
}

// ---------------------------------------------------------------- ADMT

/** Version of the ADMT pre-use notice text (bump on wording change). */
export const ADMT_NOTICE_VERSION = "admt-notice-v1-1765" as const;

export interface AdmtNotice {
  version: typeof ADMT_NOTICE_VERSION;
  /** Plain-language description of the automated logic in scope. */
  logic: string;
  /** Consequential uses the logic serves (screening, payment drafts). */
  consequentialUses: string[];
  /** The subject's right, and where to exercise it. */
  optOutRight: string;
  /** Route that records the opt-out. */
  optOutRoute: "/api/privacy/preferences";
  /** Effective decision path for this subject right now. */
  effectiveRoute: "admt" | "static";
}

/**
 * PRV-003: the ADMT pre-use notice. Served by GET
 * /api/privacy/status before any ADMT-served decision, and
 * its effectiveRoute is the routing decision: an opted-out
 * subject (stored preference, live GPC, or strict mode
 * without explicit opt-in) is served by the deterministic
 * static rule path, never by ADMT. The static path is a
 * behavior variant, not an enforcement bypass: gates and
 * audit still apply inside it.
 */
export function admtNotice(
  prefs?: PrivacyPreferences,
  opts?: { strictMode?: boolean; admtOptedIn?: boolean },
): AdmtNotice {
  const optedOut = prefs?.admtOptOut === true;
  const strictWithoutOptIn = opts?.strictMode === true && opts?.admtOptedIn !== true;
  return {
    version: ADMT_NOTICE_VERSION,
    logic:
      "Automated research and screening: ResearchAgent and ScreenerAgent " +
      "analyze market data and your saved criteria to rank opportunities, " +
      "and payment drafts may be generated from those results.",
    consequentialUses: [
      "automated options research profiling",
      "automated financial order screening",
      "automated payment draft creation",
    ],
    optOutRight:
      "You may opt out of automated decision-making: opted-out subjects " +
      "are served by a deterministic, static rule-based path instead.",
    optOutRoute: "/api/privacy/preferences",
    effectiveRoute: optedOut || strictWithoutOptIn ? "static" : "admt",
  };
}

// ---------------------------------------------------------------- Erasure

/**
 * One store in the erasure cascade. `erase` deletes every row
 * for the subject and returns the count deleted plus the
 * residual count re-checked afterwards — the cascade trusts
 * the re-check, not the delete's claim. A leg that cannot be
 * keyed by subject in this slice is registered with `deferred`
 * and no erase/count functions: it is reported, never skipped.
 */
export interface ErasureLeg {
  name: string;
  erase?: (subject: string) => Promise<{ deleted: number; residual: number }>;
  count?: (subject: string) => Promise<number>;
  deferred?: string;
}

export interface ErasureLegResult {
  name: string;
  status: "erased" | "failed" | "deferred";
  deleted: number;
  residual: number;
  deferredReason?: string;
  error?: string;
}

export interface ErasureReport {
  subject: string;
  legs: ErasureLegResult[];
  /** True only when every leg erased with zero residuals. */
  complete: boolean;
  residualTotal: number;
  deferred: string[];
  failed: string[];
}

export function buildErasureReport(subject: string, legs: ErasureLegResult[]): ErasureReport {
  const residualTotal = legs.reduce((sum, leg) => sum + leg.residual, 0);
  const deferred = legs.filter((l) => l.status === "deferred").map((l) => l.name);
  const failed = legs.filter((l) => l.status === "failed").map((l) => l.name);
  const complete =
    legs.length > 0 &&
    legs.every((l) => l.status === "erased") &&
    residualTotal === 0;
  return { subject, legs, complete, residualTotal, deferred, failed };
}

/**
 * PRV-001: run the cascade. Legs run in registration order;
 * a leg failure is isolated — it is recorded on that leg and
 * fails the report closed, and it never aborts the remaining
 * legs (a cascade that stops at the first failure would leave
 * later stores unerased while reporting only the first).
 */
export async function eraseSubject(subject: string, legs: ErasureLeg[]): Promise<ErasureReport> {
  const results: ErasureLegResult[] = [];
  for (const leg of legs) {
    if (leg.deferred || !leg.erase) {
      const residual = leg.count ? await leg.count(subject).catch(() => 0) : 0;
      results.push({
        name: leg.name,
        status: "deferred",
        deleted: 0,
        residual,
        deferredReason: leg.deferred ?? "no per-subject erasure mechanism in this slice",
      });
      continue;
    }
    try {
      const outcome = await leg.erase(subject);
      results.push({ name: leg.name, status: "erased", deleted: outcome.deleted, residual: outcome.residual });
    } catch (err) {
      const residual = leg.count ? await leg.count(subject).catch(() => -1) : -1;
      results.push({
        name: leg.name,
        status: "failed",
        deleted: 0,
        residual: residual < 0 ? 0 : residual,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return buildErasureReport(subject, results);
}

// ---------------------------------------------------------------- Export

export interface ExportSourceCoverage {
  source: string;
  status: "included" | "not_wired";
  note: string;
}

export interface ExportPayload {
  subject: string;
  generatedAt: number;
  session: unknown;
  messages: unknown[];
  researchRuns: unknown[];
  screenerRuns: unknown[];
  preferences: PrivacyPreferences;
  /**
   * Which sources the payload actually covers. A source the
   * server cannot read per-subject on current main is listed
   * as not_wired with its reason — the export never implies
   * completeness it does not have. PRV-002's acceptance
   * allows "the absence is a recorded decision": this field
   * IS that record, per source.
   */
  coverage?: ExportSourceCoverage[];
}

/**
 * PRV-002: assemble the consolidated export payload. The
 * assembler takes already-scoped inputs — it never fetches,
 * so it cannot leak another subject's rows: the server
 * wiring loads only the caller's own subject (route gate)
 * and the payload echoes that subject back for audit.
 */
export function buildExportPayload(input: {
  subject: string;
  session?: unknown;
  messages?: unknown[];
  researchRuns?: unknown[];
  screenerRuns?: unknown[];
  preferences?: PrivacyPreferences;
  generatedAt: number;
  coverage?: ExportSourceCoverage[];
}): ExportPayload {
  return {
    subject: input.subject,
    generatedAt: input.generatedAt,
    session: input.session ?? null,
    messages: input.messages ?? [],
    researchRuns: input.researchRuns ?? [],
    screenerRuns: input.screenerRuns ?? [],
    preferences: input.preferences ?? { saleSharingOptOut: false, admtOptOut: false },
    ...(input.coverage ? { coverage: input.coverage } : {}),
  };
}

// ---------------------------------------------------------------- Retention

/**
 * #1766 (parent #1717, F-37 / F-41 / F-58) — the SHARED
 * retention registry, extended from #1765's three tables to
 * every table in the recorded decision inventory
 * (src/security/storageRetention.ts header, the #635 task
 * ledgers, the #1701 AgentDB purge, the #2294 outcome
 * feed, and the research/screener stores).
 *
 * Rule semantics, read exactly:
 * - `action: "bound"` — the table has an age bound
 *   (maxAgeDays, plus capRows when a row cap also applies).
 * - `action: "keep"` — the table is deliberately NOT pruned;
 *   `reason` is the KEEP justification and maxAgeDays is null.
 *   KEEP is a decision, not an omission.
 * - `enforcement` — whether the bound is live today:
 *   "enforced" (a pass or route prunes it now), "at_source"
 *   (the writer prunes on save/submit), or "carried" (the
 *   rule is recorded but no enforcement exists yet, and
 *   enforcementNote names the blocker — a carried rule
 *   prunes nothing). A table with no rule is NOT purged by
 *   default: unknown tables are never silently invented,
 *   and never silently deleted either.
 * - `physicalTables` — the real tables a logical name maps
 *   to. The assessment's `screener_runs` is a logical name:
 *   no physical table of that name exists in DO SQLite; the
 *   screener run stores are mas_opportunity_scans and
 *   mas_discovery_runs.
 *
 * CORRECTIONS to #1765's registry (evidence in the #1766
 * §9 PR body; correcting the declaration changes zero
 * runtime behavior — no enforcement reads this registry):
 * - mas_messages is 90d, not 30d: the nightly pass defaults
 *   to STORAGE_RETENTION_DEFAULT_DAYS (90d) and the UI
 *   advertises 90d. #1765's "30d matches the #255 pass"
 *   comment was wrong; the env override
 *   (MAS_MESSAGES_RETENTION_DAYS) still applies.
 * - screener_runs keeps its declared 30d target but is
 *   carried, not enforced: its physical stores already
 *   enforce 365d + row caps at source under the C4
 *   run-store contract, and narrowing that to 30d is an
 *   owner product decision, not hygiene.
 * - research_runs keeps its declared 30d target but is
 *   carried, not enforced: the track-record feed reads
 *   research_runs directly (ResearchAgent.getTrackRecord)
 *   and research runs write no canonical mas_reports row,
 *   so pruning would truncate track history outright.
 *   Enforcement needs a track-record source decision first.
 */
export type RetentionAction = "bound" | "keep";

export type RetentionEnforcement = "enforced" | "at_source" | "carried";

export interface RetentionRule {
  table: string;
  /** Null for KEEP rules (no bound exists by decision). */
  maxAgeDays: number | null;
  /** Row cap when one also applies (null/omitted otherwise). */
  capRows?: number;
  action: RetentionAction;
  reason: string;
  /** Physical tables behind a logical name (omitted when the name is physical). */
  physicalTables?: string[];
  enforcement: RetentionEnforcement;
  /** Where enforcement lives, or what blocks it when carried. */
  enforcementNote: string;
}

export const PRIVACY_RETENTION_TABLES = ["mas_messages", "screener_runs", "research_runs"] as const;

const KEEP_FINANCIAL = "financial record: pruning would destroy the ledger history readers rely on";
const KEEP_GOVERNANCE = "governance decision record: rows accrue per cycle/transition, not per request; pruning would destroy the history later reads reason about";

const RETENTION_RULES: Record<string, RetentionRule> = {
  // --- The #1765 privacy tables (logical + enforced) ---
  mas_messages: {
    table: "mas_messages",
    maxAgeDays: 90,
    action: "bound",
    reason: "issue #255 nightly pass: chat history older than the window (env MAS_MESSAGES_RETENTION_DAYS, default 90d, matching the advertised retention)",
    enforcement: "enforced",
    enforcementNote: "nightly 0 4 * * * pass (runStorageRetention) on the shared Orchestrator instance",
  },
  screener_runs: {
    table: "screener_runs",
    maxAgeDays: 30,
    action: "bound",
    reason: "F-41/PRV-006: declared 30d target for screener run history (assessment logical name)",
    physicalTables: ["mas_opportunity_scans", "mas_discovery_runs"],
    enforcement: "carried",
    enforcementNote: "carried, not enforced: physical stores enforce 365d + row caps at source under the C4 run-store contract; narrowing to 30d is an owner product decision",
  },
  research_runs: {
    table: "research_runs",
    maxAgeDays: 30,
    action: "bound",
    reason: "F-41/PRV-006: declared 30d target for research run history (physical table in ResearchAgent DO SQLite)",
    physicalTables: ["research_runs"],
    enforcement: "carried",
    enforcementNote: "carried, not enforced: the track-record feed reads research_runs directly and research runs write no canonical mas_reports row, so pruning would truncate track history; enforcement needs a track-record source decision first",
  },
  // --- Nightly pass (#255 / #786) ---
  mas_events: {
    table: "mas_events",
    maxAgeDays: 365,
    action: "bound",
    reason: "issue #786: append-only audit/event log; 365d matches the run stores and preserves a year of audit history",
    enforcement: "enforced",
    enforcementNote: "nightly pass (env MAS_EVENTS_RETENTION_DAYS, default 365d); this run's audit row is written after the prune so it survives",
  },
  mas_memory: {
    table: "mas_memory",
    maxAgeDays: 365,
    action: "bound",
    reason: "issue #786: key/value store aged by updated_at; a key untouched for a year is residue",
    enforcement: "enforced",
    enforcementNote: "nightly pass (env MAS_MEMORY_RETENTION_DAYS, default 365d, by updated_at)",
  },
  // --- KEEP: financial / report records ---
  mas_transactions: {
    table: "mas_transactions",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_FINANCIAL} (the #896 payment ledger; one row per payment, updated in place)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_trades: {
    table: "mas_trades",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_FINANCIAL} (one row per order)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_reports: {
    table: "mas_reports",
    maxAgeDays: null,
    action: "keep",
    reason: "one row per report generation; the rows ARE the user-visible retained run history surfaced by the reports UI, so pruning is a product decision, not hygiene; deletion only via deleteCanonicalReport (which also deletes the R2 object — a raw DELETE would strand objects, and the #1766 orphan sweep owns those)",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_policy_verdicts: {
    table: "mas_policy_verdicts",
    maxAgeDays: null,
    action: "keep",
    reason: "signed compliance ledger (signature + signing key id per row); pruning would break the verdict chain's evidentiary value",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  // --- KEEP: user-owned / catalog / state ---
  mas_watchlists: {
    table: "mas_watchlists",
    maxAgeDays: null,
    action: "keep",
    reason: "user-owned data, bounded by what users create",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_referrals: {
    table: "mas_referrals",
    maxAgeDays: null,
    action: "keep",
    reason: "user-owned referral links with counters, bounded by what users create",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_ads: {
    table: "mas_ads",
    maxAgeDays: null,
    action: "keep",
    reason: "admin-managed inventory, bounded by content count",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_external_ads: {
    table: "mas_external_ads",
    maxAgeDays: null,
    action: "keep",
    reason: "admin-managed inventory, bounded by content count",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_categories: {
    table: "mas_categories",
    maxAgeDays: null,
    action: "keep",
    reason: "seeded or admin-managed catalog, bounded by content count",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_options_chain_cache: {
    table: "mas_options_chain_cache",
    maxAgeDays: null,
    action: "keep",
    reason: "inert: no writer exists in src/ today; the table is created empty and stays empty",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_autopilot: {
    table: "mas_autopilot",
    maxAgeDays: null,
    action: "keep",
    reason: "per-key state table, bounded by the fixed key set",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_settings: {
    table: "mas_settings",
    maxAgeDays: null,
    action: "keep",
    reason: "per-key state table, bounded by the fixed key set",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_screener_presets: {
    table: "mas_screener_presets",
    maxAgeDays: null,
    action: "keep",
    reason: "user-owned screener presets, bounded by what users create",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  // --- Bound at source / by other passes ---
  mas_job_outcomes: {
    table: "mas_job_outcomes",
    maxAgeDays: 90,
    capRows: 500,
    action: "bound",
    reason: "issue #2294: outcome feed history; older rows have no reader (the feed reads the newest 50) and its unindexed list scan exhausted the DO rows-read cap (#2280)",
    enforcement: "enforced",
    enforcementNote: "nightly pass (pruneJobOutcomes) for the shared instance + read-path prune (at most once per 24h, guarded by mas_job_outcomes_meta.pruned_at) for per-user agents; env MAS_JOB_OUTCOMES_RETENTION_DAYS",
  },
  mas_async_jobs: {
    table: "mas_async_jobs",
    maxAgeDays: 30,
    capRows: 500,
    action: "bound",
    reason: "terminal rows older than 30d plus a 500-row terminal cap per session; running rows are never pruned",
    enforcement: "at_source",
    enforcementNote: "pruned at source on job submit (OrchestratorAgent.submitAsyncJob)",
  },
  mas_report_confirmations: {
    table: "mas_report_confirmations",
    maxAgeDays: null,
    action: "keep",
    reason: "decided rows are kept as the HITL decision record (one small row per human decision); pending rows are swept at their TTL on create",
    enforcement: "enforced",
    enforcementNote: "KEEP for decided rows is enforced by having no age purge; pending-row TTL sweep runs at create time",
  },
  mas_opportunity_scans: {
    table: "mas_opportunity_scans",
    maxAgeDays: 365,
    capRows: 1000,
    action: "bound",
    reason: "C4 run-store contract: screener detail rows prune at source, 365d + hard row caps; the canonical mas_reports row (KEEP) is what the Runs surface serves, so a detail prune never erases a run entirely",
    enforcement: "at_source",
    enforcementNote: "pruned on save (SCAN_RUN_RETENTION_DAYS / SCAN_RUN_MAX_ROWS)",
  },
  mas_discovery_runs: {
    table: "mas_discovery_runs",
    maxAgeDays: 365,
    action: "bound",
    reason: "C4 run-store contract: discovery detail rows prune at source, 365d + hard row caps; the canonical mas_reports row (KEEP) is what the Runs surface serves",
    enforcement: "at_source",
    enforcementNote: "pruned on save, mirroring mas_opportunity_scans",
  },
  paused_schedules: {
    table: "paused_schedules",
    maxAgeDays: null,
    action: "keep",
    reason: "user paused-schedule state, bounded by what users pause; clearing is an explicit operator/user action, not age hygiene",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  cf_agents_jobs: {
    table: "cf_agents_jobs",
    maxAgeDays: null,
    action: "keep",
    reason: "framework queue rows (schedules ARE the queue rows); emptied only by the deliberate POST /api/schedules/cancel-all, never by an age pass",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no age purge; cancel-all is the deliberate clear path",
  },
  usage_events: {
    table: "usage_events",
    maxAgeDays: 365,
    action: "bound",
    reason: "issue #792 deferral: metering companion rows (one small row per research run/evaluation); PRUNE-CLASS at 365d",
    enforcement: "carried",
    enforcementNote: "carried, not enforced: rows are split across two DOs' databases (Orchestrator + ResearchAgent), so a pass on one instance cannot prune the other copy, and the metering readers' old-row window is unconfirmed; enforcement is deferred to its first production reader's window decision",
  },
  // --- Research / screener stores ---
  research_task_store: {
    table: "research_task_store",
    maxAgeDays: 90,
    action: "bound",
    reason: "issue #635: terminal task records past the retention tiers are deleted by the task ledger (90d base tier, 365d failed/escalated tier, by updatedAt; active records never pruned)",
    enforcement: "at_source",
    enforcementNote: "pruned by the task ledger (ResearchAgent.pruneExpiredResearchTasks / ScreenerAgent.pruneExpiredScreenerTasks, driven by OrchestratorAgent maintenance)",
  },
  research_settings: {
    table: "research_settings",
    maxAgeDays: null,
    action: "keep",
    reason: "per-key research configuration state, bounded by the fixed key set",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  research_evaluations: {
    table: "research_evaluations",
    maxAgeDays: null,
    action: "keep",
    reason: "evaluation rows feed the track record alongside research_runs and accrue at evaluation pace (due-runs pass: capped runs, min-age gated — not per request); pruning them would rewrite history the metrics aggregate over",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  // --- AgentDB projections (#1651 / #1676 / #1688 / #1548 / #1740 / #1742) ---
  agent_chains: {
    table: "agent_chains",
    maxAgeDays: null,
    action: "keep",
    reason: "versioned projection history of the chain lifecycle (one row per transition per chain); old versions are the audit trail the status read reasons about",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table; the DO remains authoritative",
  },
  agent_synthesized_schedules: {
    table: "agent_synthesized_schedules",
    maxAgeDays: null,
    action: "keep",
    reason: "versioned projection history of the chain lifecycle, same discipline as agent_chains",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table; the DO remains authoritative",
  },
  agent_shard_jobs: {
    table: "agent_shard_jobs",
    maxAgeDays: 30,
    capRows: 500,
    action: "bound",
    reason: "issue #1701 slice 6: job rows are operational run history, not lifecycle audit — a pruned job version destroys no lifecycle fact (the chain row keeps it), and the rails source already discards the same rows at 30d",
    enforcement: "enforced",
    enforcementNote: "bounded purge via admin-gated POST /api/retention/purge + the governed retention-purge job definition (nightly 0 4 * * *, activation is an operator step); #1766 audits every purge run as a retention.purge event",
  },
  agent_chain_audit: {
    table: "agent_chain_audit",
    maxAgeDays: null,
    action: "keep",
    reason: "row-per-event audit trail of projection lifecycle events; pruning would destroy exactly the history the audit read reasons about",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table; the DO remains authoritative",
  },
  agent_reports: {
    table: "agent_reports",
    maxAgeDays: null,
    action: "keep",
    reason: "canonical report record mirroring the mas_reports discipline; deletion happens only via deleteCanonicalReport",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  agent_governance: {
    table: "agent_governance",
    maxAgeDays: null,
    action: "keep",
    reason: "halt transition history (one row per halt set/clear, not per request); pruning would destroy the governance audit the halt read reasons about",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  agent_market_nodes: {
    table: "agent_market_nodes",
    maxAgeDays: null,
    action: "keep",
    reason: "derived reference data (curated stock universe + sectors), bounded by universe x relations; repopulation is idempotent and the universe JSON remains authoritative",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  agent_market_edges: {
    table: "agent_market_edges",
    maxAgeDays: null,
    action: "keep",
    reason: "derived reference data (sector membership, same-sector peers, supplied events), bounded like agent_market_nodes",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  agent_thesis_realizations: {
    table: "agent_thesis_realizations",
    maxAgeDays: null,
    action: "keep",
    reason: "telemetry record: realizations accrue at evaluation pace (capped runs, min-age gated); pruning would rewrite history the metrics aggregate over",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table; the DO track record remains authoritative",
  },
  agent_calibration_decisions: {
    table: "agent_calibration_decisions",
    maxAgeDays: null,
    action: "keep",
    reason: "telemetry record: decisions accrue per proposal (trigger-gated); they are the sole record of a calibration decision",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  // --- RSI-loop record / state tables ---
  mas_adaptation_audit: {
    table: "mas_adaptation_audit",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_candidate_evaluations: {
    table: "mas_candidate_evaluations",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_improvement_candidates: {
    table: "mas_improvement_candidates",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_learnings: {
    table: "mas_learnings",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_promotion_approvals: {
    table: "mas_promotion_approvals",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_promotion_gate_verdicts: {
    table: "mas_promotion_gate_verdicts",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_promotions: {
    table: "mas_promotions",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_strategy_reviews: {
    table: "mas_strategy_reviews",
    maxAgeDays: null,
    action: "keep",
    reason: `${KEEP_GOVERNANCE} (RSI-loop record table)`,
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_strategy_weights: {
    table: "mas_strategy_weights",
    maxAgeDays: null,
    action: "keep",
    reason: "RSI-loop state table: one row per strategy (strategy is the PK), upserted in place",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_strategy_weight_caps: {
    table: "mas_strategy_weight_caps",
    maxAgeDays: null,
    action: "keep",
    reason: "RSI-loop state table: one row per strategy, upserted in place",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
  mas_strategy_gates: {
    table: "mas_strategy_gates",
    maxAgeDays: null,
    action: "keep",
    reason: "RSI-loop state table: one row per strategy, upserted in place",
    enforcement: "enforced",
    enforcementNote: "KEEP is enforced by having no purge: no pass or route deletes from this table",
  },
};

export function retentionRuleFor(table: string): RetentionRule | undefined {
  return RETENTION_RULES[table];
}

/** The full shared registry, in declaration order. */
export function retentionRegistry(): RetentionRule[] {
  return Object.values(RETENTION_RULES);
}

/** Back-compat alias: the full registry (formerly the 3 privacy tables only). */
export function retentionRules(): RetentionRule[] {
  return retentionRegistry();
}
