// @vitest-environment node
/**
 * Issue #3540 (Pipeline J7) — the composed chains' host wiring
 * on the ScheduledAgent:
 * - the host manages the five chains (one per quotes lineage)
 *   alongside the 27 stage jobs — 32 Think declarations (the
 *   declaration pin itself lives in feed_pipeline_host_3543);
 * - the end-to-end surface view composes over the host plane:
 *   a never-run chain answers frontier=feed with per-stage
 *   not-run states;
 * - stage addressing refuses BY NAME for unknown chains and
 *   unknown stage names (the chain surface's coded refusals);
 * - a scheduled chain firing dispatches runJob on the host
 *   plane — here the run refuses FEED_JOB_NOT_CONFIGURED BY
 *   NAME (this host context has no AGENT_DB, so the feed
 *   stage's dataset store is unbound) and the roll-up shows
 *   the halt at the feed frontier;
 * - a chain job's own completion dispatches NOTHING through
 *   the completion intake (the chain already ran its stages;
 *   it is nobody's upstream stage job).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildScheduledAgentChainSurfaceView,
  createScheduledAgentPipelineControl,
  dispatchScheduledPipelineJob,
  ensureScheduledAgentPipelineJobs,
  listPipelineCompletions,
  pipelineChainJobIds,
  pipelineChainStageNodePath,
  recordPipelineCompletion,
  type PipelineCompletionNote,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import type { SqlStorage } from "../src/orm";
import type { Env } from "../src/types";

/** The node:sqlite DO-storage double (tests/feed_pipeline_host_3543 idiom). */
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
  return { ctx, sql };
}

const CHAIN_ID = "yahoo-nasdaq100-quotes-pipeline";

async function pollRecords(
  sql: SqliteTestStorage,
  jobId: string,
): Promise<ReturnType<SqlJobRunRecordStore["listByJob"]>> {
  const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
  let records = store.listByJob(jobId, 5);
  for (let i = 0; i < 40 && records.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    records = store.listByJob(jobId, 5);
  }
  return records;
}

describe("the composed chains on the host (#3540)", () => {
  it("the host manages the five chains, one per quotes lineage", () => {
    expect(pipelineChainJobIds()).toEqual([
      "yahoo-nasdaq100-quotes-pipeline",
      "yahoo-sp100-quotes-pipeline",
      "alpaca-nasdaq100-quotes-pipeline",
      "etrade-nasdaq100-quotes-pipeline",
      "public-nasdaq100-quotes-pipeline",
    ]);
  });

  it("the surface view over the host plane answers a never-run chain", async () => {
    const { ctx } = makeHostContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const view = await buildScheduledAgentChainSurfaceView(ctx, control, CHAIN_ID);
    expect(view.jobId).toBe(CHAIN_ID);
    expect(view.pipeline?.state).toBe("idle");
    expect(view.frontier).toBe("feed");
    expect(view.stages.map((s) => s.stage)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
    ]);
    expect(view.stages.every((s) => s.status === "not-run")).toBe(true);
    expect(view.stages.find((s) => s.stage === "deliver")?.nodePath).toBe("0/0/0/0/0");
  });

  it("stage addressing resolves node paths and refuses by name", () => {
    const { ctx } = makeHostContext();
    expect(pipelineChainStageNodePath(ctx, CHAIN_ID, "feed")).toBe("");
    expect(pipelineChainStageNodePath(ctx, CHAIN_ID, "enrich")).toBe("0/0");
    expect(pipelineChainStageNodePath(ctx, CHAIN_ID, "deliver")).toBe("0/0/0/0/0");
    expect(pipelineChainStageNodePath(ctx, "alpaca-nasdaq100-quotes-pipeline", "deliver")).toBe("0/0/0/0");
    expect(() => pipelineChainStageNodePath(ctx, CHAIN_ID, "publish")).toThrow(
      /PIPELINE_CHAIN_STAGE_UNKNOWN/,
    );
    expect(() => pipelineChainStageNodePath(ctx, "nope-pipeline", "feed")).toThrow(
      /PIPELINE_CHAIN_NOT_FOUND/,
    );
  });

  it("a scheduled chain firing lands a run record and the roll-up shows the halt at feed", async () => {
    const { ctx, sql } = makeHostContext();
    const dispatch = await dispatchScheduledPipelineJob(ctx, CHAIN_ID, "");
    expect(dispatch?.jobId).toBe(CHAIN_ID);
    const records = await pollRecords(sql, CHAIN_ID);
    expect(records).toHaveLength(1);
    expect(records[0].system).toBe("job-pipeline");
    // No AGENT_DB ⇒ the feed stage's stores are unbound and the
    // chain's first stage refuses BY NAME — the chain halts at
    // its first frontier, it does not silently succeed.
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error ?? "").toContain("FEED_JOB_NOT_CONFIGURED");
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const view = await buildScheduledAgentChainSurfaceView(ctx, control, CHAIN_ID);
    expect(view.frontier).toBe("feed");
    expect(view.stages[0]?.status).toBe("failed");
    expect(view.pipeline?.lastRunStatus).toBe("failure");
  });

  it("a chain completion records through the intake and dispatches nothing", async () => {
    const { ctx, sql } = makeHostContext();
    const note: PipelineCompletionNote = {
      jobId: CHAIN_ID,
      runId: "chain-run-1",
      state: "completed",
      artifactKeys: [],
      at: "2026-11-07T12:00:00.000Z",
    };
    await expect(recordPipelineCompletion(ctx, note)).resolves.toBeUndefined();
    const recorded = await listPipelineCompletions(ctx, CHAIN_ID);
    expect(recorded).toHaveLength(1);
    // No stage job was dispatched by the chain's completion:
    // no run records for any stage job on this host.
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob("yahoo-nasdaq100-quotes-enrich", 5)).toHaveLength(0);
    expect(store.listByJob("yahoo-nasdaq100-quotes", 5)).toHaveLength(0);
  });
});
