// @vitest-environment node
/**
 * Issue #3530 (scheduling-config slice) — a feed job's schedule is
 * operator configuration, not a re-derivable default:
 *
 * - Ensure preservation: `ensureFeedPipelineJobs` re-defines a job
 *   whose stored raw config drifts from the env-built definition —
 *   but the STORED schedule (enabled + interval/cron) must survive
 *   that re-definition while every other field converges to the
 *   built definition. Without this, any schedule edit is silently
 *   reverted by the next door call (ensure runs on every door call).
 * - The preservation is generic across the pipeline families (the
 *   ensures are one idiom): a spot pin through the enrich ensure.
 * - Re-declaration: after a configure + ensure cycle, the schedule
 *   the host registers is the CONFIGURED one — the Think task
 *   declarations derive from stored definitions, so the configured
 *   schedule is what actually fires.
 * - Door: `configureFeedJobScheduleViaDoor` resolves a surface name
 *   through the feed catalog, calls the host's configure RPC, and
 *   returns the stored schedule + the merged status view; a missing
 *   acting login refuses before any door call.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobScheduleHost,
} from "../src/services/jobPipelineEngine";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import {
  FEED_PIPELINE_CATALOG,
  buildFeedJobSurfaceView,
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
} from "../src/services/feedPipelineJobs";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import {
  ENRICH_PIPELINE_CATALOG,
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
} from "../src/services/enrichPipelineJobs";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import {
  configureFeedJobScheduleViaDoor,
  type ScheduledAgentDoorStub,
} from "../src/agents/orchestrator/meshDoors";
import type { JobDefinition } from "../src/data/jobPipelinePorts";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-08T12:00:00.000Z");
const JOB = "yahoo-nasdaq100-quotes";
const ENV15 = { FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "15" };

function makeControl(stores = createInMemoryJobPipelineStores()) {
  return new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: createFeedStepRegistry({
      registry: buildFeedJobRegistry({}),
      providerFor: () => undefined,
      universeStore: null,
      datasetStore: null,
    }),
    now: () => new Date(T0),
  });
}

async function storedDefinition(
  stores: ReturnType<typeof createInMemoryJobPipelineStores>,
  jobId: string,
): Promise<JobDefinition> {
  const def = await stores.definitions.getDefinition(jobId);
  if (!def) throw new Error(`expected a stored definition for ${jobId}`);
  return def;
}

/** Plant non-schedule drift on a stored definition (as if an older
 *  code version had written it): the stored name is stale, in both
 *  the record and its raw config, so ensure must re-define. */
async function plantStaleName(
  stores: ReturnType<typeof createInMemoryJobPipelineStores>,
  jobId: string,
): Promise<JobDefinition> {
  const def = await storedDefinition(stores, jobId);
  const stale: JobDefinition = {
    ...def,
    name: "Feed — STALE NAME",
    rawConfig: { ...(def.rawConfig as Record<string, unknown>), name: "Feed — STALE NAME" },
  };
  await stores.definitions.saveDefinition(stale);
  return stale;
}

