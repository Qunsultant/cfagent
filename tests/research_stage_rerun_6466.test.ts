/**
 * Issue #6466 part 5 — a failed stage on a run with a stamped instance is
 * restartable via the existing stage control.
 *
 * Proof at the research wrapper level (not just the engine's rerunStage):
 * run the feed stage with a failing dep, so the stage records failed; then
 * re-run the same stage through `executeResearchStageControl` with a
 * succeeding dep, and the stage records completed. The restart re-executes
 * the stage — it does not merely flip its status.
 *
 * TDD Red first: this file pins the path the slice must keep working. The
 * wrapper already implements it; the pin guards the #6466 changes (stamp +
 * limits) against breaking it.
 */
import { describe, it, expect } from "vitest";
import { executeResearchStageControl } from "../src/workflows/researchScreenEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";

describe("#6466 — a failed research stage restarts through the stage control", () => {
  it("rerun re-executes a failed feed stage and records it completed", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    let feedCalls = 0;
    // The feed stage retries under the `acquisition` bucket (3 attempts),
    // so the dep must fail three times to exhaust the budget and fail the
    // stage; the rerun then succeeds on the fourth call.
    const feedDep = async (input: { runId: string; userLogin: string; trigger: "manual" | "scheduled" }) => {
      feedCalls += 1;
      if (feedCalls <= 3) throw new Error("feed provider down");
      return {
        runId: input.runId,
        asOf: new Date().toISOString(),
        regime: null,
        universe: "NASDAQ100",
        universeError: null,
        symbols: ["AAPL"],
        quotes: [],
        universeSize: 1,
        quotesRetrieved: 0,
      };
    };
    const base = {
      runId: "run-6466-rerun",
      userLogin: "owner",
      stores,
      runRecorder,
      researchDeps: { runFeedStage: feedDep },
    } as const;

    const failed = await executeResearchStageControl({
      ...base,
      stageId: "feed",
      op: "run",
    });
    expect(failed.jobState).toBe("failed");
    expect(failed.stage?.kind).toBe("feed");
    expect(failed.stage?.units.some((u) => u.status === "failed")).toBe(true);
    expect(feedCalls).toBe(3);

    const rerun = await executeResearchStageControl({
      ...base,
      stageId: "feed",
      op: "rerun",
    });
    expect(feedCalls).toBe(4);
    expect(rerun.stage?.kind).toBe("feed");
    expect(rerun.stage?.units.every((u) => u.status === "completed")).toBe(true);
  });
});
