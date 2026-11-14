// @vitest-environment node
/**
 * Issue #3810 — Workflow runs provenance: the trigger and schedule
 * a run actually had, stamped at submission onto the async-job row.
 *
 * Pins (pure read model):
 *  - a job row carrying stamped trigger columns evidences its own
 *    trigger (agent / scheduled) with the actor / schedule named —
 *    an MCP tool run from chat shows "Agent", not "Not recorded";
 *  - the stamped column beats a conflicting payload hint (the
 *    stamped record wins over a heuristic read);
 *  - an invalid stamped value is ignored, never invented;
 *  - a job with no provenance anywhere still renders "unknown"
 *    (the honesty rule is unchanged);
 *  - a saga chain uses the trigger its input carries, and stays
 *    "unknown" when none is carried.
 */
import { describe, it, expect } from "vitest";
import {
  buildWorkflowRuns,
  runFromSagaChain,
  triggerLabel,
  type SagaChainRunInput,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";
import { scheduleProvenanceForJobs } from "../src/services/workflowLifecycle";

function job(overrides: Partial<WorkflowRunJobRow> & { job_id: string }): WorkflowRunJobRow {
  return {
    capability: "mcp.tool",
    display_name: "MCP: run_pipeline_chain",
    status: "running",
    created_at: "2026-11-08T21:14:18.000Z",
    payload_json: JSON.stringify({ toolName: "run_pipeline_chain", arguments: {} }),
    ...overrides,
  };
}

describe("workflow runs provenance (#3810)", () => {
  it("records an agent-triggered MCP tool run from the job's own trigger columns", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "mcp-1",
          trigger: "agent",
          triggered_by: "spr9s",
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("agent");
    expect(runs[0].triggerDetail).toContain("spr9s");
    expect(runs[0].triggeredBy).toBe("spr9s");
    expect(triggerLabel("agent")).toBe("Agent");
  });

  it("records an agent trigger even when no actor was stamped", () => {
    const runs = buildWorkflowRuns({
      jobs: [job({ job_id: "mcp-2", trigger: "agent" })],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("agent");
    expect(runs[0].triggerDetail).toMatch(/recorded on the run's job tree/);
    expect(runs[0].triggeredBy).toBeNull();
  });

  it("reads a legacy shard-chain row's trigger and actor from payload.chain (#4415)", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "shard-legacy",
          capability: "shard.execute",
          chain_id: "chain-9",
          payload_json: JSON.stringify({
            shard: { stage: "feed", key: "NASDAQ100" },
            chain: { chainId: "chain-9", userLogin: "venus", trigger: "scheduled", timestamp: "2026-11-08T21:14:18.000Z" },
          }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("scheduled");
    expect(runs[0].triggeredBy).toBe("venus");
  });

  it("attaches a chain-keyed serve outcome to the chain run, not a singleton (#4415)", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "shard-1",
          capability: "shard.execute",
          chain_id: "chain-9",
          payload_json: JSON.stringify({ chain: { chainId: "chain-9", userLogin: "venus", trigger: "scheduled" } }),
        }),
      ],
      outcomes: [
        {
          id: "workflow:chain-9:report",
          kind: "report",
          trigger: "scheduled",
          status: "completed",
          createdAt: "2026-11-08T21:20:00.000Z",
        },
      ],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect((runs[0].outputs as Record<string, any>).outcome?.status).toBe("completed");
  });

  it("records a scheduled run's schedule from the job's schedule column", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "sched-1",
          capability: "followup.report",
          display_name: "Generate report — stock screen",
          status: "completed",
          completed_at: "2026-11-08T21:15:00.000Z",
          trigger: "scheduled",
          schedule_id: "goal-7",
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("scheduled");
    expect(runs[0].schedule).not.toBeNull();
    expect(runs[0].schedule?.identity).toBe("goal-7");
  });

  it("leaves trigger unknown when the job carries no provenance columns", () => {
    const runs = buildWorkflowRuns({
      jobs: [job({ job_id: "plain", payload_json: JSON.stringify({ toolName: "run_pipeline_chain", arguments: {} }) })],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("unknown");
    expect(runs[0].triggerDetail).toMatch(/Not recorded/);
  });

  it("lets the stamped column beat a conflicting payload hint", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "mcp-3",
          trigger: "agent",
          triggered_by: "spr9s",
          payload_json: JSON.stringify({ toolName: "run_pipeline_chain", arguments: {}, trigger: "scheduled" }),
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("agent");
  });

  it("ignores an invalid stamped trigger value instead of inventing one", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({
          job_id: "bogus",
          trigger: "bogus",
        }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].trigger).toBe("unknown");
    expect(runs[0].triggerDetail).toMatch(/Not recorded/);
  });

  it("reads a stamped schedule id for schedule provenance", () => {
    const schedule = scheduleProvenanceForJobs(
      [
        job({
          job_id: "sched-2",
          status: "completed",
          completed_at: "2026-11-08T21:15:00.000Z",
          trigger: "scheduled",
          schedule_id: "daily-qa-sweep",
        }),
      ],
      "scheduled",
      Date.parse("2026-11-08T21:16:00.000Z"),
    );
    expect(schedule).not.toBeNull();
    expect(schedule?.identity).toBe("daily-qa-sweep");
  });

  it("lets a saga chain use the trigger its input carries", () => {
    const input: SagaChainRunInput = {
      sagaId: "saga-1",
      jobs: [
        {
          stage: "done",
          status: "completed",
          updatedAtMs: Date.parse("2026-11-08T21:15:00.000Z"),
          resultJson: {},
          detail: "Saga done",
        },
      ],
      projection: null,
      triggeredBy: "spr9s",
      trigger: "scheduled",
      triggerDetail: "Scheduled — recorded by the saga entry",
    };
    const run = runFromSagaChain(input);
    expect(run).not.toBeNull();
    expect(run!.trigger).toBe("scheduled");
    expect(run!.triggerDetail).toBe("Scheduled — recorded by the saga entry");
  });

  it("leaves a saga chain unknown when its input carries no trigger", () => {
    const input: SagaChainRunInput = {
      sagaId: "saga-2",
      jobs: [
        {
          stage: "done",
          status: "completed",
          updatedAtMs: Date.parse("2026-11-08T21:15:00.000Z"),
          resultJson: {},
          detail: "Saga done",
        },
      ],
      projection: null,
      triggeredBy: "spr9s",
    };
    const run = runFromSagaChain(input);
    expect(run).not.toBeNull();
    expect(run!.trigger).toBe("unknown");
    expect(run!.triggerDetail).toMatch(/Not recorded/);
  });
});
describe("stranded chain (#4419)", () => {
  const feed = (id: string, status: string) =>
    job({
      job_id: id,
      capability: "shard.execute",
      chain_id: "chain-9",
      stage: "feed",
      status,
      payload_json: JSON.stringify({ chain: { chainId: "chain-9" } }),
    });

  it("marks a chain stranded when every feed shard failed and no downstream was planned", () => {
    const runs = buildWorkflowRuns({ jobs: [feed("a", "failed"), feed("b", "failed")], outcomes: [], transitions: [] });
    expect(runs[0].stranded).toBe(true);
  });

  it("does not mark a partially-failed chain stranded", () => {
    const runs = buildWorkflowRuns({
      jobs: [feed("a", "failed"), feed("b", "completed")],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].stranded).toBe(false);
  });

  it("does not mark a chain with a downstream stage stranded", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        feed("a", "failed"),
        job({ job_id: "gen", capability: "shard.execute", chain_id: "chain-9", stage: "generate", status: "queued" }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs[0].stranded).toBe(false);
  });
});