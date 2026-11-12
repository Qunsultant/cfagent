/**
 * Issue #4278 ([One engine] #3550 S3) — the ONE shared seam every
 * direct stock-screen entry routes through instead of calling
 * ScreenerAgent.runScreen / runSharded.
 *
 * One seam, no per-site reimplementation: start a market screen on
 * the engine and await its collation, mapped back to
 * ScreenerRunResult. It reuses the broker's spec -> command -> start
 * machinery (buildStockScreenWorkflowCommand) and the mesh door's
 * await/read-back pattern (readJobHistory collation + assembly from
 * the stored run bodies). It introduces no new execution, persistence,
 * or delivery behaviour: the workflow's own store + deliver steps own
 * the finished run, exactly as the async paths already rely on.
 *
 * Gates, in runScreen's order (before any start):
 *   1. ND backstop (#2530): a non-deterministic command while the
 *      gate is closed refuses outright — never a silent downgrade.
 *   2. In-flight probe: the per-(user, universe) lock is probed via
 *      the agent (the sharded-chain precedent — a chain outlives any
 *      submission-scoped lease, so the seam probes instead of
 *      acquiring). A running run refuses by name with the running
 *      run's id (ScreenAlreadyRunningError, the exact error runScreen
 *      throws, so callers' existing 429 mapping answers identically).
 *      The probe is not an atomic acquire: two starts in the same
 *      instant can both pass it, where runScreen's lock admitted
 *      only one. Each run still lands under its own job id with its
 *      own record; the 429 stands for the sequential second
 *      submitter, which is the case the contract names.
 *   3. Quota charge (#2842): one charge per shard (the direct
 *      runSharded path charged once per universe), run id
 *      `<jobId>:<shardId>`, tenant partition the run owner's login
 *      (runScreen's #2426 default). A refusal throws before any
 *      start and charges nothing further.
 *
 * Failure/recovery: a workflow-start failure (port unavailable,
 * start throw) answers the caller's existing coded failure — no
 * silent direct fallback, no invented result. Once a run exists,
 * every outcome returns as results: a failed collation maps to
 * failed ScreenerRunResults (never a throw), a duplicate-scheduled
 * collation synthesizes the skippedDuplicate result the scheduled
 * service already honors, and an await deadline returns an honest
 * still-running failure naming the run's status URL.
 *
 * Read-back: the stored run bodies are the agent's own HISTORY
 * cache (persistRun writes the full result there in the workflow's
 * store stage, pdf/xlsx keys included) — the same bodies the
 * workflow stored canonically, matched per shard by the collation's
 * pdfKey first, then universe + timestamp, then elimination (the
 * door's matching order). No new store, no new read surface: every
 * site already holds the agent the read-back goes through.
 *
 * Await bound: the workflow's own per-shard deadline
 * (DEFAULT_SHARD_TIMEOUT_MS) — a run cannot legitimately outlive
 * its shards' deadlines by much, and the bound is the workflow's
 * named constant, not a new literal. Poll cadence is the shared
 * chat await cadence (CHAT_AWAIT_POLL_INTERVAL_MS).
 */
import type { Env } from "../types";
import type { ScreenerRunResult } from "../agents/screener-agent";
import type { ShardJobRow } from "../data/shardJobPorts";
import { readJobHistory } from "../data/createShardJobPorts";
import { createWorkflowPorts } from "./createWorkflowPorts";
import { buildStockScreenWorkflowCommand } from "./screenExecutionBroker";
import {
  assertScreenModeGate as assertNdGate,
  workflowTenantId,
} from "./screenerWorkflowRoutes";
import type { StockScreenRunSpec } from "./stockScreenRunSpec";
import type { BrokerId } from "../trading";
import { workflowTriggerForSpec } from "./stockScreenRunSpec";
import {
  assertWorkflowJobCommand,
  DEFAULT_SHARD_TIMEOUT_MS,
  workflowStatusUrl,
  WorkflowError,
  type WorkflowCollation,
  type WorkflowJobCommand,
  type WorkflowPort,
  type WorkflowShard,
} from "./workflowPorts";
import { ScreenAlreadyRunningError } from "../services/screenInFlight";
import { CHAT_AWAIT_POLL_INTERVAL_MS } from "../agents/orchestrator/chatAwaitBudget";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/runStockScreenViaEngine",
});

