// @vitest-environment node
/**
 * Issue #6362 — the OODA page's per-stage controls, the past-run verb.
 *
 * The page already offered Run / Re-run / Stop / Resume / Cancel per stage
 * (#5917). What it did not offer was **Replay** — replaying one stage of the
 * run on screen as its own new execution — because the op did not exist. #6400
 * built it; this pins the surface that calls it:
 *
 *  - 6362-P01 `replay` mints a NEW engine run holding that one stage, from the
 *    run's recorded input, and the stage's dep actually executes again;
 *  - 6362-P02 the stages AFTER it do not re-execute (the #6400 downstream rule,
 *    at the surface the operator uses);
 *  - 6362-P03 the original run's record survives untouched (`original`,
 *    `success`), and the new record is `replay` with the origin link;
 *  - 6362-P04 the OODA page's action table offers Replay beside Re-run for a
 *    settled stage, and never for a live one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeResearchStageControl } from "../src/workflows/researchScreenEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";

const RUN_ID = "run-6362-replay";

function harness() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const runRecorder = jobRunRecorderFromStore(runStore);
  const calls = { feed: 0, enrich: 0 };
  const researchDeps = {
    runFeedStage: async (input: { runId: string; userLogin: string }) => {
      calls.feed += 1;
      return {
        runId: input.runId,
        asOf: "2026-11-26T00:00:00.000Z",
        regime: null,
        universe: "NASDAQ100",
        universeError: null,
        symbols: ["AAPL"],
        quotes: [{ symbol: "AAPL", last: 100 }],
        universeSize: 1,
        quotesRetrieved: 1,
      };
    },
    runEnrichStage: async () => {
      calls.enrich += 1;
      return {
        bySymbol: { AAPL: { score: 1 } },
        quotes: [{ symbol: "AAPL", last: 100 }],
      };
    },
  };
  return {
    stores,
    runStore,
    calls,
    control: (op: "run" | "replay", stageId: "feed" | "enrich") =>
      executeResearchStageControl({
        runId: RUN_ID,
        userLogin: "owner",
        stageId,
        op,
        stores,
        runRecorder,
        researchDeps,
      } as never),
  };
}

describe("6362-P01 replay is a NEW run of that one stage, and it really executes", () => {
  it("re-executes the stage and reports the new run id", async () => {
    const h = harness();
    const first = await h.control("run", "feed");
    expect(first.jobState).toBe("completed");
    const firstRunId = first.engineRunId;
    expect(firstRunId).toBeTruthy();
    expect(h.calls.feed).toBe(1);
    expect(h.calls.enrich).toBe(1);

    const replayed = await h.control("replay", "feed");

    expect(h.calls.feed).toBe(2); // the stage ran again...
    expect(replayed.engineRunId).not.toBe(firstRunId); // ...as its own run
    expect(replayed.jobState).toBe("completed");
    expect(replayed.stage?.kind).toBe("feed");
  });
});

describe("6362-P02 the stages after the replayed one do not re-execute", () => {
  it("leaves the downstream stage alone", async () => {
    const h = harness();
    await h.control("run", "feed");
    expect(h.calls.enrich).toBe(1);

    await h.control("replay", "feed");

    expect(h.calls.enrich).toBe(1);
  });
});

describe("6362-P03 the original run's records survive", () => {
  it("keeps the original row and links the replay to it", async () => {
    const h = harness();
    const first = await h.control("run", "feed");
    const replayed = await h.control("replay", "feed");

    const records = h.runStore.listByJob(first.engineJobId, 10);
    const original = records.find((record) => record.workflowId === first.engineRunId);
    const replay = records.find((record) => record.workflowId === replayed.engineRunId);
    expect(original?.kind).toBe("original");
    expect(original?.outcome).toBe("success");
    expect(replay?.kind).toBe("replay");
    expect(replay?.originRunId).toBe(first.engineRunId);
    expect(replay?.definitionVersion).toBe(1);
    expect(replay?.descriptor).toContain("replay of job:0");
  });
});

describe("6362-P05 a run with no recorded definition refuses instead of replaying defaults", () => {
  it("never rebuilds a default definition under a replay", async () => {
    const h = harness();
    // No run, no definition: the wrapper's other ops rebuild a default one
    // (#6401). A replay must not — that would reproduce a configuration the
    // run never executed.
    await expect(h.control("replay", "feed")).rejects.toThrow(
      /cannot be replayed: no definition is recorded/,
    );
  });
});

describe("6362-P04 the OODA page offers Replay beside Re-run, only when settled", () => {
  it("adds replay to the settled rows' action table and to live rows never", () => {
    const panel = readFileSync(
      join(process.cwd(), "src/client/options/ResearchRunsPanel.tsx"),
      "utf8",
    );
    const table = panel.slice(
      panel.indexOf("const STAGE_ACTIONS"),
      panel.indexOf("};", panel.indexOf("const STAGE_ACTIONS")),
    );
    const settled = (status: string) => {
      const start = table.indexOf(`${status}: [`);
      expect(start).toBeGreaterThan(-1);
      return table.slice(start, table.indexOf("],", start));
    };
    expect(settled("completed")).toContain('op: "replay"');
    expect(settled("failed")).toContain('op: "replay"');
    // A live run's stages belong to the run; only settled stages replay.
    expect(settled("running")).not.toContain('op: "replay"');
    expect(settled("pending")).not.toContain('op: "replay"');
    expect(settled("stopped")).not.toContain('op: "replay"');
  });
});
