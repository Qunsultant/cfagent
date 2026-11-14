/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the policy-verdict port: the mas_policy_verdicts INSERT
 * from src/agents/orchestrator/autopilot.ts and the
 * control-center SELECT from src/agents/routes/autopilot.ts,
 * moved into the data layer statement-for-statement, plus
 * the table's DDL + index from OrchestratorAgent.ensureTables
 * (its ONE home now). The ledger is append-only: the port
 * carries no update or delete.
 */
import type {
  OrchestratorTableSqlExecutor,
  PolicyVerdictInsert,
  PolicyVerdictPort,
  PolicyVerdictRecentRow,
} from "./orchestratorTablePorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqlitePolicyVerdictStore implements PolicyVerdictPort {
  constructor(private readonly sql: OrchestratorTableSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("mas_policy_verdicts"));
    this.sql.exec(doIndexSql("idx_mas_policy_verdicts_created"));
  }

  insertVerdict(row: PolicyVerdictInsert): void {
    this.sql.exec(
      "INSERT INTO mas_policy_verdicts (id, session_id, symbol, action, quantity, notional, mode, dry_run, passed, execution_allowed, requires_approval, binding_rule, detail, limits_json, projections_json, findings_json, signature, signing_key_id, proposer_did, authorizer_did, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.sessionId,
      row.symbol,
      row.action,
      row.quantity,
      row.notional,
      row.mode,
      row.dryRun ? 1 : 0,
      row.passed ? 1 : 0,
      row.executionAllowed ? 1 : 0,
      row.requiresApproval ? 1 : 0,
      row.bindingRule,
      row.detail,
      row.limitsJson,
      row.projectionsJson,
      row.findingsJson,
      row.signature,
      row.signingKeyId,
      row.proposerDid,
      row.authorizerDid,
      row.createdAt
    );
  }

  listRecent(limit: number): PolicyVerdictRecentRow[] {
    return Array.from(
      this.sql.exec(
        "SELECT id, symbol, action, quantity, notional, mode, dry_run, passed, execution_allowed, requires_approval, binding_rule, detail, signature, proposer_did, authorizer_did, created_at FROM mas_policy_verdicts ORDER BY created_at DESC LIMIT ?",
        limit
      )
    ) as PolicyVerdictRecentRow[];
  }
}
