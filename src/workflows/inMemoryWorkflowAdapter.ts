/**
 * Issue #1737 — the in-memory workflow adapter, re-based on the
 * one workflow engine (#4192, #3550 S2 cutover).
 *
 * The second adapter behind the port: it runs a screen through
 * the engine (defineJob + runJob over the screener nodes — five
 * generic for market since the 6b3 flip #5884, six bespoke for
 * goal) with in-memory stores, and returns the collation the
 * composer builds from the persisted stage outputs + stage
 * ledger. It is the standing proof that a second
 * implementation plugs in cleanly, and the execution engine
 * for port-level tests.
 *
 * The screen itself is CANNED, not computed: the canned step
 * handlers below drive the injected ScreenRunner (the same
 * fake the old child-workflow flows called) and map its
 * ShardScreenResult onto the six stage outputs. Port-level
 * tests assert on the door + the engine's execution and
 * projection, not on the agent's screening math — that is
 * covered by the substrate tests (#4190) and the cutover
 * tests (#4192), which run the real agent stages. The canned
 * mapping is deliberately faithful to the flow it replaces:
 * the runner's counts drive the collation's coverage, its
 * keys ride the served formats, its store/deliver flags ride
 * the shard outcome, and a goal run fails only through the
 * goal result — so the mesh suites' canned expectations
 * survive the re-basing unchanged.
 *
 * Explicit construction only (tests, local development). It
 * is NEVER a silent production fallback: an in-memory
 * registry in a worker isolate cannot survive a restart, so
 * substituting it for durable execution would lie about the
 * run guarantees. The composition root never builds it.
 *
 * No virtual clock, no fake step with sleep, no child
 * workflows: the engine owns pacing, retries, and fan-out.
 * A throwing unit fails fast (single-attempt policy) — the
 * old flow's per-shard deadline is the engine's policy
 * timeout, not a poll loop.
 */

import {
  assertWorkflowJobCommand,
  workflowIdForJob,
  workflowStatusUrl,
  type WorkflowHandle,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
  type WorkflowPort,
  type WorkflowStatus,
} from "./workflowPorts";
import { createInMemoryJobPipelineStores } from "../data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../data/inMemoryJobRunRecordAdapter";
import { normalizeJobRunTrigger } from "../data/jobRunRecordPorts";
import { InMemoryMessagingAdapter } from "../messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../messaging/messagingPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import type { JobStepContext } from "../services/jobPipelineSteps";
import { FEED_PULL_STEP } from "../services/feedPipelineJobs";
import { ENRICH_SCREENER_STEP } from "../services/enrichPipelineJobs";
import { ANALYZE_SCREENER_STEP } from "../services/analyzePipelineJobs";
import { GENERATE_APPLY_STEP } from "../services/generatePipelineJobs";
import { DELIVER_APPLY_STEP } from "../services/deliverPipelineJobs";
import {
  GOAL_ARTIFACTS_STEP,
  GOAL_ASSEMBLE_STEP,
  GOAL_LEDGER_CLAIM_STEP,
  GOAL_LEDGER_COMPLETE_STEP,
  GOAL_OPTIONS_LEG_STEP,
  GOAL_PLAN_STEP,
  GOAL_QUOTA_STEP,
  GOAL_STOCK_LEG_STEP,
  SCREENER_ANALYSIS_STEP,
  SCREENER_DELIVER_STEP,
  SCREENER_FEED_STEP,
  SCREENER_GATHER_STEP,
  SCREENER_GOAL_STEP,
  SCREENER_SERVE_STEP,
  SCREENER_STORE_STEP,
} from "../services/screenerPipelineJobs";
import { DEFAULT_PIPELINE_POLICY } from "../services/pipelinePolicy";
import {
  runScreenerScreenOnEngine,
  type ScreenerEngineStep,
} from "./screenerWorkflow";
import {
  goalShardRequest,
  shardCommandFor,
  shardScreenRequest,
  type ScreenerWorkflowDeps,
  type ShardScreenResult,
} from "./screenerCollation";

