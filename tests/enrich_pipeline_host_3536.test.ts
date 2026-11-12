// @vitest-environment node
/**
 * Issue #3536 (Pipeline J3) — the enrich jobs' host wiring on
 * the ScheduledAgent:
 * - the feed → enrich hand-off: a recorded feed completion
 *   dispatches the enrich job consuming it, on the host's own
 *   control plane (a run record lands — here the run refuses
 *   ENRICH_JOB_NOT_CONFIGURED BY NAME, because this host context
 *   has no AGENT_DB, so the dataset/enriched stores are unbound);
 * - the hand-off is selective: failed feed runs, unknown jobs,
 *   and enrich jobs' own completions dispatch nothing (no
 *   cascade, no loops);
 * - the dispatch is best-effort: it never throws into the
 *   completion intake, whatever the host's wiring state.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  dispatchEnrichAfterFeedCompletion,
  pipelineEnrichJobIds,
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

const ENRICH_ID = "yahoo-nasdaq100-quotes-enrich";

function note(overrides: Partial<PipelineCompletionNote> = {}): PipelineCompletionNote {
  return {
    jobId: "yahoo-nasdaq100-quotes",
    runId: "feed-run-1",
    state: "completed",
    artifactKeys: ["feed-datasets/yahoo/quotes/a"],
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

describe("the feed → enrich host hand-off (#3536)", () => {
  it("the host manages the sixteen enrich jobs", () => {
    expect(pipelineEnrichJobIds()).toEqual([
      "yahoo-nasdaq100-quotes-enrich",
      "yahoo-sp100-quotes-enrich",
      "yahoo-sp500-quotes-enrich",
      "yahoo-dow-quotes-enrich",
      "yahoo-sp400-quotes-enrich",
      "yahoo-sector-energy-quotes-enrich",
      "yahoo-sector-materials-quotes-enrich",
      "yahoo-sector-industrials-quotes-enrich",
      "yahoo-sector-consumer-discretionary-quotes-enrich",
      "yahoo-sector-consumer-staples-quotes-enrich",
      "yahoo-sector-health-care-quotes-enrich",
      "yahoo-sector-financials-quotes-enrich",
      "yahoo-sector-information-technology-quotes-enrich",
      "alpaca-nasdaq100-quotes-enrich",
      "etrade-nasdaq100-quotes-enrich",
      "public-nasdaq100-quotes-enrich",
    ]);
  });

  it("a completed feed run dispatches its enrich job on the host plane", async () => {
    const { ctx, sql } = makeHostContext();
    await expect(dispatchEnrichAfterFeedCompletion(ctx, note())).resolves.toBeUndefined();
    const records = await pollRecords(sql, ENRICH_ID);
    expect(records).toHaveLength(1);
    expect(records[0].system).toBe("job-pipeline");
    // No AGENT_DB ⇒ the enrich stores are unbound and the run
    // refuses BY NAME (never a silent no-op success).
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error ?? "").toContain("ENRICH_JOB_NOT_CONFIGURED");
  });

  it("a failed feed run dispatches nothing", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchEnrichAfterFeedCompletion(ctx, note({ state: "failed" }));
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    // Give any (incorrect) dispatch a chance to land, then assert absence.
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(ENRICH_ID, 5)).toHaveLength(0);
  });

  it("an enrich job's own completion does not cascade", async () => {
    const { ctx, sql } = makeHostContext();
    await dispatchEnrichAfterFeedCompletion(ctx, note({ jobId: ENRICH_ID }));
    const store = new SqlJobRunRecordStore(sql as unknown as SqlStorage);
    await new Promise((r) => setTimeout(r, 250));
    expect(store.listByJob(ENRICH_ID, 5)).toHaveLength(0);
  });

  it("an unknown job's completion dispatches nothing and never throws", async () => {
    const { ctx } = makeHostContext();
    await expect(
      dispatchEnrichAfterFeedCompletion(ctx, note({ jobId: "no-such-job" })),
    ).resolves.toBeUndefined();
  });
});
