import { describe, it, expect } from "vitest";
import {
  DEFAULT_STOCK_PARETO_OBJECTIVES,
  evaluateParetoFrontier,
  paretoDominates,
  paretoFrontierForScreen,
} from "../src/workflows/paretoFrontier";

describe("Pareto frontier #2773", () => {
  const objectives = [
    { id: "momentumScore", direction: "maximize" as const },
    { id: "changePercent", direction: "maximize" as const },
  ];

  it("frontier + dominated with dominators and gaps (classic 2-objective case)", () => {
    const evaluation = evaluateParetoFrontier(
      [
        { id: "A", values: { momentumScore: 10, changePercent: 10 } },
        { id: "B", values: { momentumScore: 9, changePercent: 11 } },
        { id: "C", values: { momentumScore: 9, changePercent: 9 } },
      ],
      objectives,
    );
    expect(evaluation.frontier.map((c) => c.id)).toEqual(["A", "B"]);
    expect(evaluation.dominated.map((c) => c.id)).toEqual(["C"]);
    expect(evaluation.dominated[0].dominators).toEqual(["A", "B"]);
    // Gaps to the strongest dominator per objective: momentum 10-9=1, change 11-9=2.
    expect(evaluation.dominated[0].gaps).toEqual({ momentumScore: 1, changePercent: 2 });
    expect(evaluation.unscored).toEqual([]);
  });

  it("exact ties are co-frontier — neither dominates the other", () => {
    const evaluation = evaluateParetoFrontier(
      [
        { id: "A", values: { momentumScore: 10, changePercent: 10 } },
        { id: "A2", values: { momentumScore: 10, changePercent: 10 } },
      ],
      objectives,
    );
    expect(evaluation.frontier.map((c) => c.id)).toEqual(["A", "A2"]);
    expect(evaluation.dominated).toEqual([]);
    expect(paretoDominates(evaluation.frontier[0], evaluation.frontier[1], objectives)).toBe(false);
  });

  it("minimize direction: lower is better", () => {
    const evaluation = evaluateParetoFrontier(
      [
        { id: "cheap", values: { peRatio: 10 } },
        { id: "pricey", values: { peRatio: 25 } },
      ],
      [{ id: "peRatio", direction: "minimize" }],
    );
    expect(evaluation.frontier.map((c) => c.id)).toEqual(["cheap"]);
    expect(evaluation.dominated[0].dominators).toEqual(["cheap"]);
    expect(evaluation.dominated[0].gaps).toEqual({ peRatio: 15 });
  });

  it("missing or non-finite values land in unscored with the objective named — never dropped, never frontier", () => {
    const evaluation = evaluateParetoFrontier(
      [
        { id: "full", values: { momentumScore: 10, changePercent: 10 } },
        { id: "missing", values: { momentumScore: 10 } },
        { id: "nan", values: { momentumScore: Number.NaN, changePercent: 10 } },
      ],
      objectives,
    );
    expect(evaluation.frontier.map((c) => c.id)).toEqual(["full"]);
    expect(evaluation.unscored.map((c) => c.id)).toEqual(["missing", "nan"]);
    expect(evaluation.unscored[0].missingObjectiveIds).toEqual(["changePercent"]);
    expect(evaluation.unscored[1].missingObjectiveIds).toEqual(["momentumScore"]);
  });

  it("fails loudly on empty objectives, duplicate candidate ids, duplicate objective ids", () => {
    expect(() => evaluateParetoFrontier([{ id: "A", values: {} }], [])).toThrow(/at least one objective/);
    expect(() =>
      evaluateParetoFrontier(
        [
          { id: "A", values: { momentumScore: 1, changePercent: 1 } },
          { id: "A", values: { momentumScore: 2, changePercent: 2 } },
        ],
        objectives,
      ),
    ).toThrow(/Duplicate Pareto candidate id/);
    expect(() =>
      evaluateParetoFrontier([{ id: "A", values: { momentumScore: 1 } }], [
        { id: "momentumScore", direction: "maximize" },
        { id: "momentumScore", direction: "maximize" },
      ]),
    ).toThrow(/Duplicate Pareto objective id/);
  });

  it("no combined score: frontier entries carry ids + values only, never a score", () => {
    const evaluation = evaluateParetoFrontier(
      [{ id: "A", values: { momentumScore: 10, changePercent: 10 } }],
      objectives,
    );
    expect(evaluation.frontier[0]).not.toHaveProperty("score");
    expect(evaluation.frontier[0]).not.toHaveProperty("rank");
  });

  it("deterministic: same output for shuffled input", () => {
    const candidates = [
      { id: "A", values: { momentumScore: 10, changePercent: 10 } },
      { id: "B", values: { momentumScore: 9, changePercent: 11 } },
      { id: "C", values: { momentumScore: 9, changePercent: 9 } },
    ];
    const forward = evaluateParetoFrontier(candidates, objectives);
    const shuffled = evaluateParetoFrontier([...candidates].reverse(), objectives);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
  });

  it("stock stage: default objectives are momentumScore + changePercent (RSI excluded by design)", () => {
    expect(DEFAULT_STOCK_PARETO_OBJECTIVES.map((o) => o.id)).toEqual([
      "momentumScore",
      "changePercent",
    ]);
    const evaluation = paretoFrontierForScreen([
      { symbol: "AAPL", momentumScore: 80, changePercent: 2.5 },
      { symbol: "MSFT", momentumScore: 70, changePercent: 3.5 },
      { symbol: "NVDA", momentumScore: 60, changePercent: 1.0 },
    ]);
    expect(evaluation.frontier.map((c) => c.id)).toEqual(["AAPL", "MSFT"]);
    expect(evaluation.dominated.map((c) => c.id)).toEqual(["NVDA"]);
  });

  it("stock stage with peRatio objective: rows lacking it are unscored", () => {
    const evaluation = paretoFrontierForScreen(
      [
        { symbol: "AAPL", momentumScore: 80, changePercent: 2.5, peRatio: 20 },
        { symbol: "MSFT", momentumScore: 70, changePercent: 3.5 },
      ],
      [{ id: "peRatio", direction: "minimize" }],
    );
    expect(evaluation.unscored.map((c) => c.id)).toEqual(["MSFT"]);
    expect(evaluation.frontier.map((c) => c.id)).toEqual(["AAPL"]);
  });
});
