/**
 * Issue #3530 (scheduling-config slice) — the schedule route:
 *
 *   POST /data-providers/:id/feed-jobs/:jobId/schedule
 *
 * - Round-trip: patching { intervalMinutes } stores the engine's
 *   native schedule ("every 15 minutes") on the job's definition,
 *   the response's merged status view reports it, and a later list
 *   read reports it too — the stored definition is the one source.
 * - Disable/enable merge over the stored schedule: disabling keeps
 *   the interval; re-enabling restores the same cadence.
 * - Auth: without a verified session login the route refuses 401
 *   and the stored definition is untouched (the feed-job action
 *   route's session discipline, verbatim).
 * - Invalid schedules refuse typed 400 FEED_JOB_SCHEDULE_INVALID
 *   before any door call; an unknown job refuses 404.
 *
 * The door is injected through the route context over an in-memory
 * pipeline harness (the #3535 routes suite's idiom). No network.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
  type FeedPipelineDoorLike,
} from "../src/agents/routes/dataProviders";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  buildFeedJobSurfaceView,
  FEED_PIPELINE_CATALOG,
  type FeedJobSurfaceView,
} from "../src/services/feedPipelineJobs";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { ENRICH_PIPELINE_CATALOG, buildEnrichJobSurfaceView } from "../src/services/enrichPipelineJobs";
import type { JobDefinition } from "../src/data/jobPipelinePorts";
import type { Env } from "../src/types";

const ACTOR = "octocat";
const T0 = Date.parse("2026-11-08T12:00:00.000Z");
const JOB = "yahoo-nasdaq100-quotes";
const PATH = `/data-providers/yahoo/feed-jobs/${JOB}/schedule`;

async function makeHarness() {
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
  const view = async (jobId: string): Promise<FeedJobSurfaceView> => {
    const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
    return buildFeedJobSurfaceView({
      entry,
      datasetStore,
      registry,
      pipeline: await control.getJob(jobId).catch(() => null),
      nowMs: T0,
    });
  };
  const door: FeedPipelineDoorLike = {
    listFeedJobSurfaceStatuses: async () => Promise.all(FEED_PIPELINE_CATALOG.map((e) => view(e.jobId))),
    getFeedJobSurfaceStatus: view,
    listEnrichJobSurfaceStatuses: async () =>
      Promise.all(
        ENRICH_PIPELINE_CATALOG.map(async (entry) =>
          buildEnrichJobSurfaceView({
            entry,
            enrichedStore: new InMemoryEnrichedDatasetStore(),
            registry: buildEnrichJobRegistry({}),
            pipeline: null,
            nowMs: T0,
          }),
        ),
      ),
    getEnrichJobSurfaceStatus: async (jobId: string) => {
      const entry = ENRICH_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
      return buildEnrichJobSurfaceView({
        entry,
        enrichedStore: new InMemoryEnrichedDatasetStore(),
        registry: buildEnrichJobRegistry({}),
        pipeline: null,
        nowMs: T0,
      });
    },
    runPipelineJob: async (jobId: string) => {
      const dispatch = await control.runJob(jobId, { trigger: "manual" });
      const outcome = await dispatch.completion;
      return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
    },
    pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
    resumePipelineJob: async (jobId: string) => {
      const dispatch = await control.resumeJob(jobId);
      const outcome = await dispatch.completion;
      return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
    },
    cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
    retryPipelineJob: async (jobId: string) => {
      const dispatch = await control.retryJob(jobId);
      const outcome = await dispatch.completion;
      return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
    },
    configurePipelineJob: async (jobId: string, patch: unknown) => control.configureJob(jobId, patch),
  };
  return { door, stores };
}

async function makeCtx(overrides?: Partial<DataProviderRoutesContext>) {
  const { door, stores } = await makeHarness();
  const sql = new MockSqlStorage();
  seedProviderConfigs(sql);
  const auditRows: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx: DataProviderRoutesContext = {
    env: {} as Env,
    sql,
    userLogin: ACTOR,
    recordAudit: (type, _agent, payload) => {
      auditRows.push({ type, payload });
      return { id: "audit-1" };
    },
    feedPipelineDoor: door,
    ...overrides,
  };
  return { ctx, auditRows, stores };
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
  return handleDataProviderRoutes(request, url, path, "session-1", ctx) as Promise<Response>;
}

async function storedSchedule(
  stores: ReturnType<typeof createInMemoryJobPipelineStores>,
): Promise<JobDefinition["config"]["schedule"]> {
  const def = await stores.definitions.getDefinition(JOB);
  if (!def) throw new Error("expected a stored definition");
  return def.config.schedule;
}

describe("POST /data-providers/:id/feed-jobs/:jobId/schedule (#3530)", () => {
  it("round-trip: intervalMinutes stores the native schedule; the response + a later read report it", async () => {
    const { ctx, auditRows, stores } = await makeCtx();
    const res = await callRoute(ctx, "POST", PATH, { intervalMinutes: 15 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobId: string;
      schedule: { enabled: boolean; interval: string | null; cron: string | null };
      status: FeedJobSurfaceView;
    };
    expect(body.jobId).toBe(JOB);
    expect(body.schedule).toEqual({ enabled: true, interval: "every 15 minutes", cron: null });
    expect(body.status.schedule).toEqual(body.schedule);
    expect(await storedSchedule(stores)).toEqual({ enabled: true, interval: "every 15 minutes" });
    expect(auditRows.some((r) => r.type === "data_provider.feed_job_schedule")).toBe(true);

    const list = await callRoute(ctx, "GET", "/data-providers/yahoo/feed-jobs");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { jobs: FeedJobSurfaceView[] };
    const mine = listed.jobs.find((j) => j.jobId === JOB);
    expect(mine?.schedule).toEqual({ enabled: true, interval: "every 15 minutes", cron: null });
  });

  it("disable keeps the stored interval; re-enable restores the same cadence", async () => {
    const { ctx, stores } = await makeCtx();
    await callRoute(ctx, "POST", PATH, { intervalMinutes: 15 });
    const off = await callRoute(ctx, "POST", PATH, { enabled: false });
    expect(off.status).toBe(200);
    expect(await storedSchedule(stores)).toEqual({ enabled: false, interval: "every 15 minutes" });
    const on = await callRoute(ctx, "POST", PATH, { enabled: true });
    expect(on.status).toBe(200);
    expect(await storedSchedule(stores)).toEqual({ enabled: true, interval: "every 15 minutes" });
  });

  it("a cron patch stores the cron and clears the interval", async () => {
    const { ctx, stores } = await makeCtx();
    const res = await callRoute(ctx, "POST", PATH, { cron: "0 * * * *" });
    expect(res.status).toBe(200);
    expect(await storedSchedule(stores)).toEqual({ enabled: true, cron: "0 * * * *" });
  });

  it("without a verified session the route refuses 401 and the definition is untouched", async () => {
    const { ctx, stores } = await makeCtx({ userLogin: undefined });
    const before = await storedSchedule(stores);
    const res = await callRoute(ctx, "POST", PATH, { intervalMinutes: 15 });
    expect(res.status).toBe(401);
    expect(await storedSchedule(stores)).toEqual(before);
  });

  it.each([
    ["zero interval", { intervalMinutes: 0 }],
    ["negative interval", { intervalMinutes: -5 }],
    ["fractional interval", { intervalMinutes: 2.5 }],
    ["empty cron", { cron: "  " }],
    ["interval and cron together", { intervalMinutes: 15, cron: "0 * * * *" }],
    ["empty patch", {}],
    ["non-boolean enabled", { enabled: "yes" }],
  ])("invalid schedule (%s) refuses typed 400 before any door call", async (_name, patch) => {
    const { ctx, stores } = await makeCtx();
    const before = await stores.definitions.getDefinition(JOB);
    const res = await callRoute(ctx, "POST", PATH, patch);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("FEED_JOB_SCHEDULE_INVALID");
    const after = await stores.definitions.getDefinition(JOB);
    expect(after?.version).toBe(before?.version);
  });

  it("an unknown job refuses 404", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(
      ctx,
      "POST",
      "/data-providers/yahoo/feed-jobs/nope-quotes/schedule",
      { intervalMinutes: 15 },
    );
    expect(res.status).toBe(404);
  });
});
