// @vitest-environment node
/**
 * Issue #3700 — Generic workflow capability productization conformance:
 * the one workflow engine registered as a Technology Platform product
 * in the #3489 capability-manifest machinery, with every capability
 * term pinned to a real exported mechanism. A named capability with
 * no mechanism fails CI — the product cannot become a paper claim.
 *
 * The engine itself is NOT rebuilt here (J1–J7, #3534–#3540, built
 * the machinery); this suite pins the productization: the manifest
 * record, the registry join, the doc truth, and the mechanism pins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALL_CAPABILITY_IDS,
  GENERIC_WORKFLOW_CAPABILITY,
  PLATFORM_CAPABILITY_TERMS,
  resolveAgentCapabilityManifest,
} from "../src/actors/capabilityManifest";
import { platformCapabilities } from "../src/agents/registry";
import { buildMeshRegistryView } from "../src/services/meshRegistryView";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineControl,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  assertStageRunnerPlan,
  jobStageId,
} from "../src/workflows/stageRunnerPorts";
import { createInMemoryStageCheckpointStore } from "../src/workflows/stageRunnerCheckpoint";

const PLATFORMS_MD = readFileSync("docs/agentic-org/platforms.md", "utf8");
const CAPABILITIES_MD = readFileSync(
  "docs/architecture/agentic/agent-capabilities.md",
  "utf8",
);

function section(doc: string, heading: string, nextHeading: string): string {
  const start = doc.indexOf(heading);
  const end = doc.indexOf(nextHeading, start + 1);
  expect(start, `heading ${heading} present`).toBeGreaterThanOrEqual(0);
  return end === -1 ? doc.slice(start) : doc.slice(start, end);
}

describe("manifest registration (#3700)", () => {
  it("declares the engine as a Technology Platform product in platforms.md's own terms", () => {
    const cap = GENERIC_WORKFLOW_CAPABILITY;
    expect(cap.id).toBe("generic-workflow-capability");
    expect(cap.name).toBe("Generic workflow capability");
    expect(cap.owner).toBe("Technology Platform");
    expect(PLATFORM_CAPABILITY_TERMS).toEqual([
      "durable state",
      "tasks",
      "dependencies",
      "approvals",
      "cancellation",
    ]);
    expect(Object.keys(cap.capabilities)).toEqual([
      ...PLATFORM_CAPABILITY_TERMS,
    ]);
    for (const term of PLATFORM_CAPABILITY_TERMS) {
      const entry = cap.capabilities[term];
      expect(entry.module, `${term}: mechanism module`).toMatch(
        /^src\/[A-Za-z0-9/_-]+\.ts$/,
      );
      expect(entry.exportName, `${term}: mechanism export`).not.toBe("");
      expect(entry.note, `${term}: mechanism note`).not.toBe("");
    }
  });

  it("names its real doors as surfaces, each with its mechanism", () => {
    const ids = GENERIC_WORKFLOW_CAPABILITY.surfaces.map((s) => s.id);
    expect(ids).toEqual(["stage-ops", "job-plane", "chains", "run-records"]);
    for (const surface of GENERIC_WORKFLOW_CAPABILITY.surfaces) {
      expect(surface.door, surface.id).not.toBe("");
      expect(surface.module, surface.id).toMatch(/^src\//);
      expect(surface.exportName, surface.id).not.toBe("");
    }
  });

  it("links the consumption tracks without absorbing them", () => {
    const { consumption } = GENERIC_WORKFLOW_CAPABILITY;
    expect(consumption.adoptions).toMatch(/#3549/);
    expect(consumption.adoptions).toMatch(/#3550/);
    expect(consumption.tenantInstantiation).toMatch(/#3687/);
    expect(consumption.absorbs).toBe(false);
  });

  it("is the registry's platform-capability record, not a second list", () => {
    expect(platformCapabilities()).toEqual([GENERIC_WORKFLOW_CAPABILITY]);
  });
});

describe("mechanism pins — every term is a real mechanism (#3700)", () => {
  function makeHarness() {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const steps = createBuiltinStepRegistry();
    let tick = 0;
    const base = Date.parse("2026-11-06T12:00:00.000Z");
    let runCounter = 0;
    const deps: JobPipelineDeps = {
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: null,
      steps,
      now: () => new Date(base + tick++ * 1000),
      newRunId: () => `run-${++runCounter}`,
    };
    return {
      control: createJobPipelineControl(deps),
      stores,
      runStore,
    };
  }

  const DUMMY = {
    jobId: "dummy",
    name: "Dummy two-step job",
    root: {
      kind: "dummy",
      steps: [{ step: "record", params: { n: 1 } }, { step: "record", params: { n: 2 } }],
      executionMode: { delivery: "sync" },
    },
  };

  it("durable state: a checkpoint written to the store reads back", async () => {
    const store = createInMemoryStageCheckpointStore();
    await store.write({
      runId: "run-1",
      units: [
        { stage: "feed", unitId: "u1", status: "completed", attempt: 1 },
      ],
    });
    const read = await store.read("run-1");
    expect(read?.units[0]).toMatchObject({
      stage: "feed",
      unitId: "u1",
      status: "completed",
    });
    expect(await store.read("run-missing")).toBeNull();
  });

  it("tasks: a job defined by configuration alone runs to completion and leaves a run record", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    const dispatch = await h.control.runJob("dummy");
    // Sync delivery settles inline: the outcome rides dispatch.state
    // (a .completion promise exists only for async runs).
    expect(dispatch.state).toBe("completed");
    const view = await h.control.getJob("dummy");
    expect(view.instance?.state).toBe("completed");
    const record = await h.runStore.latestByJob("dummy");
    expect(record).toBeDefined();
    expect(record!.jobId).toBe("dummy");
    expect(await h.runStore.listByJob("dummy")).toHaveLength(1);
  });

  it("dependencies: the plan asserts its stage order and refuses a mixed-family plan", () => {
    expect(() =>
      assertStageRunnerPlan({
        runId: "r",
        invocation: "sync",
        screenMode: "deterministic",
        units: [],
        stages: [
          { stage: "feed", execution: "sequential", timeoutMs: 1 },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertStageRunnerPlan({
        runId: "r",
        invocation: "sync",
        screenMode: "deterministic",
        units: [],
        stages: [
          { stage: "feed", execution: "sequential", timeoutMs: 1 },
          { stage: jobStageId("0"), execution: "sequential", timeoutMs: 1 },
        ],
      }),
    ).toThrow(/mixes stage families/);
    expect(() =>
      assertStageRunnerPlan({
        runId: "r",
        invocation: "sync",
        screenMode: "deterministic",
        units: [],
        stages: [
          { stage: "feed", execution: "parallel", maxParallel: 0, timeoutMs: 1 },
        ],
      }),
    ).toThrow(/maxParallel/i);
  });

  it("approvals: a run paused at a boundary waits for the operator's resume decision", async () => {
    const h = makeHarness();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const releasePromise = new Promise<void>((r) => (release = r));
    let blockInvocations = 0;
    const steps = createBuiltinStepRegistry();
    steps.register("block", async () => {
      blockInvocations++;
      entered();
      await releasePromise;
      return { output: { blocked: true } };
    });
    const control = createJobPipelineControl({
      stores: h.stores,
      runRecorder: jobRunRecorderFromStore(h.runStore),
      publisher: null,
      steps,
      now: () => new Date(Date.parse("2026-11-06T12:00:00.000Z") + blockInvocations),
      newRunId: () => "run-block",
    });
    await control.defineJob({
      jobId: "blocker",
      root: {
        kind: "dummy",
        steps: [{ step: "block" }, { step: "record" }],
        executionMode: { delivery: "async" },
      },
    });
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.pauseJob("blocker");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("paused");
    const pausedView = await control.getJob("blocker");
    expect(pausedView.instance?.state).toBe("paused");
    const resumed = await control.resumeJob("blocker");
    const resumedOutcome = await resumed.completion!;
    expect(resumedOutcome.state).toBe("completed");
    expect(blockInvocations).toBe(1); // the completed step was NOT re-executed
  });

  it("cancellation: cancelling a stage settles the run cancelled and the downstream stage never runs", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const releasePromise = new Promise<void>((r) => (release = r));
    const steps = createBuiltinStepRegistry();
    steps.register("block", async () => {
      entered();
      await releasePromise;
      return { output: { blocked: true } };
    });
    let secondCalls = 0;
    steps.register("second", async () => {
      secondCalls += 1;
      return { output: { second: true } };
    });
    const control: JobPipelineControl = createJobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: null,
      steps,
      newRunId: () => "run-cancel-stage",
    });
    await control.defineJob({
      jobId: "chain",
      root: {
        kind: "pipeline",
        executionMode: { delivery: "async" },
        children: [
          { kind: "feed", steps: [{ step: "block" }] },
          { kind: "enrich", steps: [{ step: "second" }] },
        ],
      },
    });
    const dispatch = await control.runJob("chain");
    await enteredPromise;
    await control.cancelStage("chain", "1");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("cancelled");
    expect(secondCalls).toBe(0);
    const view = await control.getJob("chain");
    expect(view.stages.find((s) => s.stageId === "job:1")?.units[0].status).toBe(
      "cancelled",
    );
    expect(view.stages.find((s) => s.stageId === "job:0")?.units[0].status).toBe(
      "completed",
    );
  });
});

describe("registry join (#3700)", () => {
  it("the Agents view renders the platform capability, derived from the manifest module", () => {
    const view = buildMeshRegistryView();
    expect(view.platformCapabilities).toEqual(platformCapabilities());
    expect(view.platformCapabilities).toEqual([GENERIC_WORKFLOW_CAPABILITY]);
  });

  it("a manifest is not a tool: the per-agent capability catalog is unchanged", () => {
    expect(ALL_CAPABILITY_IDS).toHaveLength(18);
    const manifest = resolveAgentCapabilityManifest("OrchestratorAgent");
    const ids = [
      ...Object.keys(manifest.channels),
      ...Object.keys(manifest.capabilities),
      ...Object.keys(manifest.tools),
    ];
    expect(ids.sort()).toEqual([...ALL_CAPABILITY_IDS].sort());
  });
});

describe("documentation truth (#3700)", () => {
  it("platforms.md names the product at the §3 workflow-execution layer", () => {
    const section3 = section(PLATFORMS_MD, "## 3.", "## 4.");
    expect(section3).toContain("Generic workflow capability");
    expect(section3).toContain("Technology Platform");
    for (const term of PLATFORM_CAPABILITY_TERMS) {
      expect(section3.toLowerCase()).toContain(term);
    }
    expect(section3).toContain("#3700");
  });

  it("agent-capabilities.md names the same product with the same capability terms", () => {
    const section4 = section(CAPABILITIES_MD, "## 4.", "## 5.");
    expect(section4).toContain("Generic workflow capability");
    expect(section4).toContain("Technology Platform");
    for (const term of PLATFORM_CAPABILITY_TERMS) {
      expect(section4.toLowerCase()).toContain(term);
    }
    expect(section4).toContain("#3700");
  });
});
