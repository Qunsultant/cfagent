/**
 * Issue #1107 (Phase 1 of epic #1096) — Scenario/Goal engine pins.
 *
 *  - Taxonomy: all 9 GoalKinds from the Phase 0 store have metadata, and
 *    the mapping is GATE-TRUE: every default structure's family is
 *    admissible for the kind's outlook under the real researchGates
 *    thesis-coherence gate (checked through runStageGates, with a
 *    negative control proving the check can fail).
 *  - Scenario builder: typed shock grid + constraints, with the effective
 *    ResearchConfig snapshot embedded (researchConfig snapshot idiom),
 *    round-tripping through the Phase 0 mas_scenarios store.
 *  - Grid evaluator: prices every price × IV × time cell through
 *    researchEconomics.valueAtHorizon ONLY (no second pricing engine —
 *    a source pin asserts the engine adds no Black-Scholes/payoff code),
 *    and reports worst/best cells plus constraint verdicts that
 *    distinguish breach from not-evaluable.
 *  - Auto-discovery: portfolio triggers (concentration, unhedged delta,
 *    expiring leg, losing position → repair), regime triggers, event
 *    triggers, and intent mapping. A healthy fixture fires nothing.
 *    Missing catalyst data is FLAGGED (researchProviders pattern —
 *    getCatalysts() returns null), never fabricated.
 *  - Proposals persist as source:"discovered" / status:"proposed" for
 *    the owning tenant only; nothing activates a goal or emits a trade.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MockSqlStorage } from "./mock-sql";
import {
  GOAL_KINDS,
  GOAL_TAXONOMY,
  goalOutlook,
  isStructureAdmissibleForGoal,
  buildScenario,
  persistScenario,
  evaluateScenarioGrid,
  discoverGoalsFromPortfolio,
  discoverGoalsFromRegime,
  discoverGoalsFromEvents,
  goalKindForIntent,
  runGoalScenarioDiscovery,
  persistDiscoveredGoals,
  DEFAULT_DISCOVERY_THRESHOLDS,
  type DiscoveryPosition,
} from "../src/services/goalScenarioEngine";
import {
  createGoal,
  getGoal,
  getScenario,
  listGoals,
} from "../src/services/goalScenarioStore";
import { runStageGates, type GateCandidate } from "../src/services/researchGates";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import {
  ironCondorEconomics,
  type ResearchLeg,
} from "../src/services/researchEconomics";

function freshSql() {
  return new MockSqlStorage() as any;
}

function leg(
  optionType: "call" | "put",
  strike: number,
  bid: number,
  ask: number,
  quantity: number,
  dte = 35,
  openInterest: number | null = 500
): ResearchLeg {
  return {
    optionType,
    strike,
    expiry: "2026-12-18",
    dte,
    bid,
    ask,
    iv: 0.4,
    volume: 100,
    openInterest,
    quantity,
    quoteTimestamp: Date.now(),
  };
}

function condor() {
  return ironCondorEconomics(
    [
      leg("put", 90, 1.0, 1.2, 1),
      leg("put", 95, 2.4, 2.6, -1),
      leg("call", 105, 2.4, 2.6, -1),
      leg("call", 110, 1.0, 1.2, 1),
    ],
    100
  );
}

describe("goal taxonomy (issue #1107)", () => {
  it("covers exactly the 9 Phase 0 goal kinds", () => {
    expect([...GOAL_KINDS].sort()).toEqual(
      [
        "capital_efficient_leverage",
        "cash_secured_entry",
        "deconcentrate",
        "directional",
        "hedge_protect",
        "income",
        "iv_harvest",
        "repair",
        "volatility_event",
      ].sort()
    );
    for (const kind of GOAL_KINDS) {
      expect(GOAL_TAXONOMY[kind].label.length).toBeGreaterThan(0);
      expect(GOAL_TAXONOMY[kind].defaultStructures.length).toBeGreaterThan(0);
      expect(GOAL_TAXONOMY[kind].families.length).toBeGreaterThan(0);
    }
  });

  it("is gate-true: every default structure passes the real thesis-coherence gate for its kind's outlook", () => {
    for (const kind of GOAL_KINDS) {
      for (const structure of GOAL_TAXONOMY[kind].defaultStructures) {
        expect(isStructureAdmissibleForGoal(kind, structure)).toBe(true);
        const candidate: GateCandidate = {
          symbol: "TEST",
          outlook: goalOutlook(kind),
          thesis: "A sufficiently detailed thesis statement for gate evaluation.",
          quote: null,
          chain: null,
          legs: [],
          structure,
          economics: null,
          expectedMovePct: null,
          sources: ["test"],
          limitations: [],
          falsificationPresent: true,
        };
        const outcome = runStageGates(candidate, {
          config: RESEARCH_CONFIG_DEFAULTS,
          now: Date.now(),
        });
        const thesis = outcome.gateResults.find((g) => g.gate === "thesis_coherence");
        expect(thesis, `${kind}/${structure}`).toBeDefined();
        expect(
          thesis!.reasons.some((r) => r.includes("does not express")),
          `${kind}/${structure} must be admissible for ${goalOutlook(kind)}: ${thesis!.reasons.join(" ")}`
        ).toBe(false);
      }
    }
  });

  it("negative control: the gate check can fail (iron condor is not a bullish structure)", () => {
    const candidate: GateCandidate = {
      symbol: "TEST",
      outlook: "bullish",
      thesis: "A sufficiently detailed thesis statement for gate evaluation.",
      quote: null,
      chain: null,
      legs: [],
      structure: "iron_condor",
      economics: null,
      expectedMovePct: null,
      sources: ["test"],
      limitations: [],
      falsificationPresent: true,
    };
    const outcome = runStageGates(candidate, {
      config: RESEARCH_CONFIG_DEFAULTS,
      now: Date.now(),
    });
    const thesis = outcome.gateResults.find((g) => g.gate === "thesis_coherence");
    expect(thesis!.reasons.some((r) => r.includes("does not express"))).toBe(true);
    expect(isStructureAdmissibleForGoal("directional", "iron_condor")).toBe(false);
    expect(isStructureAdmissibleForGoal("income", "iron_condor")).toBe(true);
  });
});

describe("scenario builder + persistence (issue #1107)", () => {
  it("builds a typed scenario with the effective config snapshot embedded", () => {
    const built = buildScenario({ goalKind: "income", portfolioRef: { kind: "real" } });
    expect(built.goalKind).toBe("income");
    expect(built.direction).toBe("range_bound");
    expect(built.shocks.pricePct.length).toBeGreaterThan(0);
    expect(built.shocks.ivShift.length).toBeGreaterThan(0);
    expect(built.shocks.daysForward.length).toBeGreaterThan(0);
    expect(built.configSnapshot.rulesVersion).toBe(RESEARCH_CONFIG_DEFAULTS.rulesVersion);
    expect(built.configSnapshot.riskFreeRate).toBe(RESEARCH_CONFIG_DEFAULTS.riskFreeRate);
    expect(built.configSnapshot.minOpenInterest).toBe(RESEARCH_CONFIG_DEFAULTS.minOpenInterest);
  });

  it("caller constraints and config overrides win over defaults", () => {
    const built = buildScenario({
      goalKind: "hedge_protect",
      portfolioRef: { kind: "hypothetical", ref: "paper-1" },
      constraints: { maxLoss: 750, budget: 5000 },
      config: { ...RESEARCH_CONFIG_DEFAULTS, riskFreeRate: 0.03 },
    });
    expect(built.constraints.maxLoss).toBe(750);
    expect(built.constraints.budget).toBe(5000);
    expect(built.configSnapshot.riskFreeRate).toBe(0.03);
    expect(built.portfolioRef).toEqual({ kind: "hypothetical", ref: "paper-1" });
  });

  it("round-trips through the Phase 0 store, snapshot included", () => {
    const sql = freshSql();
    const goal = createGoal(sql, { userLogin: "alice", kind: "income", title: "Income" });
    const built = buildScenario({
      goalKind: "income",
      portfolioRef: { kind: "real" },
      constraints: { maxLoss: 1000 },
    });
    const scenario = persistScenario(sql, { userLogin: "alice", goalId: goal.id, scenario: built });
    expect(scenario).not.toBeNull();
    const back = getScenario(sql, "alice", scenario!.id);
    expect(back).not.toBeNull();
    const shocks = back!.shocks as any;
    const constraints = back!.constraints as any;
    expect(shocks.pricePct).toEqual(built.shocks.pricePct);
    expect(constraints.maxLoss).toBe(1000);
    expect(constraints.configSnapshot.rulesVersion).toBe(RESEARCH_CONFIG_DEFAULTS.rulesVersion);
    expect(getScenario(sql, "bob", scenario!.id)).toBeNull();
  });
});

describe("scenario grid evaluator (issue #1107)", () => {
  it("prices the full price × IV × time grid and finds worst/best cells", () => {
    const econ = condor();
    const result = evaluateScenarioGrid({
      economics: econ,
      spot: 100,
      sigma: 0.4,
      shocks: { pricePct: [-10, 0, 10], ivShift: [0, 0.25], daysForward: [0, 30] },
      constraints: { contracts: 1 },
    });
    expect(result.cells).toHaveLength(12);
    expect(result.worst.pnlTotal).toBeLessThanOrEqual(result.best.pnlTotal);
    // A condor's best cell is the flat one; its worst is a wing breach.
    expect(Math.abs(result.best.pricePct)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(result.worst.pricePct)).toBe(10);
    for (const cell of result.cells) {
      expect(Number.isFinite(cell.pnlPerUnit)).toBe(true);
      expect(cell.underlying).toBeCloseTo(100 * (1 + cell.pricePct / 100), 6);
    }
  });

  it("flat/unchanged cell approximates the position value (sanity vs researchEconomics)", () => {
    const econ = condor();
    const result = evaluateScenarioGrid({
      economics: econ,
      spot: 100,
      sigma: 0.4,
      shocks: { pricePct: [0], ivShift: [0], daysForward: [0] },
      constraints: { contracts: 1 },
    });
    // At t=0 with no shock the grid value is the position's mark less
    // opening credit/debit — for this credit condor it must be >= the
    // expiry max loss and <= the credit kept if all legs expired worthless.
    expect(result.cells[0].pnlPerUnit).toBeGreaterThan(-econ.maxLoss - 0.5);
    expect(result.cells[0].pnlPerUnit).toBeLessThan(econ.netCredit + 0.5);
  });

  it("constraint verdicts: max-loss breach is a breach, missing budget is not-evaluable", () => {
    const econ = condor();
    const result = evaluateScenarioGrid({
      economics: econ,
      spot: 100,
      sigma: 0.4,
      shocks: { pricePct: [-10, 0, 10], ivShift: [0], daysForward: [30] },
      constraints: { contracts: 1, maxLoss: 1 },
    });
    const byName = Object.fromEntries(result.verdicts.map((v) => [v.constraint, v.status]));
    expect(byName.max_loss).toBe("breach");
    expect(byName.budget).toBe("not_evaluable");
    expect(result.withinConstraints).toBe(false);
  });

  it("constraint verdicts: DTE window and liquidity floor read the legs", () => {
    const econ = condor(); // legs: dte 35, OI 500
    const ok = evaluateScenarioGrid({
      economics: econ,
      spot: 100,
      sigma: 0.4,
      shocks: { pricePct: [0], ivShift: [0], daysForward: [0] },
      constraints: {
        contracts: 1,
        dteWindow: { min: 7, max: 60 },
        liquidityFloor: { minOpenInterest: 50, minVolume: 10, maxSpreadPct: 20 },
      },
    });
    const okByName = Object.fromEntries(ok.verdicts.map((v) => [v.constraint, v.status]));
    expect(okByName.dte_window).toBe("pass");
    expect(okByName.liquidity_floor).toBe("pass");

    const thinEcon = ironCondorEconomics(
      [
        leg("put", 90, 1.0, 1.2, 1, 35, 5),
        leg("put", 95, 2.4, 2.6, -1, 35, 5),
        leg("call", 105, 2.4, 2.6, -1, 35, 5),
        leg("call", 110, 1.0, 1.2, 1, 35, 5),
      ],
      100
    );
    const thin = evaluateScenarioGrid({
      economics: thinEcon,
      spot: 100,
      sigma: 0.4,
      shocks: { pricePct: [0], ivShift: [0], daysForward: [0] },
      constraints: { contracts: 1, liquidityFloor: { minOpenInterest: 50 } },
    });
    const thinByName = Object.fromEntries(thin.verdicts.map((v) => [v.constraint, v.status]));
    expect(thinByName.liquidity_floor).toBe("breach");

    const noOiEcon = ironCondorEconomics(
      [
        leg("put", 90, 1.0, 1.2, 1, 35, null),
        leg("put", 95, 2.4, 2.6, -1, 35, null),
        leg("call", 105, 2.4, 2.6, -1, 35, null),
        leg("call", 110, 1.0, 1.2, 1, 35, null),
      ],
      100
    );
    const noOi = evaluateScenarioGrid({
      economics: noOiEcon,
      spot: 100,
      sigma: 0.4,
      shocks: { pricePct: [0], ivShift: [0], daysForward: [0] },
      constraints: { contracts: 1, liquidityFloor: { minOpenInterest: 50 } },
    });
    const noOiByName = Object.fromEntries(noOi.verdicts.map((v) => [v.constraint, v.status]));
    expect(noOiByName.liquidity_floor).toBe("not_evaluable");
  });

  it("source pin: the engine adds no pricing engine of its own", () => {
    const src = readFileSync("src/services/goalScenarioEngine.ts", "utf8");
    expect(src).toContain("valueAtHorizon");
    expect(src).not.toMatch(/function blackScholes|normCdf|payoffAtExpiry/);
  });
});

const healthyPositions: DiscoveryPosition[] = [
  { symbol: "AAPL", kind: "stock", quantity: 50, marketValue: 10000, betaDelta: 4000 },
  { symbol: "MSFT", kind: "stock", quantity: 40, marketValue: 10000, betaDelta: 3500 },
  { symbol: "SPY", kind: "stock", quantity: 30, marketValue: 10000, betaDelta: 3000 },
  { symbol: "QQQ", kind: "stock", quantity: 25, marketValue: 10000, betaDelta: 3000 },
  { symbol: "XLF", kind: "stock", quantity: 100, marketValue: 10000, betaDelta: 1500 },
];

describe("auto-discovery: portfolio triggers (issue #1107)", () => {
  it("a healthy, diversified portfolio fires nothing", () => {
    const proposals = discoverGoalsFromPortfolio(
      // Diversified (each name 20% < 25% threshold) and delta-hedged
      // (net delta 10% < 20% threshold), no expiring/losing positions.
      { totalValue: 50000, netBetaDelta: 5000, positions: healthyPositions },
      DEFAULT_DISCOVERY_THRESHOLDS
    );
    expect(proposals).toEqual([]);
  });

  it("concentration breach proposes a deconcentrate goal with evidence", () => {
    const proposals = discoverGoalsFromPortfolio(
      {
        totalValue: 50000,
        netBetaDelta: 5000,
        positions: [
          { symbol: "NVDA", kind: "stock", quantity: 100, marketValue: 30000, betaDelta: 5000 },
          ...healthyPositions.slice(0, 2),
        ],
      },
      DEFAULT_DISCOVERY_THRESHOLDS
    );
    const hit = proposals.find((p) => p.kind === "deconcentrate");
    expect(hit).toBeDefined();
    expect(hit!.trigger).toBe("portfolio.concentration_breach");
    expect(hit!.evidence.join(" ")).toContain("NVDA");
    expect(hit!.scenario.goalKind).toBe("deconcentrate");
  });

  it("unhedged delta proposes a hedge_protect goal", () => {
    const proposals = discoverGoalsFromPortfolio(
      { totalValue: 50000, netBetaDelta: 40000, positions: healthyPositions },
      DEFAULT_DISCOVERY_THRESHOLDS
    );
    expect(proposals.some((p) => p.kind === "hedge_protect" && p.trigger === "portfolio.unhedged_delta")).toBe(true);
  });

  it("an expiring option leg proposes a repair goal", () => {
    const proposals = discoverGoalsFromPortfolio(
      {
        totalValue: 50000,
        netBetaDelta: 0,
        positions: [
          ...healthyPositions.map((p) => ({ ...p, marketValue: 9000 })),
          { symbol: "NVDA", kind: "option", quantity: -1, marketValue: 500, dte: 3, expiry: "2026-10-30" },
        ],
      },
      DEFAULT_DISCOVERY_THRESHOLDS
    );
    expect(proposals.some((p) => p.kind === "repair" && p.trigger === "portfolio.expiring_leg")).toBe(true);
  });

  it("a deeply losing position proposes a repair goal", () => {
    const proposals = discoverGoalsFromPortfolio(
      {
        totalValue: 50000,
        netBetaDelta: 0,
        positions: [
          ...healthyPositions.map((p) => ({ ...p, marketValue: 9000 })),
          { symbol: "TSLA", kind: "stock", quantity: 20, marketValue: 5000, unrealizedPnlPct: -0.42 },
        ],
      },
      DEFAULT_DISCOVERY_THRESHOLDS
    );
    expect(proposals.some((p) => p.kind === "repair" && p.trigger === "portfolio.losing_position")).toBe(true);
  });
});

describe("auto-discovery: regime, events, intent (issue #1107)", () => {
  it("regime triggers: bull → directional, chop → income, high_vol + high IV rank → iv_harvest", () => {
    expect(
      discoverGoalsFromRegime({ regime: "bull", notes: [], asOf: 0 }).proposals.map((p) => p.kind)
    ).toEqual(["directional"]);
    expect(
      discoverGoalsFromRegime({ regime: "chop", notes: [], asOf: 0 }).proposals.map((p) => p.kind)
    ).toEqual(["income"]);
    expect(
      discoverGoalsFromRegime({ regime: "high_vol", notes: [], asOf: 0 }, 85).proposals.map((p) => p.kind)
    ).toEqual(["iv_harvest"]);
  });

  it("high_vol without an IV rank proposes volatility_event and flags the missing rank", () => {
    const out = discoverGoalsFromRegime({ regime: "high_vol", notes: [], asOf: 0 }, null);
    expect(out.proposals.map((p) => p.kind)).toEqual(["volatility_event"]);
    expect(out.limitations.join(" ")).toMatch(/IV rank unavailable/i);
  });

  it("unknown regime proposes nothing and says why", () => {
    const out = discoverGoalsFromRegime({ regime: "unknown", notes: [], asOf: 0 });
    expect(out.proposals).toEqual([]);
    expect(out.limitations.length).toBeGreaterThan(0);
  });

  it("events: a null catalyst feed is flagged, never fabricated; earnings in window proposes volatility_event", () => {
    const noFeed = discoverGoalsFromEvents([{ symbol: "NVDA", catalysts: null }]);
    expect(noFeed.proposals).toEqual([]);
    expect(noFeed.limitations.join(" ")).toMatch(/catalyst feed unavailable/i);
    expect(noFeed.limitations.join(" ")).toContain("NVDA");

    const earnings = discoverGoalsFromEvents([
      { symbol: "NVDA", catalysts: [], earningsInDays: 5 },
    ]);
    expect(earnings.proposals.map((p) => p.kind)).toEqual(["volatility_event"]);
    expect(earnings.proposals[0].evidence.join(" ")).toContain("NVDA");
  });

  it("intent mapping covers the taxonomy's plain-language entries", () => {
    expect(goalKindForIntent("I want monthly income from my shares")).toBe("income");
    expect(goalKindForIntent("hedge my portfolio before earnings")).toBe("hedge_protect");
    expect(goalKindForIntent("repair this losing position")).toBe("repair");
    expect(goalKindForIntent("build a PMCC for leverage")).toBe("capital_efficient_leverage");
    expect(goalKindForIntent("sell a cash-secured put to enter")).toBe("cash_secured_entry");
    expect(goalKindForIntent("harvest IV while it is elevated")).toBe("iv_harvest");
    expect(goalKindForIntent("what is the weather")).toBeNull();
  });
});

describe("discovery as a research-pipeline mode + persistence (issue #1107)", () => {
  function fakeProvider(regime: "bull" | "bear" | "chop" | "high_vol" | "unknown") {
    return {
      getUniverseSymbols: async () => [],
      getQuote: async () => null,
      getChain: async () => {
        throw new Error("not used in discovery mode");
      },
      getTechnicals: async () => null,
      getCatalysts: async () => null, // the real provider's honest null
      getRegime: async () => ({ regime, notes: ["fixture"], asOf: 0 }),
    } as any;
  }

  it("runs over the ResearchDataProvider seam and flags the missing catalyst feed", async () => {
    const out = await runGoalScenarioDiscovery({
      provider: fakeProvider("chop"),
      portfolio: { totalValue: 50000, netBetaDelta: 40000, positions: healthyPositions },
      symbols: ["AAPL"],
    });
    const kinds = out.proposals.map((p) => p.kind);
    expect(kinds).toContain("income"); // chop regime
    expect(kinds).toContain("hedge_protect"); // unhedged delta
    expect(out.limitations.join(" ")).toMatch(/catalyst feed unavailable/i);
    for (const p of out.proposals) {
      expect(p.scenario.configSnapshot.rulesVersion).toBe(RESEARCH_CONFIG_DEFAULTS.rulesVersion);
    }
  });

  it("persisted proposals are discovered + proposed, tenant-scoped, and never active", async () => {
    const out = await runGoalScenarioDiscovery({
      provider: fakeProvider("bull"),
      portfolio: { totalValue: 50000, netBetaDelta: 0, positions: healthyPositions },
      symbols: [],
    });
    expect(out.proposals.length).toBeGreaterThan(0);
    const sql = freshSql();
    const goals = persistDiscoveredGoals(sql, "alice", out.proposals);
    expect(goals.length).toBe(out.proposals.length);
    for (const g of goals) {
      expect(g.source).toBe("discovered");
      expect(g.status).toBe("proposed");
      const back = getGoal(sql, "alice", g.id);
      expect(back?.status).toBe("proposed");
      const payload = back?.payload as any;
      expect(payload.trigger).toBeDefined();
      expect(Array.isArray(payload.evidence)).toBe(true);
    }
    expect(listGoals(sql, "bob")).toEqual([]);
    expect(listGoals(sql, "alice", "active")).toEqual([]);
  });
});
