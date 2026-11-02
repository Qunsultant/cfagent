/**
 * Issue #2600 — strategy coverage as user choice, end to end.
 *
 * Pins (no invented numbers; every count below is the registry's own):
 *  - the catalogue is 74 distinct ids (the 75th createTemplateStrategy
 *    match is the factory definition in template.ts, not a registry
 *    entry; "all" expands to exactly those 74);
 *  - strategyMode defaults to thesis, evaluateAllStrategies is a
 *    deprecated alias, and a conflicting pair is an error naming
 *    both fields (schema level: a 400 naming strategyMode);
 *  - thesis mode thesis-filters, all mode keeps contra-thesis
 *    strategies (thesis stays a score bias, not an exclusion);
 *  - far-dated bands from selected templates' horizons: PMCC
 *    180-365 and LEAPS 365-550 off a near maxDte of 90; toggle OFF
 *    leaves PMCC horizon-limited and named, never silently dropped;
 *  - the panel schema accepts strategyMode / farDated / the
 *    evaluateAllStrategies alias / candidateLimit "all", and the
 *    unified schema accepts strategyMode / farDated / candidateLimit;
 *  - the run record carries all four controls and Docs Run Details
 *    renders them from the same record.
 */
import { describe, it, expect, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { defaultRegistry } from "../src/trading/options/strategies/catalog";
import {
  deriveFetchBands,
  filterDefinitionsByMode,
  normalizeViewedRecommendationBody,
  noViewComparisonError,
  resolveAllowedStrategyIds,
  resolvePanelFetchBands,
  resolveStrategyMode,
  strategyRecordControlFields,
} from "../src/trading/options/strategyChoice";
import { recommendOptionStrategies } from "../src/trading/options/strategyEngine";
import {
  parseOptionsDiscoveryRequest,
  parseUnifiedOptionsRequest,
} from "../src/trading/screeningSchemas";
import { recordStrategyScreenRun } from "../src/services/optionsServeRecord";
import { buildRunDetail } from "../src/services/runDetails";
import type { RunSummary } from "../src/services/runSummaries";

const PANEL_BODY = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 210,
  targetDate: "2027-01-15",
  expectedIvDirection: "rise",
  maxPlannedLoss: 750,
  minRewardRisk: 1.8,
  allowedStrategies: ["all"],
  minDte: 20,
  maxDte: 90,
};

describe("strategy catalogue pin: 74 ids", () => {
  it("holds 74 distinct ids and resolves 'all' to exactly those 74", () => {
    const ids = defaultRegistry.ids();
    expect(ids).toHaveLength(74);
    expect(new Set(ids).size).toBe(74);
    expect(resolveAllowedStrategyIds(["all"]).ids).toHaveLength(74);
    expect(resolveAllowedStrategyIds(["PMCC"]).ids).toEqual(["poor_mans_covered_call"]);
    expect(resolveAllowedStrategyIds(["nope"]).unknown).toEqual(["nope"]);
  });
});

describe("resolveStrategyMode", () => {
  it("defaults to thesis, folds the alias, and rejects conflicts naming both fields", () => {
    expect(resolveStrategyMode({})).toBe("thesis");
    expect(resolveStrategyMode({ evaluateAllStrategies: true })).toBe("all");
    expect(resolveStrategyMode({ evaluateAllStrategies: false })).toBe("thesis");
    expect(resolveStrategyMode({ strategyMode: "all", evaluateAllStrategies: true })).toBe("all");
    expect(() => resolveStrategyMode({ strategyMode: "thesis", evaluateAllStrategies: true })).toThrow(/strategyMode.*evaluateAllStrategies/);
    expect(() => resolveStrategyMode({ strategyMode: "all", evaluateAllStrategies: false })).toThrow(/strategyMode.*evaluateAllStrategies/);
  });

  it("thesis filters, all keeps contra-thesis definitions", () => {
    const defs = defaultRegistry.list();
    const wanted = new Set(["leaps_put", "leaps_call"]);
    expect(filterDefinitionsByMode(defs, wanted, "thesis", "bullish").map((d) => d.id)).toEqual(["leaps_call"]);
    expect(filterDefinitionsByMode(defs, wanted, "all", "bullish").map((d) => d.id).sort()).toEqual(["leaps_call", "leaps_put"]);
    expect(() => filterDefinitionsByMode(defs, wanted, "no-view", "bullish")).toThrow(/no-view/);
  });
});

