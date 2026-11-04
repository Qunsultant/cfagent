/**
 * Issue #2991 (#2770 Phase A) — one layered contract stack:
 * intent -> plan -> execution command -> stage messages ->
 * persisted results -> reports. The historical contracts are
 * mapped onto it exactly once each, with a disposition: canonical
 * (the layer's form), thin-view (survives as a view over the
 * canonical form), retire-follow-up (competes; retirement is its
 * own slice, never a silent deletion), or retired (retired by
 * this slice, named).
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACT_STACK,
  validateContractStack,
  type ContractLayer,
} from "../src/workflows/blocks/contractStack";

const LAYERS: ContractLayer[] = [
  "intent",
  "plan",
  "executionCommand",
  "stageMessages",
  "persistedResults",
  "reports",
];

describe("contract stack #2991", () => {
  it("maps every known historical contract exactly once", () => {
    const names = CONTRACT_STACK.map((r) => r.contract);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of [
      "parseStockScreenRequest",
      "parseOptionsScreenRequest",
      "GoalScreenPlan",
      "StockScreenRunSpec",
      "StockScreenPlan",
      "optionsPlanBlock",
      "ScreenerRunRequest",
      "WorkflowJobCommand",
      "StageMessage",
      "AsyncJob",
      "ScreeningProviderRegistry",
      "ScreenerAgent.runScreen",
      "DynamicOptionsScreener",
      "mas_reports+mas_data_captures+ledger",
      "mas_events saga audit rows",
      "outcomeCatalog+channelTemplates",
      "goal reports+Docs+delivery",
      "broker goal guard",
      "goal-dispatch parallel execution",
      "sync-only options path",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("every layer has at least one canonical contract", () => {
    for (const layer of LAYERS) {
      const canonical = CONTRACT_STACK.filter(
        (r) => r.layer === layer && r.disposition === "canonical",
      );
      expect(canonical.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("the broker goal guard is retired by this slice, named", () => {
    const row = CONTRACT_STACK.find((r) => r.contract === "broker goal guard");
    expect(row?.disposition).toBe("retired");
    expect(row?.notes).toContain("#2991");
  });

  it("competing shapes are retire-follow-ups with a named follow-up, never silent", () => {
    for (const contract of [
      "goal-dispatch parallel execution",
      "sync-only options path",
    ]) {
      const row = CONTRACT_STACK.find((r) => r.contract === contract);
      expect(row?.disposition).toBe("retire-follow-up");
      expect(row?.notes.length).toBeGreaterThan(0);
    }
  });

  it("the stack validates; a duplicate contract fails validation", () => {
    expect(() => validateContractStack(CONTRACT_STACK)).not.toThrow();
    expect(() =>
      validateContractStack([...CONTRACT_STACK, CONTRACT_STACK[0]]),
    ).toThrow(/duplicate/);
  });

  it("a retire-follow-up row without a named follow-up fails validation", () => {
    expect(() =>
      validateContractStack([
        {
          contract: "x",
          layer: "plan",
          disposition: "retire-follow-up",
          notes: "",
        },
      ]),
    ).toThrow(/follow-up/);
  });
});
