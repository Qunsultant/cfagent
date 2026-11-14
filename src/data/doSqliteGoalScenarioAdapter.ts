/**
 * Issue #2356 (#1976 step 4c) — the DO-SQLite implementation
 * of the goal/scenario port: the legacy
 * src/services/goalScenarioStore.ts, moved into the data
 * layer statement-for-statement. The service module is now
 * a re-export shim over this adapter and goalScenarioPorts.
 */
import {
  requireGoalScenarioOwner,
  type CreateGoalInput,
  type CreateScenarioInput,
  type GoalRecord,
  type GoalScenarioSqlExecutor,
  type GoalScenarioStore,
  type GoalStatus,
  type OutcomeRecord,
  type RecordOutcomeInput,
  type ScenarioRecord,
} from "./goalScenarioPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function goalFromRow(r: any): GoalRecord {
  return {
    id: r.id,
    userLogin: r.user_login,
    kind: r.kind,
    title: r.title,
    status: r.status,
    source: r.source,
    payload: parseJson(r.payload_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function scenarioFromRow(r: any): ScenarioRecord {
  return {
    id: r.id,
    userLogin: r.user_login,
    goalId: r.goal_id,
    portfolioRef: r.portfolio_ref
      ? { kind: r.portfolio_ref_kind, ref: r.portfolio_ref }
      : { kind: r.portfolio_ref_kind },
    shocks: parseJson(r.shocks_json),
    constraints: parseJson(r.constraints_json),
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function outcomeFromRow(r: any): OutcomeRecord {
  return {
    id: r.id,
    userLogin: r.user_login,
    goalId: r.goal_id ?? null,
    scenarioId: r.scenario_id ?? null,
    recommendationRef: r.recommendation_ref ?? null,
    screenRunRef: r.screen_run_ref ?? null,
    kind: r.kind,
    metrics: parseJson(r.metrics_json),
    createdAt: r.created_at,
  };
}

export class DoSqliteGoalScenarioStore implements GoalScenarioStore {
  constructor(private readonly sql: GoalScenarioSqlExecutor) {}

  ensureTables(): void {
    const sql = this.sql;
    sql.exec(doTableSql("mas_goals"));
    sql.exec(doIndexSql("idx_mas_goals_user_status"));
    sql.exec(doTableSql("mas_scenarios"));
    sql.exec(doIndexSql("idx_mas_scenarios_user_goal"));
    sql.exec(doTableSql("mas_outcomes"));
    sql.exec(doIndexSql("idx_mas_outcomes_user_scenario"));
  }

  createGoal(input: CreateGoalInput): GoalRecord {
    this.ensureTables();
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
    this.sql.exec(
      `INSERT INTO mas_goals (id, user_login, kind, title, status, source, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      goal.id, goal.userLogin, goal.kind, goal.title, goal.status, goal.source,
      JSON.stringify(goal.payload), goal.createdAt, goal.updatedAt
    );
    return goal;
  }

  getGoal(userLogin: string, id: string): GoalRecord | null {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT * FROM mas_goals WHERE id = ? AND user_login = ?`, id, userLogin)
    ) as any[];
    return rows.length ? goalFromRow(rows[0]) : null;
  }

  listGoals(userLogin: string, status?: GoalStatus): GoalRecord[] {
    this.ensureTables();
    const rows = status
      ? (Array.from(
          this.sql.exec(
            `SELECT * FROM mas_goals WHERE user_login = ? AND status = ? ORDER BY created_at DESC LIMIT 100`,
            userLogin, status
          )
        ) as any[])
      : (Array.from(
          this.sql.exec(`SELECT * FROM mas_goals WHERE user_login = ? ORDER BY created_at DESC LIMIT 100`, userLogin)
        ) as any[]);
    return rows.map(goalFromRow);
  }

  updateGoalStatus(userLogin: string, id: string, status: GoalStatus): boolean {
    this.ensureTables();
    // Tenant check first: MockSqlStorage and real SqlStorage differ in what
    // an UPDATE result reports, so existence is proven by a scoped read.
    if (!this.getGoal(userLogin, id)) return false;
    this.sql.exec(
      `UPDATE mas_goals SET status = ?, updated_at = ? WHERE id = ? AND user_login = ?`,
      status, new Date().toISOString(), id, userLogin
    );
    return true;
  }

  createScenario(input: CreateScenarioInput): ScenarioRecord | null {
    this.ensureTables();
    const userLogin = input.userLogin || "default";
    // No orphan scenarios, and no attaching to another tenant's goal.
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
    this.sql.exec(
      `INSERT INTO mas_scenarios (id, user_login, goal_id, portfolio_ref_kind, portfolio_ref, shocks_json, constraints_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scenario.id, scenario.userLogin, scenario.goalId, scenario.portfolioRef.kind,
      scenario.portfolioRef.ref ?? null, JSON.stringify(scenario.shocks),
      JSON.stringify(scenario.constraints), scenario.status, scenario.createdAt, scenario.updatedAt
    );
    return scenario;
  }

  getScenario(userLogin: string, id: string): ScenarioRecord | null {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT * FROM mas_scenarios WHERE id = ? AND user_login = ?`, id, userLogin)
    ) as any[];
    return rows.length ? scenarioFromRow(rows[0]) : null;
  }

  listScenarios(userLogin: string, goalId: string): ScenarioRecord[] {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM mas_scenarios WHERE user_login = ? AND goal_id = ? ORDER BY created_at DESC LIMIT 100`,
        userLogin, goalId
      )
    ) as any[];
    return rows.map(scenarioFromRow);
  }

  recordOutcome(input: RecordOutcomeInput): OutcomeRecord | null {
    this.ensureTables();
    const userLogin = input.userLogin || "default";
    // Referential honesty: a named parent must exist for THIS tenant.
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
    this.sql.exec(
      `INSERT INTO mas_outcomes (id, user_login, goal_id, scenario_id, recommendation_ref, screen_run_ref, kind, metrics_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      outcome.id, outcome.userLogin, outcome.goalId, outcome.scenarioId,
      outcome.recommendationRef, outcome.screenRunRef, outcome.kind,
      JSON.stringify(outcome.metrics), outcome.createdAt
    );
    return outcome;
  }

  listOutcomes(
    userLogin: string,
    filter?: { scenarioId?: string; goalId?: string }
  ): OutcomeRecord[] {
    this.ensureTables();
    let rows: any[];
    if (filter?.scenarioId) {
      rows = Array.from(
        this.sql.exec(
          `SELECT * FROM mas_outcomes WHERE user_login = ? AND scenario_id = ? ORDER BY created_at DESC LIMIT 100`,
          userLogin, filter.scenarioId
        )
      ) as any[];
    } else if (filter?.goalId) {
      rows = Array.from(
        this.sql.exec(
          `SELECT * FROM mas_outcomes WHERE user_login = ? AND goal_id = ? ORDER BY created_at DESC LIMIT 100`,
          userLogin, filter.goalId
        )
      ) as any[];
    } else {
      rows = Array.from(
        this.sql.exec(`SELECT * FROM mas_outcomes WHERE user_login = ? ORDER BY created_at DESC LIMIT 100`, userLogin)
      ) as any[];
    }
    return rows.map(outcomeFromRow);
  }
}
