// @vitest-environment node
/**
 * Issue #5109, Fix 2 — the resilient job-spec exec modes for the OODA job.
 *
 * Pins:
 *  - 5109-F2-P01 the catalog spec carries the resilient combination
 *    (sequential / batch / async / monolith / durable, explicit) and
 *    every one of the six stages carries its per-stage timeoutMs and
 *    retryBucket from the one config home — the wrapper node carries
 *    neither;
 *  - 5109-F2-P02 an env JSON carrier overrides one stage's timeout /
 *    bucket, and an unknown stage, an unknown bucket, or a
 *    non-positive timeout refuses by name — a typo never silently
 *    keeps the default;
 *  - 5109-F2-P03 an explicit per-definition override lands on exactly
 *    the stage it names, leaving the other five on the defaults;
 *  - 5109-F2-P04 the analyze stage timeout exceeds the inner OODA
 *    loop budget (G9 budget alignment): one loop attempt always fits
 *    inside the stage deadline.
 */
import { describe, it, expect } from "vitest";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";
import {
  DEFAULT_RESEARCH_JOB_CONFIG,
  DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS,
  DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS,
  resolveResearchStageTimeouts,
  resolveResearchStageRetryBuckets,
} from "../src/config/researchJobConfig";

const build = (extra?: Record<string, unknown>) =>
  buildResearchJobDefinition("r-exec-modes", {
    userLogin: "trader@example.com",
    trigger: "manual",
    ...(extra ?? {}),
  } as never);

const childrenOf = (definition: ReturnType<typeof build>) =>
  (definition.root.children ?? []) as Array<Record<string, unknown>>;

describe("5109-F2-P01 the resilient combination is on the job", () => {
  it("carries sequential / batch / async / monolith / durable on the root", () => {
    expect(build().root.executionMode).toEqual({
      concurrency: "sequential",
      pacing: "batch",
      delivery: "async",
      shape: "monolith",
      durability: "durable",
    });
  });

  it("gives every stage its per-stage timeout and retry bucket", () => {
    const children = childrenOf(build());
    expect(children.map((c) => c.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
    expect(children.map((c) => c.timeoutMs)).toEqual([
      240_000, 600_000, 600_000, 600_000, 300_000, 600_000,
    ]);
    expect(children.map((c) => c.retryBucket)).toEqual([
      "acquisition",
      "report",
      "report",
      "report",
      "delivery",
      "report",
    ]);
  });

  it("leaves the wrapper node without a stage timeout or bucket", () => {
    const definition = build();
    expect(definition.root.kind).toBe("research");
    expect(definition.root.timeoutMs).toBeUndefined();
    expect(definition.root.retryBucket).toBeUndefined();
  });
});

describe("5109-F2-P02 env carriers override one stage and refuse typos by name", () => {
  it("overrides a single stage timeout from JSON", () => {
    expect(
      resolveResearchStageTimeouts({ RESEARCH_STAGE_TIMEOUTS_MS: '{"deliver":120000}' }),
    ).toEqual({ ...DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS, deliver: 120_000 });
  });

  it("overrides a single stage retry bucket from JSON", () => {
    expect(
      resolveResearchStageRetryBuckets({ RESEARCH_STAGE_RETRY_BUCKETS: '{"feed":"report"}' }),
    ).toEqual({ ...DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS, feed: "report" });
  });

  it("returns the defaults when the carriers are absent", () => {
    expect(resolveResearchStageTimeouts({})).toEqual(DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS);
    expect(resolveResearchStageRetryBuckets({})).toEqual(DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS);
  });

  it("refuses an unknown stage kind", () => {
    expect(() =>
      resolveResearchStageTimeouts({ RESEARCH_STAGE_TIMEOUTS_MS: '{"anaylze":600000}' }),
    ).toThrow(/Unknown research stage "anaylze"/);
    expect(() =>
      resolveResearchStageRetryBuckets({ RESEARCH_STAGE_RETRY_BUCKETS: '{"anaylze":"report"}' }),
    ).toThrow(/Unknown research stage "anaylze"/);
  });

  it("refuses an unknown retry bucket", () => {
    expect(() =>
      resolveResearchStageRetryBuckets({ RESEARCH_STAGE_RETRY_BUCKETS: '{"feed":"urgent"}' }),
    ).toThrow(/Unknown retry bucket "urgent"/);
  });

  it("refuses a non-positive or non-integer timeout and invalid JSON", () => {
    expect(() =>
      resolveResearchStageTimeouts({ RESEARCH_STAGE_TIMEOUTS_MS: '{"feed":0}' }),
    ).toThrow(/must be a positive integer/);
    expect(() =>
      resolveResearchStageTimeouts({ RESEARCH_STAGE_TIMEOUTS_MS: '{"feed":"soon"}' }),
    ).toThrow(/must be a positive integer/);
    expect(() =>
      resolveResearchStageTimeouts({ RESEARCH_STAGE_TIMEOUTS_MS: "not json" }),
    ).toThrow(/not valid JSON/);
  });
});

describe("5109-F2-P03 an explicit override lands on exactly one stage", () => {
  it("overrides the named stage's timeout and bucket only", () => {
    const children = childrenOf(
      build({ stageTimeouts: { deliver: 120_000 }, stageRetryBuckets: { feed: "report" } }),
    );
    expect(children.find((c) => c.kind === "deliver")!.timeoutMs).toBe(120_000);
    expect(children.find((c) => c.kind === "feed")!.retryBucket).toBe("report");
    for (const other of children.filter((c) => c.kind !== "deliver")) {
      expect(
        other.timeoutMs,
        other.kind as string,
      ).toBe(DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS[other.kind as keyof typeof DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS]);
    }
    for (const other of children.filter((c) => c.kind !== "feed")) {
      expect(
        other.retryBucket,
        other.kind as string,
      ).toBe(DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS[other.kind as keyof typeof DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS]);
    }
  });
});

describe("5109-F2-P04 the analyze timeout exceeds the inner OODA budget", () => {
  it("fits one OODA loop attempt inside the stage deadline", () => {
    expect(DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS.analyze).toBeGreaterThan(
      DEFAULT_RESEARCH_JOB_CONFIG.oodaBudgetMs,
    );
  });
});
