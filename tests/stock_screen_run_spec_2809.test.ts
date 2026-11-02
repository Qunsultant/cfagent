/**
 * Issue #2809 (Phase 2 Slice 1 under #2764) — pins for the one
 * normalized StockScreenRunSpec. No behaviour change is asserted
 * here beyond construction parity: the builder must reproduce
 * exactly what the two REST routes assembled by hand, with the
 * single pinned divergence as data (deliver true vs false).
 */
import { describe, expect, it } from "vitest";
import { buildStockScreenRunSpec } from "../src/workflows/stockScreenRunSpec";

function query() {
  return new URLSearchParams();
}

describe("buildStockScreenRunSpec", () => {
  it("etrade spec carries deliver=true, no provider, and the parsed delivery envelope", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: { sector: "Technology", emailTo: "a@example.com", pushToSlack: true, slackChannel: "alerts" },
      query: query(),
      asyncRequested: false,
      source: "etrade",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.deliver).toBe(true);
    expect(result.spec.provider).toBeUndefined();
    expect(result.spec.source).toBe("etrade");
    expect(result.spec.universe).toBe("NASDAQ100");
    expect(result.spec.filters.sector).toBe("Technology");
    expect(result.spec.delivery).toEqual({
      emailTo: "a@example.com",
      pushToSlack: true,
      slackChannel: "alerts",
      webhookUrl: undefined,
      generatePdf: undefined,
    });
  });

  it("market-data spec carries deliver=false, provider yahoo, and an empty delivery (envelope not forwarded)", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: { sector: "Technology", emailTo: "a@example.com", pushToSlack: true },
      query: query(),
      asyncRequested: false,
      source: "market-data",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.deliver).toBe(false);
    expect(result.spec.provider).toBe("yahoo");
    expect(result.spec.source).toBe("market-data");
    expect(result.spec.delivery).toEqual({});
  });

  it("a pre-admitted mode is passed through, not re-admitted (E*TRADE listings ordering)", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: { sector: "Technology" },
      query: query(),
      asyncRequested: true,
      source: "etrade",
      modeSelection: { ok: true, screenMode: "non-deterministic", screenIntent: "find momentum" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.screenMode).toBe("non-deterministic");
    expect(result.spec.screenIntent).toBe("find momentum");
  });

  it("an invalid filter is a 400-style failure naming the problem, for both sources", () => {
    for (const source of ["etrade", "market-data"] as const) {
      const result = buildStockScreenRunSpec({
        env: {},
        method: "POST",
        rawFilters: { minRsi: "not-a-number" },
        query: query(),
        asyncRequested: false,
        source,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBeTruthy();
    }
  });

  it("an intent without ND mode refuses, exactly as admitScreenModeSelection does", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: { screenIntent: "stray intent" },
      query: query(),
      asyncRequested: false,
      source: "market-data",
    });
    expect(result.ok).toBe(false);
  });

  it("minScore is carried on the spec but never lands in the engine filters", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: { minScore: 42 },
      query: query(),
      asyncRequested: false,
      source: "etrade",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.minScore).toBe(42);
    expect((result.spec.filters as Record<string, unknown>).minScore).toBeUndefined();
  });
});
