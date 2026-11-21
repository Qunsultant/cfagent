/**
 * Issue #5499 — the universe step serves every index, not nasdaq100 only.
 *
 * Before this pin the step defaulted `ctx.params.index` to "nasdaq100" and
 * REFUSED every other index by name ("maintains the nasdaq100 list only"),
 * while the refresh service underneath already served dow / sp500 / sp100 /
 * nasdaq100 / sp400, the 11 GICS sector lists and the three Russell lists.
 *
 * Two levels are pinned: the rule (`resolveUniverseIndex`, one function) and
 * the handler itself (which index reaches the refresh, what the run records,
 * and that nasdaq100 keeps its exact output).
 */
import { describe, expect, it } from "vitest";
import {
  FEED_UNIVERSE_STEP,
  NASDAQ100_UNIVERSE_JOB_ID,
  createFeedStepRegistry,
  resolveUniverseIndex,
} from "../src/services/feedPipelineJobs";
import type { JobStepContext } from "../src/services/jobPipelineSteps";

const SYMBOLS = [{ symbol: "AAA" }, { symbol: "BBB" }];

function harness() {
  const stored: string[] = [];
  const steps = createFeedStepRegistry({
    registry: {} as never,
    providerFor: () => undefined,
    universeStore: null,
    datasetStore: null,
    indexRefresh: {
      store: {
        store: async (input: { index: string; snapshotDate: string; symbols: unknown[] }) => {
          stored.push(input.index);
          return {
            id: `artifact-${input.index}`,
            index: input.index,
            snapshotDate: input.snapshotDate,
            source: "wikipedia",
            sourceLabel: "test",
            symbols: input.symbols,
          };
        },
      } as never,
      service: {
        getMembers: async (index: string) => ({
          index,
          snapshotDate: "2026-11-21",
          symbols: SYMBOLS,
          source: "wikipedia",
          sourceLabel: "test",
          derivedFromHoldings: false,
        }),
      } as never,
    },
  });
  return { steps, stored };
}

function context(jobId: string, params: Record<string, unknown>): JobStepContext {
  return { jobId, params } as unknown as JobStepContext;
}

describe("#5499 universe step serves every index", () => {
  it("P01 the rule: absent or blank means nasdaq100", () => {
    expect(resolveUniverseIndex({})).toBe("nasdaq100");
    expect(resolveUniverseIndex({ index: "" })).toBe("nasdaq100");
    expect(resolveUniverseIndex({ index: "   " })).toBe("nasdaq100");
  });

  it("P02 the rule: every index the refresh service serves is accepted", () => {
    // The Wikipedia lists, a sector list, and a holdings-only Russell list.
    for (const index of ["dow", "sp500", "sp100", "nasdaq100", "sp400", "sector-energy", "russell2000"]) {
      expect(resolveUniverseIndex({ index }), index).toBe(index);
    }
  });

  it("P03 the rule: an unknown index refuses by name, listing the known ones", () => {
    expect(() => resolveUniverseIndex({ index: "sp900" })).toThrow(
      /does not know index "sp900"[\s\S]*nasdaq100[\s\S]*sector-energy/,
    );
  });

  it("P04 the handler refreshes the index the params name, not nasdaq100", async () => {
    const { steps, stored } = harness();
    const result = await steps.resolve(FEED_UNIVERSE_STEP)(context("job-dow", { index: "dow" }));
    expect(stored).toEqual(["dow"]);
    expect(result.output).toMatchObject({ index: "dow", sourceId: "nasdaq", dataset: "universe" });
    // A run of another index names its own job, never the nasdaq100 one.
    expect(result.output.feedJobId).toBe("job-dow");
    expect(result.descriptor).toContain("dow universe refreshed");
    expect(result.descriptor).toContain("2 members");
  });

  it("P05 the nasdaq100 job keeps its exact output (byte-identical)", async () => {
    const { steps, stored } = harness();
    const result = await steps.resolve(FEED_UNIVERSE_STEP)(context("job-renamed", {}));
    expect(stored).toEqual(["nasdaq100"]);
    expect(result).toMatchObject({
      output: {
        // The constant, not ctx.jobId: the nasdaq100 job's recorded id is
        // unchanged from before this slice.
        feedJobId: NASDAQ100_UNIVERSE_JOB_ID,
        sourceId: "nasdaq",
        dataset: "universe",
        index: "nasdaq100",
        status: "completed",
        artifactId: "artifact-nasdaq100",
        memberCount: 2,
        snapshotDate: "2026-11-21",
        failures: [],
      },
      descriptor: "nasdaq100 universe refreshed: 2 members (snapshot 2026-11-21)",
    });
  });

  it("P06 the handler refuses an unknown index before touching the refresh", async () => {
    const { steps, stored } = harness();
    await expect(
      steps.resolve(FEED_UNIVERSE_STEP)(context("job-x", { index: "sp900" })),
    ).rejects.toThrow(/does not know index "sp900"/);
    expect(stored).toEqual([]);
  });
});
