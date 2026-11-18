/**
 * Issue #1098 (Phase 0 of epic #1096) — mas_goals / mas_scenarios /
 * mas_outcomes store pins.
 *
 *  - The three tables are created by ensureGoalScenarioTables() with the
 *    exact table names the epic specifies (schema pin).
 *  - CRUD round-trips: a goal can be created, read back, listed, and its
 *    status updated; a scenario attaches to a goal and stores its
 *    portfolio reference (real | hypothetical), shock grid, and
 *    constraints as JSON; an outcome records against a scenario/goal.
 *  - Tenant isolation: every read/write is scoped by user_login (the
 *    #584 EP-003 tenant-scoping precedent). Another tenant's goal is
 *    invisible, cannot be status-updated, cannot have scenarios or
 *    outcomes attached to it.
 *  - Referential honesty: attaching a scenario to a missing goal, or an
 *    outcome to a missing scenario, returns null instead of writing an
 *    orphan row.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  GOAL_SCENARIO_TABLES,
  ensureGoalScenarioTables,
  createGoal,
  getGoal,
  listGoals,
  updateGoalStatus,
  createScenario,
  getScenario,
  listScenarios,
  recordOutcome,
  listOutcomes,
} from "../src/services/goalScenarioStore";

function freshSql() {
  return new MockSqlStorage() as any;
}

describe("goal/scenario/outcome store (issue #1098)", () => {
  it("declares exactly the epic's three tables", () => {
    expect(GOAL_SCENARIO_TABLES).toEqual(["mas_goals", "mas_scenarios", "mas_outcomes"]);
  });

  it("ensure creates all three tables", () => {
    const sql = freshSql();
    // The repo harness has no real SQLite (MockSqlStorage does not parse
    // CREATE TABLE), so — exactly as tests/schema_single_source.test.ts
    // documents — the executed-DDL capture at the SqlStorage seam is the
    // faithful equivalent of sqlite_master introspection.
    const executed: string[] = [];
    const recording = {
      exec: (q: string, ...args: any[]) => {
        executed.push(q);
        return sql.exec(q, ...args);
      },
    };
    ensureGoalScenarioTables(recording);
    for (const t of GOAL_SCENARIO_TABLES) {
      expect(
        executed.some((q) => new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`, "i").test(q)),
        `expected a CREATE TABLE for ${t}`
      ).toBe(true);
    }
  });

  it("goal CRUD round-trip with JSON payload", () => {
    const sql = freshSql();
    const goal = createGoal(sql, {
      userLogin: "alice",
      kind: "income",
      title: "Monthly covered-call income",
      source: "user",
      payload: { targetMonthly: 500 },
    });
    expect(goal.id).toMatch(/^goal:/);  // #5175 slice 3: goal records mint goal:<time36>-<rand6>
    expect(goal.status).toBe("proposed");
    const back = getGoal(sql, "alice", goal.id);
    expect(back?.title).toBe("Monthly covered-call income");
    expect(back?.kind).toBe("income");
    expect(back?.payload).toEqual({ targetMonthly: 500 });
    expect(listGoals(sql, "alice")).toHaveLength(1);
    expect(updateGoalStatus(sql, "alice", goal.id, "active")).toBe(true);
    expect(getGoal(sql, "alice", goal.id)?.status).toBe("active");
    expect(listGoals(sql, "alice", "active")).toHaveLength(1);
    expect(listGoals(sql, "alice", "proposed")).toHaveLength(0);
  });

  it("tenant isolation: another tenant cannot see, update, or attach to a goal", () => {
    const sql = freshSql();
    const goal = createGoal(sql, { userLogin: "alice", kind: "repair", title: "Repair NVDA vertical" });
    expect(getGoal(sql, "bob", goal.id)).toBeNull();
    expect(listGoals(sql, "bob")).toEqual([]);
    expect(updateGoalStatus(sql, "bob", goal.id, "active")).toBe(false);
    expect(createScenario(sql, { userLogin: "bob", goalId: goal.id, portfolioRef: { kind: "real" } })).toBeNull();
    expect(getGoal(sql, "alice", goal.id)?.status).toBe("proposed");
  });

  it("scenario round-trip: portfolio ref, shock grid, and constraints survive as JSON", () => {
    const sql = freshSql();
    const goal = createGoal(sql, { userLogin: "alice", kind: "hedge_protect", title: "Protect portfolio" });
    const scenario = createScenario(sql, {
      userLogin: "alice",
      goalId: goal.id,
      portfolioRef: { kind: "hypothetical", ref: "paper-1" },
      shocks: { pricePct: [-10, 0, 10], ivPoints: [0, 5], days: [0, 30] },
      constraints: { maxLoss: 2000, budget: 10000 },
    });
    expect(scenario).not.toBeNull();
    expect(scenario!.goalId).toBe(goal.id);
    expect(scenario!.portfolioRef).toEqual({ kind: "hypothetical", ref: "paper-1" });
    expect(scenario!.shocks).toEqual({ pricePct: [-10, 0, 10], ivPoints: [0, 5], days: [0, 30] });
    expect(scenario!.constraints).toEqual({ maxLoss: 2000, budget: 10000 });
    expect(getScenario(sql, "alice", scenario!.id)?.id).toBe(scenario!.id);
    expect(listScenarios(sql, "alice", goal.id)).toHaveLength(1);
    expect(getScenario(sql, "bob", scenario!.id)).toBeNull();
  });

  it("scenario for a missing goal returns null (no orphan rows)", () => {
    const sql = freshSql();
    expect(
      createScenario(sql, { userLogin: "alice", goalId: "goal_nope", portfolioRef: { kind: "real" } })
    ).toBeNull();
  });

  it("outcome round-trip and tenant/scenario honesty", () => {
    const sql = freshSql();
    const goal = createGoal(sql, { userLogin: "alice", kind: "income", title: "Income" });
    const scenario = createScenario(sql, {
      userLogin: "alice",
      goalId: goal.id,
      portfolioRef: { kind: "real" },
    })!;
    const outcome = recordOutcome(sql, {
      userLogin: "alice",
      goalId: goal.id,
      scenarioId: scenario.id,
      recommendationRef: "rec_1",
      kind: "paper",
      metrics: { pnl: 120.5, maxDrawdown: -40 },
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.metrics).toEqual({ pnl: 120.5, maxDrawdown: -40 });
    expect(listOutcomes(sql, "alice", { scenarioId: scenario.id })).toHaveLength(1);
    expect(listOutcomes(sql, "alice", { goalId: goal.id })).toHaveLength(1);
    expect(listOutcomes(sql, "bob", { scenarioId: scenario.id })).toEqual([]);
    expect(
      recordOutcome(sql, { userLogin: "alice", scenarioId: "scen_nope", kind: "paper" })
    ).toBeNull();
  });

  it("refuses to create a goal without a tenant (no 'default' owner)", () => {
    const sql = freshSql();
    expect(() => createGoal(sql, { kind: "directional", title: "Ownerless goal" } as any)).toThrow(
      /owning userLogin/,
    );
    const goal = createGoal(sql, { kind: "directional", title: "Alice goal", userLogin: "alice" });
    expect(goal.userLogin).toBe("alice");
    expect(getGoal(sql, "alice", goal.id)?.id).toBe(goal.id);
    expect(getGoal(sql, "default", goal.id)).toBeNull();
  });
});
