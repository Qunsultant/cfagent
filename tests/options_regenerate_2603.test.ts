/**
 * Issue #2603 — regenerate rebuilds the SAME request from the stored
 * record and refuses (naming the gap) when the record cannot name it.
 * The original run is never the thing being written.
 */
import { describe, expect, it } from "vitest";
import { rebuildOptionsRegenerateRequest } from "../src/services/optionsRegenerate";

const now = "2026-11-03T20:00:00.000Z";

function body(over: Record<string, unknown> = {}) {
  return {
    trigger: "scheduled",
    symbol: "TSLA",
    thesis: "income",
    strategyMode: "all",
    targetDate: "2026-12-19",
    riskProfile: "balanced",
    allowedStrategiesResolved: ["covered_call", "cash_secured_put"],
    farDated: true,
    candidateLimit: 12,
    maxPlannedLoss: 1000,
    minRewardRisk: 1.5,
    ...over,
  };
}

describe("rebuildOptionsRegenerateRequest (#2603)", () => {
  it("rebuilds the same request from the stored body", () => {
    const plan = rebuildOptionsRegenerateRequest({
      reportId: "report-1",
      body: body(),
      userLogin: "alice",
      nowIso: now,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.request).toMatchObject({
      symbol: "TSLA",
      thesis: "income",
      strategyMode: "all",
      targetDate: "2026-12-19",
      riskProfile: "balanced",
      allowedStrategies: ["covered_call", "cash_secured_put"],
      farDated: true,
      limit: 12,
      maxPlannedLoss: 1000,
      minRewardRisk: 1.5,
    });
    expect(plan.regeneratedFrom).toBe("report-1");
  });

  it("keeps the recorded mode, defaulting to thesis only when the record has none", () => {
    const withMode = rebuildOptionsRegenerateRequest({
      reportId: "r",
      body: body({ strategyMode: "no-view" }),
      userLogin: "alice",
      nowIso: now,
    });
    expect(withMode.ok && withMode.request.strategyMode).toBe("no-view");
    const withoutMode = rebuildOptionsRegenerateRequest({
      reportId: "r",
      body: body({ strategyMode: undefined }),
      userLogin: "alice",
      nowIso: now,
    });
    expect(withoutMode.ok && withoutMode.request.strategyMode).toBe("thesis");
  });

  it("carries provenance so the new run is distinguishable from the original", () => {
    const plan = rebuildOptionsRegenerateRequest({
      reportId: "report-9",
      body: body(),
      userLogin: "alice",
      nowIso: now,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.request.regeneratedFrom).toBe("report-9");
    expect(plan.request.regeneratedAt).toBe(now);
    expect(plan.request.regeneratedBy).toBe("alice");
  });

  it("refuses a record with no symbol instead of guessing one", () => {
    const plan = rebuildOptionsRegenerateRequest({
      reportId: "r",
      body: body({ symbol: undefined, symbols: [] }),
      userLogin: "alice",
      nowIso: now,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.missing).toContain("symbol or symbols");
    expect(plan.reason).toMatch(/cannot be re-run/i);
  });

  it("refuses an unreadable stored body", () => {
    const plan = rebuildOptionsRegenerateRequest({
      reportId: "r",
      body: "not-an-object",
      userLogin: "alice",
      nowIso: now,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.missing).toContain("stored run body");
  });

  it("falls back to the opportunities action for an unknown recorded action", () => {
    const plan = rebuildOptionsRegenerateRequest({
      reportId: "r",
      body: body({ action: "something-else" }),
      userLogin: "alice",
      nowIso: now,
    });
    expect(plan.ok && plan.request.action).toBe("opportunities");
  });
});
