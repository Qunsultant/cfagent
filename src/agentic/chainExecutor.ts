/**
 * Issue #1523 ([AGENTIC] Lane 2, follow-up of #1362, builds on
 * #1517) — real chain.run executor.
 *
 * This module is the typed executor seam `runChain` was designed
 * for: `createChainLegExecutor` returns an `executeLeg` function
 * that runs a validated chain leg for real, instead of reporting
 * `unimplemented`. It invents NO execution substrate and NO job
 * model — it dispatches onto the existing ones:
 *
 *  - Feed / generate / store legs run through the #1355 shard
 *    executors (`executeShardJob` in src/services/shardExecutors.ts,
 *    the same handler the async-job rails call for `shard.execute`
 *    rows), with the caller's DO/SQL runtime (sql, env, orm,
 *    storage, createETradeService, sessionId).
 *  - Serve legs submit the existing `followup.report` job through
 *    a caller-supplied submitter port (the Orchestrator's
 *    `submitAsyncJob` bound to its context). Submission is reported
 *    as `submitted`, never as `completed`: the rails execute it.
 *  - Deliver legs are NEVER submitted upfront by this executor.
 *    Deliveries are planned by the serve job's completion hook
 *    (#1123 S3) when `followup.report` completes; submitting them
 *    here would bypass serve ordering and could double-deliver.
 *    A deliver leg therefore reports `unimplemented` with that
 *    reason until the serve submission's hook has run.
 *
 * Sibling reads without job creation: the #1355 shard executors
 * read sibling results from `mas_async_jobs` via
 * `chainRowsFromSql`. The executor does NOT insert queued rows to
 * satisfy those reads — inline execution creates no jobs. Instead
 * it hands the shard runner an overlay sql: the exact chain-rows
 * SELECT returns the base rows plus the in-memory completed rows
 * for shards this executor already ran, in the raw row shape
 * `chainRowsFromSql` parses. Every other query passes through to
 * the caller's sql untouched. A caller that DOES want durable
 * shard rows (the governed firing path's Orchestrator-owned
 * caller) records them itself from the returned shard job ids —
 * this executor never writes `mas_async_jobs`.
 *
 * Stage dedup: a chain may carry two feed legs (feed-dataprovider
 * + feed-screener-pipeline) or two store legs (store-mas-reports
 * + store-r2-binaries); the stage runs once and every leg of the
 * stage reports the same shard ids. A failed leg throws, and
 * `runChain` skips later legs; a leg with no mapping throws
 * `LegNotExecutableError`, which `runChain` reports as
 * `unimplemented` with the real reason instead of failing the run.
 *
 * Capability mapping (honest limits): the #1355 substrate is a
 * screener substrate. Generate legs map only to screener
 * pdf/xlsx/csv shards; generate-options-* and
 * generate-research-pdf have no shard mapping and report
 * `unimplemented` naming that gap. Serve without a submitter
 * port reports `unimplemented` naming `followup.report` and the
 * missing port — the MCP command context is exactly that case
 * (it carries no DO/SQL runtime and no submitter), so MCP legs
 * keep reporting `unimplemented` with this seam named rather than
 * inventing execution.
 *
 * Provenance: every leg result carries the chain id, the chain
 * version the caller versioned (default 1 — the run's governed
 * snapshot, as in lane 1's blocked-firing audit), the leg
 * capability's registry version (status + verification ref, the
 * Phase 1 version shape), and the shard job ids in pipeline
 * order. Nothing here claims a leg ran that did not.
 */

import {
  CAPABILITY_REGISTRY,
  type CapabilityEntry,
} from "./capabilityRegistry";
import type { CompiledChainStep } from "../orchestrate";
import type { AsyncJobSubmission, ShardChainContext } from "../types";
import {
  assessFeedGate,
  chainRowsFromSql,
  planServeJob,
  type ShardPayload,
  type ShardRow,
} from "../services/shardJobs";
import {
  executeShardJob,
  type ShardExecutorDeps,
} from "../services/shardExecutors";
import { createAsyncJobPorts } from "../data/createAsyncJobPorts";

/** The DO/SQL runtime a production caller supplies. Same shape as
 *  `ShardExecutorDeps` — the shard executors' own dependency shape
 *  — so no adapter layer sits between this executor and them. */
export interface ChainRuntime {
  sql: {
    exec: (
      query: string,
      ...params: unknown[]
    ) => Iterable<Record<string, unknown>>;
  };
  env: Record<string, unknown>;
  orm: any;
  storage: any;
  createETradeService: (userLogin: string, environment?: string) => any;
  sessionId: string;
}

