/**
 * Issue #6028 (build-time split, sub-issue #6201) — an OODA research run is a
 * Pipeline row in the one run ledger.
 *
 * Pins:
 *  - 6028-P01 the OODA root operation (`research`, the definition's root kind)
 *    classifies as `pipeline`, so the existing Pipeline filter finds it — it
 *    no longer lands in `other`;
 *  - 6028-P02 a namespaced `research.` operation classifies the same way, so a
 *    future namespaced research operation never falls back to `other`;
 *  - 6028-P03 the classification is case- and whitespace-insensitive, like
 *    every other rule;
 *  - 6028-P04 no existing classification moves: the rule is additive and its
 *    namespace is disjoint from every other rule.
 */
import { describe, expect, it } from "vitest";
import { classifyRunKind } from "../src/services/runLedgerKinds";

describe("6028-P01 the OODA root operation is a pipeline run", () => {
  it("classifies `research` as pipeline, not other", () => {
    expect(classifyRunKind({ operation: "research" })).toBe("pipeline");
  });
});

describe("6028-P02 a namespaced research operation is a pipeline run", () => {
  it("classifies `research.<stage>` as pipeline", () => {
    expect(classifyRunKind({ operation: "research.feed" })).toBe("pipeline");
    expect(classifyRunKind({ operation: "research.deliver" })).toBe("pipeline");
  });

  it("does not swallow a different namespace that merely starts with `research`", () => {
    // The rule's prefix carries the dot for exactly this reason: a future
    // `researching.*` family is not a research run.
    expect(classifyRunKind({ operation: "researching.thing" })).toBe("other");
  });
});

describe("6028-P03 classification is case- and whitespace-insensitive", () => {
  it("normalises the operation before matching", () => {
    expect(classifyRunKind({ operation: "  Research  " })).toBe("pipeline");
    expect(classifyRunKind({ operation: "RESEARCH.deliver" })).toBe("pipeline");
  });
});

describe("6028-P04 no existing classification moves", () => {
  it("keeps every family where it was", () => {
    const table: Array<[string, string]> = [
      ["trading.screen_options", "options"],
      ["trading.screen_stocks", "stock"],
      ["trading.strategy_scan", "strategy"],
      ["report.generate", "reports"],
      ["chain", "workflow"],
      ["feed", "pipeline"],
      ["index.refresh_wikipedia", "ops"],
      ["something.unknown", "other"],
    ];
    for (const [operation, kind] of table) {
      expect(classifyRunKind({ operation }), operation).toBe(kind);
    }
  });
});
