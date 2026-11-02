/**
 * Issue #2753 (Platform Phase 7, program #2468) — rollout governance.
 *
 * TDD RED first: this suite imports six modules that do not exist yet.
 * All six are pure derivation over caller-supplied data — zero reads,
 * zero writes, zero routes, zero activation:
 * - productRollout: product-agnostic stages internal → pilot → broad,
 *   fail-safe to internal, recorded never auto-advanced (screeningFlags
 *   idiom: reader-function injection, validated setter).
 * - mainnetGate: the 8 written mainnet requirements as a checklist
 *   evaluator. RED with an exact missing list unless ALL are
 *   affirmatively present. Presence only — the module does NOT
 *   authenticate evidence; a production GREEN needs a human to verify
 *   the references at the gate.
 * - readinessGate: per-phase readiness (deploy verified + revert plan +
 *   §15 present) as an explicit evaluator with an exact missing list.
 * - pilotGate: pilot runnable ONLY with non-empty cohort AND cohort
 *   approval AND explicit owner go-ahead AND testnet-only AND all three
 *   observability hooks (revenue, usage, audit). No route, no trigger,
 *   no storage — inert by construction.
 * - rolloutBudget: operator budget vs caller actuals; empty budget or
 *   empty actual is unevaluated, never "within" by default.
 * - rolloutRisks: risk register partitions (open, unmitigated,
 *   gate-blocking); blocksGate is register-owner judgment the module
 *   surfaces, never decides.
 * Deliberately NOT built here: any mainnet activation path, any pilot
 * run/trigger/cohort provisioning, any #2000 item, any #1819 fix or
 * decision, any price/policy/review artifact. No production caller
 * wires these evaluators yet — there is no mainnet path to block and
 * no pilot path to gate; that is stated in the §15, not hidden.
 * See PHASE7-INVENTORY.md for preconditions and scope lines.
 */
import { describe, expect, it } from "vitest";
import {
  getProductRolloutStage,
  isRolloutStage,
  setProductRolloutStage,
  stageAtLeast,
  type RolloutRead,
  type RolloutStage,
  type RolloutWrite,
} from "../src/data/productRollout";
import {
  evaluateMainnetGate,
  MAINNET_GATE_REQUIREMENTS,
  type MainnetGateEvidence,
} from "../src/data/mainnetGate";
import {
  evaluateReadiness,
  type ReadinessRecord,
} from "../src/data/readinessGate";
import {
  isPilotRunnable,
  type PilotRecord,
} from "../src/data/pilotGate";
import {
  evaluateBudget,
  evaluateProductBudget,
} from "../src/data/rolloutBudget";
import {
  evaluateRiskRegister,
  type RiskRecord,
} from "../src/data/rolloutRisks";

function mapReader(values: Record<string, string>): RolloutRead {
  return (key: string) => values[key] ?? null;
}

describe("productRollout", () => {
  it("reads a stored stage verbatim", () => {
    expect(
      getProductRolloutStage(mapReader({ "product.rollout.stock": "pilot" }), "stock"),
    ).toBe("pilot");
  });

  it("fails safe to internal on absent, unknown, and throwing reads", () => {
    expect(getProductRolloutStage(mapReader({}), "stock")).toBe("internal");
    expect(
      getProductRolloutStage(mapReader({ "product.rollout.stock": "live" }), "stock"),
    ).toBe("internal");
    const throwing: RolloutRead = () => {
      throw new Error("store down");
    };
    expect(getProductRolloutStage(throwing, "stock")).toBe("internal");
  });

  it("is per-product: one product's stage never leaks to another", () => {
    const read = mapReader({ "product.rollout.stock": "broad" });
    expect(getProductRolloutStage(read, "stock")).toBe("broad");
    expect(getProductRolloutStage(read, "options")).toBe("internal");
  });

  it("validates stages on write and rejects unknown stages", () => {
    const written: Record<string, string> = {};
    const write: RolloutWrite = (key, value) => {
      written[key] = value;
    };
    setProductRolloutStage(write, "stock", "pilot");
    expect(written["product.rollout.stock"]).toBe("pilot");
    expect(() =>
      setProductRolloutStage(write, "stock", "live" as RolloutStage),
    ).toThrow(/Invalid rollout stage/);
  });

  it("orders stages internal < pilot < broad", () => {
    expect(stageAtLeast("broad", "pilot")).toBe(true);
    expect(stageAtLeast("pilot", "broad")).toBe(false);
    expect(stageAtLeast("internal", "internal")).toBe(true);
    expect(isRolloutStage("pilot")).toBe(true);
    expect(isRolloutStage("live")).toBe(false);
  });
});

describe("mainnetGate", () => {
  const empty: MainnetGateEvidence = {
    pricesApproved: null,
    refundPolicy: null,
    subscriptionCreditsRules: null,
    cisoReview: null,
    cpoReview: null,
    ctoReview: null,
    cooDeployPlan: null,
    s15Report: null,
  };

  it("lists exactly 8 written requirements", () => {
    expect(MAINNET_GATE_REQUIREMENTS).toHaveLength(8);
  });

  it("is RED with all 8 missing on empty evidence", () => {
    const r = evaluateMainnetGate(empty);
    expect(r.blocked).toBe(true);
    expect(r.missing).toHaveLength(8);
    expect(r.satisfied).toHaveLength(0);
  });

  it("is RED with the exact missing list on partial evidence", () => {
    const r = evaluateMainnetGate({ ...empty, pricesApproved: "comment 1", cisoReview: "comment 2" });
    expect(r.blocked).toBe(true);
    expect(r.satisfied).toEqual(["pricesApproved", "cisoReview"]);
    expect(r.missing).toHaveLength(6);
    expect(r.missing).not.toContain("pricesApproved");
  });

  it("treats blank and whitespace-only references as missing, never satisfied", () => {
    const r = evaluateMainnetGate({ ...empty, pricesApproved: "   " });
    expect(r.blocked).toBe(true);
    expect(r.missing).toContain("pricesApproved");
  });

  it("is GREEN only on complete evidence (synthetic references, test-only)", () => {
    const full = Object.fromEntries(
      MAINNET_GATE_REQUIREMENTS.map((req) => [req.id, `synthetic-test-evidence:${req.id}`]),
    ) as MainnetGateEvidence;
    const r = evaluateMainnetGate(full);
    expect(r.blocked).toBe(false);
    expect(r.missing).toHaveLength(0);
    expect(r.satisfied).toHaveLength(8);
  });
});

