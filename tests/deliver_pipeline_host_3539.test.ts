// @vitest-environment node
/**
 * Issue #3539 (Pipeline J6) — the deliver jobs' host wiring on
 * the ScheduledAgent:
 * - the generate → deliver hand-off: a recorded generate
 *   completion dispatches the deliver job consuming it, on the
 *   host's own control plane (a run record lands — here the
 *   run refuses DELIVER_JOB_NOT_CONFIGURED BY NAME, because
 *   this host context has no AGENT_DB, so the generated /
 *   delivery stores are unbound);
 * - the hand-off is selective: failed generate runs, unknown
 *   jobs, and feed/enrich/analyze completions (they map to
 *   stages earlier than deliver) dispatch nothing; a deliver
 *   job's own completion ALSO dispatches nothing — deliver is
 *   the END OF THE CHAIN (no cascade, no loops);
 * - the dispatch is best-effort: it never throws into the
 *   completion intake, whatever the host's wiring state.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  dispatchDeliverAfterGenerateCompletion,
  pipelineDeliverJobIds,
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

const GENERATE_ID = "yahoo-nasdaq100-quotes-enrich-analyze-generate";
const DELIVER_ID = `${GENERATE_ID}-deliver`;

function note(overrides: Partial<PipelineCompletionNote> = {}): PipelineCompletionNote {
  return {
    jobId: GENERATE_ID,
    runId: "generate-run-1",
    state: "completed",
    artifactKeys: ["generated-datasets/yahoo/quotes/a"],
    at: "2026-11-07T12:00:00.000Z",
    ...overrides,
  };
}

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

describe("the generate → deliver host hand-off (#3539)", () => {
  it("the host manages the six deliver jobs", () => {
    expect(pipelineDeliverJobIds()).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp100-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp500-quotes-enrich-analyze-generate-deliver",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "etrade-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "public-nasdaq100-quotes-enrich-analyze-generate-deliver",
    ]);
  });

  it("a completed generate run dispatches its deliver job on the host plane", async () => {
    const { ctx, sql } = makeHostContext();
    await expect(dispatchDeliverAfterGenerateCompletion(ctx, note())).resolves.toBeUndefined();
    const records = await pollRecords(sql, DELIVER_ID);
    expect(records).toHaveLength(1);
    expect(records[0].system).toBe("job-pipeline");
    // No AGENT_DB ⇒ the deliver stores are unbound and the run
    // refuses BY NAME (never a silent no-op success).
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error ?? "").toContain("DELIVER_JOB_NOT_CONFIGURED");
  });

  it("a failed generate run dispatches nothing", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(ctx, note({ state: "failed" }));
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    // Give any (incorrect) dispatch a chance to land, then assert absence.
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("a feed job's completion maps to no deliver job", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes" }),
    );
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("an enrich job's completion maps to no deliver job", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes-enrich" }),
    );
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("an analyze job's completion maps to no deliver job", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes-enrich-analyze" }),
    );
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("a deliver job's own completion does not cascade (end of chain)", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(ctx, note({ jobId: DELIVER_ID }));
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("an unknown job's completion dispatches nothing and never throws", async () => {
    const { ctx } = makeHostContext();
    await expect(
      dispatchDeliverAfterGenerateCompletion(ctx, note({ jobId: "no-such-job" })),
    ).resolves.toBeUndefined();
  });
});
