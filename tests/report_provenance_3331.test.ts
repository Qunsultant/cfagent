/**
 * Issue #3331: a report names the broker that produced it.
 *
 * The screener artifact's provenance lines hardcoded "E*TRADE live snapshots"
 * for every non-Yahoo run, so an Alpaca run's PDF described quotes it never
 * read. These tests defend the rule and the legacy behaviour:
 *
 *   1. A run that recorded Alpaca says Alpaca — in the header line AND the
 *      methodology line.
 *   2. A run that recorded E*TRADE says E*TRADE.
 *   3. A legacy run (no broker recorded) keeps the E*TRADE wording, because
 *      that is what produced it — never the currently selected broker.
 *   4. Yahoo runs are unchanged, and the CSV stays byte-clean (provenance has
 *      never belonged in CSV payloads).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { screenerProvenanceLines } from "../src/trading/screenerReportPdf";

describe("the screener artifact names its broker (#3331)", () => {
  it("an Alpaca run says Alpaca, not E*TRADE", () => {
    const lines = screenerProvenanceLines({ provider: "etrade", broker: "alpaca" });
    expect(lines.quotesLine).toContain("Alpaca");
    expect(lines.quotesLine).not.toContain("E*TRADE");
    expect(lines.methodologyQuotes).toContain("Alpaca live snapshots");
    expect(lines.methodologyQuotes).not.toContain("E*TRADE");
  });

  it("an E*TRADE run keeps its wording", () => {
    const lines = screenerProvenanceLines({ provider: "etrade", broker: "etrade" });
    expect(lines.quotesLine).toContain("E*TRADE");
    expect(lines.methodologyQuotes).toContain("E*TRADE live snapshots");
  });

  it("a legacy run (no broker recorded) keeps E*TRADE — what produced it", () => {
    const lines = screenerProvenanceLines({ provider: "etrade" });
    expect(lines.quotesLine).toContain("E*TRADE");
  });

  it("a Yahoo run is unchanged and never claims a broker's live quotes", () => {
    const lines = screenerProvenanceLines({ provider: "yahoo", broker: "alpaca" });
    expect(lines.quotesLine).toContain("Yahoo Finance");
    expect(lines.quotesLine).not.toContain("Alpaca");
    expect(lines.quotesLine).not.toContain("E*TRADE");
  });

  it("a fallback run still names the provider it fell back from", () => {
    const lines = screenerProvenanceLines({
      provider: "yahoo",
      providerFallback: { from: "etrade", reason: "auth" },
      broker: "alpaca",
    });
    expect(lines.quotesLine).toContain("fallback");
    expect(lines.quotesLine).toContain("E*TRADE");
  });

  it("the CSV stays provenance-free (a comment line would break parsers)", () => {
    const source = readFileSync("src/trading/screenerReportCsv.ts", "utf8");
    expect(source).toContain("never in the");
    expect(source).not.toMatch(/screenerProvenanceLines/);
  });
  it("states the environment when the run recorded one", () => {
    const paper = screenerProvenanceLines({ provider: "etrade", broker: "alpaca", environment: "TEST" });
    expect(paper.quotesLine).toContain("Alpaca");
    expect(paper.quotesLine).toContain("paper");
    const live = screenerProvenanceLines({ provider: "etrade", broker: "etrade", environment: "PROD" });
    expect(live.quotesLine).toContain("live");
  });

  it("a legacy run does not acquire a mode it never recorded", () => {
    const legacy = screenerProvenanceLines({ provider: "etrade" });
    expect(legacy.quotesLine).not.toContain("paper");
    expect(legacy.quotesLine).not.toContain("(live)");
  });
});