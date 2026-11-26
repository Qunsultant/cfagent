// @vitest-environment node
/**
 * Issue #3536 (Pipeline J3) — the enrich jobs' host wiring on
 * the ScheduledAgent:
 * - the feed → enrich hand-off: a recorded feed completion
 *   dispatches the enrich job consuming it, on the host's own
 *   control plane (a run record lands in the D1 ledger — here
 *   the run refuses ENRICH_INPUT_MISSING BY NAME, because no
 *   persisted feed dataset exists for the enrich job to read);
 * - the hand-off is selective: failed feed runs, unknown jobs,
 *   and enrich jobs' own completions dispatch nothing (no
 *   cascade, no loops);
 * - the dispatch is best-effort: it never throws into the
 *   completion intake, whatever the host's wiring state.
 *
 * Issue #6101 — the run record lands in D1 (the only run
 * ledger); the DO SqlJobRunRecordStore is deleted. The host
 * context carries AGENT_DB: the mock D1 binding, and the
 * ledger is read through D1JobRunRecordStore.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  dispatchEnrichAfterFeedCompletion,
  pipelineEnrichJobIds,
  type PipelineCompletionNote,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import type { Env } from "../src/types";

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

describe("the feed → enrich host hand-off (#3536)", () => {
  it("the host manages the nineteen enrich jobs", () => {
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
      "yahoo-sector-communication-services-quotes-enrich",
      "yahoo-sector-utilities-quotes-enrich",
      "yahoo-sector-real-estate-quotes-enrich",
      "alpaca-nasdaq100-quotes-enrich",
      "etrade-nasdaq100-quotes-enrich",
      "public-nasdaq100-quotes-enrich",
    ]);
  });

  it("a completed feed run dispatches its enrich job on the host plane", async () => {
    const { ctx, store } = makeHostContext();
    await expect(dispatchEnrichAfterFeedCompletion(ctx, note())).resolves.toBeUndefined();
    const records = await pollRecords(store, ENRICH_ID);
    expect(records).toHaveLength(1);
    expect(records[0].system).toBe("job-pipeline");
    // Issue #6101 — the enrich stores are D1-bound now (AGENT_DB
    // is the mock D1), so the run no longer refuses for unwired
    // stores: it refuses BY NAME for the missing persisted feed
    // input instead (never a silent no-op success).
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error ?? "").toContain("ENRICH_INPUT_MISSING");
  });

  it("a failed feed run dispatches nothing", async () => {
    const { ctx, store } = makeHostContext();
    await dispatchEnrichAfterFeedCompletion(ctx, note({ state: "failed" }));
    // Give any (incorrect) dispatch a chance to land, then assert absence.
    await new Promise((r) => setTimeout(r, 250));
    expect(await store.listByJob(ENRICH_ID, 5)).toHaveLength(0);
  });

  it("an enrich job's own completion does not cascade", async () => {
    const { ctx, store } = makeHostContext();
    await dispatchEnrichAfterFeedCompletion(ctx, note({ jobId: ENRICH_ID }));
    await new Promise((r) => setTimeout(r, 250));
    expect(await store.listByJob(ENRICH_ID, 5)).toHaveLength(0);
  });

  it("an unknown job's completion dispatches nothing and never throws", async () => {
    const { ctx } = makeHostContext();
    await expect(
      dispatchEnrichAfterFeedCompletion(ctx, note({ jobId: "no-such-job" })),
    ).resolves.toBeUndefined();
  });
});
