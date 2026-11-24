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

describe("research job — every stage's step carries the bound owner and trigger", () => {
  it("passes userLogin, trigger and runId to feed / enrich / generate / deliver (issue #6355)", () => {
    const children = definition.root.children ?? [];
    for (const kind of ["feed", "enrich", "generate", "deliver"] as const) {
      const child = children.find((c) => c.kind === kind)!;
      const params = (child.steps?.[0]?.params ?? {}) as Record<string, unknown>;
      expect(params.userLogin).toBe("trader@example.com");
      expect(params.trigger).toBe("manual");
      expect(params.runId).toBe("r-stage-pin");
    }
  });

  it("keeps userLogin and trigger on analyze and evaluate too", () => {
    const children = definition.root.children ?? [];
    for (const kind of ["analyze", "evaluate"] as const) {
      const child = children.find((c) => c.kind === kind)!;
      const params = (child.steps?.[0]?.params ?? {}) as Record<string, unknown>;
      expect(params.userLogin).toBe("trader@example.com");
      expect(params.trigger).toBe("manual");
    }
  });
});
