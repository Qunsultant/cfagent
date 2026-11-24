/**
 * Issue #773 (a) — the run report states what the evaluation history did.
 *
 * The parent's remainder is "feed evaluation outcomes back into the gates and
 * ranking". Slice (a) is the visible half: a run reads the latest evaluation
 * history at start and **says on its own report** whether that history changed
 * a decision — or why it could not. No behaviour changes here; (b) is the
 * ranking weight.
 *
 * The pin also records a real finding: `TrackRecordSlice` carries `evaluated`,
 * `winRate` and `avgRMultiple`, but **no per-family direction accuracy**, which
 * is what the existing structure reorder reads (`researchPipeline.ts`, the
 * `(#773: reorder structures by historical direction accuracy` block). So the
 * reorder is inert today, and the honest report says so instead of reporting a
 * neutral order as if it were a decision. (b) either records the accuracy on
 * the slice or names win rate as the ordering input.
 */
import { describe, it, expect } from "vitest";
import { runResearchPipeline, type PipelineDeps } from "../src/services/researchPipeline";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import type { TrackRecord } from "../src/services/researchTrackRecord";

const config = { ...RESEARCH_CONFIG_DEFAULTS };

function trackRecord(over: Partial<TrackRecord> = {}): TrackRecord {
  return {
    published: 12,
    evaluated: 12,
    invalidated: 0,
    winRate: 0.5,
    directionAccuracy: 0.5,
    avgPnlPerUnit: 0,
    avgRMultiple: 0.5,
    byStrategy: [],
    byPeriod: [],
    ideas: [],
    ...over,
  };
}

/** A provider that refuses the universe, so the run finishes without network. */
function refusingDeps(track?: TrackRecord): PipelineDeps {
  return {
    provider: {
      resolveUniverse: async () => {
        throw new Error("no universe in this pin");
      },
    } as unknown as PipelineDeps["provider"],
    ...(track ? { trackRecord: track } : {}),
  };
}

async function runWith(track?: TrackRecord) {
  return runResearchPipeline(refusingDeps(track), config, {
    trigger: "manual",
    userLogin: "trader@example.com",
    accountType: "paper",
  });
}

describe("#773 (a) — the report states the evaluation history", () => {
  it("P1: with no evaluations yet, the report says the loop has nothing to feed back", async () => {
    const report = await runWith(trackRecord({ published: 0, evaluated: 0, winRate: null }));
    expect(report.evaluationFeedback.source).toBe("track-record");
    expect(report.evaluationFeedback.evaluated).toBe(0);
    expect(report.evaluationFeedback.orderingApplied).toBe(false);
    expect(report.evaluationFeedback.statement).toMatch(/nothing to feed back/i);
  });

  it("P2: with evaluated ideas but no per-family accuracy, the report says why the order was not changed", async () => {
    const report = await runWith(
      trackRecord({
        byStrategy: [
          { key: "long_call", published: 12, evaluated: 12, winRate: 0.25, avgRMultiple: -0.4 },
          { key: "iron_condor", published: 8, evaluated: 8, winRate: 0.75, avgRMultiple: 0.6 },
        ],
      }),
    );
    const feedback = report.evaluationFeedback;
    expect(feedback.evaluated).toBe(12);
    expect(feedback.families).toEqual([
      {
        key: "long_call",
        evaluated: 12,
        winRate: 0.25,
        avgRMultiple: -0.4,
        directionAccuracy: null,
        directionAccuracyRecorded: false,
      },
      {
        key: "iron_condor",
        evaluated: 8,
        winRate: 0.75,
        avgRMultiple: 0.6,
        directionAccuracy: null,
        directionAccuracyRecorded: false,
      },
    ]);
    // Honest: the history was read, and it did not reorder anything.
    expect(feedback.orderingApplied).toBe(false);
    expect(feedback.statement).toMatch(/no family records a per-family direction accuracy/i);
    expect(feedback.statement).toMatch(/win rates are recorded and shown/i);
  });

  it("P3: a family that does carry direction accuracy at the bar is named as orderable", async () => {
    const slice = {
      key: "long_call",
      published: 12,
      evaluated: 12,
      winRate: 0.25,
      avgRMultiple: -0.4,
      // The shape the reorder reads; the type does not declare it yet (the finding).
      directionAccuracy: 0.3,
    } as never;
    const report = await runWith(trackRecord({ byStrategy: [slice] }));
    expect(report.evaluationFeedback.families[0].directionAccuracyRecorded).toBe(true);
    expect(report.evaluationFeedback.statement).toMatch(/1 met the 10-evaluation bar for ordering/i);
  });

  it("P4: the bar is stated on the report, not hidden in code", async () => {
    const report = await runWith(trackRecord({ byStrategy: [] }));
    expect(report.evaluationFeedback.minEvaluated).toBe(10);
  });
});
