// @vitest-environment node
/**
 * Issue #4479 ([Stage visibility] per-stage schedules in the definition flow).
 *
 * The engine already arms a node's own cadence: `registerSchedules` walks
 * every node and calls the host with `{jobId, nodePath, cron|interval}`,
 * which `declarePipelineTasks` turns into `pipeline:<jobId>:<nodePath>`.
 * This issue is the spec + flow surface, with the engine's own rules.
 *
 * Pins:
 *  - 4479-P01 a spec stage may declare a cadence; the engine's rules apply
 *    (enabled needs cron or interval; both at once is ambiguous).
 *  - 4479-P02 the builder puts the cadence on the node.
 *  - 4479-P03 the flow's per-stage cadence is validated (unknown stage,
 *    both sources, sub-minute interval, empty).
 *  - 4479-P04 the host DECLARES the stage task (the capability this
 *    surfaces already works): registerSchedules emits it with its path.
 *  - 4479-P05 the route carries stageSchedules and the client sends it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveJobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { bindStageOverrides } from "../src/services/jobDefinitionParamBinders";
import { handleJobDefinitionsRoutes } from "../src/agents/routes/jobDefinitions";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function specWithSchedule(schedule: unknown) {
  return resolveJobDefinitionSpec({
    id: "scheduled-stages",
    name: "Scheduled stages",
    version: 1,
    stages: [
      { kind: "feed", step: "s.feed" },
      { kind: "enrich", step: "s.enrich", schedule },
    ],
  });
}

describe("4479-P01 a stage may declare a cadence, with the engine's rules", () => {
  it("resolves an enabled interval", () => {
    const spec = specWithSchedule({ enabled: true, interval: "every 15 minutes" });
    expect(spec.stages[1].schedule).toEqual({ enabled: true, interval: "every 15 minutes" });
  });

  it("refuses an enabled schedule with neither source", () => {
    expect(() => specWithSchedule({ enabled: true })).toThrow(
      /enabled schedule requires a cron expression or an interval/,
    );
  });

  it("refuses both sources at once (ambiguous for registerSchedules)", () => {
    expect(() =>
      specWithSchedule({ enabled: true, cron: "0 * * * *", interval: "every 15 minutes" }),
    ).toThrow(/takes a cron expression or an interval, not both/);
  });
});

describe("4479-P02 the builder puts the cadence on the node", () => {
  it("carries the stage schedule", () => {
    const spec = specWithSchedule({ enabled: true, interval: "every 15 minutes" });
    const config = buildJobConfigFromSpec(spec, "job-4479");
    const child = (config.root as any).children[0];
    expect(child.kind).toBe("enrich");
    expect(child.schedule).toEqual({ enabled: true, interval: "every 15 minutes" });
  });

  it("omits a disabled cadence", () => {
    const spec = specWithSchedule({ enabled: false, interval: "every 15 minutes" });
    const config = buildJobConfigFromSpec(spec, "job-4479");
    expect((config.root as any).children[0].schedule).toBeUndefined();
  });
});

describe("4479-P03 the flow's per-stage cadence is validated", () => {
  const spec = specWithSchedule({ enabled: true, interval: "every 15 minutes" });

  it("binds minutes to the engine's interval grammar", () => {
    const bound = bindStageOverrides(spec, { stageSchedules: { enrich: { intervalMinutes: 60 } } });
    expect(bound.schedules).toEqual({ enrich: { enabled: true, interval: "every 60 minutes" } });
  });

  it("refuses an unknown stage, both sources, a sub-minute interval and an empty cadence", () => {
    expect(() =>
      bindStageOverrides(spec, { stageSchedules: { publish: { intervalMinutes: 15 } } }),
    ).toThrow(/has no stage "publish"/);
    expect(() =>
      bindStageOverrides(spec, {
        stageSchedules: { enrich: { intervalMinutes: 15, cron: "0 * * * *" } },
      }),
    ).toThrow(/takes a cron expression or an interval, not both/);
    expect(() =>
      bindStageOverrides(spec, { stageSchedules: { enrich: { intervalMinutes: 0 } } }),
    ).toThrow(/below one minute/);
    expect(() => bindStageOverrides(spec, { stageSchedules: { enrich: {} } })).toThrow(
      /neither a cron expression nor an interval/,
    );
  });
});

describe("4479-P04 the host declares the stage task", () => {
  it("registerSchedules emits the stage with its node path and cadence", async () => {
    const stores = createInMemoryJobPipelineStores();
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: new JobStepRegistry(),
    });
    const spec = specWithSchedule({ enabled: true, interval: "every 15 minutes" });
    await control.defineJob(buildJobConfigFromSpec(spec, "job-4479"));
    const seen: Array<{ jobId: string; nodePath: string; cron?: string; interval?: string }> = [];
    await control.registerSchedules({
      schedule: async (task) => {
        seen.push(task);
        return `think:${task.jobId}:${task.nodePath || "root"}`;
      },
    });
    expect(seen).toContainEqual({
      jobId: "job-4479",
      nodePath: "0",
      interval: "every 15 minutes",
    });
  });
});

describe("4479-P05 the route and the client carry the cadence", () => {
  it("passes stageSchedules through", async () => {
    let seen: unknown = null;
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions/screener/define", {
        method: "POST",
        body: JSON.stringify({
          jobId: "job-1",
          params: { universe: "NASDAQ100" },
          stageSchedules: { feed: { intervalMinutes: 60 } },
        }),
      }),
      new URL("https://x/api/job-definitions/screener/define"),
      "/api/job-definitions/screener/define",
      {
        defineJobFromSpec: async (_specId, jobId, _params, overrides) => {
          seen = overrides;
          return { jobId, name: "Screen", version: 1, stages: 6 };
        },
      },
    );
    expect(res!.status).toBe(200);
    expect(seen).toEqual({ stageSchedules: { feed: { intervalMinutes: 60 } } });
  });

  it("the client offers a per-stage cadence and sends the map", () => {
    const client = readFileSync(join(root, "src/client/WorkflowDefinitionFlow.tsx"), "utf8");
    expect(client).toContain("cadence");
    expect(client).toContain("No separate cadence");
    expect(client).toContain("stageSchedules");
    expect(client).toContain("dynamic-declaration follow-up");
  });
});
