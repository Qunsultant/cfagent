// @vitest-environment node
/**
 * Issue #4002 — the pipeline host's half of the orphan recovery,
 * at the ScheduledAgent host wiring level (DO SQLite, the real
 * host control): settleOrphanedPipelineRuns ensures the job
 * definitions, then settles every `running` instance as failed
 * with a named orphan error, so the job is dispatchable again.
 * The engine-level settle is pinned in
 * tests/pipeline_orphan_settle_4002.test.ts; this file pins that
 * the host function reaches it through the host's own stores and
 * control, with an idle instance untouched.
 *
 * Harness mirrors tests/analyze_pipeline_host_3537.test.ts: the
 * node:sqlite DO-storage double + the host context.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createScheduledAgentPipelineControl,
  settleOrphanedPipelineRuns,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import { createJobPipelineStoresFromSql } from "../src/data/createJobPipelinePorts";
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

const DUMMY = {
  jobId: "dummy",
  name: "Dummy two-step job",
  root: {
    kind: "dummy",
    steps: [{ step: "record", params: { n: 1 } }, { step: "record", params: { n: 2 } }],
    executionMode: { delivery: "sync" },
  },
};

describe("settleOrphanedPipelineRuns on the host (#4002)", () => {
  it("settles a running instance as failed and the job dispatches again", async () => {
    const { ctx, sql } = makeHostContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await control.defineJob(DUMMY);
    const stores = createJobPipelineStoresFromSql(sql as unknown as SqlStorage);
    const instance = await stores.instances.getInstance("dummy");
    if (!instance) throw new Error("no dummy instance");
    await stores.instances.saveInstance({
      ...instance,
      state: "running",
      currentRunId: "run-orphan",
      runStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      runTrigger: "manual",
    });

    const result = await settleOrphanedPipelineRuns(ctx);
    expect(result).toEqual({ settled: ["dummy"] });

    const settled = await stores.instances.getInstance("dummy");
    expect(settled?.state).toBe("failed");
    expect(settled?.lastError).toContain("Orphaned by a host restart");

    const dispatch = await control.runJob("dummy");
    expect(dispatch.state).toBe("completed");
  });

  it("leaves an idle instance untouched", async () => {
    const { ctx } = makeHostContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await control.defineJob(DUMMY);

    const result = await settleOrphanedPipelineRuns(ctx);
    expect(result).toEqual({ settled: [] });
  });
});
