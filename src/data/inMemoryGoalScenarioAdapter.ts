/**
 * Issue #2356 (#1976 step 4c) — the in-memory implementation
 * of the goal/scenario port, with semantics identical to the
 * DO-SQLite adapter (tenant scoping, referential honesty,
 * newest-first lists capped at 100).
 */
import {
  requireGoalScenarioOwner,
  type CreateGoalInput,
  type CreateScenarioInput,
  type GoalRecord,
  type GoalScenarioStore,
  type GoalStatus,
  type OutcomeRecord,
  type RecordOutcomeInput,
  type ScenarioRecord,
} from "./goalScenarioPorts";
import {
  newGoalRecordId,
  newPlatformRowId,
} from "../services/executionTreeIds";

/**
 * Issue #5175 slice 3: same mint as the DO-SQLite adapter (see there)
 * — the twin must agree with the production adapter, id for id.
 */
function newId(prefix: "goal" | "scen" | "outc"): string {
  if (prefix === "goal") return newGoalRecordId();
  return newPlatformRowId(prefix);
}

function byNewestFirst<T extends { createdAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export class InMemoryGoalScenarioStore implements GoalScenarioStore {
  private goals: GoalRecord[] = [];
  private scenarios: ScenarioRecord[] = [];
  private outcomes: OutcomeRecord[] = [];

  ensureTables(): void {
    // In-memory: nothing to ensure.
  }

  createGoal(input: CreateGoalInput): GoalRecord {
    const now = new Date().toISOString();
    const goal: GoalRecord = {
      id: newId("goal"),
      userLogin: requireGoalScenarioOwner(input.userLogin),
      kind: input.kind,
      title: input.title,
      status: input.status || "proposed",
      source: input.source || "user",
      payload: input.payload ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.goals.push(structuredClone(goal));
    return goal;
  }

  getGoal(userLogin: string, id: string): GoalRecord | null {
    const found = this.goals.find((g) => g.id === id && g.userLogin === userLogin);
    return found ? structuredClone(found) : null;
  }

  listGoals(userLogin: string, status?: GoalStatus): GoalRecord[] {
    return byNewestFirst(
      this.goals.filter((g) => g.userLogin === userLogin && (!status || g.status === status)),
    ).slice(0, 100).map((g) => structuredClone(g));
  }

  updateGoalStatus(userLogin: string, id: string, status: GoalStatus): boolean {
    const found = this.goals.find((g) => g.id === id && g.userLogin === userLogin);
    if (!found) return false;
    found.status = status;
    found.updatedAt = new Date().toISOString();
    return true;
  }

  createScenario(input: CreateScenarioInput): ScenarioRecord | null {
    const userLogin = input.userLogin || "default";
    if (!this.getGoal(userLogin, input.goalId)) return null;
    const now = new Date().toISOString();
    const scenario: ScenarioRecord = {
      id: newId("scen"),
      userLogin,
      goalId: input.goalId,
      portfolioRef: input.portfolioRef,
      shocks: input.shocks ?? null,
      constraints: input.constraints ?? null,
      status: input.status || "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.scenarios.push(structuredClone(scenario));
    return scenario;
  }

  getScenario(userLogin: string, id: string): ScenarioRecord | null {
    const found = this.scenarios.find((s) => s.id === id && s.userLogin === userLogin);
    return found ? structuredClone(found) : null;
  }

  listScenarios(userLogin: string, goalId: string): ScenarioRecord[] {
    return byNewestFirst(
      this.scenarios.filter((s) => s.userLogin === userLogin && s.goalId === goalId),
    ).slice(0, 100).map((s) => structuredClone(s));
  }

  recordOutcome(input: RecordOutcomeInput): OutcomeRecord | null {
    const userLogin = input.userLogin || "default";
    if (input.scenarioId && !this.getScenario(userLogin, input.scenarioId)) return null;
    if (input.goalId && !this.getGoal(userLogin, input.goalId)) return null;
    const outcome: OutcomeRecord = {
      id: newId("outc"),
      userLogin,
      goalId: input.goalId ?? null,
      scenarioId: input.scenarioId ?? null,
      recommendationRef: input.recommendationRef ?? null,
      screenRunRef: input.screenRunRef ?? null,
      kind: input.kind,
      metrics: input.metrics ?? null,
      createdAt: new Date().toISOString(),
    };
    this.outcomes.push(structuredClone(outcome));
    return outcome;
  }

  listOutcomes(
    userLogin: string,
    filter?: { scenarioId?: string; goalId?: string },
  ): OutcomeRecord[] {
    return byNewestFirst(
      this.outcomes.filter(
        (o) =>
          o.userLogin === userLogin &&
          (!filter?.scenarioId || o.scenarioId === filter.scenarioId) &&
          (filter?.scenarioId || !filter?.goalId || o.goalId === filter.goalId),
      ),
    ).slice(0, 100).map((o) => structuredClone(o));
  }
}
