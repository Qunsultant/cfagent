// @vitest-environment node
/**
 * Issue #5911 — one job, one run id.
 *
 * Pins:
 *  - 5911-P01 a direct run (no id supplied) mints through the platform
 *    authority: the id carries the `run:` marker, never a private `rsr_…` id;
 *  - 5911-P02 a run told which id to use adopts it verbatim — the report, the
 *    record and the ledger row then describe the same run;
 *  - 5911-P03 the engine job id stays `<kind>:<runBody>` for a canonical id,
 *    and a legacy `rsr_…` id passes through unchanged (history resolves).
 */
import { describe, it, expect } from "vitest";
import { runResearchPipeline, type ResearchDataProvider } from "../src/services/researchPipeline";
import { RESEARCH_CONFIG_DEFAULTS, type ResearchConfig } from "../src/services/researchConfig";
import { researchEngineJobId, researchArtifactKey } from "../src/workflows/researchDataPorts";

const config: ResearchConfig = {
  ...RESEARCH_CONFIG_DEFAULTS,
  universe: "NASDAQ100",
  oodaMaxIterations: 1,
} as ResearchConfig;

const provider = {
  getRegime: async () => ({ regime: "neutral", notes: [], asOf: Date.now() }),
  getUniverseSymbols: async () => [],
  getQuote: async () => null,
  getTechnicals: async () => null,
  getCatalysts: async () => null,
  getChain: async () => {
    throw new Error("no chain");
  },
} as unknown as ResearchDataProvider;

describe("5911-P01 a direct run mints a canonical id", () => {
  it("uses the platform minter, never a private rsr_ id", async () => {
    const report = await runResearchPipeline(
      { provider },
      config,
      { trigger: "manual", userLogin: "trader@example.com" },
    );
    expect(report.runId).toMatch(/^run:[0-9a-z]+-[0-9a-z]+$/);
    expect(report.runId.startsWith("rsr_")).toBe(false);
  });
});

describe("5911-P02 a run told which id to use adopts it verbatim", () => {
  it("keeps the engine's id end to end", async () => {
    const engineRunId = "run:abc123-1";
    const report = await runResearchPipeline(
      { provider },
      config,
      { trigger: "manual", userLogin: "trader@example.com", runId: engineRunId },
    );
    expect(report.runId).toBe(engineRunId);
    // the canonical report id derives from the same run id — no second id
    expect(report.generationId).toBe(`options_research:${engineRunId}`);
  });
});

describe("5911-P03 the engine job id keeps its shape", () => {
  it("drops the run: marker for a canonical id and passes legacy ids through", () => {
    expect(researchEngineJobId("run:abc123-1")).toBe("research:abc123-1");
    expect(researchEngineJobId("rsr_mwp9epp6_aif4tp")).toBe("research:rsr_mwp9epp6_aif4tp");
    expect(researchArtifactKey("run:abc123-1", "analyze")).toBe("research:abc123-1:analyze");
  });
});
