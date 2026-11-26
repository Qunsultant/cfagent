// @vitest-environment node
/**
 * Issue #3539 (Pipeline J6) — the deliver jobs' host wiring on
 * the ScheduledAgent:
 * - the generate → deliver hand-off: a recorded generate
 *   completion dispatches the deliver job consuming it, on the
 *   host's own control plane (a run record lands in the D1
 *   ledger — here the run refuses DELIVER_INPUT_MISSING BY
 *   NAME, because no persisted generated dataset exists for
 *   the deliver job);
 * - the hand-off is selective: failed generate runs, unknown
 *   jobs, and feed/enrich/analyze completions (they map to
 *   stages earlier than deliver) dispatch nothing; a deliver
 *   job's own completion ALSO dispatches nothing — deliver is
 *   the END OF THE CHAIN (no cascade, no loops);
 * - the dispatch is best-effort: it never throws into the
 *   completion intake, whatever the host's wiring state.
 */
import { describe, expect, it } from "vitest";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { DatabaseSync } from "node:sqlite";
import {
  dispatchDeliverAfterGenerateCompletion,
  pipelineDeliverJobIds,
  type PipelineCompletionNote,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
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

/** Minimal D1Database stand-in over node:sqlite (the #6101 suite's double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(stmts: { run: () => Promise<unknown> }[]) {
    return Promise.all(stmts.map((stmt) => stmt.run()));
  }
}

/** A fresh D1 ledger store over an in-memory mock binding (#6101). */
function ledgerD1() {
  const d1 = new MockD1Database();
  const store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
  return { d1, store };
}

function makeHostContext(env: Partial<Env> = {}) {
  const sql = new SqliteTestStorage();
  const { d1, store } = ledgerD1();
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
    // Issue #6101 — the host's run recorder is the D1 recorder.
    env: { AGENT_DB: d1, ...env } as Env,
    agentCtx: agentCtx as unknown as ScheduledTasksPipelineContext["agentCtx"],
  } satisfies ScheduledTasksPipelineContext;
  return { ctx, sql, d1, store };
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
  store: D1JobRunRecordStore,
  jobId: string,
): Promise<Awaited<ReturnType<D1JobRunRecordStore["listByJob"]>>> {
  let records = await store.listByJob(jobId, 5);
  for (let i = 0; i < 40 && records.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    records = await store.listByJob(jobId, 5);
  }
  return records;
}

describe("the generate → deliver host hand-off (#3539)", () => {
  it("the host manages the nineteen deliver jobs", () => {
    expect(pipelineDeliverJobIds()).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp100-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp500-quotes-enrich-analyze-generate-deliver",
      "yahoo-dow-quotes-enrich-analyze-generate-deliver",
      "yahoo-sp400-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-energy-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-materials-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-industrials-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-consumer-discretionary-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-consumer-staples-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-health-care-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-financials-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-information-technology-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-communication-services-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-utilities-quotes-enrich-analyze-generate-deliver",
      "yahoo-sector-real-estate-quotes-enrich-analyze-generate-deliver",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "etrade-nasdaq100-quotes-enrich-analyze-generate-deliver",
      "public-nasdaq100-quotes-enrich-analyze-generate-deliver",
    ]);
  });

  it("a completed generate run dispatches its deliver job on the host plane", async () => {
    const { ctx, store } = makeHostContext();
    await expect(dispatchDeliverAfterGenerateCompletion(ctx, note())).resolves.toBeUndefined();
    const records = await pollRecords(store, DELIVER_ID);
    expect(records).toHaveLength(1);
    expect(records[0].system).toBe("job-pipeline");
    // Issue #6101 — the deliver stores are D1-bound now (AGENT_DB
    // is the mock D1), so the run no longer refuses for unwired
    // stores: it refuses BY NAME for the missing persisted
    // generated input instead (never a silent no-op success).
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error ?? "").toContain("DELIVER_INPUT_MISSING");
  });

  it("a failed generate run dispatches nothing", async () => {
    const { ctx, store } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(ctx, note({ state: "failed" }));
    // Give any (incorrect) dispatch a chance to land, then assert absence.
    await new Promise((r) => setTimeout(r, 250));
    expect(await store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("a feed job's completion maps to no deliver job", async () => {
    const { ctx, store } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes" }),
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(await store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("an enrich job's completion maps to no deliver job", async () => {
    const { ctx, store } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes-enrich" }),
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(await store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("an analyze job's completion maps to no deliver job", async () => {
    const { ctx, store } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(
      ctx,
      note({ jobId: "yahoo-nasdaq100-quotes-enrich-analyze" }),
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(await store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("a deliver job's own completion does not cascade (end of chain)", async () => {
    const { ctx, store } = makeHostContext();
    await dispatchDeliverAfterGenerateCompletion(ctx, note({ jobId: DELIVER_ID }));
    await new Promise((r) => setTimeout(r, 250));
    expect(await store.listByJob(DELIVER_ID, 5)).toHaveLength(0);
  });

  it("an unknown job's completion dispatches nothing and never throws", async () => {
    const { ctx } = makeHostContext();
    await expect(
      dispatchDeliverAfterGenerateCompletion(ctx, note({ jobId: "no-such-job" })),
    ).resolves.toBeUndefined();
  });
});