describe("engine mode selection (empty chain: ledger reasons only)", () => {
  const base = {
    symbol: "NVDA",
    thesis: "bullish" as const,
    targetPrice: 210,
    targetDate: "2027-01-15",
    expectedIvDirection: "rise" as const,
    maxPlannedLoss: 750,
    minRewardRisk: 1.8,
    allowedStrategies: ["leaps_put"],
  };
  it("thesis mode skips a contra-thesis strategy for thesis conflict; all mode does not", () => {
    const thesisResult = recommendOptionStrategies([], base);
    const thesisEval = thesisResult.evaluations.find((e) => e.id === "leaps_put")!;
    expect(thesisEval.status).toBe("skipped");
    // Ledger contract: a skip reason lives in the evaluation summary
    // (reasons is the rejection histogram, empty for skipped defs);
    // the same conflict reason also lands on the result excluded list.
    expect(thesisEval.summary).toContain("bullish thesis");
    expect(thesisResult.excluded.map((e) => e.reason).join(" ")).toContain("bullish thesis");
    const allResult = recommendOptionStrategies([], { ...base, strategyMode: "all" });
    const allEval = allResult.evaluations.find((e) => e.id === "leaps_put")!;
    expect(allEval.status).toBe("skipped");
    expect(allEval.summary).not.toContain("bullish thesis");
    const aliasResult = recommendOptionStrategies([], { ...base, evaluateAllStrategies: true });
    expect(aliasResult.evaluations.find((e) => e.id === "leaps_put")!.summary)
      .not.toContain("bullish thesis");
    expect(() => recommendOptionStrategies([], { ...base, strategyMode: "thesis", evaluateAllStrategies: true })).toThrow(/strategyMode.*evaluateAllStrategies/);
  });
});

describe("moved route helpers keep their behaviour (ratchet refactor)", () => {
  const viewedBase = {
    symbol: "NVDA",
    thesis: "bullish" as const,
    targetPrice: 210,
    targetDate: "2027-01-15",
    expectedIvDirection: "rise" as const,
    maxPlannedLoss: 750,
    minRewardRisk: 1.8,
    allowedStrategies: ["poor_mans_covered_call", "leaps_call"],
    minDte: 0,
    maxDte: 90,
  };
  it("resolvePanelFetchBands: far-dated on attaches horizon bands, off names horizon-limited", () => {
    const on = resolvePanelFetchBands({ ...viewedBase, strategyMode: "thesis" } as any, true);
    // Registry order, not the worked-example order: the helper
    // iterates defaultRegistry.list(), so leaps_call's band lands
    // before poor_mans_covered_call's (same set as the worked
    // example, different order — the implementation is unchanged).
    expect(on.bands).toEqual([
      { minDte: 0, maxDte: 90 },
      { minDte: 365, maxDte: 550, maxExpirations: 4 },
      { minDte: 180, maxDte: 365, maxExpirations: 4 },
    ]);
    expect(on.request.expirationDteBands).toEqual(on.bands);
    expect(on.horizonLimited).toEqual([]);
    const off = resolvePanelFetchBands({ ...viewedBase, strategyMode: "thesis" } as any, false);
    expect(off.bands).toEqual([{ minDte: 0, maxDte: 90 }]);
    expect(off.request.expirationDteBands).toBeUndefined();
    expect(off.horizonLimited.map((h) => h.id).sort()).toEqual(["leaps_call", "poor_mans_covered_call"]);
  });
  it("normalizeViewedRecommendationBody: strips candidateLimit 'all', refuses no-view", () => {
    const all = normalizeViewedRecommendationBody({ ...viewedBase, candidateLimit: "all" });
    expect(all.candidateLimitAll).toBe(true);
    expect(all.isNoView).toBe(false);
    expect(all.noViewError).toBeNull();
    expect((all.validationBody as Record<string, unknown>).candidateLimit).toBeUndefined();
    expect(all.farDated).toBeUndefined();
    const noView = normalizeViewedRecommendationBody({ ...viewedBase, strategyMode: "no-view" });
    expect(noView.isNoView).toBe(true);
    expect(noView.noViewError).toMatch(/no-view.*viewed recommendation/);
    const plain = normalizeViewedRecommendationBody({ ...viewedBase, candidateLimit: 10, farDated: true });
    expect(plain.candidateLimitAll).toBe(false);
    expect(plain.validationBody).toEqual({ ...viewedBase, candidateLimit: 10, farDated: true });
    expect(plain.farDated).toBe(true);
  });
  it("noViewComparisonError: no-view refused, viewed passes", () => {
    expect(noViewComparisonError("no-view")).toMatch(/cannot run a comparison/);
    expect(noViewComparisonError("thesis")).toBeNull();
    expect(noViewComparisonError(undefined)).toBeNull();
  });
  it("strategyRecordControlFields: all four controls, defaults, resolved ids", () => {
    const fields = strategyRecordControlFields({
      riskProfile: "balanced",
      candidateLimit: "all",
      farDated: true,
      alternatives: 3,
      request: { thesis: "bullish", targetDate: "2027-01-15", allowedStrategies: ["PMCC"], targetPrice: 210, minDte: 0, maxDte: 90 },
      bands: [{ minDte: 0, maxDte: 90 }, { minDte: 180, maxDte: 365 }],
      horizonLimited: [],
    });
    expect(fields.strategyMode).toBe("thesis");
    expect(fields.candidateLimit).toBe("all");
    expect(fields.farDated).toBe(true);
    expect(fields.allowedStrategiesResolved).toEqual(["poor_mans_covered_call"]);
    expect(fields.fetchBands).toHaveLength(2);
    expect(fields.horizonLimited).toBeUndefined();
    expect(fields.alternatives).toBe(3);
  });
});

