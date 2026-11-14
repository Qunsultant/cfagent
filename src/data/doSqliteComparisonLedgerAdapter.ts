/**
 * Issue #2356 (#1976 step 4c) — the DO-SQLite implementation
 * of the comparison-ledger port: the legacy ledger
 * statements from recommendationKernel.ts (ensure + record)
 * and comparisonRunner.ts (the read), moved into the data
 * layer statement-for-statement.
 */
import {
  compareComparisonOutcomeRows,
  type ComparisonLedgerSqlExecutor,
  type ComparisonLedgerStore,
  type ComparisonOutcomeInput,
  type ComparisonOutcomeRow,
} from "./comparisonLedgerPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqliteComparisonLedgerStore implements ComparisonLedgerStore {
  constructor(private readonly sql: ComparisonLedgerSqlExecutor) {}

  ensureTable(): void {
    this.sql.exec(
      doTableSql("mas_comparison_arm_outcomes"),
    );
  }

  recordOutcome(input: ComparisonOutcomeInput): void {
    this.sql.exec(
      "INSERT INTO mas_comparison_arm_outcomes (id, run_id, arm, candidate_id, structure, symbol, status, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.id,
      input.runId,
      input.arm,
      input.candidateId,
      input.structure,
      input.symbol,
      input.status,
      input.provenance,
      input.createdAt,
    );
  }

  listOutcomes(runId?: string): ComparisonOutcomeRow[] {
    const rows = (
      runId
        ? Array.from(this.sql.exec(`SELECT id, run_id, arm, candidate_id, structure, symbol, status, provenance, created_at FROM mas_comparison_arm_outcomes WHERE run_id = ?`, runId))
        : Array.from(this.sql.exec(`SELECT id, run_id, arm, candidate_id, structure, symbol, status, provenance, created_at FROM mas_comparison_arm_outcomes`))
    ) as ComparisonOutcomeRow[];
    return rows.sort(compareComparisonOutcomeRows);
  }
}
