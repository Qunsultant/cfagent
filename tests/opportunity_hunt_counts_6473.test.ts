// @vitest-environment node
/**
 * Issue #6473 — the hunt report's header carries counts, not symbols, and the
 * report states the arithmetic that turns symbols into setups.
 *
 * Pins:
 *  - 6473-P01 the summary line is the counts headline only: no `SYMBOL:strategy`
 *    enumeration (it used to append the first five setups). The symbols belong
 *    in the body — the per-symbol table, the charts, the counts section.
 *  - 6473-P02 the counts narrative states the funnel from the run's own numbers
 *    (scanned → symbols with setups → setups = entries + exits) and names the
 *    per-strategy split, so "how did 101 symbols become 113 setups?" is answered
 *    by the document rather than inferred by the reader.
 *  - 6473-P03 a run with no setups says so without inventing a strategy split.
 */
import { describe, it, expect } from "vitest";
import { huntSummary, huntCountsExplanation } from "../src/services/opportunityHunt";
import type { OpportunityHuntResult, OpportunityHuntSetup } from "../src/services/opportunityHunt";

const SYMBOL_SETUPS: OpportunityHuntSetup[] = [
  { symbol: "AAPL", strategy: "sma_crossover", direction: "entry", detail: "cross", lastClose: 191 },
  { symbol: "ABNB", strategy: "breakout", direction: "entry", detail: "break", lastClose: 120 },
  { symbol: "ABNB", strategy: "mean_reversion", direction: "entry", detail: "revert", lastClose: 120 },
  { symbol: "ABNB", strategy: "sma_crossover", direction: "exit", detail: "cross", lastClose: 120 },
] as OpportunityHuntSetup[];

function result(over: Partial<OpportunityHuntResult> = {}): OpportunityHuntResult {
  const setups = over.setups ?? SYMBOL_SETUPS;
  const base = {
    asOf: "2026-11-24T21:58:00.000Z",
    scanned: 101,
    skipped: 0,
    setups,
    holdingsStatus: null,
    seriesBySymbol: {},
  } as unknown as Omit<OpportunityHuntResult, "summary">;
  return { ...base, summary: huntSummary(base), ...over } as OpportunityHuntResult;
}

describe("#6473 — the report's header and its counts section", () => {
  it("P01: the summary is counts only — no symbol enumeration", () => {
    const summary = result().summary;
    expect(summary).toContain("4 setup(s) across 101 symbol(s)");
    expect(summary).toContain("3 entries, 1 exit");
    // The enumeration that used to ride the title block.
    expect(summary).not.toContain("AAPL:");
    expect(summary).not.toContain("sma_crossover");
  });

  it("P02: the narrative states the funnel and the per-strategy split", () => {
    const text = huntCountsExplanation(result());
    expect(text).toContain("101 symbol(s) scanned");
    // Two distinct symbols carry the three entry setups.
    expect(text).toContain("2 produced at least one setup");
    expect(text).toContain("4 setups = 3 entry setup(s) + 1 exit setup(s)");
    expect(text).toContain("1 sma_crossover"); // the split counts ENTRY setups
    expect(text).toContain("1 breakout");
    expect(text).toContain("evaluated separately against the run's holdings");
  });

  it("P03: a run with no setups invents no strategy split", () => {
    const text = huntCountsExplanation(result({ setups: [] }));
    expect(text).toContain("0 setups = 0 entry setup(s) + 0 exit setup(s)");
    expect(text).toContain("no strategy fired");
    expect(text).not.toContain("evaluated separately");
  });
});