/** What a chain run executes as: the #1355 chain identity. */
export interface ChainExecutionContext {
  chainId: string;
  userLogin: string;
  universe: string;
  /** The run's governed version snapshot (default 1). */
  chainVersion?: number;
  maxItems?: number;
  trigger?: "manual" | "scheduled";
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
}

/** A leg the executor cannot run in this context, with the real
 *  reason. `runChain` maps this to `unimplemented`, not `failed`. */
export class LegNotExecutableError extends Error {
  readonly capabilityId: string;
  constructor(capabilityId: string, reason: string) {
    super(reason);
    this.name = "LegNotExecutableError";
    this.capabilityId = capabilityId;
  }
}

export function isLegNotExecutable(err: unknown): err is LegNotExecutableError {
  return (
    err instanceof LegNotExecutableError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "LegNotExecutableError")
  );
}

/** A leg handed to the async-job rails for real execution. The
 *  branded marker is what `runChain` recognizes as `submitted`. */
export interface SubmittedLeg {
  chainLegOutcome: "submitted";
  jobId: string;
  detail: string;
  submission: AsyncJobSubmission;
}

export function isSubmittedLeg(value: unknown): value is SubmittedLeg {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { chainLegOutcome?: unknown }).chainLegOutcome === "submitted"
  );
}

/** What a completed leg reports: provenance, never just "done". */
export interface ChainLegExecutionResult {
  chainId: string;
  chainVersion: number;
  capabilityVersion: {
    id: string;
    status: CapabilityEntry["status"];
    verification: string | null;
  };
  shardJobIds: string[];
  result: unknown;
}

export type ShardRunner = (
  deps: ShardExecutorDeps,
  payload: ShardPayload,
) => Promise<unknown>;

export interface ChainExecutorOptions {
  /** Defaults to the real `executeShardJob`. Tests inject a fake. */
  shardRunner?: ShardRunner;
  /**
   * Async-job submitter (the Orchestrator's `submitAsyncJob`
   * bound to its context). Absent, serve legs report
   * `unimplemented` — the executor never invents a submitter.
   */
  submitJob?: (
    spec: AsyncJobSubmission,
  ) => Promise<{ jobId: string }>;
  nowIso?: string;
}

const GENERATE_FORMAT: Record<string, "pdf" | "xlsx" | "csv"> = {
  "generate-screener-pdf": "pdf",
  "generate-screener-xlsx": "xlsx",
  "generate-screener-csv": "csv",
};

function shardJobId(chainId: string, stage: string, key: string): string {
  return `chain-exec:${chainId}:${stage}:${key}`;
}

function generateResultsFromRows(rows: ShardRow[]): Array<{
  format: string;
  key: string;
  fileName: string;
}> {
  const out: Array<{ format: string; key: string; fileName: string }> = [];
  for (const row of rows) {
    if (row.stage !== "generate" || row.status !== "completed") continue;
    const result = (row.result ?? {}) as {
      format?: unknown;
      key?: unknown;
      fileName?: unknown;
    };
    if (
      typeof result.format === "string" &&
      typeof result.key === "string"
    ) {
      out.push({
        format: result.format,
        key: result.key,
        fileName: String(result.fileName ?? ""),
      });
    }
  }
  return out;
}

/**
 * Build a leg executor for one chain run. The returned function is
 * `runChain`'s `executeLeg`: one validated step in, its real
 * result (or a `SubmittedLeg`, or a `LegNotExecutableError`) out.
 * State (stage dedup, overlay rows, provenance) lives in the
 * closure: one executor instance runs one chain, once, in order.
 */
