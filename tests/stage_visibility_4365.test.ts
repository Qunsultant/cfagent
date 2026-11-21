// @vitest-environment node
/**
 * Issue #4365 ([Stage visibility] externalized, parameterized definitions).
 *
 * Pins:
 *  - 4365-P01 a job definition exists as an externalized, addressable spec
 *    (id + version + stages + mode + schedule defaults), listed by id.
 *  - 4365-P02 validation refuses by name at load time: no stages, a stage
 *    without a step, an invalid mode, a non-object — never a partial job.
 *  - 4365-P03 the screener's five nodes and its mode LOAD FROM the spec: the
 *    built definition's kinds, steps and mode equal the catalog's.
 *    (Six nodes until the 6b3 flip #5884, which re-pointed the
 *    spec onto the generic five-stage chain.)
 *  - 4365-P04 the typed constants are the spec's projection (a parity pin,
 *    not a second definition). (They moved with the builder in
 *    the 6b3 flip #5884: the same five generic steps, as
 *    string literals — the family constants would cycle.)
 *  - 4365-P05 stage parameters merge over the run's parameters, per stage.
 *    (Since the 6b3 flip #5884 the analyze + generate stages
 *    carry params — ruleSets/inputMode, reports — and the
 *    builder injects the per-command family job ids; the
 *    "stages carry no params" shape is gone with the flip.)
 */
import { describe, expect, it } from "vitest";
import {
  JOB_DEFINITION_SPECS,
  jobDefinitionSpec,
  listJobDefinitionSpecs,
  resolveJobDefinitionSpec,
} from "../src/config/jobDefinitionCatalog";
import {
  SCREENER_NODE_KINDS,
  SCREENER_NODE_STEPS,
  buildScreenerJobDefinition,
} from "../src/services/screenerPipelineJobs";

function command(over: Record<string, unknown> = {}) {
  return {
    jobId: "screen-4365",
    type: "run-screen" as const,
    source: "mesh-door",
    trigger: "manual" as const,
    userLogin: "owner",
    role: "parent" as const,
    shards: [{ id: "shard-1", symbol: "AAPL" }],
    filters: {},
    ...over,
  } as never;
}

function chainKindsAndSteps(def: any): Array<{ kind: string; step: string }> {
  const out: Array<{ kind: string; step: string }> = [];
  let node = def.root;
  while (node) {
    out.push({ kind: node.kind, step: node.steps[0].step });
    node = node.children?.[0];
  }
  return out;
}

describe("4365-P01 the definition is an externalized, addressable spec", () => {
  it("lists the screener spec with id, version, stages, mode and schedule", () => {
    const specs = listJobDefinitionSpecs();
    const screener = specs.find((spec) => spec.id === "screener")!;
    expect(screener).toBeTruthy();
    expect(screener.version).toBeGreaterThanOrEqual(1);
    expect(screener.stages.map((s) => s.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
    ]);
    expect(screener.executionMode).toBeTruthy();
    expect(screener.schedule).toEqual({ enabled: false });
  });

  it("addresses a spec by id and refuses an unknown id with the ids that exist", () => {
    expect(jobDefinitionSpec("screener").id).toBe("screener");
    expect(() => jobDefinitionSpec("nope")).toThrow(/No job definition spec with id "nope"/);
    expect(() => jobDefinitionSpec("nope")).toThrow(/screener/);
    expect(Object.keys(JOB_DEFINITION_SPECS)).toContain("screener");
  });
});

describe("4365-P02 validation refuses by name", () => {
  const base = { id: "x", name: "X", version: 1, stages: [{ kind: "feed", step: "s.feed" }] };

  it("refuses a definition with no stages", () => {
    expect(() => resolveJobDefinitionSpec({ ...base, stages: [] })).toThrow(/declares no stages/);
  });

  it("refuses a stage without a step, naming the field", () => {
    expect(() => resolveJobDefinitionSpec({ ...base, stages: [{ kind: "feed" }] })).toThrow(
      /stage 0 step must be a non-empty string/,
    );
  });

  it("refuses a stage without a kind", () => {
    expect(() => resolveJobDefinitionSpec({ ...base, stages: [{ step: "s.feed" }] })).toThrow(
      /stage 0 kind must be a non-empty string/,
    );
  });

  it("refuses an unsupported mode through the engine resolver", () => {
    expect(() =>
      resolveJobDefinitionSpec({
        ...base,
        executionMode: { pacing: "online", delivery: "sync" },
      }),
    ).toThrow(/online\+sync is unsupported/);
  });

  it("refuses a non-object spec", () => {
    expect(() => resolveJobDefinitionSpec("nope")).toThrow(/must be an object/);
  });
});

describe("4365-P03 the screener loads from the spec", () => {
  it("builds the five stages with the spec's steps and mode", () => {
    const def = buildScreenerJobDefinition(command()) as any;
    const spec = jobDefinitionSpec("screener");
    expect(chainKindsAndSteps(def)).toEqual(spec.stages.map((s) => ({ kind: s.kind, step: s.step })));
    expect(def.root.executionMode).toEqual(
      expect.objectContaining({ concurrency: "sequential", pacing: "batch", delivery: "async" }),
    );
  });

  it("keeps the caller's mode override from #4363", () => {
    const def = buildScreenerJobDefinition(
      command({ executionMode: { concurrency: "parallel" } }),
    ) as any;
    expect(def.root.executionMode.concurrency).toBe("parallel");
  });
});

describe("4365-P04 the typed constants are the spec's projection", () => {
  it("SCREENER_NODE_KINDS and SCREENER_NODE_STEPS equal the catalog", () => {
    const spec = jobDefinitionSpec("screener");
    expect([...SCREENER_NODE_KINDS]).toEqual(spec.stages.map((s) => s.kind));
    for (const stage of spec.stages) {
      expect(SCREENER_NODE_STEPS[stage.kind as keyof typeof SCREENER_NODE_STEPS]).toBe(stage.step);
    }
  });
});

describe("4365-P05 stage parameters merge over the run's", () => {
  it("applies a stage's own params on top of the run params", () => {
    const spec = resolveJobDefinitionSpec({
      id: "with-params",
      name: "With params",
      version: 2,
      stages: [
        { kind: "feed", step: "s.feed", params: { top: 5 } },
        { kind: "deliver", step: "s.deliver", params: { channel: "email" } },
      ],
    });
    expect(spec.stages[0].params).toEqual({ top: 5 });
    expect(spec.stages[1].params).toEqual({ channel: "email" });
    // Since the 6b3 flip #5884 the screener's stages DO carry
    // params: analyze carries ruleSets + inputMode, generate
    // carries reports; feed/enrich carry none. Since the 6c
    // flip #5885 deliver carries the screener marker. The
    // run's params still ride as-is underneath.
    const byKind = new Map(
      jobDefinitionSpec("screener").stages.map((s) => [s.kind, s.params]),
    );
    expect(byKind.get("analyze")).toEqual({ ruleSets: ["screen", "factors"], inputMode: "handOff" });
    expect(byKind.get("generate")).toEqual({ reports: ["screener-report"] });
    expect(byKind.get("deliver")).toEqual({ screener: true });
    expect(byKind.get("feed")).toBeUndefined();
    expect(byKind.get("enrich")).toBeUndefined();
  });
});
