/**
 * Issue #1737 ([AGENTIC] Decouple screener executions onto
 * Workflows) — the workflow PORT. Provider-neutral by
 * construction: this module names no provider, no provider
 * binding type, and no provider delivery mechanics. A future
 * provider swap replaces the adapter behind this port; domain
 * code does not change.
 *
 * The port executes stage-typed job commands. A command is the
 * typed run-screen job (ADR 0003 M8 follow-up: the first job
 * command gets a typed module under the port). The command
 * carries ids and references, never bulk data (claim-check
 * discipline, same as the messaging port): the run request
 * (universe, filters, symbols), the owner's login, and the
 * trigger source. Screen bodies, quotes, and report bytes stay
 * behind the references the command and its outcomes carry.
 *
 * Stage pipeline (owner stage-architecture spec; the workflow
 * is the shape, per #1236 refined): feed (collect from
 * multiple providers) and gather (combine + enrich) are TWO
 * separate stages; analysis runs ONLY on post-gather data and
 * persists its own results, like each prior stage persists its
 * own results independently. The full stage order is feed →
 * gather → analysis → store → serve → deliver (the legacy
 * "generate" stage name is the analysis stage in this split).
 * Stage-typed events are first-class type values, reused from
 * the messaging port (stageEventType builds
 * "feed.completed" and siblings). Triggers are
 * trigger-agnostic: UX events and scheduled events produce the
 * SAME command and the same execution path; the source field
 * records the trigger source for audit and the executor never
 * branches on it.
 *
 * Job/sub-job model (slice-2 alignment, no second job model):
 * a parent job (one request — one ticker set or all tickers)
 * fans out to sub-jobs (shards, e.g. one universe each) that
 * run in parallel and collate under the parent id. The
 * projection grain is the slice-2 agent_shard_jobs row: one
 * row per (chain, job, version), terminal rails
 * completed/submitted/failed. The parent job's chain id IS
 * the job id; each shard is a leg. The collation — including
 * qualified partial results — lives on the parent row's
 * result summary, NOT as a new rail value: "partial" is a
 * result qualification (the #462 vocabulary: a qualified
 * partial report is never a complete screen and never a
 * failure), not a terminal state, so the rails stay
 * completed/submitted/failed and the projection version
 * column stays projection state, never message state. This
 * resolves the two #1739 M10 mismatches without a contract
 * change: (1) qualified partials have their home (the parent
 * row's collation summary); (2) versions are assigned on
 * write by the projector, never carried in commands.
 *
 * Lifecycle (State pattern, screener-doc §7): a workflow job
 * moves Idle → Running → [BudgetConstrained] → Completed |
 * Failed → ReportGenerated. BudgetConstrained is entered when
 * a shard fails or times out but collation still yields a
 * usable partial result — the run continues toward a
 * qualified partial, it does not fail. Completed means the
 * screen finished (qualified or not); ReportGenerated means
 * the canonical report was stored; Failed means no shard
 * produced a usable result. The ledger status
 * (queued/running/completed/failed) is coarser and stays
 * untouched: lifecycle detail rides in the collation summary.
 *
 * Parallelism and timeouts (owner spec; #1204 budgeting):
 * shards run in parallel up to maxParallelShards (a command
 * parameter, defaulted here). Each shard gets its own
 * invocation budget — fan-out across invocations IS the
 * subrequest-budget multiplier (#1785 precedent) — so the
 * bound guards provider rate limits, not the per-invocation
 * cap. Each shard has a deadline (shardTimeoutMs); a shard
 * past its deadline is marked timed_out and collation
 * proceeds with a qualified partial result, never a total
 * failure. A per-shard timeout yields partial results with
 * audit status (the collation summary + the parent row's
 * stage transitions), never a silent drop.
 *
 * Idempotency: the job id IS the idempotency key. Starting a
 * command with an existing job id returns the existing
 * handle and never starts a second run — duplicate scheduled
 * fires for one slot (the #1789 shape) resolve to the same
 * workflow instance. The workflow instance id is derived
 * deterministically from the job id (workflowIdForJob), so a
 * retried start adopts its own instance instead of failing.
 *
 * Failure and retry (blueprint ADR-0003 + NFR: 100%
 * retriable, max 3 retries per step): every workflow step
 * retries up to 3 times; step callbacks are idempotent by
 * construction (idempotent start, replay-no-op projection,
 * journal-guarded store/deliver — the parent row's summary
 * records which shards are already stored/delivered, so a
 * retried step skips them). A failed run is recorded as a
 * failed job with its error and is retryable by starting a
 * new command with a new job id — prior partial output is
 * never duplicated because shards are keyed by shard id and
 * projection replays are no-ops.
 */

