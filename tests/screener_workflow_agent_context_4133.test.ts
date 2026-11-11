// @vitest-environment node
/**
 * Issue #4140 — a workflow started outside an agent must still satisfy
 * AgentWorkflow's init.
 *
 * ScreenerScreenWorkflow extends ThinkWorkflow, which extends AgentWorkflow.
 * AgentWorkflow's `_initAgent` runs BEFORE `run()` and throws:
 *
 *   "AgentWorkflow requires __agentName, __agentBinding, and __workflowName
 *    in params. Use agent.runWorkflow() to start workflows with proper agent
 *    context."
 *
 * Every screener firing did exactly that — 324 errored instances, zero steps,
 * none complete — because the start path passed the bare command as params.
 * This pin freezes the three keys on the start path, and that the command's
 * own fields survive alongside them.
 */
import { describe, it, expect } from "vitest";
import { startWorkflowInstance } from "../src/workflows/cfWorkflowAdapter";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";

function command(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-4133",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner@example.com",
    ...overrides,
  } as WorkflowJobCommand;
}

function captureBinding() {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const binding = {
    create: async (options: { id: string; params: Record<string, unknown> }) => {
      calls.push(options);
      return { id: options.id };
    },
    get: async (id: string) => {
      throw new Error(`no instance ${id}`);
    },
  };
  return { binding, calls };
}

describe("workflow start carries AgentWorkflow context (#4140)", () => {
  it("passes __agentName, __agentBinding and __workflowName alongside the command", async () => {
    const { binding, calls } = captureBinding();
    await startWorkflowInstance(binding as never, command());

    expect(calls).toHaveLength(1);
    const params = calls[0].params;
    expect(params.__agentName).toBe("owner@example.com");
    expect(params.__agentBinding).toBe("ORCHESTRATOR_AGENT");
    expect(params.__workflowName).toBe("SCREENER_WORKFLOW");

    // The command itself must survive: the run's identity and idempotency key
    // are read from these fields inside run().
    expect(params.jobId).toBe("job-4133");
    expect(params.userLogin).toBe("owner@example.com");
    expect(params.type).toBe("run-screen");
  });

  it("uses the system instance name when the command has no login, never as the run owner", async () => {
    const { binding, calls } = captureBinding();
    await startWorkflowInstance(binding as never, command({ userLogin: "" }));

    // run() still refuses an empty login (#1185); this only names the DO.
    expect(calls[0].params.__agentName).toBe("system");
    expect(calls[0].params.userLogin).toBe("");
  });

  it("lets a caller name a different workflow binding", async () => {
    const { binding, calls } = captureBinding();
    await startWorkflowInstance(binding as never, command(), "OTHER_WORKFLOW");
    expect(calls[0].params.__workflowName).toBe("OTHER_WORKFLOW");
  });
});
