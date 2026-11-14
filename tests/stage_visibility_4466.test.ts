// @vitest-environment node
/**
 * Issue #4466 ([Stage visibility] per-stage parameters and execution mode).
 *
 * The engine already supports both: `JobNodeConfig.executionMode` is a
 * per-node override merged by `effectiveMode`, and `steps[].params` carries
 * per-stage parameters. This issue is the SPEC + FLOW surface for them.
 *
 * Pins:
 *  - 4466-P01 a spec stage may declare parameters and a mode override; an
 *    invalid stage mode refuses by name at load time.
 *  - 4466-P02 the builder puts both on the node (mode override, merged step
 *    params) without touching the job's own mode.
 *  - 4466-P03 the flow's per-stage values are validated: unknown stage,
 *    undeclared stage parameter, missing required one, invalid mode.
 *  - 4466-P04 the route carries stageModes/stageParams to the host, and the
 *    client sends them.
 *  - 4466-P05 the engine honors the per-node override (the capability this
 *    surfaces already exists).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobDefinitionSpec, resolveJobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { bindStageOverrides } from "../src/services/jobDefinitionParamBinders";
import { handleJobDefinitionsRoutes } from "../src/agents/routes/jobDefinitions";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function nodeByKind(rootNode: any, kind: string): any {
  let node = rootNode;
  while (node) {
    if (node.kind === kind) return node;
    node = node.children?.[0];
  }
  return null;
}

const SPEC_WITH_STAGE_INPUTS = {
  id: "stage-inputs",
  name: "Stage inputs",
  version: 1,
  executionMode: { concurrency: "sequential", pacing: "batch", delivery: "async", shape: "monolith" },
  stages: [
    {
      kind: "feed",
      step: "s.feed",
      parameters: [{ name: "maxItems", label: "Max items", type: "number", required: true }],
    },
    {
      kind: "deliver",
      step: "s.deliver",
      parameters: [{ name: "channel", label: "Channel", type: "select", options: ["slack", "email"] }],
    },
  ],
};

describe("4466-P01 a stage declares parameters and a mode override", () => {
  it("resolves them from the spec", () => {
    const spec = resolveJobDefinitionSpec({
      ...SPEC_WITH_STAGE_INPUTS,
      stages: [
        { ...SPEC_WITH_STAGE_INPUTS.stages[0], executionMode: { concurrency: "parallel" } },
        SPEC_WITH_STAGE_INPUTS.stages[1],
      ],
    });
    expect(spec.stages[0].parameters?.[0].name).toBe("maxItems");
    expect(spec.stages[0].executionMode).toEqual({ concurrency: "parallel" });
  });

  it("refuses an invalid stage mode by name", () => {
    expect(() =>
      resolveJobDefinitionSpec({
        ...SPEC_WITH_STAGE_INPUTS,
        stages: [
          { kind: "feed", step: "s.feed", executionMode: { pacing: "online", delivery: "sync" } },
        ],
      }),
    ).toThrow(/stage 0 is invalid: .*online\+sync is unsupported/);
  });
});

describe("4466-P02 the builder puts them on the node", () => {
  it("sets the stage mode override and merges the stage params", () => {
    const spec = resolveJobDefinitionSpec(SPEC_WITH_STAGE_INPUTS);
    const config = buildJobConfigFromSpec(
      spec,
      "job-4466",
      { userLogin: "owner" },
      {
        params: { feed: { maxItems: 25 } },
        modes: { feed: { concurrency: "parallel" }, deliver: { delivery: "sync" } },
      },
    );
    const feed = nodeByKind(config.root, "feed");
    const deliver = nodeByKind(config.root, "deliver");
    expect(feed.executionMode).toEqual({ concurrency: "parallel" });
    expect(feed.steps[0].params).toMatchObject({ userLogin: "owner", maxItems: 25 });
    expect(deliver.executionMode).toEqual({ delivery: "sync" });
    // The job's own mode is untouched; the node override is the only addition.
    expect(config.executionMode).toEqual(
      expect.objectContaining({ concurrency: "sequential", delivery: "async" }),
    );
  });
});

describe("4466-P03 the flow's per-stage values are validated", () => {
  const spec = resolveJobDefinitionSpec(SPEC_WITH_STAGE_INPUTS);

  it("refuses an unknown stage, naming the stages that exist", () => {
    expect(() => bindStageOverrides(spec, { stageParams: { publish: { x: 1 } } })).toThrow(
      /has no stage "publish". Its stages are: feed, deliver/,
    );
  });

  it("refuses an undeclared stage parameter", () => {
    expect(() =>
      bindStageOverrides(spec, { stageParams: { feed: { nope: 1 } } }),
    ).toThrow(/Stage "feed" .* does not declare the parameter "nope"/);
  });

  it("refuses a missing required stage parameter", () => {
    expect(() => bindStageOverrides(spec, { stageParams: { feed: {} } })).toThrow(
      /Stage "feed" .* requires the "maxItems" parameter/,
    );
  });

  it("refuses an invalid stage mode", () => {
    expect(() =>
      bindStageOverrides(spec, { stageModes: { feed: { pacing: "online", delivery: "sync" } } }),
    ).toThrow(/Stage "feed" .* invalid execution mode: .*online\+sync/);
  });
});

describe("4466-P04 the route and the client carry the values", () => {
  it("passes stageModes/stageParams to the host", async () => {
    let seen: unknown = null;
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions/screener/define", {
        method: "POST",
        body: JSON.stringify({
          jobId: "job-1",
          params: { universe: "NASDAQ100" },
          stageModes: { feed: { concurrency: "parallel" } },
          stageParams: { feed: { maxItems: 10 } },
        }),
      }),
      new URL("https://x/api/job-definitions/screener/define"),
      "/api/job-definitions/screener/define",
      {
        defineJobFromSpec: async (_specId, jobId, _params, overrides) => {
          seen = overrides;
          return { jobId, name: "Screen", version: 1, stages: 6 };
        },
      },
    );
    expect(res!.status).toBe(200);
    expect(seen).toEqual({
      stageModes: { feed: { concurrency: "parallel" } },
      stageParams: { feed: { maxItems: 10 } },
    });
  });

  it("the client renders a mode control per stage and sends both maps", () => {
    const client = readFileSync(join(root, "src/client/WorkflowDefinitionFlow.tsx"), "utf8");
    expect(client).toContain("— execution mode");
    expect(client).toContain("inherit");
    expect(client).toContain("stageModes, stageParams");
  });
});

describe("4466-P05 the engine already honors a per-node override", () => {
  it("merges node.executionMode over the root mode and validates it", () => {
    const engine = readFileSync(join(root, "src/services/jobPipelineEngine.ts"), "utf8");
    expect(engine).toContain("private effectiveMode(ctx: RunContext, node: JobNodeConfig)");
    expect(engine).toContain("...(node.executionMode ?? {}),");
    const ports = readFileSync(join(root, "src/data/jobPipelinePorts.ts"), "utf8");
    expect(ports).toContain("Per-node execution-mode overrides, merged over the job's resolved mode.");
  });
});