import type { StageName } from "../messaging/messagingPorts";
import type { ScenarioDefinition } from "../services/goalScenarioEngine";

/** Re-exported for workflow callers (single import surface). */
export type { StageName };

/** State-pattern lifecycle states for a workflow job. */
export type WorkflowRunLifecycle =
  | "Idle"
  | "Running"
  | "BudgetConstrained"
  | "Completed"
  | "Failed"
  | "ReportGenerated";

/** Liveness of a workflow instance (coarse; detail lives in the projection). */
export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting"
  | "waitingForPause"
  | "complete"
  | "errored"
  | "terminated"
  | "unknown";

/** Default cap on concurrently executing shards (provider rate-limit guard). */
export const DEFAULT_MAX_PARALLEL_SHARDS = 4;

/** Default per-shard deadline (ms): generous vs a typical screen, bounded vs infinite. */
export const DEFAULT_SHARD_TIMEOUT_MS = 10 * 60 * 1000;

/** Default poll interval (ms) for the parent's shard-status loop. */
export const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;

/** Max retries per workflow step (blueprint ADR-0003 NFR). */
export const WORKFLOW_STEP_MAX_RETRIES = 3;

/** Max explicit symbols on one command (claim-check: the request, not bulk data). */
export const MAX_COMMAND_SYMBOLS = 200;

/**
 * Issue #2530 — the two modes a screener workflow run can
 * execute in. "deterministic" is today's behavior and the
 * default for every existing caller; "non-deterministic" is
 * the sanctioned second mode under design option (a): ONE
 * prompt interpretation step at the head of the parent run
 * proposes screen criteria as a data artifact, a
 * deterministic validator gates it, and the existing
 * deterministic pipeline executes it — execution and replay
 * stay deterministic in both modes (§8 doctrine).
 */
export type ScreenMode = "deterministic" | "non-deterministic";

/** Max chars of free-form screening intent on one command (the planner-prompt cap precedent). */
export const MAX_SCREEN_INTENT_CHARS = 2000;

/** One shard of a parent job: a universe screen, or an explicit symbol set. */
export interface WorkflowShard {
  /** Shard identity within the parent job (a universe id, or "symbols"). */
  shardId: string;
  /** Universe this shard screens (absent for an explicit-symbol shard). */
  universe?: string;
  /**
   * Explicit symbols this shard screens (premium path;
   * bounded by MAX_COMMAND_SYMBOLS). Listing objects, not
   * bare strings: the route already resolved membership
   * (symbol + company + sector) and the adapter passes it
   * through to the agent request — re-resolving in the
   * adapter could diverge from what the payer asked for.
   */
  symbols?: unknown[];
}

/**
 * Issue #1996 (#1972 slice 1) — the goal-screen run request
 * carried by a run-screen command. Mirrors the direct path's
 * executeGoalScreenRun inputs (route + schedule service build
 * it from the same validated body/options); the workflow
 * child passes it straight to the agent's runGoalScreen, so
 * the child needs no scenario-store access.
 */
export interface GoalScreenCommand {
  /** Resolved scenario (built from goalKind/direction, or restored from a stored record). */
  scenario: ScenarioDefinition;
  /** How the scenario was obtained (recorded on the canonical report, as the direct path does). */
  scenarioSource: "built" | "stored";
  /** Asset classes the goal screen evaluates (absent = the engine default: stocks + options). */
  assetClasses?: ("stocks" | "options")[];
  /** Explicit symbols to screen (absent = the scenario's universe path). */
  symbols?: string[];
  /** Delivery channels for the completed run (absent = no delivery step). */
  deliver?: ("slack" | "email" | "webhook" | "voice")[];
  /** Delivery recipient for the email channel. */
  emailTo?: string;
  /** Issue #1571: "yahoo" runs the stock leg on the Yahoo engine (scheduled fallback runs). */
  provider?: "yahoo";
  /** Issue #1571: fallback marker, stamped onto the result before artifact generation. */
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}

