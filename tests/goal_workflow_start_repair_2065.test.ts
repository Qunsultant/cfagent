/**
 * Issue #2065: goal-workflow start fails in production with a generic 500.
 *
 * The start path had two diagnosability defects and one repair gap:
 *  - a failed `create` followed by a failed adoption `get` discarded the
 *    provider error, so the only trace was "start_failed";
 *  - the route could not say WHICH dependency was missing;
 *  - an unusable derived instance id (over the provider's 100-char ceiling
 *    or rejected characters) could never start, even though a shorter id
 *    would have worked.
 *
 * Pins here:
 *  - the composition root names the missing dependency;
 *  - a rejected derived id is retried once with a short provider-safe id,
 *    with the job id still carried in params;
 *  - an over-long job id derives a bounded hash id up front (#2065
 *    remainder), so the fallback fires only when the provider rejects
 *    an id — the long-id case no longer reaches it;
 *  - an existing instance is still adopted instead of duplicated;
 *  - a genuine failure preserves the original provider error.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  startWorkflowInstance,
  type WorkflowBindingLike,
} from "../src/workflows/cfWorkflowAdapter";
import { workflowPortsUnavailableReason } from "../src/workflows/createWorkflowPorts";
import { WorkflowError, type WorkflowJobCommand } from "../src/workflows/workflowPorts";

const COMMAND: WorkflowJobCommand = {
  jobId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
  type: "run-screen",
  source: "manual",
  trigger: "manual",
  userLogin: "alice",
  role: "parent",
  shards: [{ shardId: "goal" }],
  goalScreen: {
    scenario: { goalKind: "income" } as never,
    scenarioSource: "built",
  },
} as WorkflowJobCommand;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflowPortsUnavailableReason (#2065)", () => {
  it("names a missing or malformed workflow binding", () => {
    expect(workflowPortsUnavailableReason({})).toBe("workflow_binding_unavailable");
    expect(
      workflowPortsUnavailableReason({ SCREENER_WORKFLOW: {} } as never),
    ).toBe("workflow_binding_unavailable");
  });

  it("names a missing projection store", () => {
    expect(
      workflowPortsUnavailableReason({
        SCREENER_WORKFLOW: { create: async () => ({}), get: async () => ({}) },
      } as never),
    ).toBe("projection_store_unavailable");
  });

  it("returns null when both dependencies are present", () => {
    expect(
      workflowPortsUnavailableReason({
        SCREENER_WORKFLOW: { create: async () => ({}), get: async () => ({}) },
        AGENT_DB: {},
      } as never),
    ).toBeNull();
  });
});

describe("startWorkflowInstance repair (#2065)", () => {
  it("creates the derived instance id when the provider accepts it", async () => {
    const created: string[] = [];
    const binding: WorkflowBindingLike = {
      create: async ({ id }) => {
        created.push(id);
        return { id };
      },
      get: async (id) => ({ id, status: async () => ({ status: "queued" }) }),
    };

    const out = await startWorkflowInstance(binding, COMMAND);

    expect(out.existing).toBe(false);
    expect(out.workflowId).toMatch(/^screen-goal-screen-manual-alice-income-/);
    expect(created).toHaveLength(1);
  });

  it("adopts an existing instance instead of duplicating it", async () => {
    const binding: WorkflowBindingLike = {
      create: async () => {
        throw new Error("instance already exists");
      },
      get: async (id) => ({ id, status: async () => ({ status: "running" }) }),
    };

    const out = await startWorkflowInstance(binding, COMMAND);

    expect(out.existing).toBe(true);
    expect(out.workflowId).toMatch(/^screen-goal-screen-manual-alice-income-/);
  });

  it("retries with a short safe id when the derived id is rejected", async () => {
    // Issue #3515 S3 batch 5: the fallback warning rides the S2
    // structured logger — the console-info JSON fallback carries
    // the workflowInstanceSeam.start_used_fallback_instance event.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const created: Array<{ id: string; params: unknown }> = [];
    const binding: WorkflowBindingLike = {
      create: async ({ id, params }) => {
        if (id.startsWith("screen-goal-screen")) {
          throw new Error("invalid instance id");
        }
        created.push({ id, params });
        return { id };
      },
      get: async () => {
        throw new Error("no such instance");
      },
    };

    const out = await startWorkflowInstance(binding, COMMAND);

    expect(out.existing).toBe(false);
    expect(out.adoptedFallbackId).toBe(true);
    expect(out.workflowId).toMatch(/^screen-[0-9a-f]{40}$/);
    expect(created).toHaveLength(1);
    expect((created[0].params as WorkflowJobCommand).jobId).toBe(COMMAND.jobId);
    const fallbackEvents: Array<Record<string, unknown>> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as Record<string, unknown>;
        if (parsed.operation === "workflowInstanceSeam.start_used_fallback_instance") {
          fallbackEvents.push(parsed);
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0].level).toBe("warn");
    infoSpy.mockRestore();
  });

  it("derives a bounded hash id for a job id over the provider ceiling (#2065 remainder)", async () => {
    const longCommand = { ...COMMAND, jobId: "x".repeat(120) } as WorkflowJobCommand;
    const binding: WorkflowBindingLike = {
      create: async ({ id }) => ({ id }),
      get: async () => {
        throw new Error("no such instance");
      },
    };

    const out = await startWorkflowInstance(binding, longCommand);

    // The remainder's deterministic derivation handles over-long ids
    // before create is attempted, so no fallback fires here; the
    // fallback pin below covers provider-rejected ids.
    expect(out.adoptedFallbackId).toBeUndefined();
    expect(out.workflowId).toMatch(/^screen-h-[0-9a-f]{32}$/);
  });

  it("preserves the provider error when every attempt fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding: WorkflowBindingLike = {
      create: async ({ id }) => {
        throw new Error(id.startsWith("screen-goal") ? "binding boom" : "retry boom");
      },
      get: async () => {
        throw new Error("no instance");
      },
    };

    await expect(startWorkflowInstance(binding, COMMAND)).rejects.toThrow(WorkflowError);
    await expect(startWorkflowInstance(binding, COMMAND)).rejects.toThrow(/binding boom/);
    await expect(startWorkflowInstance(binding, COMMAND)).rejects.toThrow(/retry boom/);
  });
});
