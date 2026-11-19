// @vitest-environment node
/**
 * Issue #5739 — whole-job control from chat over MCP.
 *
 * The engine (`JobPipelineControl`) and the `ScheduledAgent` host already
 * implement start / pause / resume / cancel / retry at job granularity;
 * the stage tool (#4362) exposes one STAGE of a run. This pin covers the
 * missing WHOLE-JOB surface:
 *
 *  - 5739-P01 the tool is registered with the five operations and the
 *    required args;
 *  - 5739-P02 it is gated as a write, like the stage tool it sits beside;
 *  - 5739-P03 each operation dispatches to its engine RPC through the one
 *    door (start→run, pause→pause, resume→resume, cancel→cancel,
 *    retry→retry) and returns the engine's state;
 *  - 5739-P04 control is never anonymous: a missing or retired-synthetic
 *    identity is refused BEFORE dispatch;
 *  - 5739-P05 an absent binding is a named door failure, never a pretend
 *    success;
 *  - 5739-P06 the command executes through the door and audits the call.
 */
import { describe, expect, it } from "vitest";

import {
  controlPipelineJobViaDoor,
  PIPELINE_JOB_OPERATIONS,
  type PipelineJobOperation,
} from "../src/agents/orchestrator/meshDoors";
import { StockCopilotJobControlCommand } from "../src/mcps/openaimp/jobStageControlCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";

interface Call {
  method: string;
  args: unknown[];
}

function recordedEnv(result?: Record<string, unknown>) {
  const calls: Call[] = [];
  const instance = {
    jobId: "yahoo-nasdaq100-technicals",
    state: "paused",
    desiredState: "paused",
    currentRunId: "run-7",
    ...result,
  };
  const dispatch = {
    jobId: "yahoo-nasdaq100-technicals",
    runId: "run-8",
    state: "running",
    ...result,
  };
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return method === "pausePipelineJob" || method === "cancelPipelineJob"
      ? instance
      : dispatch;
  };
  const env = {
    SCHEDULED_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({
        runPipelineJob: record("runPipelineJob"),
        pausePipelineJob: record("pausePipelineJob"),
        resumePipelineJob: record("resumePipelineJob"),
        cancelPipelineJob: record("cancelPipelineJob"),
        retryPipelineJob: record("retryPipelineJob"),
      }),
    },
  };
  return { env, calls };
}

const JOB = "yahoo-nasdaq100-technicals";

describe("5739-P01 the tool is registered", () => {
  it("exposes stock_copilot_job_control with the five operations", () => {
    const tool = McpToolFactory.getTool("stock_copilot_job_control");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("stock_copilot_job_control");
    expect((tool!.jsonSchema as any).required).toEqual(["jobId", "operation"]);
    expect((tool!.jsonSchema as any).properties.operation.enum).toEqual([
      ...PIPELINE_JOB_OPERATIONS,
    ]);
    expect([...PIPELINE_JOB_OPERATIONS]).toEqual([
      "start",
      "pause",
      "resume",
      "cancel",
      "retry",
    ]);
  });
});

describe("5739-P02 the tool is gated as a write", () => {
  it("declares mcp:write, the same scope as the stage tool", () => {
    expect(MCP_TOOL_SCOPES.stock_copilot_job_control).toBe("mcp:write");
    expect(MCP_TOOL_SCOPES.stock_copilot_stage_control).toBe("mcp:write");
  });
});

describe("5739-P03 each operation reaches its engine RPC", () => {
  const expected: Record<PipelineJobOperation, string> = {
    start: "runPipelineJob",
    pause: "pausePipelineJob",
    resume: "resumePipelineJob",
    cancel: "cancelPipelineJob",
    retry: "retryPipelineJob",
  };

  for (const operation of PIPELINE_JOB_OPERATIONS) {
    it(`${operation} → ${expected[operation]}`, async () => {
      const { env, calls } = recordedEnv();
      const result = await controlPipelineJobViaDoor(
        env as never,
        "alice",
        JOB,
        operation,
      );
      expect(calls.map((c) => c.method)).toEqual([expected[operation]]);
      expect(result.jobId).toBe(JOB);
      expect(result.operation).toBe(operation);
      expect(result.state).toBe(
        operation === "pause" || operation === "cancel" ? "paused" : "running",
      );
      expect(result.runId).toBe(
        operation === "pause" || operation === "cancel" ? "run-7" : "run-8",
      );
    });
  }

  it("carries the acting login on the dispatch verbs", async () => {
    const { env, calls } = recordedEnv();
    await controlPipelineJobViaDoor(env as never, "alice", JOB, "start");
    expect(calls[0].args).toEqual([JOB, { userLogin: "alice" }]);
  });
});

describe("5739-P04 control is never anonymous", () => {
  it("refuses a missing identity before the door is touched", async () => {
    const { env, calls } = recordedEnv();
    await expect(
      controlPipelineJobViaDoor(env as never, undefined, JOB, "start"),
    ).rejects.toThrow(/acting identity/i);
    expect(calls).toEqual([]);
  });

  it("refuses the retired synthetic identity", async () => {
    const { env, calls } = recordedEnv();
    await expect(
      controlPipelineJobViaDoor(env as never, "default", JOB, "cancel"),
    ).rejects.toThrow(/identity/i);
    expect(calls).toEqual([]);
  });
});

describe("5739-P05 an absent binding is a named failure", () => {
  it("throws door_unavailable instead of pretending success", async () => {
    await expect(
      controlPipelineJobViaDoor({} as never, "alice", JOB, "pause"),
    ).rejects.toThrow(/unavailable/i);
  });
});

describe("5739-P06 the command executes through the door", () => {
  it("returns the engine's answer and audits the call", async () => {
    const { env, calls } = recordedEnv();
    const audited: unknown[] = [];
    const command = new StockCopilotJobControlCommand();
    const result = await command.execute(
      { jobId: JOB, operation: "resume" },
      {
        env: env as never,
        actingLogin: () => "alice",
        audit: (type: string, _cat: string, payload: unknown) => {
          audited.push({ type, payload });
        },
      } as never,
    );
    expect(calls.map((c) => c.method)).toEqual(["resumePipelineJob"]);
    expect(result).toMatchObject({ jobId: JOB, operation: "resume", state: "running" });
    expect(audited).toHaveLength(1);
    expect((audited[0] as any).type).toBe("stock_copilot_job_control");
    expect((audited[0] as any).payload).toMatchObject({
      jobId: JOB,
      operation: "resume",
      state: "running",
    });
  });
});
