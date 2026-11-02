/**
 * #1771 slice B: swarm consensus harness — RED pins (written before
 * the implementation; the first run must fail on the missing
 * src/orchestrations/swarmConsensus.ts module).
 *
 * Pins: majority consensus + dissent named (never silently
 * dropped); a lone source's pick is dissent even alone; a source
 * cannot vote twice for its own pick; duplicate source names and
 * empty source lists throw; status is always DRAFT (never an
 * order, never a trade proposal).
 */
import { describe, expect, it } from "vitest";
import { computeSwarmConsensus } from "../src/orchestrations/swarmConsensus";

describe("swarm consensus (#1771 slice B)", () => {
  it("majority symbols reach consensus; minority picks are named dissent", () => {
    const r = computeSwarmConsensus([
      { source: "a", symbols: [{ symbol: "AAA", rank: 1 }, { symbol: "BBB", rank: 2 }] },
      { source: "b", symbols: [{ symbol: "AAA", rank: 2 }, { symbol: "CCC", rank: 1 }] },
      { source: "c", symbols: [{ symbol: "AAA", rank: 1 }] },
    ]);
    expect(r.status).toBe("DRAFT");
    expect(r.consensus.map((c) => c.symbol)).toEqual(["AAA"]);
    expect(r.consensus[0]!.agreement).toBe(1);
    expect(r.consensus[0]!.meanRank).toBeCloseTo(4 / 3);
    expect(r.dissent.map((d) => d.symbol)).toEqual(["BBB", "CCC"]);
  });

  it("a single source cannot create consensus (minSources default 2)", () => {
    const r = computeSwarmConsensus([{ source: "only", symbols: [{ symbol: "AAA" }] }]);
    expect(r.consensus).toEqual([]);
    expect(r.dissent.map((d) => d.symbol)).toEqual(["AAA"]);
  });

  it("a source listing a symbol twice counts once", () => {
    const r = computeSwarmConsensus([
      { source: "a", symbols: [{ symbol: "AAA" }, { symbol: "AAA" }] },
      { source: "b", symbols: [{ symbol: "AAA" }] },
    ]);
    expect(r.consensus[0]!.agreement).toBe(1);
    expect(r.consensus[0]!.sources).toEqual(["a", "b"]);
  });

  it("duplicate source names and empty source lists throw", () => {
    expect(() =>
      computeSwarmConsensus([
        { source: "a", symbols: [] },
        { source: "a", symbols: [] },
      ]),
    ).toThrow(/duplicate source/);
    expect(() => computeSwarmConsensus([])).toThrow(/at least one/);
  });

  it("a custom threshold is honored", () => {
    const r = computeSwarmConsensus(
      [
        { source: "a", symbols: [{ symbol: "AAA" }] },
        { source: "b", symbols: [{ symbol: "AAA" }] },
        { source: "c", symbols: [{ symbol: "BBB" }] },
      ],
      { minAgreement: 1 },
    );
    expect(r.consensus.map((c) => c.symbol)).toEqual([]);
    expect(r.dissent.map((d) => d.symbol)).toEqual(["AAA", "BBB"]);
  });
});
