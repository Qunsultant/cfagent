// @vitest-environment node
/**
 * Issue #4362 ([Stage visibility] stock stage control surface) — one stage
 * of one stock run, from chat and from Workflow Runs.
 *
 * Pins:
 *  - 4362-P01 POST /api/jobs/:id/stages/:stage/:op drives the stage and
 *    returns the engine's answer; a refusal is a 409 naming the reason.
 *  - 4362-P02 the surface refuses by name when no control door is wired
 *    (never a pretend success).
 *  - 4362-P03 the chat tool requires the acting identity and returns the
 *    engine's result through the same door.
 *  - 4362-P04 the Workflow Runs row carries per-stage buttons for engine
 *    stages only, addressed by the stage's engine job id.
 *  - 4362-P05 the tool is registered, gated as a write, and drawn from the
 *    one engine control plane (no second control path).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleJobStatusRoutes } from "../src/agents/routes/jobStatus";
import { controlPipelineStageViaDoor } from "../src/agents/orchestrator/meshDoors";
import { StockCopilotStageControlCommand } from "../src/mcps/openaimp/jobStageControlCommands";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function controlCtx(result: unknown, error?: string) {
  return {
    readJobStatus: async () => null,
    controlJobStage: async () => {
      if (error) throw new Error(error);
      return result as never;
    },
  };
}

const RESULT = {
  jobId: "screen-4362",
  stageId: "job:0",
  nodePath: "0",
  operation: "rerun",
  state: "running",
  runId: "run-2",
};

function fakeEnv(over: Record<string, unknown> = {}) {
  return {
    SCHEDULED_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({
        controlPipelineStage: async () => RESULT,
        ...over,
      }),
    },
  };
}

describe("4362-P01 the stage-control route", () => {
  it("returns the engine's result for a stage operation", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4362/stages/enrich/rerun", { method: "POST" }),
      new URL("https://x/api/jobs/screen-4362/stages/enrich/rerun"),
      "/api/jobs/screen-4362/stages/enrich/rerun",
      controlCtx(RESULT) as never,
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual(RESULT);
  });

  it("maps an engine refusal to a 409 that names the reason", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4362/stages/publish/stop", { method: "POST" }),
      new URL("https://x/api/jobs/screen-4362/stages/publish/stop"),
      "/api/jobs/screen-4362/stages/publish/stop",
      controlCtx(null, 'Stage "publish" is not part of job "screen-4362". Its stages are: job:root.') as never,
    );
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("publish");
    expect(body.error).toContain("job:root");
  });

  it("ignores a POST that is not a stage operation", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/abc/status", { method: "POST" }),
      new URL("https://x/api/jobs/abc/status"),
      "/api/jobs/abc/status",
      controlCtx(RESULT) as never,
    );
    expect(res).toBeNull();
  });
});

describe("4362-P02 no control door means a named refusal", () => {
  it("refuses with 503 instead of pretending", async () => {
    const res = await handleJobStatusRoutes(
      new Request("https://x/api/jobs/screen-4362/stages/feed/run", { method: "POST" }),
      new URL("https://x/api/jobs/screen-4362/stages/feed/run"),
      "/api/jobs/screen-4362/stages/feed/run",
      { readJobStatus: async () => null } as never,
    );
    expect(res!.status).toBe(503);
    expect(((await res!.json()) as any).error).toContain("no control door");
  });
});

describe("4362-P03 the chat tool", () => {
  it("requires the acting identity (the operator gate)", async () => {
    await expect(
      controlPipelineStageViaDoor(
        fakeEnv() as never,
        undefined,
        "screen-4362",
        "enrich",
        "rerun",
      ),
    ).rejects.toThrow(/identity/i);
  });

  it("returns the engine's result through the door", async () => {
    const result = await new StockCopilotStageControlCommand().execute(
      { jobId: "screen-4362", stage: "enrich", operation: "rerun" },
      { env: fakeEnv(), actingLogin: () => "owner", audit: () => {} } as never,
    );
    expect(result).toEqual(RESULT);
  });
});

describe("4362-P04 Workflow Runs carries the per-stage buttons", () => {
  it("renders the three controls only for engine stages, addressed by engine job id", () => {
    const panel = readFileSync(join(root, "src/client/WorkflowRunsPanel.tsx"), "utf8");
    expect(panel).toContain('header: "Actions"');
    expect(panel).toContain("stage.engineJobId ? (");
    expect(panel).toContain("controlJobStage(stage.engineJobId, stage.key, operation)");
    for (const label of ["Re-run", "Stop", "Resume"]) expect(panel).toMatch(new RegExp(`>\\s*${label}\\s*<`));
    const api = readFileSync(join(root, "src/client/jobsApi.ts"), "utf8");
    expect(api).toContain("export async function controlJobStage(");
    expect(api).toContain("/stages/${encodeURIComponent(stage)}/${operation}");
  });

  it("stamps the engine job id on the projected stages", () => {
    const runs = readFileSync(join(root, "src/services/workflowRuns.ts"), "utf8");
    expect(runs).toContain("engineJobId?: string | null;");
    expect(runs).toContain("stagesFromEngineViews(engineStages, engineJobId ?? null)");
    expect(runs).toContain("stagesFromEngineViews(engineStages, record.jobId)");
  });
});

describe("4362-P05 one engine control plane", () => {
  it("is registered, gated as a write, synchronous, and drives the engine's own ops", () => {
    const commands = readFileSync(join(root, "src/mcps/openaimp/commands.ts"), "utf8");
    expect(commands).toContain("new StockCopilotStageControlCommand()");
    const perms = readFileSync(join(root, "src/mcps/openaimp/mcpPermissionPorts.ts"), "utf8");
    expect(perms).toContain('stock_copilot_stage_control: "mcp:write"');
    const modes = readFileSync(join(root, "src/config/asyncJobModes.ts"), "utf8");
    expect(modes).toContain('"stock_copilot_stage_control"');
    const agent = readFileSync(join(root, "src/agents/scheduled-agent.ts"), "utf8");
    expect(agent).toContain("async controlPipelineStage(");
    expect(agent).toContain("control.controlPipelineStage".replace("control.", ""));
    for (const op of ["runStage", "rerunStage", "stopStage", "resumeStage", "cancelStage"]) {
      expect(agent).toContain(`control.${op}(`);
    }
  });
});