/** Single-attempt policy: a throwing unit fails fast (no retry sleeps in tests). */
const SINGLE_ATTEMPT_POLICY = {
  ...DEFAULT_PIPELINE_POLICY,
  retry: {
    acquisition: { ...DEFAULT_PIPELINE_POLICY.retry.acquisition, maxAttempts: 1 },
    delivery: { ...DEFAULT_PIPELINE_POLICY.retry.delivery, maxAttempts: 1 },
    report: { ...DEFAULT_PIPELINE_POLICY.retry.report, maxAttempts: 1 },
  },
};

/**
 * This unit's prior hand-off: the engine hands a sharded unit
 * its parent's whole per-shard map (`{shardKey: output}`), so
 * a downstream step reads its own shard's entry; a monolith
 * unit receives the single output directly. (Mirrors
 * src/services/screenerPipelineJobs.ts — the adapter is
 * test-only; the production handlers own the canonical copy.)
 */
function priorFor<T>(input: unknown, shardKey: string | null): T {
  if (
    shardKey &&
    input !== null &&
    typeof input === "object" &&
    shardKey in (input as Record<string, unknown>)
  ) {
    return (input as Record<string, T>)[shardKey];
  }
  return input as T;
}

/** A scheduled duplicate passes through untouched from feed to deliver. */
function isDupOutput(value: unknown): value is { duplicate: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { duplicate?: unknown }).duplicate === true
  );
}

interface InstanceRecord {
  workflowId: string;
  jobId: string;
  command: WorkflowJobCommand;
  status: WorkflowInstanceStatus;
  output?: unknown;
  error?: { message: string };
}

export class InMemoryWorkflowAdapter implements WorkflowPort {
  private readonly instances = new Map<string, InstanceRecord>();
  private readonly control: JobPipelineControl;
  private readonly stores: ReturnType<typeof createInMemoryJobPipelineStores>;

  constructor(private readonly deps: ScreenerWorkflowDeps) {
    this.stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const messaging = new InMemoryMessagingAdapter();
    const ports: MessagingPorts = { producer: messaging, consumer: messaging, publisher: messaging, subscriber: messaging };
    const registry = createBuiltinStepRegistry();
    this.registerCannedSteps(registry);
    this.control = new JobPipelineControl({
      stores: this.stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: ports.publisher,
      steps: registry,
      now: () => new Date(this.deps.nowMs()),
      policy: SINGLE_ATTEMPT_POLICY,
    });
  }

  /** The command this job id is running (the handlers resolve it per step). */
  private commandFor(jobId: string): WorkflowJobCommand | undefined {
    return this.instances.get(workflowIdForJob(jobId))?.command;
  }

  /** Record one trace hop for a completed step, best-effort (never throws into the run). */
  private async traceStep(
    command: WorkflowJobCommand,
    operation: string,
  ): Promise<void> {
    try {
      await this.deps.traceHop?.(command, { kind: "workflow-step", operation });
    } catch {
      // Tracing degrades; the run does not (the #1743 rule).
    }
  }

  /** This unit's shard descriptor (the command's row, or the flat list under monolith). */
  private shardFor(
    command: WorkflowJobCommand,
    ctx: JobStepContext,
  ): WorkflowJobCommand["shards"][number] {
    const row = ctx.shardKey
      ? command.shards.find((entry) => entry.shardId === ctx.shardKey)
      : undefined;
    if (row) return row;
    // Monolith: the single shard IS the unit (its descriptor
    // carries the universe the request builder reads).
    if (command.shards.length === 1) return command.shards[0];
    const flat = (ctx.params.symbols ?? []) as WorkflowJobCommand["shards"][number]["symbols"];
    return {
      shardId: ctx.shardKey ?? command.shards[0]?.shardId ?? "s0",
      ...(flat ? { symbols: flat } : {}),
    };
  }