/** The agent surface the seam gates + reads back through (structural: any ScreenerAgent satisfies it). */
export interface ScreenEngineAgentGates {
  isScreenRunning: (
    universe: string,
    userLogin?: string,
  ) => Promise<{ running: boolean; startedAt: number | null; runId: string | null; status: "running" | "idle" }>; // ScreenerAgent order: universe first
  chargeScreenQuota: (input: {
    userLogin: string;
    tenantId?: string;
    runId: string;
  }) => Promise<void> | void;
  getHistory: () => Promise<ScreenerRunResult[]>;
}

/** Command fields a site overrides beyond the spec (defined fields only; absent stays absent). */
export interface EngineScreenCommandOverrides {
  jobId?: string;
  shards?: WorkflowShard[];
  sector?: string;
  maxItems?: number;
  maxSymbols?: number;
  provider?: string;
  broker?: BrokerId;
  mode?: "live" | "paper";
  modeSource?: "pin" | "selection" | "inference";
  deliver?: boolean;
}

export interface RunStockScreenViaEngineInput {
  env: Env;
  spec: StockScreenRunSpec;
  userLogin: string;
  /** Optional: the broker route passes its requested env; market-data passes none. */
  environment?: "TEST" | "PROD";
  /** Optional: the broker route passes its flag; market-data passes none. */
  portfolioContext?: boolean;
  commandOverrides?: EngineScreenCommandOverrides;
  /** Issue #3922: forwarded to the ND backstop so the gate resolves through the stored layer. */
  readSettingRaw?: (key: string) => string | null;
  /** The run owner's agent: gates + HISTORY read-back. No default — a caller without one cannot gate. */
  agent: ScreenEngineAgentGates;
  /** Injectable for tests; defaults to createWorkflowPorts(env). Explicit null = unavailable (coded failure). */
  workflowPort?: WorkflowPort | null;
  /** Injectable for tests; defaults to readJobHistory(env, ...). */
  readWorkflowJobHistory?: (tenantId: string, jobId: string) => Promise<ShardJobRow[] | null>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** Injectable bound; defaults to the workflow's per-shard deadline (see the module note). */
  awaitDeadlineMs?: number;
  pollIntervalMs?: number;
}

export interface EngineScreenRunOutcome {
  /** One result per command shard, in shard order. */
  results: ScreenerRunResult[];
  /** The parent collation when one projected; null on deadline/terminal-without-projection. */
  collation: WorkflowCollation | null;
  jobId: string;
  workflowId: string;
}

/** The duplicate-suppression marker the collation carries for a suppressed scheduled run. */
const DUPLICATE_MARKER = "Duplicate scheduled delivery suppressed";

/**
 * Aggregate per-shard results into the one result an ALL caller
 * consumes (the REST ALL branches keep the per-shard array; A2A
 * run_screen returns one result). Success iff at least one shard
 * succeeded (the route ALL rule); counts sum; rows concatenate in
 * shard order; the first shard error rides the aggregate.
 */
export function aggregateShardResults(
  results: ScreenerRunResult[],
  universe: string,
): ScreenerRunResult {
  const first = results[0];
  const success = results.some((r) => r.success);
  const firstError = results.find((r) => !r.success)?.error;
  return {
    ...first,
    timestamp: results.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), results[0]?.timestamp ?? new Date().toISOString()),
    universe: universe as ScreenerRunResult["universe"],
    sector:
      results.length === 1
        ? (results[0].sector ?? "")
        : results.every((r) => r.sector === results[0].sector)
          ? (results[0].sector ?? "")
          : "ALL",
    success,
    totalScanned: results.reduce((n, r) => n + r.totalScanned, 0),
    matchedCount: results.reduce((n, r) => n + r.matchedCount, 0),
    opportunities: results.flatMap((r) => r.opportunities),
    allStocks: results.flatMap((r) => r.allStocks),
    discoveryMessage: results.find((r) => r.discoveryMessage)?.discoveryMessage ?? "",
    ...(!success && firstError ? { error: firstError } : {}),
  };
}

