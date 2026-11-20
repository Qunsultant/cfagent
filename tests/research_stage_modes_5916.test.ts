// @vitest-environment node
/**
 * Issue #5916 — per-stage execution modes for the OODA job.
 *
 * Pins:
 *  - 5916-P01 with no overrides every stage runs the job's mode (no child
 *    carries its own executionMode) — today's behaviour;
 *  - 5916-P02 an override lands on exactly the stage it names, merged per
 *    axis, leaving the other five untouched;
 *  - 5916-P03 an unknown stage kind, an unknown axis, a non-string value or
 *    invalid JSON refuses by name — a typo never silently keeps the job mode.
 */
import { describe, it, expect } from "vitest";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";
import { resolveResearchStageModes } from "../src/config/researchJobConfig";

const build = (stageModes?: Record<string, Record<string, string>>) =>
  buildResearchJobDefinition("r-modes", {
    userLogin: "trader@example.com",
    trigger: "manual",
    ...(stageModes ? { stageModes } : {}),
  } as never);

describe("5916-P01 no overrides — every stage runs the job's mode", () => {
  it("leaves all six children without their own executionMode", () => {
    const children = build().root.children ?? [];
    expect(children.map((c) => c.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
    for (const child of children) {
      expect(child.executionMode, child.kind).toBeUndefined();
    }
  });
});

describe("5916-P02 an override lands on exactly one stage", () => {
  it("merges the axis onto analyze and nothing else", () => {
    const children = build({ analyze: { delivery: "sync" } }).root.children ?? [];
    const analyze = children.find((c) => c.kind === "analyze")!;
    expect(analyze.executionMode).toEqual({ delivery: "sync" });
    for (const other of children.filter((c) => c.kind !== "analyze")) {
      expect(other.executionMode, other.kind).toBeUndefined();
    }
  });

  it("keeps two axes when both are given", () => {
    const children = build({ deliver: { delivery: "sync", pacing: "stream" } }).root.children ?? [];
    expect(children.find((c) => c.kind === "deliver")!.executionMode).toEqual({
      delivery: "sync",
      pacing: "stream",
    });
  });
});

describe("5916-P03 config refusals are named", () => {
  it("refuses an unknown stage kind", () => {
    expect(() =>
      resolveResearchStageModes({ RESEARCH_STAGE_MODES: '{"anaylze":{"delivery":"sync"}}' }),
    ).toThrow(/Unknown research stage "anaylze"/);
  });

  it("refuses an unknown execution-mode axis", () => {
    expect(() =>
      resolveResearchStageModes({ RESEARCH_STAGE_MODES: '{"analyze":{"delivry":"sync"}}' }),
    ).toThrow(/Unknown execution-mode axis "delivry"/);
  });

  it("refuses a non-string value and invalid JSON", () => {
    expect(() =>
      resolveResearchStageModes({ RESEARCH_STAGE_MODES: '{"analyze":{"delivery":5}}' }),
    ).toThrow(/must be a non-empty string/);
    expect(() =>
      resolveResearchStageModes({ RESEARCH_STAGE_MODES: "not json" }),
    ).toThrow(/not valid JSON/);
  });

  it("accepts an empty config", () => {
    expect(resolveResearchStageModes({})).toEqual({});
    expect(resolveResearchStageModes()).toEqual({});
  });
});
