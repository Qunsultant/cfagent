/**
 * RETIRED by issue #4280 ([One engine] #3550 S5) — the scheduled sharded
 * chain moved onto the engine (`submitStockScreenViaEngine`,
 * `src/workflows/runStockScreenViaEngine.ts`). This function is FROZEN,
 * not deleted: it keeps the broker's old chain start (planFeedStart +
 * the shardSubmit async-job port) exactly as it was, for the record and
 * for the tests that pin the retired shape. No live caller remains —
 * `ScheduledTasksService.autonomousMarketScreenSharded` submits through
 * the engine seam now, with `jobId = chainId`.
 *
 * Deletion condition: zero consumers plus an owner decision plus a gate
 * amendment; deletion is never part of a program slice. Ledger:
 * `docs/architecture/transition/deprecations.md`.
 */
import type { AsyncJobSubmission, ShardChainContext } from "../types";

/**
 * @deprecated Superseded by submitStockScreenViaEngine
 * (`src/workflows/runStockScreenViaEngine.ts`) — use that instead.
 * The broker's retired scheduled-async branch (see the module note).
 */
export async function startScheduledShardedChain(args: {
  chain: ShardChainContext;
  /** Injectable for tests; production passes the async-job submission port. */
  submit: (submission: AsyncJobSubmission) => Promise<{ jobId: string }>;
}): Promise<{ jobId: string }> {
  const { planFeedStart } = await import("../services/shardJobs");
  return args.submit(planFeedStart(args.chain));
}
