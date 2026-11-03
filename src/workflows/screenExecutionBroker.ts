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
import type { Env } from "../types";
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
  /** Injectable for tests; defaults to tryStartScreenerWorkflow. */
  starter?: ScreenWorkflowStarter;
}): Promise<ScreenExecutionBrokerResult | null> {
  const { env, spec, userLogin, environment, portfolioContext } = args;
  // Issue #2882: goal stock legs never start a screener
  // workflow. Goal execution and delivery stay owned by goal
  // dispatch; the goal spec is a canonical record, not an
  // execution request. Returning null here is the broker's
  // routing decision for source "goal", not a failure.
  if (spec.source === "goal") return null;
  if (!spec.asyncRequested) return null;
  // Issue #2908 (G1): the job id and identity come from the
  // spec when it carries them — no field re-derived by hand
  // downstream. The workflow trigger maps from the spec
  // trigger (scheduled only for scheduled specs); the spec's
  // own trigger rides as specTrigger so NLQ/mesh/research
  // provenance survives the workflow hop.
  const jobId = spec.jobId ?? manualWorkflowJobId(spec.universe);
  const shards: WorkflowShard[] = shardsForUniverse(spec.universe);
  const starter = args.starter ?? tryStartScreenerWorkflow;
  // ND throw propagates by design — see module header.
  const handle = await starter(env, {
    jobId,
    type: "run-screen",
    source: "manual",
    trigger: workflowTriggerForSpec(spec),
    ...(spec.trigger !== undefined ? { specTrigger: spec.trigger } : {}),
    userLogin: spec.userLogin ?? userLogin,
    role: "parent",
    tenantId: workflowTenantId(env),
    shards,
    ...(spec.scheduleId !== undefined ? { scheduleId: spec.scheduleId } : {}),
    ...(spec.goalId !== undefined ? { goalId: spec.goalId } : {}),
    ...(spec.patternRef !== undefined ? { patternRef: spec.patternRef } : {}),
    ...(spec.presetRef !== undefined ? { presetRef: spec.presetRef } : {}),
    ...(spec.patternQualifications !== undefined ? { patternQualifications: spec.patternQualifications } : {}),
    deliver: spec.deliver,
    ...(spec.provider ? { provider: spec.provider } : {}),
    filters: spec.filters as unknown as Record<string, unknown>,
    ...(environment !== undefined ? { environment } : {}),
    ...(portfolioContext !== undefined ? { portfolioContext } : {}),
    ...(spec.screenMode
      ? { screenMode: spec.screenMode, screenIntent: spec.screenIntent }
      : {}),
  });
  if (!handle) return null;
  return { handle, jobId, shards };
}
