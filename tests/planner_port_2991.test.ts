/**
 * Issue #2991 (#2770 Phase A) — ONE planner port, per-asset-class
 * plan Blocks behind it. There is no options planner in the repo
 * today (only stockScreenPlanner.ts; zero "planner" mentions in
 * options code) — options planning inputs become the options plan
 * Block, NOT a second planner. No stock-only assumptions: the port
 * and the plan shape are generic over asset class.
 *
 * Common plan fields (owner directive): run identity, trigger,
 * provider, idempotency, delivery. Bonds/forex/futures/commodities
 * plan Blocks are named follow-ups: planning one fails closed with
 * a coded error, never a silent fallback.
 */
import { describe, expect, it } from "vitest";
import {
  createPlannerPort,
  optionsPlanBlock,
  stockPlanBlock,
  type PlannerInput,
} from "../src/workflows/blocks/plannerPort";
import { goalStockSpecFromPlan } from "../src/workflows/goalStockScreenSpec";
import type { StockScreenRunSpec } from "../src/workflows/stockScreenRunSpec";

const TIMESTAMP = "2026-11-02T10:00:00.000Z";

function stockSpec(): StockScreenRunSpec {
  return {
    source: "etrade",
    trigger: "manual",
    deliver: true,
    universe: "TECH",
    filters: { sector: "TECH" },
    asyncRequested: false,
    delivery: {},
  } as StockScreenRunSpec;
}

describe("planner port #2991", () => {
  it("plans a stock spec through the stock plan Block (matches planFromSpec)", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    const plan = port.plan({
      assetClass: "stock",
      runIdentity: { jobId: "job-1" },
      trigger: "manual",
      classInput: stockSpec(),
      timestamp: TIMESTAMP,
    });
    expect(plan.assetClass).toBe("stock");
    expect(plan.trigger).toBe("manual");
    expect(plan.provider).toBe("etrade");
    expect(plan.idempotencyKey).toBe(
      `screener:manual:TECH:TECH:${TIMESTAMP}`,
    );
    expect(plan.classPlan.sector).toBe("TECH");
    expect(plan.classPlan.universe).toBe("TECH");
    expect(plan.classPlan.scheduledClaimKey).toBe("stock:TECH");
  });

  it("plans a goal stock leg through the same stock plan Block", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    const spec = goalStockSpecFromPlan({
      goalKind: "income",
      outlook: "range_bound",
      structures: ["iron_condor", "butterfly"],
      stockFilter: { momentum: "any", sector: "TECH", minPrice: 10 },
      optionsFilter: { minDte: 7, maxDte: 45 },
    });
    const plan = port.plan({
      assetClass: "stock",
      runIdentity: { jobId: "job-1" },
      trigger: "manual",
      provenanceTrigger: "goal",
      classInput: spec,
      timestamp: TIMESTAMP,
    });
    expect(plan.classPlan.sector).toBe("TECH");
    expect(plan.classPlan.universe).toBe("ALL");
    expect(plan.idempotencyKey).toBe(
      `screener:manual:ALL:TECH:${TIMESTAMP}`,
    );
  });

  it("plans an options route request through the options plan Block", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    const plan = port.plan({
      assetClass: "options",
      runIdentity: { jobId: "job-2" },
      trigger: "manual",
      classInput: {
        request: {
          filter: {
            underlyingSymbols: ["AAPL"],
            minDte: 7,
            maxDte: 45,
            maxSpreadPct: 0.05,
            minVolume: 100,
            minOpenInterest: 50,
          },
          pushToSlack: true,
          slackChannel: "#screens",
          emailTo: "a@example.com",
        },
      },
      timestamp: TIMESTAMP,
    });
    expect(plan.assetClass).toBe("options");
    expect(plan.classPlan.underlyings).toEqual(["AAPL"]);
    expect(plan.classPlan.dteWindow).toEqual({ minDte: 7, maxDte: 45 });
    expect(plan.classPlan.spreadCap).toBe(0.05);
    expect(plan.classPlan.liquidityFloor).toEqual({
      minVolume: 100,
      minOpenInterest: 50,
    });
    expect(plan.classPlan.chainFetch).toEqual({
      strategy: "dynamic-options-screener",
    });
    expect(plan.delivery).toEqual({
      pushToSlack: true,
      slackChannel: "#screens",
      emailTo: "a@example.com",
    });
  });

  it("plans a goal options leg: structures + DTE + liquidity from the goal plan", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    const plan = port.plan({
      assetClass: "options",
      runIdentity: { jobId: "job-3" },
      trigger: "manual",
      provenanceTrigger: "goal",
      classInput: {
        goalPlan: {
          structures: ["iron_condor"],
          optionsFilter: { minDte: 7, maxDte: 45, minOpenInterest: 50 },
        },
      },
      timestamp: TIMESTAMP,
    });
    expect(plan.classPlan.structures).toEqual(["iron_condor"]);
    expect(plan.classPlan.dteWindow).toEqual({ minDte: 7, maxDte: 45 });
    expect(plan.classPlan.liquidityFloor).toEqual({ minOpenInterest: 50 });
    // Provider is recorded only when known — never fabricated.
    expect(plan.provider).toBeUndefined();
  });

  it("an options plan needs no stock fields: no universe, no sector required", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    const plan = port.plan({
      assetClass: "options",
      runIdentity: { jobId: "job-4" },
      trigger: "manual",
      classInput: { request: { filter: { minDte: 30 } } },
      timestamp: TIMESTAMP,
    });
    expect(plan.classPlan).not.toHaveProperty("universe");
    expect(plan.classPlan).not.toHaveProperty("sector");
    expect(plan.classPlan.dteWindow).toEqual({ minDte: 30 });
  });

  it("an invalid options filter fails closed (reused zod validation)", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    expect(() =>
      port.plan({
        assetClass: "options",
        runIdentity: { jobId: "job-5" },
        trigger: "manual",
        classInput: { request: { filter: { minDte: -1 } } },
        timestamp: TIMESTAMP,
      }),
    ).toThrow();
  });

  it("an unregistered asset class fails closed with a coded error, never a fallback", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    expect(port.supportedClasses).toEqual(["options", "stock"]);
    expect(() =>
      port.plan({
        assetClass: "bonds",
        runIdentity: { jobId: "job-6" },
        trigger: "manual",
        classInput: {},
        timestamp: TIMESTAMP,
      } as PlannerInput),
    ).toThrow(/plan_block_not_registered: bonds/);
  });

  it("duplicate plan Blocks for one class are rejected", () => {
    expect(() =>
      createPlannerPort([stockPlanBlock(), stockPlanBlock()]),
    ).toThrow(/stock/);
  });

  it("every plan carries the common fields: identity, trigger, idempotency, delivery", () => {
    const port = createPlannerPort([stockPlanBlock(), optionsPlanBlock()]);
    for (const input of [
      {
        assetClass: "stock",
        runIdentity: { jobId: "job-7" },
        trigger: "manual" as const,
        classInput: stockSpec(),
        timestamp: TIMESTAMP,
      },
      {
        assetClass: "options",
        runIdentity: { jobId: "job-8" },
        trigger: "manual" as const,
        classInput: { request: { filter: { minDte: 7 } } },
        timestamp: TIMESTAMP,
      },
    ]) {
      const plan = port.plan(input);
      expect(plan.runIdentity.jobId).toBeDefined();
      expect(plan.trigger).toBe("manual");
      expect(plan.idempotencyKey).toBeDefined();
      expect(plan.delivery).toBeDefined();
    }
  });
});
