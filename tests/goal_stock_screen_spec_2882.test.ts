import { describe, it, expect, vi } from "vitest";
import {
  goalStockSpecFromPlan,
  isGoalStockSpec,
  planGoalStockLeg,
} from "../src/workflows/goalStockScreenSpec";
import { startStockScreenWorkflowOrNull } from "../src/workflows/screenExecutionBroker";
import { buildGoalScreenPlan } from "../src/services/goalDrivenScreen";
import type { GoalScreenPlan } from "../src/services/goalDrivenScreen";

const PLAN: GoalScreenPlan = {
  goalKind: "income",
  outlook: "range_bound",
  structures: ["iron_condor", "butterfly"],
  stockFilter: { momentum: "any", sector: "TECH", minPrice: 10 },
  optionsFilter: { minDte: 7, maxDte: 45 },
};

describe("goal stock leg translation #2882", () => {
  it("translates a plan to a goal spec: deliver false, universe ALL, provenance as reference", () => {
    const spec = goalStockSpecFromPlan(PLAN);
    expect(spec.source).toBe("goal");
    expect(spec.deliver).toBe(false);
    expect(spec.universe).toBe("ALL");
    expect(spec.asyncRequested).toBe(false);
    expect(spec.delivery).toEqual({});
    expect(spec.provider).toBeUndefined();
    expect(spec.filters).toEqual(PLAN.stockFilter);
    expect(spec.goal).toEqual({
      goalKind: "income",
      outlook: "range_bound",
      structures: ["iron_condor", "butterfly"],
    });
    expect(isGoalStockSpec(spec)).toBe(true);
  });

  it("preserves the plan's momentum mapping and never leaks options constraints into the stock filter", () => {
    const spec = goalStockSpecFromPlan(PLAN);
    expect(spec.filters.momentum).toBe("any");
    const filter = spec.filters as Record<string, unknown>;
    expect(filter).not.toHaveProperty("minDte");
    expect(filter).not.toHaveProperty("maxDte");
    expect(filter).not.toHaveProperty("minOpenInterest");
  });

  it("buildGoalScreenPlan momentum mapping survives translation (bullish -> bullish_breakout)", () => {
    const plan = buildGoalScreenPlan(
      {
        goalKind: "directional",
        direction: "bullish",
        portfolioRef: { kind: "hypothetical" },
        shocks: { pricePct: [0], ivShift: [0] },
        constraints: {},
        configSnapshot: {},
      } as never,
      {},
    );
    expect(plan.stockFilter.momentum).toBe("bullish_breakout");
    const spec = goalStockSpecFromPlan(plan);
    expect(spec.filters.momentum).toBe("bullish_breakout");
    expect(spec.goal?.outlook).toBe("bullish");
  });

  it("planner mapping: sector precedence, universe ALL, manual idempotency formula", () => {
    const spec = goalStockSpecFromPlan(PLAN);
    const plan = planGoalStockLeg(spec, "manual", "2026-11-02T10:00:00.000Z");
    expect(plan.sector).toBe("TECH");
    expect(plan.universe).toBe("ALL");
    expect(plan.idempotencyKey).toBe("screener:manual:ALL:TECH:2026-11-02T10:00:00.000Z");
    expect(plan.scheduledClaimKey).toBe("stock:ALL");
  });

  it("planner mapping refuses non-goal specs loudly", () => {
    const spec = goalStockSpecFromPlan(PLAN);
    expect(() => planGoalStockLeg({ ...spec, source: "etrade" }, "manual", "2026-11-02T10:00:00.000Z")).toThrow(
      /requires a source "goal" spec/,
    );
  });

  it("broker guard RETIRED (#2991): a goal spec routes like any spec when async", async () => {
    // The #2882 guard (source "goal" -> null) is retired by #2991:
    // goal dispatch becomes a caller of the one pipeline, so a goal
    // spec with async requested starts a workflow and carries its
    // goal provenance (specTrigger "goal") through the command.
    // No live caller passed goal specs to the broker before this
    // change, so no live route changes behavior today; the guard
    // removal enables the goal-dispatch migration follow-up.
    const starter = vi.fn().mockResolvedValue({ workflowId: "wf-1" });
    const spec = goalStockSpecFromPlan(PLAN);
    const result = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: { ...spec, asyncRequested: true },
      userLogin: "alice",
      starter: starter as never,
    });
    expect(result).not.toBeNull();
    expect(starter).toHaveBeenCalledTimes(1);
    const command = starter.mock.calls[0][1] as Record<string, unknown>;
    expect(command.specTrigger).toBe("goal");
    expect(command.filters).toEqual(PLAN.stockFilter);
    expect(result!.shards.length).toBeGreaterThan(0);
  });

  it("filter is copied, never aliased: mutating the spec filter leaves the plan intact", () => {
    const spec = goalStockSpecFromPlan(PLAN);
    (spec.filters as Record<string, unknown>).minPrice = 999;
    expect(PLAN.stockFilter.minPrice).toBe(10);
  });
});
