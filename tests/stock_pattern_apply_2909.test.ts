/**
 * Issue #2909 (G2 under #2764) — pattern apply pins patternRef
 * into spec, canonical body, and replay; unmapped guardrails
 * qualify visibly, never silently drop; Apply fully determines
 * the New Screen criteria (audit F1).
 */
import { describe, it, expect } from "vitest";
import { listStockPatterns, stockPatternById } from "../src/workflows/stockPatternCatalog";
import {
  buildAppliedPatternParams,
  parseAppliedPatternParams,
  patternQualificationLines,
} from "../src/client/patternApplyHandoff";
import { stockFilterToCriteria } from "../src/client/StockCriteriaPanel";
import { parseStockScreenRequest } from "../src/trading/screeningSchemas";
import {
  buildStockScreenRunSpec,
  specCanonicalFields,
} from "../src/workflows/stockScreenRunSpec";
import { buildReplayFromRecord } from "../src/workflows/reportReplay";

const REPLAY_BASE = {
  timestamp: "2026-11-02T09:30:00.000Z",
  universe: "TECH",
  sector: "ALL",
  provider: "etrade",
  trigger: "manual",
  success: true,
  totalScanned: 2,
  matchedCount: 1,
  criteria: { momentum: "bullish_breakout" },
  opportunities: [{ symbol: "AAPL" }],
  allStocks: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
  pdfKey: "reports/a.pdf",
};

describe("G2 pattern catalog", () => {
  it("pins a catalog version and names trend_breakout's unmapped guardrail", () => {
    const pattern = stockPatternById("trend_breakout");
    expect(pattern).toBeDefined();
    expect(pattern!.version).toBe("1");
    expect(pattern!.screenFilter).toEqual({ momentum: "bullish_breakout" });
    expect(pattern!.unmappedGuardrails).toEqual(["volumeRatioMin"]);
    expect(pattern!.guardrails.volumeRatioMin).toBe(1.2);
  });

  it("maps pullback_reversion's rsiMax onto maxRsi with no unmapped guardrails", () => {
    const pattern = stockPatternById("pullback_reversion");
    expect(pattern!.screenFilter).toEqual({ maxRsi: 30 });
    expect(pattern!.unmappedGuardrails).toEqual([]);
  });

  it("lists stock patterns only", () => {
    expect(listStockPatterns().map((p) => p.id)).toEqual(["trend_breakout", "pullback_reversion"]);
  });
});

