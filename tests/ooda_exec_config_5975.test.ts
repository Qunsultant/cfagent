// @vitest-environment node
/**
 * Issue #5975 (server slice) — the OODA execution configuration is persisted,
 * validated and what a run resolves.
 *
 * Pins:
 *  - 5975-P01 the stage-mode map round-trips through ResearchConfigService
 *    (stored as JSON, loaded as the object form);
 *  - 5975-P02 an unknown stage or axis is refused by name and nothing is
 *    persisted — the load still answers the defaults;
 *  - 5975-P03 the stored map wins over the deployment default per stage and
 *    per axis, and a stage present in only one carrier survives the merge;
 *  - 5975-P04 the merged map is what `buildResearchJobDefinition` puts on the
 *    stage children — the run executes the stored mode;
 *  - 5975-P05 the deployment default's own parsing is unchanged (regression).
 */
import { describe, expect, it } from "vitest";
import {
  ResearchConfigService,
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchSettingsStore,
} from "../src/services/researchConfig";
import {
  mergeResearchStageModes,
  resolveResearchStageModes,
} from "../src/config/researchJobConfig";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";

function store(): ResearchSettingsStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get: (key) => (raw.has(key) ? raw.get(key)! : null),
    set: (key, value) => void raw.set(key, value),
  };
}

describe("5975-P01 the stage-mode map round-trips", () => {
  it("persists as JSON and loads as the object form", () => {
    const s = store();
    const service = new ResearchConfigService(s);
    const out = service.save({ stageModes: { analyze: { pacing: "online" } } });
    expect(out.errors).toEqual([]);
    expect(out.config.stageModes).toEqual({ analyze: { pacing: "online" } });
    // Stored as JSON in the same key/value store as every other setting.
    expect(s.raw.get("research.stageModes")).toBe('{"analyze":{"pacing":"online"}}');
    // A fresh service (a new request) loads the same value.
    expect(new ResearchConfigService(s).load().stageModes).toEqual({
      analyze: { pacing: "online" },
    });
  });

  it("defaults to an empty map, so every stage inherits the job mode", () => {
    const config = new ResearchConfigService(store()).load();
    expect(config.stageModes).toEqual({});
    expect(RESEARCH_CONFIG_DEFAULTS.stageModes).toEqual({});
  });

  it("a corrupt stored value falls closed to the defaults", () => {
    const s = store();
    s.raw.set("research.stageModes", "{not json");
    expect(new ResearchConfigService(s).load().stageModes).toEqual({});
  });
});

describe("5975-P02 an unknown stage or axis is refused by name", () => {
  it("refuses an unknown stage and persists nothing", () => {
    const s = store();
    const service = new ResearchConfigService(s);
    const out = service.save({ stageModes: { nope: { pacing: "online" } } as never });
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors.join(" ")).toContain('"nope"');
    expect(out.errors.join(" ")).toContain("analyze");
    expect(s.raw.has("research.stageModes")).toBe(false);
    expect(service.load().stageModes).toEqual({});
  });

  it("refuses an unknown axis, naming the stage and the accepted axes", () => {
    const s = store();
    const out = new ResearchConfigService(s).save({
      stageModes: { analyze: { bogus: "x" } } as never,
    });
    expect(out.errors.join(" ")).toContain('"bogus"');
    expect(out.errors.join(" ")).toContain("analyze");
    expect(s.raw.has("research.stageModes")).toBe(false);
  });
});

describe("5975-P03 the stored map wins over the deployment default", () => {
  it("merges per stage and per axis, keeping both sides' stages", () => {
    const env = { pacing: "batch" as const };
    const merged = mergeResearchStageModes(
      { analyze: { pacing: "batch", delivery: "async" }, deliver: { delivery: "async" } } as never,
      { analyze: { pacing: "online" }, evaluate: { shape: "sharded" } } as never,
    );
    expect(merged.analyze).toEqual({ pacing: "online", delivery: "async" });
    expect(merged.deliver).toEqual({ delivery: "async" });
    expect(merged.evaluate).toEqual({ shape: "sharded" });
    // The base is not mutated.
    expect(env.pacing).toBe("batch");
  });

  it("a missing stored map leaves the deployment default as the whole map", () => {
    const base = { analyze: { pacing: "batch" } } as never;
    expect(mergeResearchStageModes(base, undefined)).toEqual(base);
    expect(mergeResearchStageModes(base, {})).toEqual(base);
  });
});

describe("5975-P04 the run executes the merged map", () => {
  it("puts the stored axis on the stage child and keeps the env-only stage", () => {
    const merged = mergeResearchStageModes(
      resolveResearchStageModes({
        RESEARCH_STAGE_MODES: JSON.stringify({ deliver: { delivery: "async" } }),
      }),
      { analyze: { pacing: "online" } },
    );
    const def = buildResearchJobDefinition("r-5975", {
      userLogin: "trader@example.com",
      trigger: "manual",
      stageModes: merged,
    });
    const analyze = (def.root.children ?? []).find((c) => c.kind === "analyze")!;
    const deliver = (def.root.children ?? []).find((c) => c.kind === "deliver")!;
    expect(analyze.executionMode).toMatchObject({ pacing: "online" });
    expect(deliver.executionMode).toMatchObject({ delivery: "async" });
  });
});

describe("5975-P05 the deployment default's parsing is unchanged", () => {
  it("still refuses invalid JSON and an unknown stage by the env's name", () => {
    expect(() => resolveResearchStageModes({ RESEARCH_STAGE_MODES: "{nope" })).toThrow(
      /RESEARCH_STAGE_MODES is not valid JSON/,
    );
    expect(() =>
      resolveResearchStageModes({ RESEARCH_STAGE_MODES: JSON.stringify({ nope: {} }) }),
    ).toThrow(/Unknown research stage "nope" in RESEARCH_STAGE_MODES/);
    expect(
      resolveResearchStageModes({ RESEARCH_STAGE_MODES: JSON.stringify({ analyze: { pacing: "online" } }) }),
    ).toEqual({ analyze: { pacing: "online" } });
    expect(resolveResearchStageModes({})).toEqual({});
  });
});
