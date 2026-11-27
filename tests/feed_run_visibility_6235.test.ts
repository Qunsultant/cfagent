// @vitest-environment node
/**
 * Issue #6235 — an accepted feed run must settle with a visible
 * terminal record, or refuse by name before dispatch.
 *
 * Pins:
 * - the ScheduledAgent pipeline host records terminal runs in D1
 *   when AGENT_DB is bound (the ledger reads D1 only, #6103), so a
 *   settled host run is visible without a projection carrier;
 * - a paused feed job refuses dispatch by name
 *   (`job_already_running`, naming the paused state);
 * - a feed run that pauses after dispatch is named as paused, not
 *   reported as a generic settled refusal;
 * - the feed-job surface carries the pipeline run's terminal
 *   error/detail when no dataset artifact was stored.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockSqlStorage } from "./mock-sql";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
  type FeedPipelineDoorLike,
} from "../src/agents/routes/dataProviders";
import {
  createScheduledAgentPipelineControl,
  ensureScheduledAgentPipelineJobs,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import {
  FEED_PIPELINE_CATALOG,
  buildFeedJobSurfaceView,
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
} from "../src/services/feedPipelineJobs";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-26T00:21:00.000Z");
const YAHOO_JOB = "yahoo-nasdaq100-quotes";

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

/** Minimal D1Database stand-in over node:sqlite (the #4116 suite's double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as never[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as never[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as never[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as never[]))
              .map((row: Record<string, unknown>) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results: unknown[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

function makeHostContext(env: Partial<Env>) {
  const sql = new SqliteTestStorage();
  const kv = new Map<string, unknown>();
  const ctx = {
    env: env as Env,
    agentCtx: {
      storage: {
        sql,
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
      },
    } as unknown as ScheduledTasksPipelineContext["agentCtx"],
  } satisfies ScheduledTasksPipelineContext;
  return { ctx, sql };
}

async function makeRouteHarness() {
  const datasetStore = new InMemoryFeedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  const registry = buildFeedJobRegistry({});
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    steps: createFeedStepRegistry({
      registry,
      providerFor: () => undefined,
      universeStore,
      datasetStore,
    }),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  const door = {
    listFeedJobSurfaceStatuses: async () =>
      Promise.all(
        FEED_PIPELINE_CATALOG.map(async (entry) =>
          buildFeedJobSurfaceView({
            entry,
            datasetStore,
            registry,
            pipeline: await control.getJob(entry.jobId).catch(() => null),
            nowMs: T0,
          }),
        ),
      ),
    getFeedJobSurfaceStatus: async (jobId: string) => {
      const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildFeedJobSurfaceView({
        entry,
        datasetStore,
        registry,
        pipeline: await control.getJob(entry.jobId).catch(() => null),
        nowMs: T0,
      });
    },
    runPipelineJob: async (jobId: string) => {
      const dispatch = await control.runJob(jobId, { trigger: "manual" });
      const outcome = await dispatch.completion;
      return {
        jobId,
        runId: dispatch.runId,
        state: outcome.state,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    },
  } as unknown as FeedPipelineDoorLike;
  const sql = new MockSqlStorage();
  seedProviderConfigs(sql);
  const ctx: DataProviderRoutesContext = {
    env: {} as Env,
    sql,
    userLogin: "octocat",
    recordAudit: () => ({ id: "audit-1" }),
    feedPipelineDoor: door,
    feedDatasetStore: datasetStore,
  };
  return { ctx, control, stores, datasetStore };
}

function callRoute(
  ctx: DataProviderRoutesContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`https://agent.internal${path}`);
  const request = new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleDataProviderRoutes(
    request,
    url,
    url.pathname,
    "session-1",
    ctx,
  ) as Promise<Response>;
}

describe("feed run visibility (#6235)", () => {
  it("the ScheduledAgent host records a settled feed run in D1 when AGENT_DB is bound", async () => {
    const d1 = new MockD1Database();
    const { ctx, sql } = makeHostContext({ AGENT_DB: d1 as unknown as Env["AGENT_DB"] });
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);

    // The E*TRADE job refuses by name on this host (no acting login
    // to wire its per-login provider) — a settled terminal run with
    // no dataset artifact, exactly the visibility shape at issue.
    const dispatch = await control.runJob("etrade-nasdaq100-quotes", {
      trigger: "manual",
    });
    const outcome = await dispatch.completion;
    expect(outcome.state).toBe("failed");

    const d1Store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as never));
    const d1Records = await d1Store.listByJob("etrade-nasdaq100-quotes", 5);
    expect(d1Records).toHaveLength(1);
    expect(d1Records[0].workflowId).toBe(dispatch.runId);
    expect(d1Records[0].outcome).toBe("failure");
    expect(d1Records[0].error ?? "").toContain("FEED_JOB_NOT_CONFIGURED");

    // Direct D1 recording, not a DO copy waiting on a carrier.
    // #6101 — the DO run-record adapter is retired (frozen stub, no
    // exports), so there is no DO store to query. The host must hold
    // no DO copy: the DO table is absent from this host's storage,
    // or empty if anything ever creates it.
    const doTables = sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_run_records'",
    ) as Array<{ name: string }>;
    const doRowCount =
      doTables.length === 0
        ? 0
        : (
            sql.exec("SELECT COUNT(*) AS n FROM job_run_records") as Array<{
              n: number;
            }>
          )[0]?.n ?? -1;
    expect(doRowCount).toBe(0);

    const view = await control.getJob("etrade-nasdaq100-quotes");
    expect(view.latestRun?.workflowId).toBe(dispatch.runId);
  });

  it("a paused feed job refuses dispatch by name", async () => {
    const { ctx, stores } = await makeRouteHarness();
    const instance = await stores.instances.getInstance(YAHOO_JOB);
    await stores.instances.saveInstance({
      ...instance!,
      state: "paused",
      currentRunId: "run-paused-6235",
      runStartedAt: new Date(T0).toISOString(),
    });

    const res = await callRoute(
      ctx,
      "POST",
      `/data-providers/yahoo/feed-jobs/${YAHOO_JOB}/run`,
      {},
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("job_already_running");
    expect(body.error ?? "").toContain("paused");
  });

  it("a feed run that pauses after dispatch is named as paused", async () => {
    const { ctx } = await makeRouteHarness();
    const pausedDoor = {
      runPipelineJob: async (jobId: string) => ({
        jobId,
        runId: "run-paused-after-dispatch",
        state: "paused",
      }),
    } as unknown as FeedPipelineDoorLike;

    const res = await callRoute(
      { ...ctx, feedPipelineDoor: pausedDoor },
      "POST",
      "/data-providers/yahoo/feed-run",
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("job_already_running");
    expect(body.error ?? "").toContain("paused");
    expect(body.error ?? "").not.toContain("settled as");
  });

  it("the feed-job surface carries the pipeline terminal error when no artifact was stored", async () => {
    const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === YAHOO_JOB)!;
    const view = await buildFeedJobSurfaceView({
      entry,
      datasetStore: null,
      registry: buildFeedJobRegistry({}),
      pipeline: {
        definition: {
          config: { schedule: { enabled: false } },
        },
        instance: {
          state: "cancelled",
          currentRunId: "run-cancelled-6235",
          runStartedAt: new Date(T0).toISOString(),
          lastError: null,
        },
        latestRun: {
          outcome: "skipped",
          started: new Date(T0).toISOString(),
          finished: new Date(T0 + 1000).toISOString(),
          detail: "job_cancelled",
        },
        stages: [],
      } as never,
      nowMs: T0,
    });
    expect(view.pipeline?.lastRunStatus).toBe("skipped");
    expect((view.pipeline as { lastError?: string | null } | null)?.lastError).toBe(
      "job_cancelled",
    );
  });
});
