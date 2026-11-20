// @vitest-environment node
/**
 * The OODA job's stage wiring, pinned.
 *
 * The catalogue declares `step: "noop"` for feed / enrich / generate /
 * deliver; `buildResearchJobDefinition` rewrites each child to its own
 * registered step. Before this pin only the children's KINDS were asserted,
 * so a regression in that rewrite would have turned four stages into silent
 * no-ops while every existing test still passed — and a run would still have
 * reported "6/6 stages".
 */
import { describe, it, expect } from "vitest";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";

const definition = buildResearchJobDefinition("r-stage-pin", {
  userLogin: "trader@example.com",
  trigger: "manual",
} as never);

describe("research job — every stage runs its own step", () => {
  it("binds the six stages to feed → enrich → analyze → generate → deliver → evaluate", () => {
    const children = definition.root.children ?? [];
    expect(children.map((child) => child.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
  });

  it("replaces the catalogue's noop with the registered step on every child", () => {
    const children = definition.root.children ?? [];
    expect(children.map((child) => child.steps?.[0]?.step)).toEqual([
      "research.feed",
      "research.enrich",
      "analyze.ooda",
      "research.generate",
      "research.deliver",
      "evaluate.apply",
    ]);
  });

  it("keeps the container's own step a noop — the work is in the children", () => {
    expect(definition.root.steps?.[0]?.step).toBe("noop");
  });
});