describe("ensure preserves the stored schedule (#3530 scheduling-config)", () => {
  it("a configured interval survives an ensure cycle whose built definition drifted; other fields converge", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, {});
    const v1 = await storedDefinition(stores, JOB);
    expect(v1.config.schedule).toEqual({ enabled: true, interval: "every 43200 minutes" });

    // The operator configures a 15-minute cadence through the engine.
    await control.configureJob(JOB, { root: { schedule: { enabled: true, interval: "every 15 minutes" } } });
    const v2 = await storedDefinition(stores, JOB);
    expect(v2.config.schedule.interval).toBe("every 15 minutes");

    // Non-schedule drift (a stale name, as an older build would have
    // written it) forces a re-definition: the name must converge to
    // the built definition, the configured schedule must not move.
    const planted = await plantStaleName(stores, JOB);
    await ensureFeedPipelineJobs(control, stores, {});
    const v3 = await storedDefinition(stores, JOB);
    expect(v3.name).toBe(v1.name);
    expect(v3.config.schedule).toEqual({ enabled: true, interval: "every 15 minutes" });
    expect(v3.version).toBe(planted.version + 1);
  });

  it("a disabled schedule survives ensure; the rest of the definition still converges", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, {});
    await control.configureJob(JOB, { root: { schedule: { enabled: false, interval: "every 15 minutes" } } });
    const builtName = (await storedDefinition(stores, JOB)).name;
    const planted = await plantStaleName(stores, JOB);
    await ensureFeedPipelineJobs(control, stores, {});
    const after = await storedDefinition(stores, JOB);
    expect(after.name).toBe(builtName);
    expect(after.config.schedule).toEqual({ enabled: false, interval: "every 15 minutes" });
    expect(after.version).toBe(planted.version + 1);
  });

  it("first definition still uses the env-built schedule; a no-drift ensure does not churn", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, ENV15);
    const v1 = await storedDefinition(stores, JOB);
    expect(v1.config.schedule.interval).toBe("every 15 minutes");
    await ensureFeedPipelineJobs(control, stores, ENV15);
    const v2 = await storedDefinition(stores, JOB);
    expect(v2.version).toBe(v1.version);
  });

  it("the preservation is generic: an enrich job's configured schedule survives its ensure too", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createPipelineStepRegistry(
        {
          registry: buildFeedJobRegistry({}),
          providerFor: () => undefined,
          universeStore: null,
          datasetStore: null,
        },
        {
          registry: buildEnrichJobRegistry({}),
          datasetStore: null,
          enrichedStore: new InMemoryEnrichedDatasetStore(),
        },
      ),
      now: () => new Date(T0),
    });
    await ensureEnrichPipelineJobs(control, stores, {});
    const entry = ENRICH_PIPELINE_CATALOG[0]!;
    await control.configureJob(entry.jobId, {
      root: { schedule: { enabled: true, interval: "every 45 minutes" } },
    });
    const planted = await plantStaleName(stores, entry.jobId);
    await ensureEnrichPipelineJobs(control, stores, {});
    const after = await storedDefinition(stores, entry.jobId);
    expect(after.config.schedule.interval).toBe("every 45 minutes");
    expect(after.name).not.toBe("Feed — STALE NAME");
    expect(after.version).toBe(planted.version + 1);
  });

  it("re-declaration registers the CONFIGURED schedule, not the env-built one", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, {});
    // Configure 25 minutes, then run an ensure cycle whose env builds
    // 15 (ENV15) — without preservation the ensure would revert the
    // stored schedule to the env's 15 and registration would fire 15.
    await control.configureJob(JOB, { root: { schedule: { enabled: true, interval: "every 25 minutes" } } });
    await ensureFeedPipelineJobs(control, stores, ENV15);
    const specs: Array<{ jobId: string; interval?: string; cron?: string }> = [];
    const host: JobScheduleHost = {
      schedule: async (spec) => {
        specs.push(spec);
        return `reg:${spec.jobId}`;
      },
    };
    await control.registerSchedules(host);
    const mine = specs.filter((s) => s.jobId === JOB);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.interval).toBe("every 25 minutes");
  });
});

describe("configureFeedJobScheduleViaDoor (#3530 scheduling-config)", () => {
  function fakeDoorEnv(control: JobPipelineControl, stores: ReturnType<typeof createInMemoryJobPipelineStores>) {
    const stub = {
      configurePipelineJob: async (jobId: string, patch: unknown) => control.configureJob(jobId, patch),
      getFeedJobSurfaceStatus: async (jobId: string) => {
        const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
        return buildFeedJobSurfaceView({
          entry,
          datasetStore: new InMemoryFeedDatasetStore(),
          registry: buildFeedJobRegistry({}),
          pipeline: await control.getJob(jobId).catch(() => null),
          nowMs: T0,
        });
      },
    } as unknown as ScheduledAgentDoorStub;
    void stores;
    const env = {
      SCHEDULED_AGENT: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
    } as unknown as Env;
    return env;
  }

  it("resolves the surface name, merges over the stored schedule, and returns the new schedule + status", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, {});
    const env = fakeDoorEnv(control, stores);
    const result = await configureFeedJobScheduleViaDoor(env, "octocat", "yahoo", {
      interval: "every 20 minutes",
    });
    expect(result.jobId).toBe(JOB);
    expect(result.schedule).toEqual({ enabled: true, interval: "every 20 minutes", cron: null });
    expect(result.status.schedule).toEqual(result.schedule);
    const stored = await storedDefinition(stores, JOB);
    expect(stored.config.schedule.interval).toBe("every 20 minutes");

    // A disable patch keeps the stored interval (merge, not replace).
    const disabled = await configureFeedJobScheduleViaDoor(env, "octocat", "yahoo", { enabled: false });
    expect(disabled.schedule).toEqual({ enabled: false, interval: "every 20 minutes", cron: null });
  });

  it("refuses without an acting login, before any door call", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, {});
    const env = fakeDoorEnv(control, stores);
    await expect(
      configureFeedJobScheduleViaDoor(env, null, "yahoo", { enabled: false }),
    ).rejects.toThrow();
    const stored = await storedDefinition(stores, JOB);
    expect(stored.config.schedule.enabled).toBe(true);
  });

  it("an unknown source refuses by name", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, {});
    const env = fakeDoorEnv(control, stores);
    await expect(
      configureFeedJobScheduleViaDoor(env, "octocat", "bloomberg", { enabled: false }),
    ).rejects.toThrow(/No feed job matches/);
  });
});
