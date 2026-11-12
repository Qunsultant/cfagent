// @vitest-environment node
/**
 * Issue #3538 (Pipeline J5) — the generate jobs' host wiring on
 * the ScheduledAgent:
 * - the analyze → generate hand-off: a recorded analyze
 *   completion dispatches the generate job consuming it, on the
 *   host's own control plane (a run record lands — here the run
 *   refuses GENERATE_JOB_NOT_CONFIGURED BY NAME, because this
 *   host context has no AGENT_DB, so the analyzed/generated
 *   stores are unbound);
 * - the hand-off is selective: failed analyze runs, unknown
 *   jobs, feed/enrich completions (they map to stages earlier
 *   than generate), and generate jobs' own completions dispatch
 *   nothing (no cascade, no loops — the deliver stage, J6, is
 *   the generate consumer when it lands);
 * - the dispatch is best-effort: it never throws into the
 *   completion intake, whatever the host's wiring state.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  dispatchGenerateAfterAnalyzeCompletion,
  pipelineGenerateJobIds,
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

const ANALYZE_ID = "yahoo-nasdaq100-quotes-enrich-analyze";
const GENERATE_ID = `${ANALYZE_ID}-generate`;

function note(overrides: Partial<PipelineCompletionNote> = {}): PipelineCompletionNote {
  return {
    jobId: ANALYZE_ID,
    runId: "analyze-run-1",
    state: "completed",
    artifactKeys: ["analyzed-datasets/yahoo/quotes/a"],
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

describe("the analyze → generate host hand-off (#3538)", () => {
  it("the host manages the nineteen generate jobs", () => {
    expect(pipelineGenerateJobIds()).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
      "yahoo-sp100-quotes-enrich-analyze-generate",
      "yahoo-sp500-quotes-enrich-analyze-generate",
      "yahoo-dow-quotes-enrich-analyze-generate",
      "yahoo-sp400-quotes-enrich-analyze-generate",
      "yahoo-sector-energy-quotes-enrich-analyze-generate",
      "yahoo-sector-materials-quotes-enrich-analyze-generate",
      "yahoo-sector-industrials-quotes-enrich-analyze-generate",
      "yahoo-sector-consumer-discretionary-quotes-enrich-analyze-generate",
      "yahoo-sector-consumer-staples-quotes-enrich-analyze-generate",
      "yahoo-sector-health-care-quotes-enrich-analyze-generate",
      "yahoo-sector-financials-quotes-enrich-analyze-generate",
      "yahoo-sector-information-technology-quotes-enrich-analyze-generate",
      "yahoo-sector-communication-services-quotes-enrich-analyze-generate",
      "yahoo-sector-utilities-quotes-enrich-analyze-generate",
      "yahoo-sector-real-estate-quotes-enrich-analyze-generate",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate",
      "etrade-nasdaq100-quotes-enrich-analyze-generate",
      "public-nasdaq100-quotes-enrich-analyze-generate",
    ]);
  });

  it("a completed analyze run dispatches its generate job on the host plane", async () => {
    const { ctx, sql } = makeHostContext();
    await expect(dispatchGenerateAfterAnalyzeCompletion(ctx, note())).resolves.toBeUndefined();
    const records = await pollRecords(sql, GENERATE_ID);
    expect(records).toHaveLength(1);
    expect(records[0].system).toBe("job-pipeline");
    // No AGENT_DB ⇒ the generate stores are unbound and the run
    // refuses BY NAME (never a silent no-op success).
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error ?? "").toContain("GENERATE_JOB_NOT_CONFIGURED");
  });

  it("a failed analyze run dispatches nothing", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchGenerateAfterAnalyzeCompletion(ctx, note({ state: "failed" }));
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    // Give any (incorrect) dispatch a chance to land, then assert absence.
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(GENERATE_ID, 5)).toHaveLength(0);
  });

  it("a feed job's completion maps to no generate job", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchGenerateAfterAnalyzeCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes" }),
    );
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(GENERATE_ID, 5)).toHaveLength(0);
  });

  it("an enrich job's completion maps to no generate job", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchGenerateAfterAnalyzeCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes-enrich" }),
    );
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(GENERATE_ID, 5)).toHaveLength(0);
  });

  it("a generate job's own completion does not cascade", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchGenerateAfterAnalyzeCompletion(ctx, note({ jobId: GENERATE_ID }));
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(GENERATE_ID, 5)).toHaveLength(0);
  });

  it("an unknown job's completion dispatches nothing and never throws", async () => {
    const { ctx } = makeHostContext();
    await expect(
      dispatchGenerateAfterAnalyzeCompletion(ctx, note({ jobId: "no-such-job" })),
    ).resolves.toBeUndefined();
  });
});
