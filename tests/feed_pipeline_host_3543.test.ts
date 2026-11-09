/**
 * Issue #3543 — the pipeline's host wiring.
 *
 * The ScheduledAgent manages/controls the pipeline (decided on
 * #3543); the OrchestratorAgent is only the invoking surface.
 * This suite pins the host-side pieces:
 * - the Think scheduled-task declaration: every ensured feed job
 *   (and, since #3536, every enrich job — the declaration set is
 *   the whole plane: 7 feed + 5 enrich) with an enabled schedule
 *   becomes a task named
 *   `pipeline-job:<jobId>` whose firing dispatches runJob on the
 *   host's own control plane (a run record lands even when the
 *   run itself refuses — here the dataset store is unbound, so
 *   the firing's run fails FEED_JOB_NOT_CONFIGURED BY NAME);
 * - a host without DO SQLite declares nothing (never crashes);
 * - the workflow start path: the injected seam wins; otherwise
 *   the JOB_PIPELINE_WORKFLOW binding + AGENT_DB are required by
 *   name (job_pipeline_workflow_not_configured);
 * - the completion inbox the JOB_PIPELINE_EVENTS consumer routes
 *   into (capped, newest first, per-job filter);
 * - the queue consumer itself: terminal job events route to the
 *   host, other job.* events ack as the live stream, foreign
 *   types dead-letter, a routing failure retries — and its
 *   config is pinned against wrangler.jsonc (the #2544 rule);
 * - the jobs stage family declared for stageMessage (#3543's
 *   host step): the five stage kinds address as stages, while
 *   node-path claim addressing ("job:0") is unchanged.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  declarePipelineTasks,
  startPipelineJobWorkflow,
  recordPipelineCompletion,
  listPipelineCompletions,
  pipelineAnalyzeJobIds,
  pipelineChainJobIds,
  pipelineDeliverJobIds,
  pipelineGenerateJobIds,
  pipelineEnrichJobIds,
  pipelineJobIds,
  PIPELINE_TASK_ID_PREFIX,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import {
  createJobPipelineEventsHandler,
  extractJobPipelineCompletion,
  JOB_PIPELINE_EVENTS_CONSUMER_CONFIG,
} from "../src/messaging/jobPipelineEventsConsumer";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";
import {
  stageMessage,
  stageIdempotencyKey,
  STAGE_IDS_BY_FAMILY,
} from "../src/workflows/stageMessage";
import type { Env } from "../src/types";

/** The node:sqlite DO-storage double (tests/job_pipeline_3534 idiom). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function makeHostContext(env: Partial<Env> = {}) {
  const sql = new SqliteTestStorage();
  const kv = new Map<string, unknown>();
  const agentCtx = {
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
    },
  };
  const ctx = {
    env: env as Env,
    agentCtx: agentCtx as unknown as ScheduledTasksPipelineContext["agentCtx"],
  } satisfies ScheduledTasksPipelineContext;
  return { ctx, sql, kv };
}

function jobEvent(type: string, data: Record<string, unknown>): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `evt-${type}`,
    source: "cfagent/job-pipeline",
    type,
    time: new Date().toISOString(),
    subject: String(data.jobId ?? ""),
    data,
  };
}

// Same string-aware stripper as the #2544 pin test.
function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

describe("pipeline host wiring (#3543)", () => {
  it("declares one Think task per feed job, named pipeline-job:<jobId>", async () => {
    const { ctx } = makeHostContext();
    const tasks = await declarePipelineTasks(ctx);
    // #3536 pin update (§7): the declaration set is the whole
    // plane — pipelineJobIds() stays the feed jobs (7 at #3536,
    // 8 since #3876), and the
    // enrich jobs declare alongside them under the same prefix.
    // #3537 pin update (§7): the analyze jobs join the set too.
    // #3538 pin update (§7): the generate jobs join the set too.
    // #3539 pin update (§7): the deliver jobs join the set too.
    // #3540 pin update (§7): the composed pipeline chains join
    // the set too — one declaration per chain root (the chain's
    // stages carry no schedules of their own inside the chain).
    // #3876 pin update (S7): the S&P 500 Yahoo quotes job joins
    // the plane - every stage family gains its sp500 member.
    // #3905 pin update (§7): the Dow Yahoo quotes job joins
    // the plane - every stage family gains its dow member.
    expect(pipelineJobIds()).toHaveLength(9);
    expect(pipelineEnrichJobIds()).toHaveLength(7);
    expect(pipelineAnalyzeJobIds()).toHaveLength(7);
    expect(pipelineGenerateJobIds()).toHaveLength(7);
    expect(pipelineDeliverJobIds()).toHaveLength(7);
    expect(pipelineChainJobIds()).toHaveLength(7);
    const ids = [
      ...pipelineJobIds(),
      ...pipelineEnrichJobIds(),
      ...pipelineAnalyzeJobIds(),
      ...pipelineGenerateJobIds(),
      ...pipelineDeliverJobIds(),
      ...pipelineChainJobIds(),
    ];
    expect(Object.keys(tasks).sort()).toEqual(
      ids.map((id) => `${PIPELINE_TASK_ID_PREFIX}${id}`).sort(),
    );
    for (const id of ids) {
      const task = tasks[`${PIPELINE_TASK_ID_PREFIX}${id}`];
      expect(task.schedule).toBe("every 60 minutes");
      expect(typeof task.handler).toBe("function");
    }
  });

  it("a firing dispatches runJob on the host plane — a run record lands", async () => {
    const { ctx, sql } = makeHostContext();
    const tasks = await declarePipelineTasks(ctx);
    await tasks[`${PIPELINE_TASK_ID_PREFIX}yahoo-nasdaq100-quotes`].handler({} as never);
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    let records = store.listByJob("yahoo-nasdaq100-quotes", 5);
    for (let i = 0; i < 40 && records.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      records = store.listByJob("yahoo-nasdaq100-quotes", 5);
    }
    expect(records).toHaveLength(1);
    expect(records[0].system).toBe("job-pipeline");
    // No AGENT_DB in this host context ⇒ the dataset store is
    // unbound and the run refuses BY NAME (never a silent fetch).
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error ?? "").toContain("FEED_JOB_NOT_CONFIGURED");
  });

  it("a host without DO SQLite declares nothing and does not throw", async () => {
    const ctx = {
      env: {} as Env,
      agentCtx: { storage: {} } as unknown as ScheduledTasksPipelineContext["agentCtx"],
    } satisfies ScheduledTasksPipelineContext;
    await expect(declarePipelineTasks(ctx)).resolves.toEqual({});
  });

  it("the workflow start path prefers the injected seam", async () => {
    const { ctx } = makeHostContext();
    const calls: Array<{ jobId: string; trigger: string }> = [];
    const seamCtx: ScheduledTasksPipelineContext = {
      ...ctx,
      startWorkflow: async (jobId, opts) => {
        calls.push({ jobId, trigger: opts.trigger });
        return { instanceId: "wf-seam-1" };
      },
    };
    await expect(
      startPipelineJobWorkflow(seamCtx, "yahoo-nasdaq100-quotes", { trigger: "manual" }),
    ).resolves.toEqual({ instanceId: "wf-seam-1" });
    expect(calls).toEqual([{ jobId: "yahoo-nasdaq100-quotes", trigger: "manual" }]);
  });

  it("the workflow start path refuses BY NAME without binding or AGENT_DB", async () => {
    const { ctx } = makeHostContext();
    await expect(
      startPipelineJobWorkflow(ctx, "yahoo-nasdaq100-quotes", { trigger: "manual" }),
    ).rejects.toThrow(/job_pipeline_workflow_not_configured/);
    const withBinding = makeHostContext({
      JOB_PIPELINE_WORKFLOW: {
        create: async () => ({ id: "wf-1" }),
      } as unknown as Env["JOB_PIPELINE_WORKFLOW"],
    });
    await expect(
      startPipelineJobWorkflow(withBinding.ctx, "yahoo-nasdaq100-quotes", { trigger: "manual" }),
    ).rejects.toThrow(/job_pipeline_workflow_not_configured/);
  });

  it("the completion inbox round-trips, filters per job, and caps", async () => {
    const { ctx } = makeHostContext();
    await recordPipelineCompletion(ctx, {
      jobId: "yahoo-nasdaq100-quotes",
      runId: "run-1",
      state: "completed",
      artifactKeys: ["feed-datasets/yahoo/quotes/a"],
      at: "2026-11-06T12:00:00.000Z",
    });
    await recordPipelineCompletion(ctx, {
      jobId: "alpaca-nasdaq100-quotes",
      runId: "run-2",
      state: "failed",
      artifactKeys: [],
      at: "2026-11-06T12:01:00.000Z",
    });
    const all = await listPipelineCompletions(ctx);
    expect(all.map((n) => n.runId)).toEqual(["run-2", "run-1"]);
    const yahooOnly = await listPipelineCompletions(ctx, "yahoo-nasdaq100-quotes");
    expect(yahooOnly.map((n) => n.runId)).toEqual(["run-1"]);
    for (let i = 0; i < 105; i++) {
      await recordPipelineCompletion(ctx, {
        jobId: "yahoo-nasdaq100-quotes",
        runId: `run-x${i}`,
        state: "completed",
        artifactKeys: [],
        at: "2026-11-06T12:02:00.000Z",
      });
    }
    expect(await listPipelineCompletions(ctx)).toHaveLength(100);
  });

  it("extractJobPipelineCompletion reads terminal events only", () => {
    expect(
      extractJobPipelineCompletion(
        jobEvent("job.completed", {
          jobId: "yahoo-nasdaq100-quotes",
          runId: "run-9",
          state: "completed",
          artifactKeys: ["k"],
        }),
      ),
    ).toEqual({
      jobId: "yahoo-nasdaq100-quotes",
      runId: "run-9",
      state: "completed",
      artifactKeys: ["k"],
      at: expect.any(String),
    });
    expect(
      extractJobPipelineCompletion(
        jobEvent("job.running", { jobId: "j", runId: "r", state: "running" }),
      ),
    ).toBeNull();
  });

  it("the consumer routes completions, acks the stream, dead-letters foreign types, retries route failures", async () => {
    const routed: Array<{ jobId: string; runId: string }> = [];
    const dead: unknown[] = [];
    const handler = createJobPipelineEventsHandler({
      routeCompletion: async (note) => {
        routed.push(note);
      },
      onDeadLetter: {
        record: async (record: unknown) => {
          dead.push(record);
        },
      },
    });
    await expect(
      handler(jobEvent("job.completed", { jobId: "j1", runId: "r1", state: "completed", artifactKeys: [] })),
    ).resolves.toBe("processed");
    expect(routed).toHaveLength(1);
    await expect(
      handler(jobEvent("job.running", { jobId: "j1", runId: "r1", state: "running" })),
    ).resolves.toBe("processed");
    expect(routed).toHaveLength(1);
    await expect(handler(jobEvent("screener.completed", { jobId: "x" }))).resolves.toBe("drop");
    expect(dead).toHaveLength(1);

    const failing = createJobPipelineEventsHandler({
      routeCompletion: async () => {
        throw new Error("host unreachable");
      },
    });
    await expect(
      failing(jobEvent("job.failed", { jobId: "j1", runId: "r2", state: "failed", artifactKeys: [] })),
    ).resolves.toBe("retry");
  });

  it("the consumer config is pinned against wrangler.jsonc (#2544 rule)", () => {
    const cfg = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
      queues: {
        producers?: Array<{ binding: string; queue: string }>;
        consumers?: Array<Record<string, unknown>>;
      };
    };
    const consumer = cfg.queues.consumers?.find((c) => c.queue === "job-pipeline-events");
    expect(consumer).toBeDefined();
    expect(consumer!.max_batch_size).toBe(JOB_PIPELINE_EVENTS_CONSUMER_CONFIG.maxBatchSize);
    expect(consumer!.max_batch_timeout).toBe(JOB_PIPELINE_EVENTS_CONSUMER_CONFIG.maxBatchTimeoutSeconds);
    expect(consumer!.max_retries).toBe(JOB_PIPELINE_EVENTS_CONSUMER_CONFIG.maxRetries);
    expect(consumer!.max_concurrency).toBe(JOB_PIPELINE_EVENTS_CONSUMER_CONFIG.maxConcurrency);
    expect(consumer!.dead_letter_queue).toBe(JOB_PIPELINE_EVENTS_CONSUMER_CONFIG.deadLetterQueue);
    expect(
      cfg.queues.producers?.some(
        (p) => p.binding === "JOB_PIPELINE_EVENTS_DLQ" && p.queue === "job-pipeline-events-dlq",
      ),
    ).toBe(true);
  });

  it("stageMessage addresses the jobs family kinds; node-path claims are unchanged", () => {
    expect(STAGE_IDS_BY_FAMILY.jobs).toEqual(["feed", "enrich", "analyze", "generate", "deliver"]);
    const msg = stageMessage({
      runId: "run-1",
      family: "jobs",
      stageId: "feed",
      artifactKeys: ["feed-datasets/yahoo/quotes/a"],
      userLogin: "owner",
    });
    expect(msg.idempotencyKey).toBe("run-1::jobs::feed");
    expect(() =>
      stageMessage({
        runId: "run-1",
        family: "jobs",
        stageId: "job:0",
        artifactKeys: ["k"],
        userLogin: "owner",
      }),
    ).toThrow();
    // The pipeline's own claim addressing (job node paths) keeps
    // its shape — the family declaration did not move it.
    expect(stageIdempotencyKey("run-1", "job:0", "jobs")).toBe("run-1::jobs::job:0");
  });
});
