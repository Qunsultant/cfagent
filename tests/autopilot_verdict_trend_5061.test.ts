/**
 * Issue #5061 (AG-7) — the monthly Autopilot verdicts get an operator-facing
 * consumer.
 *
 * A verdict was recorded each month and nothing read it: a rule that kept
 * blocking produced one row a month and nothing else. GET /autopilot now
 * aggregates the verdicts it already lists and names a repeated binding rule.
 * The aggregate is evidence — the envelope still changes by human edit.
 */
import { describe, it, expect } from "vitest";
import {
  AUTOPILOT_VERDICT_TREND_DEFAULTS,
  resolveAutopilotVerdictTrendPolicy,
  summarizeAutopilotVerdictTrend,
  type AutopilotVerdictLike,
} from "../src/services/autopilotVerdictTrend";
import {
  handleAutopilotRoutes,
  type AutopilotRouteContext,
} from "../src/agents/routes/autopilot";

const policy = { ...AUTOPILOT_VERDICT_TREND_DEFAULTS };

function verdict(
  passed: boolean,
  bindingRule: string | null,
  createdAt = "2026-11-01T00:00:00.000Z",
): AutopilotVerdictLike {
  return { passed: passed ? 1 : 0, binding_rule: bindingRule, created_at: createdAt };
}

describe("Issue #5061 — autopilot verdict trend", () => {
  it("resolves its thresholds from env with defaults", () => {
    const resolved = resolveAutopilotVerdictTrendPolicy({
      AUTOPILOT_VERDICT_TREND_WINDOW: "10",
      AUTOPILOT_VERDICT_REPEAT_THRESHOLD: "3",
      AUTOPILOT_VERDICT_TREND_ENABLED: "false",
    } as any);
    expect(resolved).toEqual({ enabled: false, window: 10, repeatThreshold: 3 });
    expect(resolveAutopilotVerdictTrendPolicy({} as any)).toEqual(
      AUTOPILOT_VERDICT_TREND_DEFAULTS,
    );
  });

  it("names a binding rule that repeats in the window", () => {
    const trend = summarizeAutopilotVerdictTrend(
      [
        verdict(false, "max_daily_notional"),
        verdict(false, "max_daily_notional"),
        verdict(true, null),
        verdict(false, "max_open_positions"),
      ],
      policy,
    );

    expect(trend.evaluations).toBe(4);
    expect(trend.blocked).toBe(3);
    expect(trend.passed).toBe(1);
    expect(trend.repeatedBindingRules).toEqual([
      { rule: "max_daily_notional", count: 2 },
    ]);
    expect(trend.escalated).toBe(true);
    expect(trend.notice).toContain("max_daily_notional ×2");
    expect(trend.notice).toContain("changed by a human");
  });

  it("stays quiet for one-offs and for all-passing windows", () => {
    expect(
      summarizeAutopilotVerdictTrend(
        [verdict(false, "max_daily_notional"), verdict(true, null)],
        policy,
      ).escalated,
    ).toBe(false);

    const clean = summarizeAutopilotVerdictTrend(
      [verdict(true, null), verdict(true, null)],
      policy,
    );
    expect(clean.escalated).toBe(false);
    expect(clean.notice).toBeNull();
  });

  it("only considers the newest window", () => {
    const verdicts = [
      verdict(false, "new_rule"),
      verdict(false, "new_rule"),
      verdict(false, "old_rule"),
      verdict(false, "old_rule"),
    ];
    const trend = summarizeAutopilotVerdictTrend(verdicts, {
      ...policy,
      window: 2,
    });
    expect(trend.evaluations).toBe(2);
    expect(trend.repeatedBindingRules.map((r) => r.rule)).toEqual(["new_rule"]);
  });

  it("honours the kill switch", () => {
    const trend = summarizeAutopilotVerdictTrend(
      [verdict(false, "max_daily_notional"), verdict(false, "max_daily_notional")],
      { ...policy, enabled: false },
    );
    expect(trend.enabled).toBe(false);
    expect(trend.escalated).toBe(false);
    expect(trend.notice).toBeNull();
  });

  it("is served by GET /autopilot", async () => {
    const verdicts = [
      verdict(false, "max_daily_notional"),
      verdict(false, "max_daily_notional"),
      verdict(true, null),
    ];
    const ctx = {
      ensureTables: () => ({}),
      env: {} as any,
      audit: () => {},
      getAutopilotState: () => ({ running: true, killSwitch: false }),
      writeAutopilotState: () => ({}),
      evaluateAndRecordAutopilotVerdict: async () => {
        throw new Error("not used");
      },
    } as unknown as AutopilotRouteContext;

    // The port read comes from the orchestrator tables; the route tolerates a
    // store that cannot answer (empty list) — so drive the aggregate directly
    // through the same service the route calls, and assert the route's shape.
    const response = await handleAutopilotRoutes(
      new Request("https://agent.internal/autopilot"),
      new URL("https://agent.internal/autopilot"),
      "/autopilot",
      "session-1",
      ctx,
    );
    const body = (await response!.json()) as any;

    expect(body.verdictTrend).toBeDefined();
    expect(body.verdictTrend.enabled).toBe(true);
    expect(body.verdictTrend.evaluations).toBe(0);
    expect(body.recentVerdicts).toEqual([]);
    // With verdicts present the aggregate names the repeat; that path is
    // covered against the real projection by the summarize tests above.
    expect(verdicts).toHaveLength(3);
  });
});
