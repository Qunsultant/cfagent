/**
 * Issue #6466 parts 3 + 4 — the limits that decide a timeout are externalized.
 *
 * Part 3: the settlement wait (`awaitResearchJobSettlement`) was a hardcoded
 * default (`timeoutMs ?? 120_000`) with no env/config carrier and no UX
 * control. It resolves from the `RESEARCH_SETTLEMENT_WAIT_MS` carrier with
 * a stored override winning, bounded 10 s..30 min (the 10–15x range is
 * 1,200,000–1,800,000 ms); an invalid value refuses by name.
 *
 * Part 4: the per-stage timeouts / retry buckets already resolve from env
 * carriers; the stored config wins per stage, mirroring stageModes, and the
 * execution description reports the effective value and its source per
 * stage, so a stage budget is raisable without a deploy.
 *
 * TDD Red first: `resolveResearchSettlementWaitMs` and the limits fields on
 * the execution description do not exist yet.
 */
import { describe, it, expect } from "vitest";
import {
  resolveResearchSettlementWaitMs,
  DEFAULT_RESEARCH_SETTLEMENT_WAIT_MS,
} from "../src/config/researchJobConfig";
import { describeResearchExecution } from "../src/services/researchExecutionView";

describe("#6466 — settlement wait externalized", () => {
  it("defaults to 120 s with no env and no stored override", () => {
    expect(DEFAULT_RESEARCH_SETTLEMENT_WAIT_MS).toBe(120_000);
    expect(resolveResearchSettlementWaitMs({}, null)).toBe(120_000);
    expect(resolveResearchSettlementWaitMs(undefined, undefined)).toBe(120_000);
  });

  it("reads the env carrier", () => {
    expect(resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "600000" }, null)).toBe(600_000);
  });

  it("the 10–15x range is raisable: 1,200,000 and 1,800,000 resolve", () => {
    expect(resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "1200000" }, null)).toBe(1_200_000);
    expect(resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "1800000" }, null)).toBe(1_800_000);
  });

  it("the stored override wins over the deployment carrier", () => {
    expect(
      resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "600000" }, 1_500_000),
    ).toBe(1_500_000);
  });

  it("a null stored override falls back to the deployment carrier", () => {
    expect(resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "600000" }, null)).toBe(600_000);
  });

  it("refuses a non-numeric carrier by name", () => {
    expect(() => resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "banana" }, null)).toThrow(
      /RESEARCH_SETTLEMENT_WAIT_MS/,
    );
  });

  it("refuses zero, negative, and above the 30 min bound by name", () => {
    expect(() => resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "0" }, null)).toThrow(
      /RESEARCH_SETTLEMENT_WAIT_MS/,
    );
    expect(() => resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "-5" }, null)).toThrow(
      /RESEARCH_SETTLEMENT_WAIT_MS/,
    );
    expect(() => resolveResearchSettlementWaitMs({ RESEARCH_SETTLEMENT_WAIT_MS: "2000000" }, null)).toThrow(
      /RESEARCH_SETTLEMENT_WAIT_MS/,
    );
  });

  it("refuses an invalid stored override by name", () => {
    expect(() => resolveResearchSettlementWaitMs({}, 0)).toThrow(/settlementWaitMs/);
    expect(() => resolveResearchSettlementWaitMs({}, 2_000_000)).toThrow(/settlementWaitMs/);
  });
});

describe("#6466 — execution description reports the limits and their sources", () => {
  it("reports the effective wait, the effective stage timeouts, and each value's source", () => {
    const view = describeResearchExecution(
      { RESEARCH_STAGE_TIMEOUTS_MS: '{"feed": 300000}' },
      {
        stageModes: {},
        stageTimeouts: { analyze: 900_000 },
        stageRetryBuckets: {},
        settlementWaitMs: 1_500_000,
      },
    );
    expect(view.settlementWaitMs.effectiveMs).toBe(1_500_000);
    expect(view.settlementWaitMs.source).toBe("stored");
    expect(view.settlementWaitMs.deploymentMs).toBe(120_000);
    expect(view.stageTimeouts.effective.feed).toBe(300_000);
    expect(view.stageTimeouts.sources.feed).toBe("deployment");
    expect(view.stageTimeouts.effective.analyze).toBe(900_000);
    expect(view.stageTimeouts.sources.analyze).toBe("stored");
    expect(view.stageTimeouts.effective.enrich).toBe(600_000);
    expect(view.stageTimeouts.sources.enrich).toBe("deployment");
  });

  it("reports a broken deployment carrier beside the read instead of failing", () => {
    const view = describeResearchExecution({ RESEARCH_STAGE_TIMEOUTS_MS: "not-json" }, {});
    expect(view.stageTimeouts.errors.length).toBeGreaterThan(0);
    expect(view.stageTimeouts.effective.feed).toBe(240_000);
  });

  it("reports a broken wait carrier beside the read instead of failing", () => {
    const view = describeResearchExecution({ RESEARCH_SETTLEMENT_WAIT_MS: "banana" }, {});
    expect(view.settlementWaitMs.errors.length).toBeGreaterThan(0);
    expect(view.settlementWaitMs.effectiveMs).toBe(120_000);
  });
});
