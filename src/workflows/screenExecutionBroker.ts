/**
 * Issue #2827 (Phase 2 Slice 2 under #2764) — ScreenExecutionBroker:
 * the one REST async-or-sync branch, extracted from the two REST
 * stock-screen routes (etradeBrokerScreen.ts, marketDataResearch.ts).
 *
 * GRASP Controller / Pure Fabrication: this module owns the single
 * decision "start a workflow, or fall back to the synchronous
 * screen", which both routes previously re-implemented inline.
 * It introduces no new execution, persistence, or delivery
 * behaviour, and no new port family: the workflow start goes
 * through the existing tryStartScreenerWorkflow seam
 * (screenerWorkflowRoutes.ts), which itself goes through
 * WorkflowPort / CfWorkflowAdapter.
 *
 * Contract (preserves both routes' behaviour exactly):
 *   - spec.asyncRequested false -> null. Caller runs sync.
 *   - spec.asyncRequested true -> build WorkflowJobCommand
 *     exactly as the routes did (jobId manualWorkflowJobId,
 *     shards ALL ? shardableUniverses : [universe], type
 *     run-screen, source/trigger manual, role parent,
 *     tenantId workflowTenantId(env), deliver/provider from
 *     spec, filters, environment, portfolioContext,
 *     screenMode/screenIntent when present) and start it.
 *   - starter returns a handle -> return { handle, jobId, shards }
 *     so the route can audit with its own audit name and
 *     return workflowAcceptedResponse(handle), exactly as today.
 *   - starter returns null (unbound workflow, start failure) ->
 *     return null. Caller falls through to sync. This is the
 *     routes' "unbound -> sync" rule, unchanged.
 *   - ND gate closed -> tryStartScreenerWorkflow THROWS.
 *     This broker does NOT catch it: a throw must never
 *     degrade to a synchronous deterministic run (issue #2530
 *     fail-closed rule, also enforced by the routes' 400
 *     admission). Callers must not wrap this call in a
 *     fallback catch that converts a throw to sync.
 *
 * Testability (DIP): the starter is injectable. Production
 * callers pass nothing and get tryStartScreenerWorkflow;
 * tests pass a fake starter and never touch a workflow binding.
 */

import { shardableUniverses } from "../trading";
import type { AsyncJobSubmission, Env, ShardChainContext } from "../types";
import {
  manualWorkflowJobId,
  tryStartScreenerWorkflow,
  workflowTenantId,
} from "./screenerWorkflowRoutes";
import type { WorkflowHandle, WorkflowJobCommand, WorkflowShard } from "./workflowPorts";
import type { StockScreenRunSpec } from "./stockScreenRunSpec";
import { workflowTriggerForSpec } from "./stockScreenRunSpec";

export type ScreenWorkflowStarter = (
  env: Env,
  command: WorkflowJobCommand,
) => Promise<WorkflowHandle | null>;

export interface ScreenExecutionBrokerResult {
  handle: WorkflowHandle;
  jobId: string;
  shards: WorkflowShard[];
}

/**
 * Issue #2867 (Phase 2 Slice 7 under #2764) — the broker's one
 * shard policy, shared by the REST broker, the NLQ chat-screen
 * command builder, and the mesh door's command builder (which
 * previously each wrote this ternary out by hand): universe
 * "ALL" fans out to every shardable universe, any other
 * universe is its own single shard.
 */
export function shardsForUniverse(universe: string): WorkflowShard[] {
  return universe === "ALL"
    ? shardableUniverses().map((u) => ({ shardId: u, universe: u }))
    : [{ shardId: universe, universe }];
}

/**
 * Issue #2914 (G7) — the one parent command builder. Every
 * server-side run-screen parent command is built here: the
 * broker's REST start below, the NLQ chat-screen builder,
 * and the mesh door's builder (which previously each wrote
 * the literal out by hand, sharing only shardsForUniverse).
 * Defined fields ride; genuinely unknown fields stay
 * absent — the builder never invents a value. The goal
 * command keeps its own builder (buildGoalScreenCommand):
 * it carries the goalScreen descriptor, not a market
 * command. The paid-fulfillment path (premium.ts) keeps its
 * own literal too, out of G7 scope (own symbols-shard
 * scheme, own tests) — named in the G7 pin test, not
 * silently passed.
 */
