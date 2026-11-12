/**
 * Issue #4279 ([One engine] #3550 S4) — the ONE seam the A2A
 * `screener.run_goal_screen` entry routes through instead of calling
 * ScreenerAgent.runGoalScreen.
 *
 * One seam, no per-site reimplementation: submit a goal screen on
 * the engine and await its outcome, mapped back to the
 * `{ task, executed, result }` shape the A2A dispatch already
 * returns. It reuses the goal submission machinery
 * (buildGoalScreenCommand + startGoalScreenWorkflow), the S3 seam's
 * collation parser (collationFromRows), and the canonical report as
 * the read-back surface: the goal job's store stage writes the full
 * structured result into the canonical row's body (`body.result`),
 * and the collation's `childReportIds` (or the goal shard's
 * `reportId`) names that row. No new store, no new read surface.
 *
 * Start failure (port unavailable, start throw) throws a coded
 * WorkflowError — the caller's existing coded failure, never a
 * silent direct fallback, never an invented result. A duplicate
 * submission (same idempotencyKey — the workflow reports
 * `existing`) returns the existing run's outcome with
 * `executed: false`, exactly like the ledger's duplicate rule.
 *
 * Await bound: twice the workflow's per-shard deadline
 * (2 x DEFAULT_SHARD_TIMEOUT_MS) — the goal job composes two legs
 * sequentially (stock leg, then options leg), each bounded by the
 * shard deadline, so one shard deadline cannot bound the goal job.
 * Poll cadence is the shared chat await cadence
 * (CHAT_AWAIT_POLL_INTERVAL_MS). A deadline expiry, or a terminal
 * workflow without a projected collation, returns an honest
 * still-running failure naming the run's status URL — the goal job
 * continues; the caller polls Workflow Runs. A job that produced no
 * canonical row (failed before its store stage) throws honestly
 * with the collation's error — never a fabricated result.
 */
import type { Env } from "../types";
import type { SqlStorage } from "../data/repositoryPorts";
import type { ShardJobRow } from "../data/shardJobPorts";
import { readJobHistory } from "../data/createShardJobPorts";
import { createWorkflowPorts } from "./createWorkflowPorts";
import {
  buildGoalScreenCommand,
  startGoalScreenWorkflow,
  type GoalScreenSubmissionInput,
} from "../services/goalScreenWorkflowSubmission";
import { getCanonicalReport, resolveCanonicalReportBody } from "../services/scheduledReports";
import type { GoalDrivenScreenResult } from "../services/goalDrivenScreen";
import type { ScreenerTask } from "../services/screenerTaskLedger";
import { collationFromRows } from "./runStockScreenViaEngine";
import { workflowTenantId } from "./screenerWorkflowRoutes";
import {
  DEFAULT_SHARD_TIMEOUT_MS,
  workflowStatusUrl,
  WorkflowError,
  type WorkflowCollation,
  type WorkflowHandle,
  type WorkflowPort,
} from "./workflowPorts";
import { CHAT_AWAIT_POLL_INTERVAL_MS } from "../agents/orchestrator/chatAwaitBudget";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** A goal job composes two legs sequentially — twice one shard deadline. */
export const GOAL_SCREEN_AWAIT_DEADLINE_MS = 2 * DEFAULT_SHARD_TIMEOUT_MS;

export interface RunGoalScreenViaEngineInput {
  env: Env;
  /** The goal submission (jobId IS the idempotencyKey). */
  submission: GoalScreenSubmissionInput;
  /** The DO SQL store the canonical row is read back from. No default — a caller without one cannot read back. */
  getSql: () => SqlStorage;
  /** The goal run's ledger task, by idempotencyKey. */
  readTask: (idempotencyKey: string) => Promise<ScreenerTask | null>;
  /** Injectable for tests; defaults to startGoalScreenWorkflow. */
  startWorkflow?: (
    env: Env,
    command: ReturnType<typeof buildGoalScreenCommand>,
    sink: ReturnType<typeof createObservabilitySink>,
  ) => Promise<WorkflowHandle>;
  /** Injectable for tests; defaults to createWorkflowPorts(env). Explicit null = unavailable (coded failure). */
  workflowPort?: WorkflowPort | null;
  /** Injectable for tests; defaults to readJobHistory(env, ...). */
  readWorkflowJobHistory?: (tenantId: string, jobId: string) => Promise<ShardJobRow[] | null>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** Injectable bound; defaults to GOAL_SCREEN_AWAIT_DEADLINE_MS. */
  awaitDeadlineMs?: number;
  pollIntervalMs?: number;
}

export interface GoalScreenRunOutcome {
  task: ScreenerTask;
  executed: boolean;
  result?: GoalDrivenScreenResult;
}

