/**
 * Issue #2357 (#1976 step 4b) — the DO-SQLite implementation
 * of the champion/challenger port: the store section of the
 * legacy src/services/championChallenger.ts, moved into the
 * data layer statement-for-statement. The gate logic stays
 * in the service module and delegates its store functions
 * here; the promotion unit's legs call these methods inside
 * the transaction wrap exactly as they called the legacy
 * functions (#2346 atomicity is preserved by construction —
 * the sabotage pins re-prove it in this slice's conformance).
 */
import type {
  ActiveSetWrite,
  ActiveStrategySet,
  Challenger,
  ChallengerApprovalRecord,
  ChallengerApprovalWrite,
  ChallengerEvaluation,
  ChallengerSqlExecutor,
  ChallengerStatus,
  ChallengerStore,
  PromotionRecord,
  PromotionRecordWrite,
} from "./challengerPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

function rowToChallenger(r: any): Challenger {
  return {
    id: String(r.id),
    userLogin: String(r.user_login),
    kind: r.kind as Challenger["kind"],
    title: String(r.title),
    regime: (r.regime ?? null) as Challenger["regime"],
    spec: JSON.parse(String(r.spec_json)) as Challenger["spec"],
    criteria: JSON.parse(String(r.criteria_json)) as Challenger["criteria"],
    evalSetVersion: String(r.eval_set_version),
    sourceProposalId: (r.source_proposal_id ?? null) as string | null,
    createdBy: String(r.created_by),
    status: r.status as ChallengerStatus,
    evaluation: r.evaluation_json
      ? (JSON.parse(String(r.evaluation_json)) as ChallengerEvaluation)
      : null,
    createdAt: String(r.created_at),
  };
}

export class DoSqliteChallengerStore implements ChallengerStore {
  constructor(private readonly sql: ChallengerSqlExecutor) {}

  ensureTables(): void {
    const sql = this.sql;
    sql.exec(doTableSql("mas_challengers"));
    sql.exec(doTableSql("mas_challenger_approvals"));
    sql.exec(doTableSql("mas_challenger_promotions"));
    sql.exec(doTableSql("mas_strategy_bank_active"));
  }

  getChallenger(userLogin: string, id: string): Challenger | null {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM mas_challengers WHERE id = ? AND user_login = ?`,
        id,
        userLogin
      )
    ) as any[];
    return rows.length ? rowToChallenger(rows[0]) : null;
  }

  listChallengers(userLogin: string): Challenger[] {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM mas_challengers WHERE user_login = ? ORDER BY created_at DESC LIMIT 200`,
        userLogin
      )
    ) as any[];
    return rows.map(rowToChallenger);
  }

  insertChallenger(challenger: Challenger): void {
    this.sql.exec(
      `INSERT INTO mas_challengers (id, user_login, kind, title, regime, spec_json, criteria_json, eval_set_version, source_proposal_id, status, evaluation_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      challenger.id,
      challenger.userLogin,
      challenger.kind,
      challenger.title,
      challenger.regime,
      JSON.stringify(challenger.spec),
      JSON.stringify(challenger.criteria),
      challenger.evalSetVersion,
      challenger.sourceProposalId,
      challenger.status,
      null,
      challenger.createdBy,
      challenger.createdAt,
      challenger.createdAt
    );
  }

  setChallengerStatus(
    challenger: Challenger,
    status: ChallengerStatus,
    evaluation: ChallengerEvaluation | null | undefined,
    now: Date
  ): void {
    this.sql.exec(
      `UPDATE mas_challengers SET status = ?, evaluation_json = ?, updated_at = ? WHERE id = ? AND user_login = ?`,
      status,
      evaluation === undefined
        ? challenger.evaluation
          ? JSON.stringify(challenger.evaluation)
          : null
        : evaluation
          ? JSON.stringify(evaluation)
          : null,
      now.toISOString(),
      challenger.id,
      challenger.userLogin
    );
  }

  insertApproval(write: ChallengerApprovalWrite): void {
    this.sql.exec(
      `INSERT INTO mas_challenger_approvals (id, challenger_id, user_login, approver, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      write.id,
      write.challengerId,
      write.userLogin,
      write.approver,
      write.decision,
      write.createdAt
    );
  }

  getApprovedApprover(userLogin: string, challengerId: string): string | null {
    const rows = Array.from(
      this.sql.exec(
        `SELECT approver FROM mas_challenger_approvals WHERE challenger_id = ? AND user_login = ? AND decision = 'approved' ORDER BY created_at DESC`,
        challengerId,
        userLogin
      )
    ) as any[];
    return rows.length ? String(rows[0].approver) : null;
  }

  listApprovals(userLogin: string, challengerId: string): ChallengerApprovalRecord[] {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM mas_challenger_approvals WHERE challenger_id = ? AND user_login = ? ORDER BY created_at ASC`,
        challengerId,
        userLogin
      )
    ) as any[];
    return rows.map((r) => ({
      id: String(r.id),
      challengerId: String(r.challenger_id),
      approver: String(r.approver),
      decision: r.decision as "approved" | "rejected",
      createdAt: String(r.created_at),
    }));
  }

  insertPromotion(write: PromotionRecordWrite): void {
    this.sql.exec(
      `INSERT INTO mas_challenger_promotions (id, challenger_id, user_login, action, prior_json, applied_json, weights_version, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      write.id,
      write.challengerId,
      write.userLogin,
      write.action,
      JSON.stringify(write.prior ?? null),
      JSON.stringify(write.applied ?? null),
      write.weightsVersion,
      write.actor,
      write.reason,
      write.createdAt
    );
  }

  listPromotionRecords(userLogin: string, challengerId: string): PromotionRecord[] {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM mas_challenger_promotions WHERE challenger_id = ? AND user_login = ? ORDER BY created_at ASC`,
        challengerId,
        userLogin
      )
    ) as any[];
    return rows.map((r) => ({
      action: String(r.action),
      prior: JSON.parse(String(r.prior_json)),
      applied: JSON.parse(String(r.applied_json)),
      actor: String(r.actor),
      reason: (r.reason ?? null) as string | null,
    }));
  }

  getActiveStrategySet(userLogin: string): ActiveStrategySet | null {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM mas_strategy_bank_active WHERE user_login = ? ORDER BY version DESC LIMIT 1`,
        userLogin
      )
    ) as any[];
    if (!rows.length) return null;
    return {
      strategies: JSON.parse(String(rows[0].strategies_json)) as string[],
      version: Number(rows[0].version),
      challengerId: (rows[0].challenger_id ?? null) as string | null,
      createdAt: String(rows[0].created_at),
    };
  }

  insertActiveSet(write: ActiveSetWrite): void {
    this.sql.exec(
      `INSERT INTO mas_strategy_bank_active (id, user_login, version, strategies_json, challenger_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      write.id,
      write.userLogin,
      write.version,
      JSON.stringify(write.strategies),
      write.challengerId,
      write.createdAt
    );
  }
}
