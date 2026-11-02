/**
 * Issue #2908 (G1 under #2764) — StockScreenRunSpec
 * completeness pins. The spec carries trigger, userLogin,
 * scheduleId (when scheduled), jobId, goalId (when goal),
 * patternRef {patternId, version} pinned at run, and
 * presetRef {presetId, resolvedAt} resolved at run, plus
 * the existing fields — and no field is re-derived by hand
 * downstream: the broker, planner, and canonical-body
 * helper all read the spec.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildStockScreenRunSpec,
  specCanonicalFields,
  withRunProvenance,
  workflowTriggerForSpec,
  type StockScreenRunSpec,
} from "../src/workflows/stockScreenRunSpec";
import { startStockScreenWorkflowOrNull } from "../src/workflows/screenExecutionBroker";
import { planFromSpec } from "../src/workflows/stockScreenPlanner";
import { goalStockSpecFromPlan } from "../src/workflows/goalStockScreenSpec";

function baseSpec(overrides: Partial<StockScreenRunSpec> = {}): StockScreenRunSpec {
  return {
    source: "etrade",
    trigger: "manual",
    deliver: true,
    filters: {} as StockScreenRunSpec["filters"],
    universe: "NASDAQ100",
    asyncRequested: true,
    delivery: {},
    ...overrides,
  };
}

describe("buildStockScreenRunSpec provenance (G1)", () => {
  it("REST etrade spec carries trigger manual + userLogin from the route", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: {},
      query: new URLSearchParams(),
      asyncRequested: false,
      source: "etrade",
      userLogin: "alice",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.trigger).toBe("manual");
    expect(result.spec.userLogin).toBe("alice");
    expect(result.spec.scheduleId).toBeUndefined();
    expect(result.spec.patternRef).toBeUndefined();
  });

  it("goal source defaults trigger to goal", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: {},
      query: new URLSearchParams(),
      asyncRequested: false,
      source: "goal",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.trigger).toBe("goal");
  });

  it("builder carries schedule/job/goal ids and pinned pattern + resolved preset refs", () => {
    const result = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: {},
      query: new URLSearchParams(),
      asyncRequested: true,
      source: "etrade",
      trigger: "scheduled",
      userLogin: "alice",
      scheduleId: "sched-1",
      jobId: "job-1",
      patternRef: { patternId: "trend_breakout", version: "3" },
      presetRef: { presetId: "preset-1", resolvedAt: "2026-11-02T00:00:00Z" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.scheduleId).toBe("sched-1");
    expect(result.spec.jobId).toBe("job-1");
    expect(result.spec.patternRef).toEqual({ patternId: "trend_breakout", version: "3" });
    expect(result.spec.presetRef).toEqual({ presetId: "preset-1", resolvedAt: "2026-11-02T00:00:00Z" });
    expect(result.spec.goalId).toBeUndefined();
  });
});

describe("withRunProvenance (G1)", () => {
  it.each([
    ["scheduled", { trigger: "scheduled" as const, scheduleId: "sched-9", userLogin: "alice" }],
    ["nlq", { trigger: "nlq" as const, userLogin: "alice" }],
    ["mesh", { trigger: "mesh" as const, userLogin: "alice" }],
    ["goal", { trigger: "goal" as const, goalId: "goal-7", userLogin: "alice" }],
    ["research", { trigger: "research" as const, userLogin: "alice" }],
  ])("populates a %s spec without fabricating unknown fields", (_label, provenance) => {
    const out = withRunProvenance(baseSpec(), provenance);
    expect(out.trigger).toBe(provenance.trigger);
    expect(out.userLogin).toBe("alice");
    expect(out.jobId).toBeUndefined();
    expect(out.patternRef).toBeUndefined();
  });

  it("defined values win, undefined values never overwrite", () => {
    const out = withRunProvenance(baseSpec({ jobId: "job-1" }), { trigger: "scheduled" });
    expect(out.trigger).toBe("scheduled");
    expect(out.jobId).toBe("job-1");
  });
});

describe("workflowTriggerForSpec + specCanonicalFields (G1)", () => {
  it("only scheduled maps to a scheduled workflow trigger", () => {
    expect(workflowTriggerForSpec(baseSpec({ trigger: "scheduled" }))).toBe("scheduled");
    for (const trigger of ["manual", "nlq", "mesh", "goal", "research"] as const) {
      expect(workflowTriggerForSpec(baseSpec({ trigger }))).toBe("manual");
    }
  });

  it("canonical fields carry only defined provenance", () => {
    const fields = specCanonicalFields(
      baseSpec({
        trigger: "scheduled",
        userLogin: "alice",
        scheduleId: "sched-1",
        jobId: "job-1",
        patternRef: { patternId: "p", version: "1" },
      }),
    );
    expect(fields).toEqual({
      trigger: "scheduled",
      userLogin: "alice",
      scheduleId: "sched-1",
      jobId: "job-1",
      patternRef: { patternId: "p", version: "1" },
    });
  });
});

describe("broker reads the spec, never re-derives (G1)", () => {
  function fakeHandle() {
    return { workflowId: "wf-1", jobId: "job-1", status: "waiting" as const, existing: false, statusUrl: "/x" };
  }

  it("spec jobId, userLogin, schedule/goal/pattern/preset refs ride the command", async () => {
    const starter = vi.fn(async () => fakeHandle());
    const result = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: baseSpec({
        trigger: "scheduled",
        userLogin: "spec-alice",
        scheduleId: "sched-1",
        jobId: "spec-job-1",
        patternRef: { patternId: "trend_breakout", version: "3" },
        presetRef: { presetId: "preset-1", resolvedAt: "2026-11-02T00:00:00Z" },
      }),
      userLogin: "arg-alice",
      starter,
    });
    expect(result!.jobId).toBe("spec-job-1");
    const command = starter.mock.calls[0][1];
    expect(command.trigger).toBe("scheduled");
    expect(command.specTrigger).toBe("scheduled");
    expect(command.userLogin).toBe("spec-alice");
    expect(command.scheduleId).toBe("sched-1");
    expect(command.patternRef).toEqual({ patternId: "trend_breakout", version: "3" });
    expect(command.presetRef).toEqual({ presetId: "preset-1", resolvedAt: "2026-11-02T00:00:00Z" });
  });

  it("an NLQ spec keeps specTrigger nlq while the workflow trigger stays manual", async () => {
    const starter = vi.fn(async () => fakeHandle());
    await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: baseSpec({ trigger: "nlq" }),
      userLogin: "alice",
      starter,
    });
    const command = starter.mock.calls[0][1];
    expect(command.trigger).toBe("manual");
    expect(command.specTrigger).toBe("nlq");
  });
});

describe("planner + goal spec (G1)", () => {
  it("planFromSpec derives a scheduled plan from a scheduled spec", () => {
    const plan = planFromSpec(baseSpec({ trigger: "scheduled", universe: "TECH" }));
    expect(plan.idempotencyKey.startsWith("screener:scheduled:TECH:")).toBe(true);
    const manual = planFromSpec(baseSpec({ trigger: "manual", universe: "TECH" }));
    expect(manual.idempotencyKey.startsWith("screener:manual:TECH:")).toBe(true);
  });

  it("goal spec carries trigger goal + goalId + userLogin", () => {
    const spec = goalStockSpecFromPlan(
      { goalKind: "growth", outlook: "bullish", structures: ["stocks"], stockFilter: {}, optionsFilter: {} } as never,
      { goalId: "goal-7", userLogin: "alice" },
    );
    expect(spec.source).toBe("goal");
    expect(spec.trigger).toBe("goal");
    expect(spec.goalId).toBe("goal-7");
    expect(spec.userLogin).toBe("alice");
    expect(spec.goal).toEqual({ goalKind: "growth", outlook: "bullish", structures: ["stocks"] });
  });
});