describe("deriveFetchBands: PMCC / LEAPS worked example", () => {
  const pmcc = defaultRegistry.get("poor_mans_covered_call")!;
  const leaps = defaultRegistry.get("leaps_call")!;
  it("derives 180-365 for PMCC and 365-550 for LEAPS off a near maxDte of 90", () => {
    expect(pmcc.dataHorizonDte).toBe(365);
    expect(leaps.dataHorizonDte).toBe(550);
    const { bands, horizonLimited, dataMaxDte } = deriveFetchBands({
      selected: [pmcc, leaps],
      nearMinDte: 0,
      nearMaxDte: 90,
      farDated: true,
    });
    expect(bands).toContainEqual(expect.objectContaining({ minDte: 180, maxDte: 365 }));
    expect(bands).toContainEqual(expect.objectContaining({ minDte: 365, maxDte: 550 }));
    expect(horizonLimited).toEqual([]);
    expect(dataMaxDte).toBe(550);
  });

  it("toggle OFF keeps the near band only and names PMCC horizon-limited", () => {
    const { bands, horizonLimited, dataMaxDte } = deriveFetchBands({
      selected: [pmcc],
      nearMinDte: 0,
      nearMaxDte: 90,
      farDated: false,
    });
    expect(bands).toEqual([expect.objectContaining({ minDte: 0, maxDte: 90 })]);
    expect(horizonLimited).toEqual([{ id: "poor_mans_covered_call", label: pmcc.label, horizonDte: 365 }]);
    expect(dataMaxDte).toBe(90);
  });

  it("derives bands from selected templates only, never the full catalogue", () => {
    const { bands } = deriveFetchBands({ selected: [pmcc], nearMinDte: 0, nearMaxDte: 90, farDated: true });
    expect(bands).toHaveLength(2);
    expect(bands).not.toContainEqual(expect.objectContaining({ maxDte: 550 }));
  });
});

describe("panel discovery schema (#2600 fix)", () => {
  it("accepts strategyMode + farDated + candidateLimit 'all', uncapped on the forwarded request", () => {
    const parsed = parseOptionsDiscoveryRequest({ ...PANEL_BODY, strategyMode: "all", farDated: true, candidateLimit: "all" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.strategyMode).toBe("all");
    expect(parsed.value.farDated).toBe(true);
    expect(parsed.value.candidateLimit).toBe("all");
    expect(parsed.value.request.candidateLimit).toBeUndefined();
    expect(parsed.value.request.strategyMode).toBe("all");
  });

  it("accepts the deprecated alias alone (previously a strictObject 400) and folds it to 'all'", () => {
    const parsed = parseOptionsDiscoveryRequest({ ...PANEL_BODY, evaluateAllStrategies: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.strategyMode).toBe("all");
  });

  it("defaults to thesis and rejects unknown modes and conflicting alias pairs, naming strategyMode", () => {
    const plain = parseOptionsDiscoveryRequest(PANEL_BODY);
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.value.strategyMode).toBe("thesis");
    const badMode = parseOptionsDiscoveryRequest({ ...PANEL_BODY, strategyMode: "everything" });
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) expect(badMode.error).toContain("strategyMode");
    const conflict = parseOptionsDiscoveryRequest({ ...PANEL_BODY, strategyMode: "thesis", evaluateAllStrategies: true });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain("strategyMode");
  });
});

