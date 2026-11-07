/**
 * Issue #1257 retirement (PR3) — TDD anchor.
 *
 * The v1 recommendation-family modules are deleted: the five service
 * modules, their test files, and every route import of them. The drain
 * endpoints (promotions/start, advance, active) go with stagedPromotion;
 * the challenger endpoints under the same prefix stay.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETIRED_MODULES = [
  "src/services/strategyWeights.ts",
  "src/services/improvementCandidates.ts",
  "src/services/candidateEvaluation.ts",
  "src/services/promotionGate.ts",
  "src/services/stagedPromotion.ts",
];

const RETIRED_TESTS = [
  "tests/strategy_weights.test.ts",
  "tests/staged_promotion.test.ts",
  "tests/candidate_evaluation.test.ts",
  "tests/promotion_gate.test.ts",
  "tests/improvement_candidates.test.ts",
];

describe("#1257 retirement: v1 modules are gone", () => {
  it("the five retired service modules do not exist", () => {
    for (const f of RETIRED_MODULES) {
      expect(existsSync(path.join(ROOT, f)), `${f} must be deleted`).toBe(false);
    }
  });

  it("the five retired module test files do not exist", () => {
    for (const f of RETIRED_TESTS) {
      expect(existsSync(path.join(ROOT, f)), `${f} must be deleted`).toBe(false);
    }
  });

  it("no route imports a retired module", () => {
    const routes = readFileSync(path.join(ROOT, "src/agents/routes/screenerResearch.ts"), "utf8");
    // The v1 path ends with a quote; the v2 path (strategyWeightsV2)
    // must not trip this pin.
    expect(routes).not.toMatch(/services\/strategyWeights"/);
    for (const name of ["stagedPromotion", "promotionGate", "candidateEvaluation", "improvementCandidates"]) {
      expect(routes, `screenerResearch still references ${name}`).not.toContain(name);
    }
  });

  it("the drain endpoints are gone from the route table", () => {
    const routes = readFileSync(path.join(ROOT, "src/agents/routes/screenerResearch.ts"), "utf8");
    // Exact-match (closing quote): the #1257 live-check route
    // /adaptation/promotions/active-check shares the "active" prefix, so
    // a bare substring check would trip on it. The deleted drain
    // endpoint's exact condition string is what is guarded here.
    for (const endpoint of ["/adaptation/promotions/start", "/adaptation/promotions/advance", "/adaptation/promotions/active"]) {
      expect(routes, `drain endpoint ${endpoint} must be deleted`).not.toContain(`${endpoint}"`);
    }
  });

  it("the challenger endpoints under the same prefix stay", () => {
    const routes = readFileSync(path.join(ROOT, "src/agents/routes/screenerResearch.ts"), "utf8");
    for (const endpoint of ["/adaptation/promotions", "/adaptation/promotions/promote", "/adaptation/promotions/rollback"]) {
      expect(routes, `challenger endpoint ${endpoint} must stay`).toContain(endpoint);
    }
  });

  it("the moved helpers live in strategyWeightsV2", () => {
    const v2 = readFileSync(path.join(ROOT, "src/services/strategyWeightsV2.ts"), "utf8");
    for (const name of [
      "STRATEGY_WEIGHT_BOUNDS",
      "WEIGHT_ADAPTATION_ACTOR",
      "WEIGHTS_LAST_RUN_WEEK_KEY",
      "isoWeekKey",
      "proposeWeightAdjustments",
      "buildWeightPolicyEvaluation",
    ]) {
      expect(v2, `strategyWeightsV2 must export ${name}`).toContain(name);
    }
    expect(v2, "strategyWeightsV2 must not import v1").not.toContain("./strategyWeights\"");
  });
});
