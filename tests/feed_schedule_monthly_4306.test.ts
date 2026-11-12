// @vitest-environment node
/**
 * Issue #4306 S1 — feed cadence to monthly: the defaults move to
 * every 43,200 minutes (30 days) with the stale threshold moving
 * with them (44,640 minutes = 31 days, just over the maximum gap).
 *
 * Boundary pins:
 * - `every 43200 minutes` is the longest interval the Agents SDK
 *   allows: MAX_INTERVAL_SECONDS = 720*60*60 = 2,592,000 s and
 *   validateIntervalSeconds throws only when intervalSeconds >
 *   2,592,000 (agents 0.32.0, dist/scheduler-FIHv2-kJ.js:14,62-66).
 *   43,200 minutes is exactly the cap, so it is allowed.
 * - `every 44640 minutes` (31 days) is 2,678,400 s > the cap and
 *   is refused by the platform at Think reconciliation. The
 *   platform validators are not exported from the public package
 *   APIs, so this file pins the boundary value the repo must never
 *   emit (derived from the repo's own emitted schedule strings),
 *   not an observed platform throw.
 * - The Think DSL accepts the monthly form: its interval grammar
 *   is /^every ([1-9]\d*) (minute|minutes|hour|hours)$/ with
 *   singular/plural enforced (@cloudflare/think dist/think.js
 *   parseDeclaredTaskScheduleUnchecked); "every 43200 minutes"
 *   parses to intervalMs 2,592,000,000.
 *
 * Preservation pin: a monthly schedule configured through the
 * engine survives a later ensure cycle whose built definition
 * drifted — the rewrite must never silently revert it.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { buildFeedJobRegistry, FEED_JOB_DEFAULTS } from "../src/services/feedJobs";
import {
  buildAllFeedPipelineJobDefinitions,
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
} from "../src/services/feedPipelineJobs";
import type { JobDefinition } from "../src/data/jobPipelinePorts";

const T0 = Date.parse("2026-11-08T12:00:00.000Z");
const JOB = "yahoo-nasdaq100-quotes";

// Agents SDK 30-day interval cap, in seconds (see the header
// comment for the source citation). The platform refuses any
// interval above this value.
const SDK_MAX_INTERVAL_SECONDS = 2_592_000;

function intervalMinutesOf(raw: unknown): number {
  const root = (raw as { root?: { schedule?: { interval?: unknown } } }).root;
  const interval = root?.schedule?.interval;
  if (typeof interval !== "string") {
    throw new Error(`expected a string interval on the raw definition, got ${String(interval)}`);
  }
  const match = /^every (\d+) minutes$/.exec(interval);
  if (!match) throw new Error(`expected an "every N minutes" interval, got ${interval}`);
  return Number(match[1]);
}

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

describe("FEED_JOB_DEFAULTS is monthly (#4306 S1)", () => {
  it("the defaults are cadence 43200 / stale 44640, with no per-job literal override", () => {
    expect(FEED_JOB_DEFAULTS).toEqual({
      cadenceMinutes: 43200,
      staleAfterMinutes: 44640,
    });
    const registry = buildFeedJobRegistry({});
    for (const job of registry.list()) {
      expect(job.cadenceMinutes).toBe(43200);
      expect(job.staleAfterMinutes).toBe(44640);
    }
  });

  it("the env knobs still override the monthly defaults per job", () => {
    const registry = buildFeedJobRegistry({
      FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "10080",
      FEED_JOB_YAHOO_NASDAQ100_QUOTES_STALE_MINUTES: "11520",
    });
    expect(registry.get(JOB)?.cadenceMinutes).toBe(10080);
    expect(registry.get(JOB)?.staleAfterMinutes).toBe(11520);
    expect(registry.get("alpaca-nasdaq100-quotes")?.cadenceMinutes).toBe(43200);
  });
});

describe("monthly interval at the platform boundary (#4306 S1)", () => {
  it("every one of the 26 built feed definitions carries every 43200 minutes", () => {
    const raws = buildAllFeedPipelineJobDefinitions({});
    expect(raws).toHaveLength(26);
    for (const raw of raws) {
      expect(intervalMinutesOf(raw)).toBe(43200);
    }
  });

  it("43200 minutes sits exactly on the 30-day SDK cap, so it is allowed", () => {
    const raws = buildAllFeedPipelineJobDefinitions({});
    for (const raw of raws) {
      const seconds = intervalMinutesOf(raw) * 60;
      expect(seconds).toBe(SDK_MAX_INTERVAL_SECONDS);
      expect(seconds).not.toBeGreaterThan(SDK_MAX_INTERVAL_SECONDS);
    }
  });

  it("44640 minutes (31 days) exceeds the cap and must never be emitted", () => {
    const registry = buildFeedJobRegistry({
      FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "44640",
    });
    expect(registry.get(JOB)?.cadenceMinutes).toBe(44640);
    const raws = buildAllFeedPipelineJobDefinitions({
      FEED_JOB_YAHOO_NASDAQ100_QUOTES_CADENCE_MINUTES: "44640",
    });
    const yahoo = raws.find(
      (raw) => (raw as { jobId?: unknown }).jobId === JOB,
    );
    expect(yahoo).toBeDefined();
    const seconds = intervalMinutesOf(yahoo) * 60;
    expect(seconds).toBe(2_678_400);
    expect(seconds).toBeGreaterThan(SDK_MAX_INTERVAL_SECONDS);
  });
});

describe("a configured monthly schedule survives ensure (#4306 S1)", () => {
  it("configureJob to monthly, then a drifted ensure: the schedule stays monthly", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = makeControl(stores);
    await ensureFeedPipelineJobs(control, stores, {});
    const v1 = await storedDefinition(stores, JOB);
    expect(v1.config.schedule).toEqual({ enabled: true, interval: "every 43200 minutes" });

    // The operator configures the monthly cadence through the engine
    // (the same call the schedule route makes per job).
    await control.configureJob(JOB, {
      root: { schedule: { enabled: true, interval: "every 43200 minutes" } },
    });
    const v2 = await storedDefinition(stores, JOB);
    expect(v2.config.schedule.interval).toBe("every 43200 minutes");

    // Non-schedule drift forces a re-definition: the name must
    // converge to the built definition, the monthly schedule must
    // not move (no silent revert to the old hourly cadence).
    const planted = await plantStaleName(stores, JOB);
    await ensureFeedPipelineJobs(control, stores, {});
    const v3 = await storedDefinition(stores, JOB);
    expect(v3.name).toBe(v1.name);
    expect(v3.config.schedule).toEqual({ enabled: true, interval: "every 43200 minutes" });
    expect(v3.version).toBe(planted.version + 1);
  });
});
