import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_BINDING,
  DEFAULT_WORKFLOW_NAME,
  startManagedWorkflowInstance,
  withAgentWorkflowContext,
} from "../src/workflows/workflowInstanceSeam";

describe("5776 / 5777 / 5778 AgentWorkflow context injection across workflows", () => {
  it("injects __agentName, __agentBinding, and __workflowName into workflow params without overwriting caller values", () => {
    expect(
      withAgentWorkflowContext(
        { jobId: "options-chain:123", trigger: "scheduled" },
        { workflowName: "JOB_PIPELINE_WORKFLOW" },
      ),
    ).toEqual({
      jobId: "options-chain:123",
      trigger: "scheduled",
      __agentName: "system",
      __agentBinding: DEFAULT_AGENT_BINDING,
      __workflowName: "JOB_PIPELINE_WORKFLOW",
    });

    expect(
      withAgentWorkflowContext(
        {
          jobId: "saga-1",
          userLogin: "trader@example.com",
          __agentBinding: "CUSTOM_AGENT",
        },
        { workflowName: "SAGA_WORKFLOW" },
      ),
    ).toEqual({
      jobId: "saga-1",
      userLogin: "trader@example.com",
      __agentName: "trader@example.com",
      __agentBinding: "CUSTOM_AGENT",
      __workflowName: "SAGA_WORKFLOW",
    });
  });

  it("passes AgentWorkflow context on startManagedWorkflowInstance create and fallback create", async () => {
    const create = vi.fn(async () => ({ id: "wf-1" }));
    const get = vi.fn(async () => {
      throw new Error("not found");
    });

    const started = await startManagedWorkflowInstance(
      { create, get },
      {
        id: "options-chain-09b4",
        params: { jobId: "options-chain:09b4", trigger: "scheduled" },
        workflowName: "JOB_PIPELINE_WORKFLOW",
      },
    );
    expect(started.workflowId).toBe("wf-1");
    expect(create).toHaveBeenCalledWith({
      id: "options-chain-09b4",
      params: {
        jobId: "options-chain:09b4",
        trigger: "scheduled",
        __agentName: "system",
        __agentBinding: DEFAULT_AGENT_BINDING,
        __workflowName: DEFAULT_WORKFLOW_NAME,
      },
    });
  });
});