/**
 * The collation out of a chain's projection rows: the parent row
 * (keyed by the job id) carries it as its resultJson once
 * project-final lands. The announce row's {jobId, detail} shape has
 * no lifecycle — not terminal, keep polling. (Twin of the mesh
 * door's + the NLQ port's private copies; those stay untouched in
 * this slice — consolidating them onto one helper is a follow-up,
 * not a silent second seam: this copy serves the routed sites only.)
 */
function collationFromRows(rows: ShardJobRow[] | null, jobId: string): WorkflowCollation | null {
  const parent = rows?.find((r) => r.jobKey === jobId);
  if (!parent) return null;
  try {
    const parsed = JSON.parse(parent.resultJson) as WorkflowCollation;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.lifecycle === "string" &&
      Array.isArray(parsed.shards)
    ) {
      return parsed;
    }
  } catch {
    // Not a collation payload (announce row) — keep polling.
  }
  return null;
}

/** The failed ScreenerRunResult for one shard that produced no readable body. */
function failedShardResult(args: {
  shard: WorkflowShard;
  trigger: "manual" | "scheduled";
  provider: string | undefined;
  sector: string;
  startedAtIso: string;
  error: string;
  totalScanned?: number;
  matchedCount?: number;
  timestamp?: string;
}): ScreenerRunResult {
  return {
    timestamp: args.timestamp ?? args.startedAtIso,
    trigger: args.trigger,
    provider: args.provider as ScreenerRunResult["provider"],
    universe: (args.shard.universe ?? args.shard.shardId) as ScreenerRunResult["universe"],
    sector: args.sector,
    success: false,
    totalScanned: args.totalScanned ?? 0,
    matchedCount: args.matchedCount ?? 0,
    opportunities: [],
    allStocks: [],
    discoveryMessage: "",
    error: args.error,
  };
}

/**
 * Assemble one ScreenerRunResult per command shard from the
 * collation + the agent's HISTORY bodies. Matching order is the
 * door's: collation pdfKey first, then universe + timestamp,
 * then elimination when one shard and one body remain. A shard
 * whose collation outcome is a duplicate suppression synthesizes
 * the skippedDuplicate result (the feed stage's dup shape, which
 * never reaches HISTORY because the store stage passes it through
 * without persisting). A shard with no readable body fails honestly
 * with the collation's, the shard outcome's, or the projection
 * detail's error — never a fabricated success.
 */
function assembleResults(args: {
  shards: WorkflowShard[];
  collation: WorkflowCollation | null;
  history: ScreenerRunResult[];
  rows: ShardJobRow[] | null;
  startedAtIso: string;
  jobId: string;
  trigger: "manual" | "scheduled";
  // Issue #4278: the provider a synthesized failure carries — the
  // command's when the run named one, undefined when it did not
  // (no hardcoded default: the engine never reported one).
  provider: string | undefined;
  sector: string;
  terminalNote: string;
}): ScreenerRunResult[] {
  const { shards, collation, history, rows, startedAtIso, jobId } = args;
  const detailFor = (jobKey: string): string | undefined =>
    rows?.find((r) => r.jobKey === jobKey)?.detail || undefined;
  const used = new Set<number>();
  const perShard = new Map<string, ScreenerRunResult>();
  for (const shard of shards) {
    const outcome = collation?.shards.find((s) => s.shardId === shard.shardId);
    if (outcome?.pdfKey) {
      const idx = history.findIndex((b, i) => !used.has(i) && b.pdfKey === outcome.pdfKey);
      if (idx >= 0) {
        used.add(idx);
        perShard.set(shard.shardId, history[idx]);
      }
    }
  }
  for (const shard of shards) {
    if (perShard.has(shard.shardId)) continue;
    const idx = history.findIndex(
      (b, i) =>
        !used.has(i) &&
        b.universe !== undefined &&
        b.universe === shard.universe &&
        b.timestamp >= startedAtIso,
    );
    if (idx >= 0) {
      used.add(idx);
      perShard.set(shard.shardId, history[idx]);
    }
  }
  const unmatchedShards = shards.filter((s) => !perShard.has(s.shardId));
  const unmatchedBodies = history.filter((_, i) => !used.has(i));
  if (unmatchedShards.length === 1 && unmatchedBodies.length === 1) {
    perShard.set(unmatchedShards[0].shardId, unmatchedBodies[0]);
  }

  return shards.map((shard) => {
    const matched = perShard.get(shard.shardId);
    if (matched) return matched;
    const outcome = collation?.shards.find((s) => s.shardId === shard.shardId);
    const shardError =
      outcome?.error ?? collation?.error ?? detailFor(`leg:${shard.shardId}`);
    // Duplicate suppression: the collation carries the feed
    // stage's dup message as the shard error. Synthesize the
    // feed stage's dup result (skippedDuplicate, no invented
    // counts, no error field — the agent's dup shape verbatim).
    if (typeof shardError === "string" && shardError.includes(DUPLICATE_MARKER)) {
      return {
        timestamp: outcome?.timestamp ?? startedAtIso,
        trigger: args.trigger,
        provider: args.provider as ScreenerRunResult["provider"],
        universe: (shard.universe ?? shard.shardId) as ScreenerRunResult["universe"],
        sector: args.sector,
        success: false,
        totalScanned: 0,
        expectedCount: 0,
        matchedCount: 0,
        opportunities: [],
        allStocks: [],
        discoveryMessage: shardError,
        skippedDuplicate: true,
      };
    }
    const error =
      shardError ??
      detailFor("leg:parent") ??
      `Screen workflow run ${jobId} ${args.terminalNote}; it remains tracked at ${workflowStatusUrl(jobId)}.`;
    return failedShardResult({
      shard,
      trigger: args.trigger,
      provider: args.provider,
      sector: args.sector,
      startedAtIso,
      error,
      ...(outcome?.totalScanned !== undefined ? { totalScanned: outcome.totalScanned } : {}),
      ...(outcome?.matchedCount !== undefined ? { matchedCount: outcome.matchedCount } : {}),
      ...(outcome?.timestamp ? { timestamp: outcome.timestamp } : {}),
    });
  });
}

