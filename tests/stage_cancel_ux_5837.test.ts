// @vitest-environment node
/**
 * Issue #5837 — per-stage cancel in Workflow Runs.
 *
 * The engine has `cancelStage` and the route already accepts the `cancel`
 * operation; the panel offered only re-run / stop / resume. Pins:
 *
 *  - 5837-P01 the panel offers a Cancel action on an engine stage, wired to
 *    the same `runStageAction` seam as the other three operations;
 *  - 5837-P02 the route drives the engine with operation `cancel` for
 *    `POST /api/jobs/:id/stages/:stage/cancel` (so the button's promise is
 *    the engine's, not a second path);
 *  - 5837-P03 the client seam types `cancel` alongside the other operations.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleJobStatusRoutes } from "../src/agents/routes/jobStatus";

const panel = readFileSync(join(__dirname, "../src/client/WorkflowRunsPanel.tsx"), "utf8");
const jobsApi = readFileSync(join(__dirname, "../src/client/jobsApi.ts"), "utf8");

describe("5837-P01 the panel offers Cancel on a stage", () => {
  it("wires a Cancel button to the same stage-action seam", () => {
    expect(panel).toContain('runStageAction(stage, "cancel")');
    expect(panel).toContain("Cancel this stage");
    expect(panel).toContain("stageActionBusy === `${stage.key}:cancel`");
  });

  it("keeps the three existing operations", () => {
    expect(panel).toContain('runStageAction(stage, "rerun")');
    expect(panel).toContain('runStageAction(stage, "stop")');
    expect(panel).toContain('runStageAction(stage, "resume")');
  });

  it("types cancel on the action union", () => {
    expect(panel).toContain('operation: "rerun" | "stop" | "resume" | "cancel"');
  });
});

describe("5837-P02 the route drives the engine's cancel", () => {
  it("passes operation cancel through to the control door", async () => {
    const calls: Array<{ jobId: string; stage: string; op: string }> = [];
    const ctx = {
      readJobStatus: async () => null,
      controlJobStage: async (jobId: string, stage: string, op: string) => {
        calls.push({ jobId, stage, op });
        return {
          jobId,
          stageId: stage,
          nodePath: "root",
          operation: op,
          state: "cancelled",
          runId: "run-1",
        } as never;
      },
    };
    const path = "/api/jobs/screen-1/stages/root/cancel";
    const res = await handleJobStatusRoutes(
      new Request(`https://x${path}`, { method: "POST" }),
      new URL(`https://x${path}`),
      path,
      ctx as never,
    );
    expect(res!.status).toBe(200);
    expect(calls).toEqual([{ jobId: "screen-1", stage: "root", op: "cancel" }]);
  });
});

describe("5837-P03 the client seam already carries cancel", () => {
  it("declares cancel in controlJobStage's operation union", () => {
    expect(jobsApi).toContain('"run" | "rerun" | "stop" | "resume" | "cancel"');
  });
});