/**
 * The typed run-screen job command. This IS the workflow
 * input: the workflow class receives exactly this object as
 * its params (plus role). No bulk data: filters are criteria,
 * symbols are membership, everything else is a reference.
 */
export interface WorkflowJobCommand {
  /** Idempotency key: slot key for scheduled, timestamp key for manual. */
  jobId: string;
  /** Command type. Only run-screen exists in this slice. */
  type: "run-screen";
  /** Trigger source for audit (never branched on): e.g. "scheduled-tasks" or "manual". */
  source: string;
  trigger: "manual" | "scheduled";
  /** Owner login. Required — fail closed without an identity (#1185). */
  userLogin: string;
  /** Shards to run in parallel (computed by the starter from the request). */
  shards: WorkflowShard[];
  /** Role: "parent" fans out; "shard" executes one shard. Routes start parents. */
  role: "parent" | "shard";
  /** Parent job id (shard commands only). */
  parentJobId?: string;
  /** This shard's descriptor (shard commands only). */
  shard?: WorkflowShard;
  /** Tenant id resolved by the starter (absent → projection best-effort skipped). */
  tenantId?: string;
  /**
   * Issue #1743 — W3C traceparent for the run: the ingress
   * trace continued into the workflow. Steps emit under it
   * when they gain sink access (follow-up); the contract and
   * the adapter passthrough land here, not a fake producer —
   * service-layer call sites carry no request context today.
   */
  traceparent?: string;
  /**
   * Issue #2530 — the run's mode. Absent = "deterministic"
   * (today's behavior; every existing caller). A run is one
   * mode end to end: the mode rides the command to every
   * shard (shardCommandFor spreads the parent), so it is
   * recorded on the run's input record, and the parent
   * collation carries it. Shards never interpret — the mode
   * changes only how the parent obtains the run's filters.
   */
  screenMode?: ScreenMode;
  /**
   * Issue #2530 — the free-form screening intent the
   * interpretation step proposes criteria from. Required
   * (non-blank) when screenMode is "non-deterministic";
   * invalid on a deterministic command (an intent that would
   * be silently ignored is refused instead).
   */
  screenIntent?: string;
  /** Sector filter (recorded on the job; the screen applies it). */
  sector?: string;
  /** Data provider ("etrade" | "yahoo"; the screen defaults it when absent). */
  provider?: string;
  /** Screen criteria (filters object, as the route parsed it). */
  filters?: Record<string, unknown>;
  maxItems?: number;
  maxSymbols?: number;
  environment?: "TEST" | "PROD";
  portfolioContext?: boolean;
  /** Whether the deliver step runs (etrade routes: true; market-data/premium: false). */
  deliver?: boolean;
  /**
   * Issue #1996 (#1972 slice 1) — goal-screen descriptor. Present
   * only for goal-screen runs: the child executes the goal-driven
   * screen (scenario + thesis gates) instead of a market screen.
   * The scenario is run-request parameters (analogous to the
   * filters a market command carries), not bulk data: results
   * stay behind references, exactly as for market commands.
   * Domain values (goalKind membership, direction vocabulary)
   * are validated at the submission points (route + schedule
   * service), which already own that taxonomy; the port
   * validates shape only.
   */
  goalScreen?: GoalScreenCommand;
  /** Parallelism bound (default DEFAULT_MAX_PARALLEL_SHARDS). */
  maxParallelShards?: number;
  /** Per-shard deadline in ms (default DEFAULT_SHARD_TIMEOUT_MS). */
  shardTimeoutMs?: number;
  /** Poll interval in ms for the parent's shard-status loop (default DEFAULT_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
}

/** A started (or already-existing) workflow instance. */
export interface WorkflowHandle {
  workflowId: string;
  jobId: string;
  /** Instance liveness at start time. */
  status: WorkflowInstanceStatus;
  /** True when start adopted an already-running instance (duplicate start). */
  existing: boolean;
  /** Existing job-history path for this job (no new status route). */
  statusUrl: string;
}

/** Liveness read for one workflow instance. */
export interface WorkflowStatus {
  workflowId: string;
  /** Job id when the adapter knows it (the in-memory adapter does; the binding adapter does not — instance status carries no params). */
  jobId?: string;
  status: WorkflowInstanceStatus;
}

/** Provider-neutral workflow execution port. */
export interface WorkflowPort {
  /** Start a command, or adopt the existing instance for its job id. Never starts twice. */
  start(command: WorkflowJobCommand): Promise<WorkflowHandle>;
  /** Liveness for one instance (detail lives in the jobs-history projection). */
  status(workflowId: string): Promise<WorkflowStatus | null>;
}

/** Neutral error codes. Provider error shapes never escape an adapter. */
export type WorkflowErrorCode =
  | "invalid_command"
  | "start_failed"
  | "unavailable"
  | "workflow_binding_absent"
  | "workflow_binding_malformed"
  | "projection_store_unbound";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

/**
 * Derive a deterministic instance id from a job id. Instance
 * ids accept at most 100 chars of [A-Za-z0-9_-] (first char
 * not '-'). Job ids in this codebase are slot/timestamp keys
 * Issue #2065: long job ids must NOT fail the start. A short
 * job id keeps the readable `screen-<sanitized>` form (its
 * instances already exist under that id — changing it would
 * orphan in-flight runs and break duplicate-start adoption).
 * A job id whose short form would exceed 100 chars gets a
 * deterministic hash form instead: never truncated (truncation
 * collides on shared prefixes), never refused. The hash is
 * FNV-1a (two independent 64-bit seeds, 32 hex chars) —
 * synchronous, dependency-free, and deterministic; it is an
 * instance-id disambiguator, not a security boundary.
 * (Complements ddd019a9's adapter-level fallback-id retry on the
 * same issue: the hash keeps duplicate-start adoption for long
 * ids, which a fresh random fallback id cannot.)
 */
export function workflowIdForJob(jobId: string): string {
  const sanitized = jobId.replace(/[^A-Za-z0-9_-]/g, "-");
  const short = `screen-${sanitized}`;
  if (short.length <= 100) return short;
  return `screen-h-${hashJobId(jobId)}`;
}

/** Two-seed FNV-1a over the raw job id → 32 hex chars. */
function hashJobId(jobId: string): string {
  const hash = (seed: bigint): string => {
    let h = seed;
    const prime = 1099511628211n;
    const mask = (1n << 64n) - 1n;
    for (let i = 0; i < jobId.length; i++) {
      h ^= BigInt(jobId.charCodeAt(i));
      h = (h * prime) & mask;
    }
    return h.toString(16).padStart(16, "0");
  };
  // Distinct seeds so the two halves are independent enough for
  // disambiguation (a single 64-bit half would also suffice at
  // this volume; 128 bits leaves no doubt).
  return hash(14695981039346656037n) + hash(1099511628211n);
}

/** Validate a run-screen command (fail fast, before any start). Throws WorkflowError. */
export function assertWorkflowJobCommand(
  command: WorkflowJobCommand,
): WorkflowJobCommand {
  if (!command || typeof command !== "object") {
    throw new WorkflowError("invalid_command", "Workflow command must be an object.");
  }
  if (command.type !== "run-screen") {
    throw new WorkflowError(
      "invalid_command",
      `Unknown workflow command type "${String((command as { type?: unknown }).type)}" (only "run-screen" exists).`,
    );
  }
  if (!command.jobId || typeof command.jobId !== "string") {
    throw new WorkflowError("invalid_command", "Workflow command requires a jobId (idempotency key).");
  }
  if (!command.userLogin || typeof command.userLogin !== "string") {
    throw new WorkflowError(
      "invalid_command",
      "Workflow command requires a userLogin — no default identity (#1185).",
    );
  }
  if (!command.source || typeof command.source !== "string") {
    throw new WorkflowError("invalid_command", "Workflow command requires a source (trigger source for audit).");
  }
  if (command.trigger !== "manual" && command.trigger !== "scheduled") {
    throw new WorkflowError("invalid_command", 'Workflow command trigger must be "manual" or "scheduled".');
  }
  if (!Array.isArray(command.shards) || command.shards.length === 0) {
    throw new WorkflowError("invalid_command", "Workflow command requires at least one shard.");
  }
  for (const shard of command.shards) {
    if (!shard || typeof shard.shardId !== "string" || shard.shardId.length === 0) {
      throw new WorkflowError("invalid_command", "Every workflow shard requires a shardId.");
    }
    if (shard.symbols && shard.symbols.length > MAX_COMMAND_SYMBOLS) {
      throw new WorkflowError(
        "invalid_command",
        `Workflow shard carries ${shard.symbols.length} symbols over the ${MAX_COMMAND_SYMBOLS} cap (claim-check: membership, not bulk data).`,
      );
    }
  }
  if (command.role === "shard" && (!command.parentJobId || !command.shard)) {
    throw new WorkflowError("invalid_command", "A shard command requires parentJobId and shard.");
  }
  if (
    command.maxParallelShards !== undefined &&
    (!Number.isInteger(command.maxParallelShards) || command.maxParallelShards < 1)
  ) {
    throw new WorkflowError("invalid_command", "maxParallelShards must be a positive integer.");
  }
  if (
    command.shardTimeoutMs !== undefined &&
    (!Number.isInteger(command.shardTimeoutMs) || command.shardTimeoutMs < 1)
  ) {
    throw new WorkflowError("invalid_command", "shardTimeoutMs must be a positive integer.");
  }
  if (command.goalScreen !== undefined) {
    const g = command.goalScreen;
    if (!g || typeof g !== "object") {
      throw new WorkflowError("invalid_command", "Goal-screen command requires a goalScreen descriptor.");
    }
    if (
      !g.scenario ||
      typeof g.scenario !== "object" ||
      typeof (g.scenario as { goalKind?: unknown }).goalKind !== "string"
    ) {
      throw new WorkflowError(
        "invalid_command",
        "Goal-screen command requires a scenario with a goalKind (shape only; domain values are validated at submission).",
      );
    }
    if (g.scenarioSource !== "built" && g.scenarioSource !== "stored") {
      throw new WorkflowError(
        "invalid_command",
        'Goal-screen command scenarioSource must be "built" or "stored".',
      );
    }
    if (
      g.assetClasses !== undefined &&
      (!Array.isArray(g.assetClasses) ||
        g.assetClasses.some((c) => c !== "stocks" && c !== "options"))
    ) {
      throw new WorkflowError(
        "invalid_command",
        'Goal-screen assetClasses must be a subset of ["stocks", "options"].',
      );
    }
    if (g.symbols !== undefined) {
      if (!Array.isArray(g.symbols) || g.symbols.some((s) => typeof s !== "string")) {
        throw new WorkflowError("invalid_command", "Goal-screen symbols must be an array of strings.");
      }
      if (g.symbols.length > MAX_COMMAND_SYMBOLS) {
        throw new WorkflowError(
          "invalid_command",
          `Goal-screen command carries ${g.symbols.length} symbols over the ${MAX_COMMAND_SYMBOLS} cap (claim-check: membership, not bulk data).`,
        );
      }
    }
    if (
      g.deliver !== undefined &&
      (!Array.isArray(g.deliver) ||
        g.deliver.some((c) => c !== "slack" && c !== "email" && c !== "webhook" && c !== "voice"))
    ) {
      throw new WorkflowError(
        "invalid_command",
        'Goal-screen deliver must be a subset of ["slack", "email", "webhook", "voice"].',
      );
    }
    if (g.emailTo !== undefined && typeof g.emailTo !== "string") {
      throw new WorkflowError("invalid_command", "Goal-screen emailTo must be a string.");
    }
    if (g.provider !== undefined && g.provider !== "yahoo") {
      throw new WorkflowError("invalid_command", 'Goal-screen provider must be "yahoo" when present.');
    }
    if (
      g.providerFallback !== undefined &&
      (typeof g.providerFallback !== "object" ||
        g.providerFallback.from !== "etrade" ||
        typeof g.providerFallback.reason !== "string")
    ) {
      throw new WorkflowError(
        "invalid_command",
        "Goal-screen providerFallback requires { from: \"etrade\", reason: string }.",
      );
    }
  }
  // Issue #2530 — the mode contract. An unrecognized mode is
  // invalid; ND mode requires its intent; an intent without
  // ND mode would be silently ignored, so it is invalid too;
  // ND mode never composes with a goalScreen descriptor
  // (goal runs interpret through their scenario).
  if (
    command.screenMode !== undefined &&
    command.screenMode !== "deterministic" &&
    command.screenMode !== "non-deterministic"
  ) {
    throw new WorkflowError(
      "invalid_command",
      `Workflow command screenMode must be "deterministic" or "non-deterministic" when present, got "${String(command.screenMode)}".`,
    );
  }
  if (command.screenMode === "non-deterministic") {
    if (typeof command.screenIntent !== "string" || command.screenIntent.trim().length === 0) {
      throw new WorkflowError(
        "invalid_command",
        "A non-deterministic screen command requires a non-blank screenIntent (the free-form screening intent the interpretation step proposes criteria from).",
      );
    }
    if (command.screenIntent.length > MAX_SCREEN_INTENT_CHARS) {
      throw new WorkflowError(
        "invalid_command",
        `Workflow command screenIntent carries ${command.screenIntent.length} chars over the ${MAX_SCREEN_INTENT_CHARS} cap.`,
      );
    }
    if (command.goalScreen !== undefined) {
      throw new WorkflowError(
        "invalid_command",
        "A non-deterministic screen command cannot carry a goalScreen descriptor (goal runs interpret through their scenario, not the criteria interpreter).",
      );
    }
  } else if (command.screenIntent !== undefined) {
    throw new WorkflowError(
      "invalid_command",
      "screenIntent is only valid with screenMode \"non-deterministic\" — an intent on a deterministic command would be silently ignored.",
    );
  }
  return command;
}

/** One shard's outcome, as the parent collates it. References only, never bodies. */
export interface ShardOutcome {
  shardId: string;
  status: "completed" | "failed" | "timed_out";
  /** True when the shard exceeded its deadline (a timeout is a qualification, not a crash). */
  timedOut?: boolean;
  /** Symbols the shard was asked to consider (coverage denominator). */
  expectedCount?: number;
  /** Symbols the shard actually evaluated (coverage numerator). */
  totalScanned?: number;
  matchedCount?: number;
  /** Canonical report reference for this shard (pdfKey), when one was stored. */
  pdfKey?: string;
  /** Issue #2080: the workbook/CSV keys this shard recorded. */
  xlsxKey?: string;
  csvKey?: string;
  /** Failure detail (never a spec payload, never auth material). */
  error?: string;
  /**
   * Issue #1737: set by the CHILD workflow, which owns store
   * and deliver of its own full result. The parent never
   * stores or delivers — it only collates these flags.
   */
  stored?: boolean;
  delivered?: boolean;
  storeError?: string;
  deliverError?: string;
}

/** One lifecycle transition on the job's journal. */
export interface LifecycleTransition {
  lifecycle: WorkflowRunLifecycle;
  atMs: number;
}

/** One stage transition on the job's journal (stage-typed, via stageEventType vocabulary). */
export interface StageTransition {
  stage: StageName;
  outcome: "completed" | "failed";
  atMs: number;
}

/**
 * The parent row's collation summary (rides the parent
 * agent_shard_jobs row's result summary, capped by the
 * projector). This is the home for qualified partial
 * results: status stays on the terminal rails, qualification
 * lives here.
 */
export interface WorkflowCollation {
  jobId: string;
  workflowId: string;
  /**
   * Issue #2530 — the mode the run executed in, recorded by
   * the parent flow ("deterministic" when the command named
   * none). Optional in the type for collation literals built
   * outside the parent flow; the parent flow always sets it.
   */
  screenMode?: ScreenMode;
  /**
   * Final lifecycle: Completed (qualified or not), Failed (no
   * usable shard), or ReportGenerated (every completed shard
   * stored by its child — computed at collation time from the
   * child outputs' stored flags, not by a later parent step).
   */
  lifecycle: "Completed" | "Failed" | "ReportGenerated";
  /** True when any shard failed or timed out but a partial result stands (#462 vocabulary). */
  qualified: boolean;
  /** Coverage across shards: evaluated / considered (null ratio when nothing was considered). */
  coverage: { evaluated: number; considered: number; ratio: number | null };
  shards: ShardOutcome[];
  lifecycleTransitions: LifecycleTransition[];
  stageTransitions: StageTransition[];
  /** Canonical report references stored for this job (pdfKeys). */
  reportKeys: string[];
  /** Shards whose child stored a canonical report (from child outputs, not a parent step). */
  storedShards: string[];
  /** Shards whose child delivered an outcome through the tracked pipeline. */
  deliveredShards: string[];
  /** Per-shard store errors (recorded, not fatal: the screen itself succeeded). */
  storeErrors?: Record<string, string>;
  /** Per-shard deliver errors (recorded, not fatal). */
  deliverErrors?: Record<string, string>;
  /** Top-level error when lifecycle is Failed. */
  error?: string;
}

/** Status URL for a job (existing jobs-history path; no new status route). */
export function workflowStatusUrl(jobId: string): string {
  return `/api/jobs/history?chainId=${encodeURIComponent(jobId)}`;
}
