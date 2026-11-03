/**
 * Issue #3039 — the run detail must READ what the contract records.
 * #3028 put `fanoutCapReason` / `resumedSkippedUnits` on the collation;
 * these pins hold the projection (model) and the render (panel).
 */
import { describe, expect, it } from "vitest";
import { runFromJobs, type WorkflowRunJobRow } from "../src/services/workflowRuns";

function job(overrides: Partial<WorkflowRunJobRow> & { job_id: string }): WorkflowRunJobRow {
  return {
    capability: "screener.workflow",
    display_name: "Options screen — TSLA",
    status: "completed",
    created_at: "2026-11-03T00:00:00.000Z",
    completed_at: "2026-11-03T00:01:00.000Z",
    job_kind: "main",
    chain_id: "job-3028",
    stage: "generate",
    ...overrides,
  };
}

function chainWithResult(resultJson: string): WorkflowRunJobRow[] {
  return [job({ job_id: "job-3028", result_json: resultJson })];
}

describe("workflow run model reads the collation (#3039)", () => {
  it("projects the cap reason and the resumed units from the parent row", () => {
    const run = runFromJobs(
      chainWithResult(
        JSON.stringify({
          shardJobIds: ["job-3028"],
          result: {
            jobId: "job-3028",
            lifecycle: "Completed",
            fanoutCapReason: "fanout_cap_exceeded: 1 unit(s) deferred on stage analysis at maxParallel 2 (S5)",
            resumedSkippedUnits: ["S1", "S2"],
          },
        }),
      ),
      [],
    );
    expect(run.fanoutCapReason).toContain("fanout_cap_exceeded");
    expect(run.fanoutCapReason).toContain("S5");
    expect(run.resumedSkippedUnits).toEqual(["S1", "S2"]);
  });

  it("is absent (null / []) when the collation recorded neither — never invented", () => {
    const run = runFromJobs(
      chainWithResult(JSON.stringify({ shardJobIds: ["job-3028"], result: { lifecycle: "Completed" } })),
      [],
    );
    expect(run.fanoutCapReason).toBeNull();
    expect(run.resumedSkippedUnits).toEqual([]);
  });

  it("degrades to absent on an unreadable result instead of throwing", () => {
    const run = runFromJobs(chainWithResult("not-json{"), []);
    expect(run.fanoutCapReason).toBeNull();
    expect(run.resumedSkippedUnits).toEqual([]);
  });

  it("ignores a malformed field shape rather than trusting it", () => {
    const run = runFromJobs(
      chainWithResult(
        JSON.stringify({
          result: { fanoutCapReason: 42, resumedSkippedUnits: ["S1", 7, null] },
        }),
      ),
      [],
    );
    expect(run.fanoutCapReason).toBeNull();
    expect(run.resumedSkippedUnits).toEqual(["S1"]);
  });
});