export interface ParentScreenCommandInput {
  jobId: string;
  source: string;
  trigger: "manual" | "scheduled";
  specTrigger?: WorkflowJobCommand["specTrigger"];
  userLogin: string;
  tenantId?: string;
  shards: WorkflowShard[];
  filters: Record<string, unknown>;
  maxItems?: number;
  pollIntervalMs?: number;
  traceparent?: string;
  screenMode?: WorkflowJobCommand["screenMode"];
  screenIntent?: string;
  deliver?: boolean;
  provider?: string;
  environment?: "TEST" | "PROD";
  portfolioContext?: boolean;
  scheduleId?: string;
  goalId?: string;
  patternRef?: WorkflowJobCommand["patternRef"];
  presetRef?: WorkflowJobCommand["presetRef"];
  patternQualifications?: string[];
}

export function buildParentScreenCommand(
  input: ParentScreenCommandInput,
): WorkflowJobCommand {
  return {
    jobId: input.jobId,
    type: "run-screen",
    source: input.source,
    trigger: input.trigger,
    ...(input.specTrigger !== undefined ? { specTrigger: input.specTrigger } : {}),
    userLogin: input.userLogin,
    role: "parent",
    tenantId: input.tenantId,
    shards: input.shards,
    ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
    ...(input.patternRef !== undefined ? { patternRef: input.patternRef } : {}),
    ...(input.presetRef !== undefined ? { presetRef: input.presetRef } : {}),
    ...(input.patternQualifications !== undefined ? { patternQualifications: input.patternQualifications } : {}),
    ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    filters: input.filters,
    ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.portfolioContext !== undefined ? { portfolioContext: input.portfolioContext } : {}),
    ...(input.screenMode
      ? { screenMode: input.screenMode, screenIntent: input.screenIntent }
      : {}),
  };
}

/**
 * Issue #2373 (Slice A) — the spec -> parent-command mapping,
 * extracted from startStockScreenWorkflowOrNull so the paid
 * seam (which hands the same command to the payment workflow
 * instead of starting the screener directly) builds exactly
 * one command, never a second literal. Pure: the tenant id
 * arrives via deps (callers resolve it from env with
 * workflowTenantId), so no env access lives here. The broker
 * below and the paid seam both call this; the broker's
 * contract is unchanged.
 */
export interface StockScreenWorkflowCommandDeps {
  userLogin: string;
  tenantId?: string;
  /** Optional: E*TRADE passes its requested env; market-data passes none. */
  environment?: "TEST" | "PROD";
  /** Optional: E*TRADE passes its flag; market-data passes none. */
  portfolioContext?: boolean;
}

export function buildStockScreenWorkflowCommand(
  spec: StockScreenRunSpec,
  deps: StockScreenWorkflowCommandDeps,
): WorkflowJobCommand {
  // Issue #2908 (G1): the job id and identity come from the
  // spec when it carries them — no field re-derived by hand
  // downstream. The workflow trigger maps from the spec
  // trigger (scheduled only for scheduled specs); the spec's
  // own trigger rides as specTrigger so NLQ/mesh/research
  // provenance survives the workflow hop.
  // Issue #2914 (G7): the command comes from the one
  // builder — the literal lived in the broker before, now shared.
  return buildParentScreenCommand({
    jobId: spec.jobId ?? manualWorkflowJobId(spec.universe),
    source: "manual",
    trigger: workflowTriggerForSpec(spec),
    ...(spec.trigger !== undefined ? { specTrigger: spec.trigger } : {}),
    userLogin: spec.userLogin ?? deps.userLogin,
    tenantId: deps.tenantId,
    shards: shardsForUniverse(spec.universe),
    ...(spec.scheduleId !== undefined ? { scheduleId: spec.scheduleId } : {}),
    ...(spec.goalId !== undefined ? { goalId: spec.goalId } : {}),
    ...(spec.patternRef !== undefined ? { patternRef: spec.patternRef } : {}),
    ...(spec.presetRef !== undefined ? { presetRef: spec.presetRef } : {}),
    ...(spec.patternQualifications !== undefined ? { patternQualifications: spec.patternQualifications } : {}),
    deliver: spec.deliver,
    ...(spec.provider ? { provider: spec.provider } : {}),
    filters: spec.filters as unknown as Record<string, unknown>,
    ...(deps.environment !== undefined ? { environment: deps.environment } : {}),
    ...(deps.portfolioContext !== undefined ? { portfolioContext: deps.portfolioContext } : {}),
    ...(spec.screenMode
      ? { screenMode: spec.screenMode, screenIntent: spec.screenIntent }
      : {}),
  });
}