export function createChainLegExecutor(
  runtime: ChainRuntime,
  ctx: ChainExecutionContext,
  opts: ChainExecutorOptions = {},
): (step: CompiledChainStep) => Promise<ChainLegExecutionResult | SubmittedLeg> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const chainVersion = ctx.chainVersion ?? 1;
  const shardChain: ShardChainContext = {
    chainId: ctx.chainId,
    universe: ctx.universe,
    userLogin: ctx.userLogin,
    trigger: ctx.trigger ?? "manual",
    timestamp: nowIso,
    channels: [],
    ...(ctx.maxItems !== undefined ? { maxItems: ctx.maxItems } : {}),
    ...(ctx.emailTo ? { emailTo: ctx.emailTo } : {}),
    ...(ctx.slackChannel ? { slackChannel: ctx.slackChannel } : {}),
    ...(ctx.webhookUrl ? { webhookUrl: ctx.webhookUrl } : {}),
  };
  const shardRunnerFn = opts.shardRunner ?? executeShardJob;

  // In-memory completed shard rows, in the raw DB shape
  // `chainRowsFromSql` parses. The overlay sql returns base rows
  // plus these for the chain-rows SELECT only.
  //
  // #2358 (#1976 step 4a): the base rows for the chain-rows
  // SELECT now come through the async-job READ PORT over the
  // real runtime (chainRows in src/data/asyncJobPorts.ts owns
  // the statement); the overlay still appends this run's
  // in-memory rows, which exist nowhere durable. Any other
  // statement forwards the runtime's exec unchanged — the
  // shard executors' own provider composition takes a
  // sql-shaped handle by design, and their statements live in
  // their own modules.
  const overlayRows: Array<Record<string, unknown>> = [];
  const runtimeExec = runtime.sql.exec.bind(runtime.sql);
  const overlaySql = {
    exec: (query: string, ...params: unknown[]) => {
      if (
        typeof query === "string" &&
        query.includes("FROM mas_async_jobs") &&
        query.includes("chain_id")
      ) {
        const base = createAsyncJobPorts(runtime.sql as never).read.chainRows(
          String(params[0] ?? ""),
          String(params[1] ?? ""),
        ) as unknown as Array<Record<string, unknown>>;
        return [...base, ...overlayRows];
      }
      return Array.from(runtimeExec(query, ...params) as Iterable<Record<string, unknown>>);
    },
  };
  const shardDeps: ShardExecutorDeps = {
    sql: overlaySql as any,
    env: runtime.env,
    orm: runtime.orm,
    storage: runtime.storage,
    createETradeService: runtime.createETradeService,
    sessionId: runtime.sessionId,
  };

  const provenance: string[] = [];
  let feedResult: unknown = null;
  let feedDone = false;
  let assembleResult: unknown = null;
  let assembleDone = false;
  const generateResults = new Map<string, unknown>();
  const storeResults = new Map<string, unknown>();

  function chainRows(): ShardRow[] {
    return chainRowsFromSql(overlaySql as any, ctx.chainId, runtime.sessionId);
  }

  async function runShard(
    stage: "feed" | "generate" | "store",
    key: string,
    inputs?: Record<string, unknown>,
  ): Promise<{ jobId: string; result: unknown }> {
    const jobId = shardJobId(ctx.chainId, stage, key);
    const payload: ShardPayload = {
      shard: { stage, key },
      chain: shardChain,
      ...(inputs ? { inputs } : {}),
    };
    const result = await shardRunnerFn(shardDeps, payload);
    overlayRows.push({
      job_id: jobId,
      stage,
      status: "completed",
      payload_json: JSON.stringify({ shard: { stage, key }, chain: shardChain }),
      result_json: JSON.stringify(result ?? null),
      error: null,
      created_at: nowIso,
      parent_job_id: null,
    });
    if (!provenance.includes(jobId)) provenance.push(jobId);
    return { jobId, result };
  }

  function legResult(
    step: CompiledChainStep,
    entry: CapabilityEntry,
    shardIds: string[],
    result: unknown,
  ): ChainLegExecutionResult {
    return {
      chainId: ctx.chainId,
      chainVersion,
      capabilityVersion: {
        id: entry.id,
        status: entry.status,
        verification: entry.verification,
      },
      shardJobIds: shardIds,
      result,
    };
  }

  async function runFeed(step: CompiledChainStep, entry: CapabilityEntry) {
    if (!feedDone) {
      const shards: Array<{ jobId: string; result: unknown }> = [];
      // Dependency order is a data fact (#1355): etrade needs
      // nasdaq's listings, yahoo needs etrade's quoted set — the
      // overlay makes each shard see its predecessors' rows.
      for (const key of ["nasdaq", "etrade", "yahoo"] as const) {
        shards.push(await runShard("feed", key));
      }
      feedResult = {
        shards: shards.map((s) => ({ shard: s.jobId, result: s.result })),
      };
      feedDone = true;
    }
    return legResult(step, entry, [...provenance].filter((id) =>
      id.includes(":feed:"),
    ), feedResult);
  }

  async function runGenerate(step: CompiledChainStep, entry: CapabilityEntry) {
    const format = GENERATE_FORMAT[step.capabilityId];
    if (!format) {
      throw new LegNotExecutableError(
        step.capabilityId,
        `No #1355 shard executor maps ${step.capabilityId}: the sharded substrate covers screener pdf/xlsx/csv generation only, so this leg cannot execute here.`,
      );
    }
    if (!assembleDone) {
      // Completeness gate, enforced at execution too (not only at
      // planning): a partial feed refuses assembly, naming every
      // blocker — the same gate `executeShardJob` enforces.
      const gate = assessFeedGate(chainRows(), shardChain);
      if (!gate.ready) {
        const names = gate.blockedBy
          .map((b) => `${b.shardKey} (${b.reason})`)
          .join(", ");
        throw new Error(
          `Assembly blocked by feed shard(s): ${names} — no partial report.`,
        );
      }
      const assembled = await runShard("generate", "assemble");
      assembleResult = assembled.result;
      assembleDone = true;
    }
    if (!generateResults.has(format)) {
      const generated = await runShard("generate", format);
      generateResults.set(format, generated.result);
    }
    return legResult(step, entry, [...provenance].filter((id) =>
      id.includes(":generate:"),
    ), {
      assemble: assembleResult,
      generated: generateResults.get(format),
    });
  }

  async function runStore(step: CompiledChainStep, entry: CapabilityEntry) {
    // Store reads generated artifacts from chain rows (own run's
    // overlay rows, or a prior run's durable rows) — never from
    // memory alone, so a store-only run still finds its inputs.
    const generated = generateResultsFromRows(chainRows());
    if (generated.length === 0) {
      throw new Error(
        `Store leg ${step.capabilityId} has no generated artifacts to store: no completed generate shard result for chain ${ctx.chainId}.`,
      );
    }
    const stored: unknown[] = [];
    for (const g of generated) {
      if (!storeResults.has(g.format)) {
        const s = await runShard("store", g.format, {
          format: g.format,
          key: g.key,
          fileName: g.fileName,
        });
        storeResults.set(g.format, s.result);
      }
      stored.push(storeResults.get(g.format));
    }
    return legResult(step, entry, [...provenance].filter((id) =>
      id.includes(":store:"),
    ), { stored });
  }

  async function runServe(step: CompiledChainStep, _entry: CapabilityEntry) {
    if (!opts.submitJob) {
      throw new LegNotExecutableError(
        step.capabilityId,
        `Serve executes through the followup.report async job, and no async-job submitter was supplied to this executor — the MCP command context carries neither a DO/SQL runtime nor a submitter, so this leg cannot execute here.`,
      );
    }
    const rows = chainRows();
    const assembleJobId =
      provenance.find((id) => id.includes(":generate:assemble")) ??
      `chain-exec:${ctx.chainId}:root`;
    const spec = planServeJob(shardChain, assembleJobId, rows, nowIso);
    const submitted = await opts.submitJob(spec);
    if (!submitted || typeof submitted.jobId !== "string") {
      throw new Error("Serve submission returned no job id; refusing to report it submitted.");
    }
    return {
      chainLegOutcome: "submitted" as const,
      jobId: submitted.jobId,
      detail:
        `Submitted to the async-job rails as followup.report (job ${submitted.jobId}); ` +
        "deliver follows from the serve job's completion hook (followup.deliver), not from this executor.",
      submission: spec,
    };
  }

  return async function executeLeg(
    step: CompiledChainStep,
  ): Promise<ChainLegExecutionResult | SubmittedLeg> {
    const entry = CAPABILITY_REGISTRY.find((e) => e.id === step.capabilityId);
    if (!entry) {
      throw new LegNotExecutableError(
        step.capabilityId,
        `No executor mapping for unknown capability ${step.capabilityId}: it is not in the Phase 1 registry.`,
      );
    }
    if (entry.status !== "shipped" && entry.status !== "in_flight") {
      throw new LegNotExecutableError(
        step.capabilityId,
        `Capability ${step.capabilityId} is registry status "${entry.status}": only shipped/in_flight capabilities execute.`,
      );
    }
    switch (step.stage) {
      case "feed":
        return runFeed(step, entry);
      case "generate":
        return runGenerate(step, entry);
      case "store":
        return runStore(step, entry);
      case "serve":
        return runServe(step, entry);
      case "deliver":
        throw new LegNotExecutableError(
          step.capabilityId,
          `Deliver executes through followup.deliver jobs planned by the serve job's completion hook when followup.report completes; submitting deliver upfront would bypass serve ordering, so this leg cannot execute inline here.`,
        );
      default:
        throw new LegNotExecutableError(
          step.capabilityId,
          `No executor mapping for stage "${step.stage}".`,
        );
    }
  };
}
