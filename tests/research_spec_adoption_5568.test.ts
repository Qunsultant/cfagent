import { describe, expect, it } from "vitest";
import { jobDefinitionSpec, listJobDefinitionSpecs } from "../src/config/jobDefinitionCatalog";
import { bindJobDefinitionParams } from "../src/services/jobDefinitionParamBinders";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";

describe("5568 research spec adoption", () => {
  it("declares the research JobDefinitionSpec in the catalog with its parameters", () => {
    const ids = listJobDefinitionSpecs().map((s) => s.id);
    expect(ids).toContain("research");
    const spec = jobDefinitionSpec("research");
    expect(spec.shortId).toBe("oodares");
    expect(spec.parameters?.map((p) => p.name)).toEqual([
      "runId",
      "sourceId",
      "dataset",
      "trigger",
      "cron",
      // Issue #6031 — the run-level parameters the Define page collects
      // (declared without defaults: an absent venue/mode is inherited
      // from the tenant binding, #6036).
      "universe",
      "brokerId",
      "mode",
    ]);
  });

  it("binds research parameters generically and refuses undeclared parameters by name", () => {
    const spec = jobDefinitionSpec("research");
    const bound = bindJobDefinitionParams(spec, { trigger: "scheduled" }, "trader@example.com");
    expect(bound).toEqual({
      userLogin: "trader@example.com",
      trigger: "scheduled",
      sourceId: "primary-feed",
      dataset: "quotes",
    });

    expect(() =>
      bindJobDefinitionParams(spec, { bogusParam: 1 }, "trader@example.com"),
    ).toThrow(/does not declare the parameter "bogusParam"/);
  });

  it("builds research:<runId> via buildJobConfigFromSpec with stage parity", () => {
    const def = buildResearchJobDefinition("r-5568", {
      userLogin: "trader@example.com",
      trigger: "scheduled",
      cron: "0 21 * * 1-5",
    });
    expect(def.jobId).toBe("research:r-5568");
    expect(def.root.kind).toBe("research");
    expect(def.root.inputs).toEqual({ sources: ["primary-feed"], datasets: ["quotes"] });
    expect(def.root.schedule).toEqual({ enabled: true, cron: "0 21 * * 1-5" });
    expect(def.root.children.map((c: any) => c.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);

    const directSpecConfig = buildJobConfigFromSpec(
      jobDefinitionSpec("research"),
      "research:r-5568",
      { runId: "r-5568", userLogin: "trader@example.com", trigger: "scheduled" },
    );
    expect((directSpecConfig.root as any).kind).toBe("research");
  });
});