describe("readinessGate", () => {
  const full: ReadinessRecord = {
    phase: "Phase 7",
    deployVerified: true,
    revertPlan: true,
    s15Present: true,
  };

  it("is ready only when deploy + revert plan + §15 are all present", () => {
    expect(evaluateReadiness(full).ready).toBe(true);
    expect(evaluateReadiness(full).missing).toHaveLength(0);
  });

  it("names exactly the missing items, one at a time", () => {
    expect(evaluateReadiness({ ...full, deployVerified: false }).missing).toEqual([
      "deployVerified",
    ]);
    expect(evaluateReadiness({ ...full, revertPlan: false }).missing).toEqual(["revertPlan"]);
    expect(evaluateReadiness({ ...full, s15Present: false }).missing).toEqual(["s15Present"]);
  });

  it("lists all three missing when nothing is present, plus a blank phase", () => {
    const r = evaluateReadiness({
      phase: "  ",
      deployVerified: false,
      revertPlan: false,
      s15Present: false,
    });
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["phase", "deployVerified", "revertPlan", "s15Present"]);
  });
});

describe("pilotGate", () => {
  const runnable: PilotRecord = {
    cohort: ["user-a", "user-b"],
    cohortApproved: true,
    ownerGoAhead: true,
    testnetOnly: true,
    observability: { revenue: true, usage: true, audit: true },
  };

  it("is runnable only with cohort + approval + go-ahead + testnet + all observability", () => {
    const r = isPilotRunnable(runnable);
    expect(r.runnable).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("blocks on every missing combination, each with its reason", () => {
    const cases: Array<[string, PilotRecord, string]> = [
      ["empty cohort", { ...runnable, cohort: [] }, "cohort"],
      ["blank-only cohort", { ...runnable, cohort: ["  "] }, "cohort"],
      ["unapproved cohort", { ...runnable, cohortApproved: false }, "cohortApproved"],
      ["no go-ahead", { ...runnable, ownerGoAhead: false }, "ownerGoAhead"],
      ["not testnet-only", { ...runnable, testnetOnly: false }, "testnetOnly"],
      ["no revenue hook", { ...runnable, observability: { revenue: false, usage: true, audit: true } }, "observability.revenue"],
      ["no usage hook", { ...runnable, observability: { revenue: true, usage: false, audit: true } }, "observability.usage"],
      ["no audit hook", { ...runnable, observability: { revenue: true, usage: true, audit: false } }, "observability.audit"],
    ];
    for (const [label, record, blocker] of cases) {
      const r = isPilotRunnable(record);
      expect(r.runnable, label).toBe(false);
      expect(r.blockers, label).toContain(blocker);
    }
  });
});

describe("rolloutBudget", () => {
  it("is unevaluated on empty budget or empty actual, never within by default", () => {
    expect(evaluateBudget(null, 100)).toBe("unevaluated");
    expect(evaluateBudget(100, null)).toBe("unevaluated");
    expect(evaluateBudget(null, null)).toBe("unevaluated");
  });

  it("compares actuals against budget numerically", () => {
    expect(evaluateBudget(100, 50)).toBe("within");
    expect(evaluateBudget(100, 100)).toBe("within");
    expect(evaluateBudget(100, 101)).toBe("over");
  });

  it("evaluates a product record per metric", () => {
    const r = evaluateProductBudget({
      product: "stock",
      budget: { rowsReadPerDay: 1000, costPerRun: null },
      actual: { rowsReadPerDay: 1200, costPerRun: 5 },
    });
    expect(r.rowsReadPerDay).toBe("over");
    expect(r.costPerRun).toBe("unevaluated");
  });
});

describe("rolloutRisks", () => {
  const risks: RiskRecord[] = [
    { id: "R1", risk: "Pilot without #2000 operability", mitigation: "Pilot blocked until #2000 lands", revertPath: "Do not start pilot", blocksGate: true },
    { id: "R2", risk: "Mainnet without approved prices", mitigation: null, revertPath: "Stay on testnet", blocksGate: true },
    { id: "R3", risk: "Stale credits copy in panel", mitigation: "Copy corrected in Phase 6", revertPath: null, blocksGate: false },
  ];

  it("partitions open, unmitigated, and gate-blocking risks exactly", () => {
    const r = evaluateRiskRegister(risks);
    expect(r.open).toHaveLength(3);
    expect(r.unmitigated.map((x) => x.id)).toEqual(["R2"]);
    expect(r.gateBlockers.map((x) => x.id)).toEqual(["R1", "R2"]);
  });

  it("reports an empty register as no blockers and no unmitigated risks", () => {
    const r = evaluateRiskRegister([]);
    expect(r.open).toHaveLength(0);
    expect(r.gateBlockers).toHaveLength(0);
    expect(r.unmitigated).toHaveLength(0);
  });
});