/**
 * The seam's function type, for call-site contexts that carry
 * an injectable override (tests substitute a fake; production
 * omits it and the site calls this function directly).
 */
export type RunStockScreenViaEngine = typeof runStockScreenViaEngine;

/**
 * Run one market screen through the engine: gates -> start ->
 * awaited collation -> ScreenerRunResults. Throws WorkflowError
 * (coded) for pre-start refusals that must never start a run
 * (port unavailable, start failure, ND backstop) and
 * ScreenAlreadyRunningError / quota errors for the gate refusals
 * (callers map those to their existing 429s). Once a run exists,
 * every outcome returns as results — starting anything else would
 * run the screen twice.
 */
export async function runStockScreenViaEngine(
  input: RunStockScreenViaEngineInput,
): Promise<EngineScreenRunOutcome> {
  const { env, spec, userLogin } = input;
  const nowMs = input.nowMs ?? (() => Date.now());
  const startedAtIso = new Date(nowMs()).toISOString();
  const tenantId = workflowTenantId(env);
  // The command comes from the broker's one spec -> command
  // mapping; overrides ride only the fields the spec cannot
  // express (symbols shards, sector, caps, broker/mode).
  const command = buildStockScreenWorkflowCommand(spec, {
    userLogin,
    tenantId,
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.portfolioContext !== undefined ? { portfolioContext: input.portfolioContext } : {}),
  });
  const overrides = input.commandOverrides;
  if (overrides) {
    if (overrides.jobId !== undefined) command.jobId = overrides.jobId;
    if (overrides.shards !== undefined) command.shards = overrides.shards;
    if (overrides.sector !== undefined) command.sector = overrides.sector;
    if (overrides.maxItems !== undefined) command.maxItems = overrides.maxItems;
    if (overrides.maxSymbols !== undefined) command.maxSymbols = overrides.maxSymbols;
    if (overrides.provider !== undefined) command.provider = overrides.provider;
    if (overrides.broker !== undefined) command.broker = overrides.broker;
    if (overrides.mode !== undefined) command.mode = overrides.mode;
    if (overrides.modeSource !== undefined) command.modeSource = overrides.modeSource;
    if (overrides.deliver !== undefined) command.deliver = overrides.deliver;
  }
  // Gate 1 — ND backstop (#2530), before any side effect.
  assertNdGate(env, command, { readSettingRaw: input.readSettingRaw });
  assertWorkflowJobCommand(command);

  const trigger = workflowTriggerForSpec(spec);
  const shards = command.shards;
  // Gate 2 — in-flight probe, one per shard universe (the lock
  // scope is per universe; a symbols shard probes runScreen's
  // default lock key). A running run refuses by name with its id.
  for (const shard of shards) {
    const probeUniverse = shard.universe ?? "nasdaq100";
    const probe = await input.agent.isScreenRunning(probeUniverse, userLogin);
    if (probe.running) {
      const err = new ScreenAlreadyRunningError(userLogin, probeUniverse, probe.startedAt, nowMs());
      structuredLog.warn("runStockScreenViaEngine.already_running", {
        message: `[engine-screen] Screen already running for ${probeUniverse} (run ${probe.runId ?? "unknown"}) — refusing job ${command.jobId} before start.`,
        runId: probe.runId ?? "",
        universe: probeUniverse,
      });
      throw err;
    }
  }
  // Gate 3 — quota charge, one per shard (runSharded charged once
  // per universe). A refusal throws before any start.
  for (const shard of shards) {
    try {
      await input.agent.chargeScreenQuota({
        userLogin,
        tenantId: userLogin,
        runId: `${command.jobId}:${shard.shardId}`,
      });
    } catch (err) {
      structuredLog.warn("runStockScreenViaEngine.quota_refused", {
        message: `[engine-screen] Quota refused job ${command.jobId} shard ${shard.shardId} — no workflow was started.`,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  const ports: WorkflowPort | null =
    input.workflowPort !== undefined ? input.workflowPort : createWorkflowPorts(env);
  if (!ports) {
    throw new WorkflowError(
      "unavailable",
      `Stock screen workflow unavailable for job ${command.jobId}: the workflow port could not be built (SCREENER_WORKFLOW binding or AGENT_DB projection store unbound). No direct fallback run was started — a screen is a workflow run or it does not run.`,
    );
  }
  let handle;
  try {
    handle = await ports.start(assertWorkflowJobCommand(command));
  } catch (err) {
    structuredLog.warn("runStockScreenViaEngine.start_failed", {
      message: `[engine-screen] Workflow start failed for job ${command.jobId}: ${err instanceof Error ? err.message : String(err)}. No fallback run was started.`,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new WorkflowError(
      "start_failed",
      `Stock screen workflow start failed for job ${command.jobId}: ${err instanceof Error ? err.message : String(err)}. No fallback run was started.`,
    );
  }

  const readHistory =
    input.readWorkflowJobHistory ?? ((t: string, c: string) => readJobHistory(env, t, c));
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = input.pollIntervalMs ?? CHAT_AWAIT_POLL_INTERVAL_MS;
  const deadline = nowMs() + (input.awaitDeadlineMs ?? DEFAULT_SHARD_TIMEOUT_MS);
  // A terminal instance whose collation has not projected yet
  // gets a few extra polls — projection lag is not a failure.
  let terminalPolls = 0;
  const assemble = async (collation: WorkflowCollation | null, rows: ShardJobRow[] | null, terminalNote: string) => {
    let history: ScreenerRunResult[];
    try {
      history = await input.agent.getHistory();
    } catch {
      history = [];
    }
    return {
      results: assembleResults({
        shards,
        collation,
        history,
        rows,
        startedAtIso,
        jobId: command.jobId,
        trigger,
        provider: command.provider,
        sector: command.sector ?? "ALL",
        terminalNote,
      }),
      collation,
      jobId: command.jobId,
      workflowId: handle.workflowId,
    };
  };
  for (;;) {
    const rows = await readHistory(tenantId, command.jobId).catch(() => null);
    const collation = collationFromRows(rows, command.jobId);
    if (collation) {
      return assemble(collation, rows, "completed");
    }
    const status = await ports.status(handle.workflowId).catch(() => null);
    const terminal =
      status !== null &&
      (status.status === "complete" || status.status === "errored" || status.status === "terminated");
    if (terminal) {
      terminalPolls += 1;
      if (terminalPolls >= 3) {
        return assemble(
          null,
          rows,
          `ended with workflow status "${status.status}" before its outcome was projected`,
        );
      }
    }
    if (nowMs() >= deadline) {
      return assemble(null, rows, "did not complete within the engine await window");
    }
    await sleep(pollIntervalMs);
  }
}
