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
  if (!spec.asyncRequested) return null;
  const jobId = manualWorkflowJobId(spec.universe);
  const shards: WorkflowShard[] =
    spec.universe === "ALL"
      ? shardableUniverses().map((u) => ({ shardId: u, universe: u }))
      : [{ shardId: spec.universe, universe: spec.universe }];
  const starter = args.starter ?? tryStartScreenerWorkflow;
  // ND throw propagates by design — see module header.
  const handle = await starter(env, {
    jobId,
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin,
    role: "parent",
    tenantId: workflowTenantId(env),
    shards,
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