/** The seam's function type, for call-site contexts that carry an injectable override (tests substitute a fake; production omits it). */
export type RunGoalScreenViaEngine = typeof runGoalScreenViaEngine;

/** The canonical report id for a goal parent's collation: the absorbed child report id first, then the goal shard's own. */
function goalReportId(collation: WorkflowCollation): string | undefined {
  const absorbed = collation.childReportIds?.[0];
  if (typeof absorbed === "string" && absorbed) return absorbed;
  const shard = collation.shards.find((s) => s.shardId === "goal");
  return shard?.reportId ?? undefined;
}

/**
 * Run one goal screen through the engine: submit -> await the
 * collation -> read the structured result back from the canonical
 * row -> return the ledger task + result. Throws WorkflowError
 * (coded) for pre-start failures and honest Errors for a run that
 * produced no readable outcome; a deadline expiry returns the
 * still-running failure as a throw naming the status URL.
 */
export async function runGoalScreenViaEngine(
  input: RunGoalScreenViaEngineInput,
): Promise<GoalScreenRunOutcome> {
  const { env, submission } = input;
  const nowMs = input.nowMs ?? (() => Date.now());
  const tenantId = workflowTenantId(env);
  const command = buildGoalScreenCommand(submission);
  const sink = createObservabilitySink(env);
  const start = input.startWorkflow ?? startGoalScreenWorkflow;
  let handle: WorkflowHandle;
  try {
    handle = await start(env, command, sink);
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    throw new WorkflowError(
      "start_failed",
      `Goal screen workflow start failed for job ${command.jobId}: ${err instanceof Error ? err.message : String(err)}. No fallback run was started.`,
    );
  }
  const executed = !handle.existing;

  const ports: WorkflowPort | null =
    input.workflowPort !== undefined ? input.workflowPort : createWorkflowPorts(env);
  const readHistory =
    input.readWorkflowJobHistory ?? ((t: string, c: string) => readJobHistory(env, t, c));
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = input.pollIntervalMs ?? CHAT_AWAIT_POLL_INTERVAL_MS;
  const deadline = nowMs() + (input.awaitDeadlineMs ?? GOAL_SCREEN_AWAIT_DEADLINE_MS);
  let terminalPolls = 0;
  for (;;) {
    const rows = await readHistory(tenantId, command.jobId).catch(() => null);
    const collation = collationFromRows(rows, command.jobId);
    if (collation) {
      return readOutcome(input, collation, executed, command.jobId);
    }
    const status = ports ? await ports.status(handle.workflowId).catch(() => null) : null;
    const terminal =
      status !== null &&
      (status.status === "complete" || status.status === "errored" || status.status === "terminated");
    if (terminal) {
      terminalPolls += 1;
      if (terminalPolls >= 3) {
        throw new Error(
          `Goal screen workflow ${command.jobId} ended with workflow status "${status.status}" before its outcome was projected; it remains tracked at ${workflowStatusUrl(command.jobId)}.`,
        );
      }
    }
    if (nowMs() >= deadline) {
      throw new Error(
        `Goal screen workflow ${command.jobId} did not complete within the engine await window; it remains tracked at ${workflowStatusUrl(command.jobId)}.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

async function readOutcome(
  input: RunGoalScreenViaEngineInput,
  collation: WorkflowCollation,
  executed: boolean,
  jobId: string,
): Promise<GoalScreenRunOutcome> {
  const reportId = goalReportId(collation);
  if (!reportId) {
    throw new Error(
      `Goal screen workflow ${jobId} completed without storing a canonical report (lifecycle "${collation.lifecycle}"${collation.error ? `: ${collation.error}` : ""}); no goal result is readable.`,
    );
  }
  const sql = input.getSql();
  const hit = getCanonicalReport(sql, reportId);
  if (!hit) {
    throw new Error(
      `Goal screen workflow ${jobId} stored canonical report ${reportId}, but the row is not readable.`,
    );
  }
  const bodyText = await resolveCanonicalReportBody(input.env, hit);
  let result: GoalDrivenScreenResult | undefined;
  try {
    const parsed = bodyText ? (JSON.parse(bodyText) as { result?: unknown }) : null;
    if (parsed && typeof parsed === "object" && parsed.result && typeof parsed.result === "object") {
      result = parsed.result as GoalDrivenScreenResult;
    }
  } catch {
    // Fall through to the unreadable-body throw below.
  }
  if (!result) {
    throw new Error(
      `Goal screen workflow ${jobId} stored canonical report ${reportId}, but its body carries no goal result.`,
    );
  }
  const task = await input.readTask(jobId);
  if (!task) {
    throw new Error(
      `Goal screen workflow ${jobId} completed with a stored result, but no ledger task is recorded for it.`,
    );
  }
  return { task, executed, result };
}