describe("G2 Apply handoff (URL params)", () => {
  it("round-trips a pattern through build/parse, filter + unmapped guardrails intact", () => {
    const pattern = stockPatternById("trend_breakout")!;
    const params = buildAppliedPatternParams(pattern);
    const search = `?tab=stock-hub&view=new-screen&${new URLSearchParams(params).toString()}`;
    const parsed = parseAppliedPatternParams(search);
    expect(parsed).not.toBeNull();
    expect(parsed!.patternId).toBe("trend_breakout");
    expect(parsed!.version).toBe("1");
    expect(parsed!.filter).toEqual({ momentum: "bullish_breakout" });
    expect(parsed!.unmappedGuardrails).toEqual([{ key: "volumeRatioMin", value: 1.2 }]);
    // The decoded filter fully determines the New Screen criteria.
    const criteria = stockFilterToCriteria(parsed!.filter);
    expect(criteria.momentum).toEqual({ enabled: true, value: "bullish_breakout" });
  });

  it("returns null with no applied pattern, and drops malformed fields instead of guessing", () => {
    expect(parseAppliedPatternParams("?tab=stock-hub&view=new-screen")).toBeNull();
    const parsed = parseAppliedPatternParams(
      "?appliedPattern=trend_breakout&appliedMaxRsi=banana&appliedMomentum=bogus",
    );
    expect(parsed!.filter).toEqual({});
    expect(parsed!.version).toBe("1");
  });

  it("names unmapped guardrails as qualifications, never as filters", () => {
    const lines = patternQualificationLines([{ key: "volumeRatioMin", value: 1.2 }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/volumeRatioMin = 1\.2/);
    expect(lines[0]).toMatch(/not enforced/);
  });
});

describe("G2 spec + canonical body", () => {
  it("carries a request body's patternRef and qualifications into the spec and canonical fields, not the filter", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: {
        momentum: "bullish_breakout",
        patternRef: { patternId: "trend_breakout", version: "1" },
        patternQualifications: ["volumeRatioMin = 1.2 — not enforced by this screen"],
      } as never,
      query: new URLSearchParams(),
      asyncRequested: false,
      source: "etrade",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.patternRef).toEqual({ patternId: "trend_breakout", version: "1" });
    expect(result.spec.filters).not.toHaveProperty("patternRef");
    expect(result.spec.patternQualifications).toEqual([
      "volumeRatioMin = 1.2 — not enforced by this screen",
    ]);
    const canonical = specCanonicalFields(result.spec);
    expect(canonical.patternRef).toEqual({ patternId: "trend_breakout", version: "1" });
    expect(canonical.patternQualifications).toEqual([
      "volumeRatioMin = 1.2 — not enforced by this screen",
    ]);
  });

  it("a hand-built run carries no patternRef and no qualifications", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: { momentum: "bullish_breakout" } as never,
      query: new URLSearchParams(),
      asyncRequested: false,
      source: "etrade",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.patternRef).toBeUndefined();
    expect(result.spec.patternQualifications).toBeUndefined();
    expect(specCanonicalFields(result.spec)).not.toHaveProperty("patternRef");
  });

  it("parseStockScreenRequest splits pattern provenance out of the filter and rejects a bad shape", () => {
    const parsed = parseStockScreenRequest({
      momentum: "bullish_breakout",
      patternRef: { patternId: "trend_breakout", version: "1" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.patternRef).toEqual({ patternId: "trend_breakout", version: "1" });
    expect(parsed.value.filters).not.toHaveProperty("patternRef");
    const bad = parseStockScreenRequest({ patternRef: { patternId: "trend_breakout" } });
    expect(bad.ok).toBe(false);
  });
});

describe("G2 replay", () => {
  it("replays an object-form patternRef and its qualifications", () => {
    const env = buildReplayFromRecord({
      id: "rep-1",
      runId: "screener:2026-11-02T09:30:00.000Z",
      source: "screener",
      body: {
        ...REPLAY_BASE,
        patternRef: { patternId: "trend_breakout", version: "1" },
        patternQualifications: ["volumeRatioMin = 1.2 — not enforced by this screen"],
      },
    });
    expect(env.reportKind).toBe("stock-screen");
    if (env.reportKind !== "stock-screen") return;
    expect(env.patternRef).toEqual({ patternId: "trend_breakout", version: "1" });
    expect(env.patternQualifications).toEqual(["volumeRatioMin = 1.2 — not enforced by this screen"]);
    expect(env.partial).toBe(false);
  });

  it("still passes a legacy string patternRef through unchanged", () => {
    const env = buildReplayFromRecord({
      id: "rep-1",
      runId: "screener:x",
      source: "screener",
      body: { ...REPLAY_BASE, patternRef: "pattern:breakout:v1" },
    });
    if (env.reportKind !== "stock-screen") return;
    expect(env.patternRef).toBe("pattern:breakout:v1");
  });

  it("marks a malformed patternRef partial instead of inventing one", () => {
    const env = buildReplayFromRecord({
      id: "rep-1",
      runId: "screener:x",
      source: "screener",
      body: { ...REPLAY_BASE, patternRef: { bogus: true } },
    });
    if (env.reportKind !== "stock-screen") return;
    expect(env.patternRef).toBeUndefined();
    expect(env.partial).toBe(true);
    expect(env.partialReasons.join(" ")).toMatch(/pattern reference/);
  });
});
