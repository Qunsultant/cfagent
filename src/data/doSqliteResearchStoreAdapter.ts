/**
 * Issue #2361 (#1976 step 4e) — the DO-SQLite implementations
 * of the ResearchAgent-private store ports: the statements from
 * src/agents/research-agent.ts, moved into the data layer
 * statement-for-statement, plus each table's DDL (its ONE home
 * now — the agent's ensureTables delegates here). The agent
 * keeps every behaviour around the statements: JSON shaping,
 * the config service, the task ledger, the due-run selection,
 * and each caller's try/catch envelope.
 */
import type {
  ResearchEvaluationInsert,
  ResearchEvaluationPort,
  ResearchRunInsert,
  ResearchRunPort,
  ResearchRunRef,
  ResearchSettingsPort,
  ResearchStoreSqlExecutor,
  ResearchTaskStorePort,
} from "./researchStorePorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqliteResearchSettingsStore implements ResearchSettingsPort {
  constructor(private readonly sql: ResearchStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("research_settings"));
  }

  get(key: string): string | null {
    // Fail-soft by contract (see researchStorePorts.ts): the
    // legacy store read its marker before any ensure ran.
    try {
      const rows = Array.from(
        this.sql.exec("SELECT value FROM research_settings WHERE key = ?", key)
      ) as Array<{ value?: unknown }>;
      const v = rows[0]?.value;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    const now = new Date().toISOString();
    // DELETE+INSERT (not INSERT OR REPLACE) keeps MockSqlStorage compatible.
    this.sql.exec("DELETE FROM research_settings WHERE key = ?", key);
    this.sql.exec(
      "INSERT INTO research_settings (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      value,
      now
    );
  }
}

export class DoSqliteResearchTaskStore implements ResearchTaskStorePort {
  constructor(private readonly sql: ResearchStoreSqlExecutor) {}

  ensureSchema(): void {
    // Issue #577: durable task ledger store (key/value, same idiom as
    // research_settings — table is created in code, no wrangler migration).
    this.sql.exec(doTableSql("research_task_store"));
  }

  get(key: string): string | null {
    try {
      const rows = Array.from(
        this.sql.exec("SELECT value FROM research_task_store WHERE key = ?", key)
      ) as Array<{ value?: unknown }>;
      const v = rows[0]?.value;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    const now = new Date().toISOString();
    // DELETE+INSERT (not INSERT OR REPLACE) keeps MockSqlStorage compatible.
    this.sql.exec("DELETE FROM research_task_store WHERE key = ?", key);
    this.sql.exec(
      "INSERT INTO research_task_store (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      value,
      now
    );
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM research_task_store WHERE key = ?", key);
  }

  list(prefix: string): Array<{ key: string; value: string }> {
    try {
      const rows = Array.from(
        this.sql.exec(
          "SELECT key, value FROM research_task_store WHERE key LIKE ?",
          `${prefix}%`
        )
      ) as Array<{ key?: unknown; value?: unknown }>;
      return rows
        .filter((r) => typeof r.key === "string" && typeof r.value === "string")
        .map((r) => ({ key: r.key as string, value: r.value as string }));
    } catch {
      return [];
    }
  }
}

export class DoSqliteResearchRunStore implements ResearchRunPort {
  constructor(private readonly sql: ResearchStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("research_runs"));
  }

  replaceRun(record: ResearchRunInsert): void {
    this.sql.exec("DELETE FROM research_runs WHERE run_id = ?", record.runId);
    this.sql.exec(
      `INSERT INTO research_runs
           (run_id, trigger, user_login, created_at, rules_version, status, ideas_count, report_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.runId,
      record.trigger,
      record.userLogin,
      record.createdAt,
      record.rulesVersion,
      record.status,
      record.ideasCount,
      record.reportJson
    );
  }

  listReportJsonValues(): unknown[] {
    const rows = Array.from(
      this.sql.exec("SELECT report_json FROM research_runs ORDER BY created_at DESC")
    ) as Array<{ report_json?: unknown }>;
    return rows.map((r) => r.report_json);
  }

  getReportJsonValue(runId: string): unknown {
    const rows = Array.from(
      this.sql.exec("SELECT report_json FROM research_runs WHERE run_id = ?", runId)
    ) as Array<{ report_json?: unknown }>;
    return rows[0]?.report_json;
  }

  listRunRefs(): ResearchRunRef[] {
    const rows = Array.from(
      this.sql.exec("SELECT run_id, created_at FROM research_runs")
    ) as Array<{ run_id?: unknown; created_at?: unknown }>;
    return rows.map((r) => ({ runId: r.run_id, createdAt: r.created_at }));
  }
}

export class DoSqliteResearchEvaluationStore implements ResearchEvaluationPort {
  constructor(private readonly sql: ResearchStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("research_evaluations"));
  }

  insertEvaluation(record: ResearchEvaluationInsert): void {
    this.sql.exec(
      "INSERT INTO research_evaluations (id, run_id, evaluated_at, evaluation_json) VALUES (?, ?, ?, ?)",
      record.id,
      record.runId,
      record.evaluatedAt,
      record.evaluationJson
    );
  }

  listEvaluationJsonValues(): unknown[] {
    const rows = Array.from(
      this.sql.exec("SELECT evaluation_json FROM research_evaluations ORDER BY evaluated_at ASC")
    ) as Array<{ evaluation_json?: unknown }>;
    return rows.map((r) => r.evaluation_json);
  }

  listEvaluatedRunIds(): unknown[] {
    const rows = Array.from(
      this.sql.exec("SELECT run_id FROM research_evaluations")
    ) as Array<{ run_id?: unknown }>;
    return rows.map((r) => r.run_id);
  }
}