  /**
   * The canned steps: the injected ScreenRunner's result,
   * mapped onto the stage outputs the composer reads. The
   * runner's counts drive the collation's coverage (the
   * analyze step overwrites the feed's symbol-count
   * expectedCount with the runner's), its keys ride the
   * served formats, and its store/deliver flags ride the
   * shard outcome — exactly as the retired child flow did.
   * The seven bespoke handlers serve the goal definition;
   * the four generic handlers serve the flipped market
   * definition (#5884, 6b3): feed/gather/analysis share the
   * bespoke handlers, and generate composes store + serve.
   */
  private registerCannedSteps(
    registry: ReturnType<typeof createBuiltinStepRegistry>,
  ): void {
    const feedHandler = async (ctx: JobStepContext) => {
      const command = this.commandFor(ctx.jobId);
      const table = (ctx.params.shards ?? []) as {
        shardId: string;
        universe?: string;
        symbols?: unknown[];
      }[];
      const row = ctx.shardKey
        ? table.find((entry) => entry.shardId === ctx.shardKey)
        : undefined;
      const symbols = (row?.symbols ?? ctx.params.symbols ?? []) as unknown[];
      return {
        output: {
          timestamp: ctx.now,
          userLogin: ctx.params.userLogin as string,
          // Issue #5052: mirror of the real feed step — the dispatch
          // trigger passes through the five modes, never collapsed
          // to "manual" (see screenRequestFromParams).
          trigger: normalizeJobRunTrigger(ctx.params.trigger),
          ...(row?.universe ? { universe: row.universe } : {}),
          ...(ctx.params.provider ? { provider: ctx.params.provider } : {}),
          symbols,
          expectedCount: symbols.length,
          acquired: {
            symbols: symbols.map((s) =>
              typeof s === "string" ? s : (s as { symbol: string }).symbol,
            ),
          },
          ...(command?.goalScreen
            ? {
                goalSymbols: (command.goalScreen.symbols ?? []).map((s: unknown) =>
                  typeof s === "string" ? s : (s as { symbol: string }).symbol,
                ),
              }
            : {}),
        },
      };
    };

    registry.register(SCREENER_FEED_STEP, feedHandler);
    // #5884 (6b3): the flipped market definition's feed node is
    // feed.pull — the same canned handler; the market definition
    // no longer names screener.feed.
    registry.register(FEED_PULL_STEP, feedHandler);

    const gatherHandler = async (ctx: JobStepContext) => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) return { output: prior };
      return {
        output: {
          ...prior,
          technicalsBySymbol: {},
          technicalsCoverage: null,
          persistedSentiment: null,
        },
      };
    };

    registry.register(SCREENER_GATHER_STEP, gatherHandler);
    // #5884 (6b3): the flipped market definition's enrich node
    // is enrich.screener — the same canned pass-through; the
    // market definition no longer names screener.gather.
    registry.register(ENRICH_SCREENER_STEP, gatherHandler);

    const analysisHandler = async (ctx: JobStepContext) => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) return { output: prior };
      const command = this.commandFor(ctx.jobId);
      if (!command) {
        throw new Error(
          `InMemoryWorkflowAdapter: no command for job "${ctx.jobId}" — refusing an uncommanded analysis.`,
        );
      }
      // #5873: market-only — the goal branch moved to the canned
      // goal step below, mirroring production's market-only
      // screenAnalysisStage. A goal command never reaches this
      // handler: the goal definition's analyze node is
      // screener.goal.
      const shard = this.shardFor(command, ctx);
      const result: ShardScreenResult = await this.deps.screenRunner.runScreen(
        // #4192: the ND head merges interpreted filters into
        // the command before defineJob, so the definition's
        // params carry the merged set while the stored command
        // still has the original filters — the canned step
        // reads the merged filters from ctx.params, exactly
        // as the production steps do via
        // screenRequestFromParams.
        {
          ...shardScreenRequest(shardCommandFor(command, shard)),
          ...(ctx.params.filters !== undefined
            ? { filters: ctx.params.filters as Record<string, unknown> }
            : {}),
        },
      );
      // A market failure throws at analysis: the unit fails,
      // the ledger names the cause, and the composer fails
      // the shard — there is no child to store a failed
      // screen's payload (the attempt record is the failed
      // leg row + the Failed collation).
      if (!result.success) {
        throw new Error(result.error ?? "screen failed");
      }
      await this.traceStep(command, "execute-screen");
      return {
        output: {
          ...prior,
          screenResult: {
            totalScanned: result.totalScanned,
            expectedCount: result.expectedCount,
            matchedCount: result.matchedCount,
            filterSummary: {},
          },
          expectedCount: result.expectedCount,
          allStocks: [],
          opportunities: [],
          // The canned result itself, for the store step's
          // payload (full ?? summary, exactly as the retired
          // child flow built it).
          runnerResult: result,
        },
      };
    };

    registry.register(SCREENER_ANALYSIS_STEP, analysisHandler);
    // #5884 (6b3): the flipped market definition's analyze node
    // is analyze.screener — the same canned handler (the
    // market-only runner call; the goal branch never reaches
    // it, exactly as the bespoke analysis never did).
    registry.register(ANALYZE_SCREENER_STEP, analysisHandler);

    const goalHandler = async (ctx: JobStepContext) => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) return { output: prior };
      const command = this.commandFor(ctx.jobId);
      if (!command) {
        throw new Error(
          `InMemoryWorkflowAdapter: no command for job "${ctx.jobId}" — refusing an uncommanded goal dispatch.`,
        );
      }
      // #5873: the goal branch moved out of the canned analysis
      // step into this canned goal step, mirroring production's
      // screener.goal (screenGoalStage). A goal command's analyze
      // node is screener.goal, so without this handler the
      // engine refuses the unit job_step_unknown and the fake
      // goal runner is never called.
      if (!command.goalScreen) {
        throw new Error(
          "SCREENER_GOAL_STEP_NO_GOAL: the goal step ran without a goalScreen command — refusing to run a goal dispatch with no goal command.",
        );
      }
      const runGoalScreen = this.deps.screenRunner.runGoalScreen;
      if (!runGoalScreen) {
        throw new Error(
          "Goal-screen workflow command reached a runner without runGoalScreen — refusing a market-screen fallback for a goal run (issue #1996).",
        );
      }
      const result: ShardScreenResult = await runGoalScreen(
        goalShardRequest(command),
      );
      // The goal leg returns its failed goalResult as data: the
      // unit continues to store/deliver, and the composer fails
      // the shard on the goal verdict (the real agent's
      // screenGoalStage behaves the same way).
      await this.traceStep(command, "execute-goal-screen");
      // The goal result rides the canned result's `full`
      // envelope (goalResultToShardResult) when present; else
      // the runner's success flag is the goal verdict.
      const goalFull = (
        result.full as { result?: Record<string, unknown> } | undefined
      )?.result;
      return {
        output: {
          ...prior,
          screenResult: {
            totalScanned: result.totalScanned,
            expectedCount: result.expectedCount,
            matchedCount: result.matchedCount,
            filterSummary: {},
          },
          expectedCount: result.expectedCount,
          allStocks: [],
          opportunities: [],
          // The canned result itself, for the store step's
          // payload (full ?? summary, exactly as the retired
          // child flow built it).
          runnerResult: result,
          goalResult: goalFull ?? {
            status: result.success ? "success" : "failed",
            ...(result.error ? { message: result.error } : {}),
          },
          goalExecuted: true,
        },
      };
    };

    registry.register(SCREENER_GOAL_STEP, goalHandler);
    // #6072 (6d-a): the goal definition v2's analyze node is the
    // eight-step composition (goal.quota → goal.plan →
    // goal.ledgerClaim → goal.stockLeg → goal.optionsLeg →
    // goal.assemble → goal.ledgerComplete → goal.artifacts), never
    // the single screener.goal dispatch — the adapter must can all
    // eight, or the engine refuses the run job_step_unknown. The
    // assemble step carries the canned goal handler (the fake
    // runner call, its guards, and the goal envelope), exactly as
    // screener.goal did; the other seven are pass-throughs — the
    // canned world has no quota ledger, plan, or legs to compute,
    // and the envelope the store/deliver steps read rides the
    // assemble output forward unchanged.
    const goalPassThrough = async (ctx: JobStepContext) => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) return { output: prior };
      return { output: prior };
    };
    registry.register(GOAL_QUOTA_STEP, goalPassThrough);
    registry.register(GOAL_PLAN_STEP, goalPassThrough);
    registry.register(GOAL_LEDGER_CLAIM_STEP, goalPassThrough);
    registry.register(GOAL_STOCK_LEG_STEP, goalPassThrough);
    registry.register(GOAL_OPTIONS_LEG_STEP, goalPassThrough);
    registry.register(GOAL_ASSEMBLE_STEP, goalHandler);
    registry.register(GOAL_LEDGER_COMPLETE_STEP, goalPassThrough);
    registry.register(GOAL_ARTIFACTS_STEP, goalPassThrough);

    // The store leg as a value (not a registration), so the
    // canned generate step below can compose store + serve.
    const storeOutput = async (
      ctx: JobStepContext,
    ): Promise<Record<string, unknown>> => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) return prior;
      const command = this.commandFor(ctx.jobId);
      if (!command) {
        throw new Error(
          `InMemoryWorkflowAdapter: no command for job "${ctx.jobId}" — refusing an uncommanded store.`,
        );
      }
      // The store input is the analysis output; the payload is
      // rebuilt from the canned runner result the way the
      // retired child flow built it: the `full` envelope when
      // the runner provided one, else the summary — keys
      // recorded on the summary win over a predating envelope.
      const runnerResult = (prior.runnerResult ?? {}) as Record<string, unknown>;
      const payload = {
        ...((runnerResult.full as Record<string, unknown> | undefined) ??
          runnerResult),
        ...(typeof runnerResult.pdfKey === "string"
          ? { pdfKey: runnerResult.pdfKey }
          : {}),
        ...(typeof runnerResult.xlsxKey === "string"
          ? { xlsxKey: runnerResult.xlsxKey }
          : {}),
        ...(typeof runnerResult.csvKey === "string"
          ? { csvKey: runnerResult.csvKey }
          : {}),
        trigger: command.trigger,
      };
      let stored = false;
      let reportId: string | undefined;
      let storeError: string | undefined;
      try {
        const storedId = await this.deps.storeReport(payload, command.userLogin);
        stored = true;
        if (typeof storedId === "string") reportId = storedId;
      } catch (err) {
        storeError = err instanceof Error ? err.message : String(err);
      }
      await this.traceStep(command, "store-shard");
      return {
        ...prior,
        payload,
        stored,
        ...(reportId ? { reportId } : {}),
        ...(storeError ? { storeError } : {}),
      };
    };

    registry.register(SCREENER_STORE_STEP, async (ctx: JobStepContext) => ({
      output: await storeOutput(ctx),
    }));

    // The serve leg as a value over a prior output, so the
    // canned generate step below can compose store + serve.
    const serveOutput = (prior: Record<string, unknown>) => {
      const payload = (prior.payload ?? {}) as Record<string, unknown>;
      const formats: { format: string; key: string }[] = [];
      for (const format of ["pdf", "xlsx", "csv"] as const) {
        const key = payload[`${format}Key`];
        if (typeof key === "string" && key.length > 0) {
          formats.push({ format, key });
        }
      }
      return {
        ...prior,
        servedReport: { formats },
      };
    };

    registry.register(SCREENER_SERVE_STEP, async (ctx: JobStepContext) => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) return { output: prior };
      return { output: serveOutput(prior) };
    });

    // #5884 (6b3): the flipped market definition's generate
    // node is generate.apply — the store + serve legs composed
    // into one node (the canonical report is stored and served
    // there; the deliver node reads the served output exactly
    // as it read the bespoke serve output).
    registry.register(GENERATE_APPLY_STEP, async (ctx: JobStepContext) => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) return { output: prior };
      return { output: serveOutput(await storeOutput(ctx)) };
    });

    // #5885 (6c): the flipped market definition's deliver node
    // is deliver.apply — the same canned handler (the goal spec
    // still runs the bespoke step, so both names stay registered).
    const deliverHandler = async (ctx: JobStepContext) => {
      const prior = priorFor<Record<string, unknown>>(ctx.input, ctx.shardKey);
      if (isDupOutput(prior)) {
        return { output: { ...prior, delivered: false, deliverSkipped: true } };
      }
      const command = this.commandFor(ctx.jobId);
      if (!command) {
        throw new Error(
          `InMemoryWorkflowAdapter: no command for job "${ctx.jobId}" — refusing an uncommanded deliver.`,
        );
      }
      const payload = (prior.payload ?? {}) as Record<string, unknown>;
      let delivered = false;
      let deliverError: string | undefined;
      if (ctx.params.deliver === true) {
        try {
          await this.deps.deliverOutcome(payload, command.userLogin);
          delivered = true;
        } catch (err) {
          deliverError = err instanceof Error ? err.message : String(err);
        }
        await this.traceStep(command, "deliver-shard");
      }
      return {
        output: {
          ...prior,
          delivered,
          ...(deliverError ? { deliverError } : {}),
          ...(ctx.params.deliver === true ? {} : { deliverSkipped: true }),
        },
      };
    };
    registry.register(SCREENER_DELIVER_STEP, deliverHandler);
    registry.register(DELIVER_APPLY_STEP, deliverHandler);
  }

  /** Fake step: do executes immediately (the engine owns pacing; there is no sleep loop). */
  private readonly fakeStep: ScreenerEngineStep = {
    do: async (_name, fn) => fn(),
  };

  async start(command: WorkflowJobCommand): Promise<WorkflowHandle> {
    assertWorkflowJobCommand(command);
    const workflowId = workflowIdForJob(command.jobId);
    const existing = this.instances.get(workflowId);
    if (existing) {
      return {
        workflowId,
        jobId: command.jobId,
        status: existing.status,
        existing: true,
        statusUrl: workflowStatusUrl(command.jobId),
      };
    }
    const record: InstanceRecord = {
      workflowId,
      jobId: command.jobId,
      command,
      status: "running",
    };
    this.instances.set(workflowId, record);
    try {
      // Execution is synchronous here (unlike the provider
      // adapter, where start only creates): an execution
      // failure is recorded on the instance, never thrown
      // from start — callers poll status for the outcome,
      // exactly as they do on the provider path.
      const output = await runScreenerScreenOnEngine(
        this.fakeStep,
        {
          control: this.control,
          stores: this.stores,
          shardStore: this.deps.shardStore,
          ...(this.deps.storeParentReport
            ? { storeParentReport: this.deps.storeParentReport }
            : {}),
          ...(this.deps.ndModeEnabled !== undefined
            ? { ndModeEnabled: this.deps.ndModeEnabled }
            : {}),
          ...(this.deps.intentInterpreter
            ? { intentInterpreter: this.deps.intentInterpreter }
            : {}),
          ...(this.deps.auditInterpretation
            ? { auditInterpretation: this.deps.auditInterpretation }
            : {}),
          ...(this.deps.traceHop ? { traceHop: this.deps.traceHop } : {}),
          nowMs: this.deps.nowMs,
        },
        command,
      );
      record.status = "complete";
      record.output = output;
    } catch (err) {
      record.status = "errored";
      record.error = { message: err instanceof Error ? err.message : String(err) };
    }
    return {
      workflowId,
      jobId: command.jobId,
      status: record.status,
      existing: false,
      statusUrl: workflowStatusUrl(command.jobId),
    };
  }

  async status(workflowId: string): Promise<WorkflowStatus | null> {
    const record = this.instances.get(workflowId);
    if (!record) return null;
    return { workflowId, jobId: record.jobId, status: record.status };
  }
}