/**
 * Start a REST stock screen via workflow when the spec asks
 * for async, otherwise return null for the sync path.
 */
export async function startStockScreenWorkflowOrNull(args: {
  env: Env;
  spec: StockScreenRunSpec;
  userLogin: string;
  /** Optional: E*TRADE passes its requested env; market-data passed none. */
  environment?: "TEST" | "PROD";
  /** Optional: E*TRADE passes its flag; market-data passed none. */
  portfolioContext?: boolean;
  /**
   * Issue #3922: the hosting instance's per-login settings
   * reader, forwarded to the default starter so the ND
   * backstop gate resolves through the stored layer. An
   * injected starter keeps its own (env, command) contract.
   * Absent → the env-only backstop, exactly as before.
   */
  readSettingRaw?: (key: string) => string | null;
  /** Injectable for tests; defaults to tryStartScreenerWorkflow. */
  starter?: ScreenWorkflowStarter;
}): Promise<ScreenExecutionBrokerResult | null> {
  const { env, spec, userLogin, environment, portfolioContext } = args;
  // Issue #2991: the #2882 broker guard (source "goal" -> null)
  // is retired. Goal dispatch becomes a caller of the one
  // pipeline, so a goal spec with async requested routes like
  // any spec, carrying goal provenance (specTrigger) through
  // the command. Goal delivery stays goal-owned until the
  // migration follow-up; no live caller passed goal specs to
  // the broker before this change.
  if (!spec.asyncRequested) return null;
  const starter =
    args.starter ??
    ((env: Env, command: WorkflowJobCommand) =>
      tryStartScreenerWorkflow(env, command, { readSettingRaw: args.readSettingRaw }));
  // ND throw propagates by design — see module header.
  // Issue #2373 (Slice A): the command comes from the one
  // spec -> command mapping above, shared with the paid seam.
  const command = buildStockScreenWorkflowCommand(spec, {
    userLogin,
    tenantId: workflowTenantId(env),
    ...(environment !== undefined ? { environment } : {}),
    ...(portfolioContext !== undefined ? { portfolioContext } : {}),
  });
  const handle = await starter(env, command);
  if (!handle) return null;
  return { handle, jobId: command.jobId, shards: command.shards };
}

/**
 * Issue #2914 (G7) — the broker's scheduled-async branch:
 * start a scheduled sharded run's chain. The submission
 * (planFeedStart + the shardSubmit async-job port) moved
 * here from ScheduledTasksService, so scheduledTasks no
 * longer imports the chain planner for its start — the
 * broker owns every screen start, and the chain keeps its
 * own engine (below).
 *
 * What this is NOT: a migration of scheduled-sharded
 * execution onto the ScreenerScreenWorkflow. That literal
 * migration was considered and rejected in G7, for the
 * record: (1) the chain is the stage pipeline — its
 * stageChain config (serve delays, stage options) has no
 * workflow equivalent (zero stageChain references in
 * src/workflows/); (2) the chain run model (chain_id) is
 * read by the workflowRuns surface as one run, and the
 * chain's serve step feeds the same delivery bridge
 * (followup.report -> followup.deliver) the workflow
 * feeds; (3) per-run delivery channels (emailTo,
 * slackChannel, webhookUrl) ride the chain context, while
 * the workflow command carries no channel fields. Moving
 * execution would drop staging + channels and fight the
 * #2869 production-wiring direction (chain stages -> the
 * bridge). If a workflow-start migration is ever wanted,
 * it needs channel plumbing + stageChain-in-workflow +
 * chain-run-model migration as its own designed issue,
 * not a silent side effect of G7.
 */
export async function startScheduledShardedChain(args: {
  chain: ShardChainContext;
  /** Injectable for tests; production passes the async-job submission port. */
  submit: (submission: AsyncJobSubmission) => Promise<{ jobId: string }>;
}): Promise<{ jobId: string }> {
  const { planFeedStart } = await import("../services/shardJobs");
  return args.submit(planFeedStart(args.chain));
}
