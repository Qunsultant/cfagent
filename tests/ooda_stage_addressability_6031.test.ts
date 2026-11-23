// @vitest-environment node
/**
 * Issue #6031 — the OODA spec's six stages are addressable.
 *
 * The `research` spec nests `feed → enrich → analyze → generate → deliver →
 * evaluate` under one `research` wrapper node. Three things followed from
 * that: the Define page rendered ONE stage row, `bindStageOverrides` judged
 * `stageModes` against the top level only (so `{ analyze: … }` refused with
 * "its stages are: research"), and the spec declared no `universe`,
 * `brokerId` or `mode` parameter. Per-stage mode was therefore reachable
 * only through `RESEARCH_STAGE_MODES` — a process-global env var.
 *
 * This pin holds the fix: `addressableStages` walks the tree, the binder and
 * the flow use it, the built definition carries the override on the child
 * node the engine actually executes, and the run-level parameters the Define
 * page collects are declared by the spec.
 */
import { describe, expect, it } from "vitest";
import {
  addressableStages,
  JOB_DEFINITION_SPECS,
  jobDefinitionSpec,
} from "../src/config/jobDefinitionCatalog";
import { resolveEnumSource } from "../src/config/jobDefinitionParamRegistry";
import {
  bindJobDefinitionParams,
  bindStageOverrides,
} from "../src/services/jobDefinitionParamBinders";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { researchUniverseIds } from "../src/trading";

const RESEARCH_KINDS = ["feed", "enrich", "analyze", "generate", "deliver", "evaluate"];

describe("#6031 the research spec's six stages are addressable", () => {
  it("addressableStages walks the nested spec to the six real kinds", () => {
    const spec = jobDefinitionSpec("research");
    expect(spec.stages.map((stage) => stage.kind)).toEqual(["research"]);
    expect(addressableStages(spec).map((stage) => stage.kind)).toEqual(RESEARCH_KINDS);
  });

  it("the flow's list is the executable stages of every spec (no client-side list)", () => {
    for (const spec of Object.values(JOB_DEFINITION_SPECS)) {
      const flat = addressableStages(spec).map((stage) => stage.kind);
      expect(flat.length).toBeGreaterThan(0);
      // No container is addressable; every leaf of the tree is.
      for (const stage of spec.stages) {
        if (stage.children && stage.children.length > 0) expect(flat).not.toContain(stage.kind);
        else expect(flat).toContain(stage.kind);
      }
    }
  });

  it("a per-stage mode targeting a child stage is accepted", () => {
    const spec = jobDefinitionSpec("research");
    const perStage = bindStageOverrides(spec, {
      stageModes: { analyze: { pacing: "online" }, deliver: { delivery: "sync" } },
    });
    expect(perStage.modes).toEqual({
      analyze: { pacing: "online" },
      deliver: { delivery: "sync" },
    });
  });

  it("the built definition carries the override on the child node, not the wrapper", () => {
    const spec = jobDefinitionSpec("research");
    const perStage = bindStageOverrides(spec, {
      stageModes: { analyze: { pacing: "online" } },
    });
    const built = buildJobConfigFromSpec(spec, "research:test", {}, perStage);
    const root = built.root as Record<string, unknown> & {
      children?: Array<Record<string, unknown>>;
    };
    // The wrapper takes the job mode only; the override lands on analyze.
    expect((root.executionMode as Record<string, string> | undefined)?.pacing ?? "batch").toBe(
      "batch",
    );
    const analyze = root.children?.find((child) => child.kind === "analyze");
    expect((analyze?.executionMode as Record<string, string>).pacing).toBe("online");
    const feed = root.children?.find((child) => child.kind === "feed");
    expect(feed?.executionMode).toBeUndefined();
  });

  it("an unknown stage still refuses by name, listing the addressable kinds", () => {
    const spec = jobDefinitionSpec("research");
    try {
      bindStageOverrides(spec, { stageModes: { nope: { pacing: "online" } } });
      throw new Error("expected a refusal");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('has no stage "nope"');
      for (const kind of RESEARCH_KINDS) expect(message).toContain(kind);
    }
  });

  it("the research spec declares the run parameters the Define page collects", () => {
    const spec = jobDefinitionSpec("research");
    const names = (spec.parameters ?? []).map((param) => param.name);
    expect(names).toEqual(expect.arrayContaining(["universe", "brokerId", "mode"]));

    const universe = (spec.parameters ?? []).find((param) => param.name === "universe");
    expect(universe?.type).toBe("select");
    expect(universe?.enumSource).toBe("universes");
    // The enum source is the accepted set (#6032), not the raw registry.
    expect(resolveEnumSource("universes", "research")).toEqual(researchUniverseIds());
    expect(resolveEnumSource("universes", "research")).not.toContain("ALL");
  });

  it("those parameters bind through the existing binder", () => {
    const spec = jobDefinitionSpec("research");
    const bound = bindJobDefinitionParams(
      spec,
      { universe: "SP500", brokerId: "alpaca", mode: "live" },
      "owner-1",
    );
    expect(bound.universe).toBe("SP500");
    expect(bound.brokerId).toBe("alpaca");
    expect(bound.mode).toBe("live");
    expect(bound.userLogin).toBe("owner-1");
  });

  it("the screener spec's stage modes are unaffected", () => {
    const spec = jobDefinitionSpec("screener");
    const perStage = bindStageOverrides(spec, { stageModes: { analyze: { pacing: "online" } } });
    expect(perStage.modes).toEqual({ analyze: { pacing: "online" } });
    expect(addressableStages(spec)).toHaveLength(spec.stages.length);
  });
});