describe("unified schema (#2600)", () => {
  const base = { action: "strategies", symbol: "NVDA", allowedStrategies: ["all"] } as const;
  it("accepts strategyMode + farDated + candidateLimit and rejects conflicts", () => {
    const parsed = parseUnifiedOptionsRequest({ ...base, strategyMode: "all", farDated: true, candidateLimit: "all" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.request.strategyMode).toBe("all");
    expect(parsed.value.request.farDated).toBe(true);
    expect(parsed.value.request.candidateLimit).toBe("all");
    const conflict = parseUnifiedOptionsRequest({ ...base, strategyMode: "thesis", evaluateAllStrategies: true });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain("strategyMode");
  });
});

describe("run record carries all four controls, read identically by Run Details", () => {
  it("stores mode, resolved ids, candidateLimit 'all', farDated, bands, horizon-limited", () => {
    const sql = new MockSqlStorage();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-nvda", created: true })),
      getSql: () => sql,
    };
    const createdAt = "2026-11-01T12:00:00.000Z";
    recordStrategyScreenRun(orm as any, {
      userLogin: "OpenAIMP",
      symbol: "NVDA",
      trigger: "manual",
      mode: "strategies",
      ranked: [],
      screenedOut: [],
      screen: { underlyingsScanned: 1, contractsEvaluated: 0, contractsMatched: 0, fetchErrors: [], warnings: [] },
      contracts: [],
      dataSource: "live",
      thesis: "bullish",
      strategyMode: "all",
      allowedStrategies: ["all"],
      allowedStrategiesResolved: defaultRegistry.ids(),
      dteMin: 0,
      dteMax: 90,
      candidateLimit: "all",
      alternatives: 3,
      farDated: true,
      fetchBands: [{ minDte: 0, maxDte: 90 }, { minDte: 180, maxDte: 365 }],
      horizonLimited: [],
      createdAt,
    });
    const body = orm.storeCanonicalReport.mock.calls[0][0].body as Record<string, any>;
    expect(body.input).toMatchObject({
      strategyMode: "all",
      candidateLimit: "all",
      alternatives: 3,
      farDated: true,
      fetchBands: [{ minDte: 0, maxDte: 90 }, { minDte: 180, maxDte: 365 }],
    });
    expect((body.input.allowedStrategiesResolved as string[])).toHaveLength(74);
    const detail = buildRunDetail({
      kind: "options_scanner",
      id: "rep-nvda",
      runId: `options_strategy:strategies:NVDA:${createdAt}`,
      title: "Strategy screen — NVDA (manual)",
      summary: "Strategy screen for NVDA: 0 ranked strategies.",
      trigger: "manual",
      createdAt,
      status: "completed",
      resultCount: 0,
      pdfKey: null,
      reportUrl: null,
      xlsxKey: null,
      xlsxUrl: null,
      csvKey: null,
      csvUrl: null,
      pdfStatus: null,
      pdfError: null,
      xlsxStatus: null,
      xlsxError: null,
      csvStatus: null,
      csvError: null,
      reportId: "rep-nvda",
      scanRunId: null,
      discoveryRunId: null,
      source: "options_strategy",
      body,
    } as RunSummary & { body?: unknown });
    expect(detail.request.find((f) => f.field === "strategyMode")?.value).toBe("all");
    // stringifyValue passes strings through unchanged (same as
    // strategyMode "all" above), so the stored "all" reads back plain.
    expect(detail.request.find((f) => f.field === "candidateLimit")?.value).toBe("all");
    expect(detail.request.find((f) => f.field === "farDated")?.value).toBe("true");
    expect(detail.request.find((f) => f.field === "fetchBands")?.source).toBe("recorded");
  });
});
