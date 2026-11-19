// @vitest-environment node
/**
 * Issue #5801 — the copilot must not reason past its own strategy catalog.
 *
 * Live failure: a GOOG poor-man's-covered-call turn told the user the
 * strategy "requires owning at least one share", framing the short call as
 * naked. It does not — the long LEAP call is the cover — and the engine has
 * carried PMCC all along. The same turn also implied a subset was available
 * rather than the full catalog.
 *
 * Pins:
 *  - 5801-P01 the prompt states a PMCC needs NO shares, and forbids the
 *    naked-call framing / the share-covered substitution;
 *  - 5801-P02 the prompt says "all strategies" is served by omitting
 *    strategyType (the full catalog), not by a subset;
 *  - 5801-P03 the engine's catalog really does carry the full set, so the
 *    guidance matches the capability (no prompt-only promise).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_STRATEGY_TYPES } from "../src/trading/options/strategyEngine";

const prompt = readFileSync(
  join(__dirname, "../src/agents/prompts/stockCopilotPrompt.ts"),
  "utf8",
);

describe("5801-P01 a PMCC needs no shares", () => {
  it("says so, and forbids the naked-call framing", () => {
    expect(prompt).toContain("A PMCC needs NO shares");
    expect(prompt).toContain("never naked");
    expect(prompt).toContain("never tell the user a PMCC requires owning stock");
  });
});

describe("5801-P02 all strategies is the default, by omission", () => {
  it("names the omission rule", () => {
    expect(prompt).toContain("OMIT strategyType");
    expect(prompt).toContain("the engine evaluates the full catalog by default");
  });
});

describe("5801-P03 the catalog carries the full set", () => {
  it("registers every strategy the guidance promises", () => {
    expect(ALL_STRATEGY_TYPES.length).toBeGreaterThan(70);
    expect(ALL_STRATEGY_TYPES).toContain("poor_mans_covered_call");
  });
});
