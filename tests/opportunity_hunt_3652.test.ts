/**
 * Issue #3652 — the seeded `opportunity-hunt` goal (daily 07:00,
 * enabled, `config/builtin-scheduled-goals.json`) failed every firing:
 * `search.opportunity_hunt` was absent from `OPERATION_CATALOG`, so
 * `createJob` threw `Unknown operation: search.opportunity_hunt` and the
 * tick's catch recorded a failure run.
 *
 * Pins (Red on main, Green with this change):
 * - the search catalog entry lists `search.opportunity_hunt` and
 *   `createJob` accepts it — the #1655 precedent, registration;
 * - registration alone is not the fix (#1655 applied only because
 *   `qa.run_sweep` had a consumer): the operation executes over the
 *   supplied closes, and an unreadable source fails with a named reason;
 * - a forced `opportunity-hunt` tick records a success run whose
 *   descriptor is the hunt summary and stamps the goal.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { OPERATION_CATALOG, createJob } from "../src/orchestrate";
import {
  executeOpportunityHunt,
  OPPORTUNITY_HUNT_MIN_BARS,
  OPPORTUNITY_HUNT_OPERATION,
  runOpportunityHunt,
} from "../src/services/opportunityHunt";

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    store,
    ctx: {
      storage: {
        get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
        put: async (k: string, v: unknown) => void store.set(k, v),
      },
    },
  };
}

function makeEnv() {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
  } as any;
}

/** 16 flat bars, then 5 higher ones: the fast SMA overtakes the slow one. */
const RISING = [...Array(21).fill(100).slice(0, 16), ...Array(5).fill(120)];

/** 20 flat bars, then a 3% dip: the mean-reversion family's entry. */
const DIP = [...Array(20).fill(100), 97];

const asMap = (entries: Record<string, number[]>) => new Map(Object.entries(entries));

describe("search.opportunity_hunt is registered (#3652)", () => {
  it("the search catalog entry lists the operation alongside search.query", () => {
    const search = OPERATION_CATALOG.find((e) => e.agent === "search");
    expect(search).toBeDefined();
    expect(search!.operations).toContain("search.query");
    expect(search!.operations).toContain(OPPORTUNITY_HUNT_OPERATION);
  });

  it("createJob accepts the operation instead of throwing Unknown operation", async () => {
    const job = await createJob(makeEnv(), {
      goalId: "opportunity-hunt",
      goalName: "Opportunity hunt",
      operation: OPPORTUNITY_HUNT_OPERATION,
      budgetCents: 1000,
    });
    expect(job.operation).toBe("search.opportunity_hunt");
    expect(job.status).toBe("pending");
  });
});

describe("runOpportunityHunt (#3652)", () => {
  it("reports the sma_crossover entry on a rising series", () => {
    const result = runOpportunityHunt({
      closesBySymbol: asMap({ AAA: RISING }),
      now: () => new Date("2026-11-19T12:00:00.000Z"),
    });
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(0);
    // Issue 6406 — a setup now carries its direction, latest close, the
    // evaluator's reason, and the entry recommendation's price range
    // (sma_crossover on a 120 close: entry 119.40–120.60, stop 114,
    // take-profit 132 — the externalized 0.5%/5%/10% levels).
    expect(result.setups).toEqual([
      {
        symbol: "AAA",
        strategy: "sma_crossover",
        direction: "entry",
        lastClose: 120,
        detail: "(Fast SMA 116.00 > Slow 104.00)",
        levels: { entryLow: 119.4, entryHigh: 120.6, stopLoss: 114, takeProfit: 132 },
      },
    ]);
    expect(result.summary).toContain("1 setup(s) across 1 symbol(s)");
    // Issue #6473 — the summary is the counts headline only: the symbol
    // enumeration moved to the report body (table, charts, counts section),
    // so the header no longer repeats it.
    expect(result.summary).not.toContain("AAA:sma_crossover");
    expect(result.asOf).toBe("2026-11-19T12:00:00.000Z");
  });

  it("reports the mean-reversion family on a dip, sorted by strategy", () => {
    const result = runOpportunityHunt({ closesBySymbol: asMap({ BBB: DIP }) });
    expect(result.setups.map((s) => s.strategy)).toEqual([
      "breakout",
      "mean_reversion",
      "rsi_reversal",
    ]);
    expect(result.summary).toContain("3 setup(s)");
  });

  it("skips a symbol below the bar floor and says so", () => {
    const result = runOpportunityHunt({
      closesBySymbol: asMap({ CCC: Array(OPPORTUNITY_HUNT_MIN_BARS - 1).fill(100) }),
    });
    expect(result.scanned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.setups).toEqual([]);
    expect(result.summary).toContain("1 skipped (short history)");
  });

  it("an empty universe is a completed hunt, not an error", () => {
    const result = runOpportunityHunt({ closesBySymbol: new Map() });
    expect(result.setups).toEqual([]);
    // Issue #6473 — no trailing "— none": the counts speak for themselves and
    // the body carries the (empty) symbol detail.
    expect(result.summary).toBe("Opportunity hunt: 0 setup(s) across 0 symbol(s)");
  });
});

