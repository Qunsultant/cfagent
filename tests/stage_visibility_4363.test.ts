// @vitest-environment node
/**
 * Issue #4363 ([Stage visibility] execution-mode control + surfacing).
 *
 * Pins:
 *  - 4363-P01 the family default is externalized: built-in values, an env
 *    override, and a named refusal for a malformed knob (fail closed).
 *  - 4363-P02 a run's mode is a parameter: the builder honors the caller's
 *    choice axis by axis, and keeps today's values when none is given.
 *  - 4363-P03 the mode is recorded and surfaced: the status report and the
 *    Workflow Runs stage rows carry the definition's mode; a legacy
 *    definition without one surfaces null, never an invented default.
 *  - 4363-P04 a mid-run change refuses by name with the next-run-only rule
 *    (the definition is only rewritten for a non-live job).
 *  - 4363-P05 the run tool accepts the mode and the set tool is registered,
 *    gated as a write, and drawn from the one engine resolver.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCREENER_DEFAULT_EXECUTION_MODE,
  resolveScreenerDefaultExecutionMode,
} from "../src/config/screenerExecutionMode";
import { buildScreenerJobDefinition } from "../src/services/screenerPipelineJobs";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import type { JobDefinition, JobInstanceRecord } from "../src/data/jobPipelinePorts";
import type { JobStageView, JobStatusView } from "../src/services/jobPipelineEngine";
import type { JobRunRecord } from "../src/data/jobRunRecordPorts";
import { buildJobStatusReport } from "../src/services/jobStageStatus";
import { runFromJobs, stagesFromEngineViews, type WorkflowRunJobRow } from "../src/services/workflowRuns";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function command(over: Record<string, unknown> = {}) {
  return {
    jobId: "screen-4363",
    type: "run-screen" as const,
    source: "mesh-door",
    trigger: "manual" as const,
    userLogin: "owner",
    role: "parent" as const,
    shards: [{ id: "shard-1", symbol: "AAPL" }] as never,
    filters: {},
    ...over,
  } as never;
}

describe("4363-P01 the family default is configuration", () => {
  it("returns the built-in values when nothing is configured", () => {
    expect(resolveScreenerDefaultExecutionMode()).toEqual(SCREENER_DEFAULT_EXECUTION_MODE);
    expect(SCREENER_DEFAULT_EXECUTION_MODE).toEqual({
      concurrency: "sequential",
      pacing: "batch",
      delivery: "async",
      shape: "monolith",
    });
  });

  it("accepts an env override axis by axis", () => {
    const resolved = resolveScreenerDefaultExecutionMode({
      SCREENER_DEFAULT_EXECUTION_MODE: '{"concurrency":"parallel","delivery":"sync"}',
    });
    expect(resolved.concurrency).toBe("parallel");
    expect(resolved.delivery).toBe("sync");
    expect(resolved.pacing).toBe("batch");
  });

  it("refuses a malformed knob by name", () => {
    expect(() =>
      resolveScreenerDefaultExecutionMode({ SCREENER_DEFAULT_EXECUTION_MODE: "{nope" }),
    ).toThrow(/SCREENER_DEFAULT_EXECUTION_MODE is not valid JSON/);
  });

  it("refuses online+sync through the engine resolver", () => {
    expect(() =>
      resolveScreenerDefaultExecutionMode({
        SCREENER_DEFAULT_EXECUTION_MODE: '{"pacing":"online","delivery":"sync"}',
      }),
    ).toThrow(JobPipelineError);
  });
});

describe("4363-P02 the run's mode is a parameter", () => {
  it("honors the caller's axes and keeps the default on the others", () => {
    const def = buildScreenerJobDefinition(
      command({ executionMode: { concurrency: "parallel", delivery: "sync" } }),
    ) as any;
    expect(def.root.executionMode).toEqual({
      concurrency: "parallel",
      pacing: "batch",
      delivery: "sync",
      shape: "monolith",
    });
  });

  it("keeps today's values when no mode is given, deriving shape from the shards", () => {
    const single = buildScreenerJobDefinition(command()) as any;
    expect(single.root.executionMode).toEqual(SCREENER_DEFAULT_EXECUTION_MODE);
    const multi = buildScreenerJobDefinition(
      command({
        shards: [
          { id: "shard-1", symbol: "AAPL" },
          { id: "shard-2", symbol: "MSFT" },
        ],
      }),
    ) as any;
    expect(multi.root.executionMode.shape).toBe("sharded");
  });

  it("honors an explicit shape over the shard-derived one", () => {
    const def = buildScreenerJobDefinition(
      command({
        executionMode: { shape: "monolith" },
        shards: [
          { id: "shard-1", symbol: "AAPL" },
          { id: "shard-2", symbol: "MSFT" },
        ],
      }),
    ) as any;
    expect(def.root.executionMode.shape).toBe("monolith");
  });
});

describe("4363-P03 the mode is recorded and surfaced", () => {
  const mode = { concurrency: "parallel", pacing: "batch", delivery: "sync", shape: "sharded" };

  function view(withMode: boolean): JobStatusView {
    return {
      definition: {
        jobId: "screen-4363",
        name: "Screen",
        root: { kind: "feed", steps: [] },
        rawConfig: {},
        config: { executionMode: withMode ? mode : undefined },
        version: 1,
        updatedAt: iso(T0),
      } as unknown as JobDefinition,
      instance: {
        jobId: "screen-4363",
        state: "idle",
        currentRunId: "run-1",
        runStartedAt: iso(T0),
        stageCheckpoint: { runId: "run-1", units: [] },
      } as unknown as JobInstanceRecord,
      latestRun: {
        started: iso(T0),
        finished: iso(T0 + 1000),
        outcome: "success",
        workflowId: "run-1",
      } as unknown as JobRunRecord,
      history: [],
      stages: [
        {
          stageId: "job:root",
          nodePath: "",
          kind: "feed",
          startedAt: iso(T0),
          endedAt: iso(T0 + 1000),
          durationMs: 1000,
          executionMode: withMode ? mode : null,
          units: [{ unitId: "run-1", status: "completed", attempt: 1 }],
        } as JobStageView,
      ],
    };
  }

  it("carries the definition's mode on the report and the stage rows", () => {
    const report = buildJobStatusReport("screen-4363", view(true));
    expect(report.executionMode).toEqual(mode);
    const stages = stagesFromEngineViews(view(true).stages, "screen-4363");
    expect(stages[0].executionMode).toBe("parallel · batch · sync · sharded");
    const job: WorkflowRunJobRow = {
      job_id: "screen-4363",
      capability: "screening",
      display_name: "Screen",
      status: "completed",
      created_at: iso(T0),
    };
    const run = runFromJobs([job], [], undefined, T0, view(true).stages, "screen-4363");
    expect(run.stages[0].executionMode).toContain("parallel");
  });

  it("surfaces null when a legacy definition records none", () => {
    const report = buildJobStatusReport("screen-4363", view(false));
    expect(report.executionMode).toBeNull();
    const stages = stagesFromEngineViews(view(false).stages, "screen-4363");
    expect(stages[0].executionMode).toBeUndefined();
  });
});

describe("4363-P04 a mid-run change refuses by name", () => {
  it("states the next-run-only rule and only rewrites a non-live job", () => {
    const agent = readFileSync(join(root, "src/agents/scheduled-agent.ts"), "utf8");
    expect(agent).toContain("async setPipelineJobExecutionMode(");
    expect(agent).toContain("the execution mode is fixed at start and cannot change mid-run");
    expect(agent).toContain("Next-run-only: stop or cancel this run, set the mode, then start a new run.");
    expect(agent).toContain('state === "running" || state === "queued" || state === "paused"');
    // The write goes through the one engine resolver and the definition plane.
    expect(agent).toContain("resolveExecutionMode(mode)");
    expect(agent).toContain("assertExecutionModeSupported(resolved)");
    expect(agent).toContain("control.configureJob(jobId, { executionMode: resolved })");
  });
});

describe("4363-P05 the tool surfaces", () => {
  it("run_stock_screen accepts the mode; set_job_execution_mode is registered and gated", () => {
    const door = readFileSync(join(root, "src/mcps/openaimp/meshDoorCommands.ts"), "utf8");
    expect(door).toContain("executionMode: {");
    expect(door).toContain("online+sync is refused");
    const commands = readFileSync(join(root, "src/mcps/openaimp/commands.ts"), "utf8");
    expect(commands).toContain("new SetJobExecutionModeCommand()");
    const perms = readFileSync(join(root, "src/mcps/openaimp/mcpPermissionPorts.ts"), "utf8");
    expect(perms).toContain('set_job_execution_mode: "mcp:write"');
    const modes = readFileSync(join(root, "src/config/asyncJobModes.ts"), "utf8");
    expect(modes).toContain('"set_job_execution_mode"');
    const panel = readFileSync(join(root, "src/client/WorkflowRunsPanel.tsx"), "utf8");
    expect(panel).toContain("<dt>Execution mode</dt>");
  });
});