describe("executeOpportunityHunt (#3652)", () => {
  it("fails with a named reason when the bar source throws", async () => {
    await expect(
      executeOpportunityHunt({
        loadCloses: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("opportunity_hunt_bar_source_failed: boom");
  });

  it("fails with a named reason when no bars are available", async () => {
    await expect(
      executeOpportunityHunt({ loadCloses: async () => new Map() }),
    ).rejects.toThrow(/opportunity_hunt_no_bars/);
  });

  it("returns the hunt over a readable source", async () => {
    const result = await executeOpportunityHunt({
      loadCloses: async () => asMap({ DDD: DIP }),
    });
    expect(result.setups.length).toBe(3);
  });
});

describe("the opportunity-hunt tick (#3652)", () => {
  // Issue #6205 — every test in this block restores the real clock, so a
  // pinned `Date` can never leak into the next file.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a success run carrying the hunt summary and stamps the goal", async () => {
    // Issue #6205 — pin the tick's clock. `onCron` runs every goal that is due
    // in the same tick as the forced one, and `resource-cap-alert` (daily
    // 00:00 UTC) needs AGENT_DB, which this test's env does not bind. With the
    // real clock the assertion below therefore passed or failed depending on
    // the hour CI ran. Only `Date` is faked: no timer in the path changes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T12:00:00.000Z"));

    const { ctx } = makeCtx();
    const agent: any = new (ScheduledAgent as any)(ctx, makeEnv());
    const summary = "Opportunity hunt: 0 setup(s) across 2 symbol(s) — none";
    const spy = vi.spyOn(agent, "huntOpportunities").mockResolvedValue({
      scanned: 2,
      skipped: 0,
      setups: [],
      summary,
      asOf: "2026-11-19T12:00:00.000Z",
      holdingsStatus: { available: false, reason: "holdings_not_loaded" },
      seriesBySymbol: {},
    });

    const tick = await agent.onCron({ forceGoalId: "opportunity-hunt" });

    expect(spy).toHaveBeenCalledTimes(1);
    // Issue #6205 — scoped to the goal under test. `onCron` runs every goal
    // that is due in the same tick as the forced one (by design), and another
    // goal's missing binding is that goal's prerequisite, not this one's
    // failure. The assertion still fails if this goal records an error.
    expect(tick.errors.filter((e: string) => e.startsWith("opportunity-hunt:"))).toEqual([]);
    expect(tick.jobsCreated).toBeGreaterThanOrEqual(1);
    const goal = (await agent.listGoals()).find((g: any) => g.id === "opportunity-hunt")!;
    expect(goal.lastRun).toBeTruthy();
    const runs = await agent.listJobRuns("opportunity-hunt");
    expect(runs[0]).toMatchObject({
      outcome: "success",
      operation: "search.opportunity_hunt",
      descriptor: summary,
    });
  });

  it("records the named failure and does not stamp the goal", async () => {
    const { ctx } = makeCtx();
    const agent: any = new (ScheduledAgent as any)(ctx, makeEnv());
    vi.spyOn(agent, "huntOpportunities").mockRejectedValue(
      new Error("opportunity_hunt_no_bars: nothing persisted"),
    );

    const tick = await agent.onCron({ forceGoalId: "opportunity-hunt" });

    expect(tick.errors.join(" ")).toContain("opportunity_hunt_no_bars");
    expect(tick.jobsSkipped).toBeGreaterThanOrEqual(1);
    const goal = (await agent.listGoals()).find((g: any) => g.id === "opportunity-hunt")!;
    expect(goal.lastRun).toBeFalsy();
    const runs = await agent.listJobRuns("opportunity-hunt");
    expect(runs[0].outcome).toBe("failure");
    expect(runs[0].error).toContain("opportunity_hunt_no_bars");
  });
});
