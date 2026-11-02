/**
 * Issue #2359 (#1976 step 4d) — the in-memory implementations
 * of the orchestrator-table ports (test doubles for the
 * conformance suite; the inMemoryOrmAdapters.ts grouping
 * precedent). Semantics mirror the DO adapters exactly:
 * insert-or-throw on primary-key conflict (ADR D-E.1),
 * owner scoping on every preset statement, the pending
 * sweep's strict cutoff comparison, newest-first orderings
 * (with insertion order breaking timestamp ties, matching
 * the DO's rowid order for equal keys).
 */
import type {
  AutopilotStatePort,
  InsertConfirmationInput,
  PolicyVerdictInsert,
  PolicyVerdictPort,
  PolicyVerdictRecentRow,
  ReportConfirmationForReportRow,
  ReportConfirmationPendingRow,
  ReportConfirmationPort,
  ReportConfirmationRow,
  ScreenerPresetPort,
  ScreenerPresetRow,
} from "./orchestratorTablePorts";

export class InMemoryAutopilotStateStore implements AutopilotStatePort {
  private readonly values = new Map<string, string>();
  ensureSchema(): void {}
  getValue(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  putValue(key: string, value: string): void {
    this.values.set(key, value);
  }
}

interface StoredVerdict extends PolicyVerdictInsert {
  seq: number;
}

export class InMemoryPolicyVerdictStore implements PolicyVerdictPort {
  private readonly rows: StoredVerdict[] = [];
  private seq = 0;
  ensureSchema(): void {}
  insertVerdict(row: PolicyVerdictInsert): void {
    if (this.rows.some((r) => r.id === row.id)) {
      throw new Error(`UNIQUE constraint failed: mas_policy_verdicts.id`);
    }
    this.rows.push({ ...row, seq: this.seq++ });
  }
  listRecent(limit: number): PolicyVerdictRecentRow[] {
    return [...this.rows]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.seq - a.seq))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        symbol: r.symbol,
        action: r.action,
        quantity: r.quantity,
        notional: r.notional,
        mode: r.mode,
        dry_run: r.dryRun ? 1 : 0,
        passed: r.passed ? 1 : 0,
        execution_allowed: r.executionAllowed ? 1 : 0,
        requires_approval: r.requiresApproval ? 1 : 0,
        binding_rule: r.bindingRule,
        detail: r.detail,
        signature: r.signature,
        proposer_did: r.proposerDid,
        authorizer_did: r.authorizerDid,
        created_at: r.createdAt,
      }));
  }
}

export class InMemoryReportConfirmationStore implements ReportConfirmationPort {
  private readonly rows = new Map<string, ReportConfirmationRow>();
  ensureSchema(): void {}
  sweepExpiredPending(cutoffIso: string): void {
    for (const [id, row] of this.rows) {
      if (row.status === "pending" && row.created_at < cutoffIso) this.rows.delete(id);
    }
  }
  insertConfirmation(input: InsertConfirmationInput): void {
    if (this.rows.has(input.id)) {
      throw new Error(`UNIQUE constraint failed: mas_report_confirmations.id`);
    }
    this.rows.set(input.id, {
      id: input.id,
      kind: input.kind,
      payload_json: input.payloadJson,
      status: input.status,
      created_at: input.createdAt,
      decided_at: null,
      decided_by: null,
      report_id: input.reportId,
      created_by: input.createdBy ?? null,
    });
  }
  getById(id: string): ReportConfirmationRow | null {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  decide(id: string, status: string, decidedAt: string, decidedBy: string | null): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = status;
    row.decided_at = decidedAt;
    row.decided_by = decidedBy;
  }
  listPending(): ReportConfirmationPendingRow[] {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map(({ id, kind, payload_json, created_at }) => ({ id, kind, payload_json, created_at }));
  }
  listByReportId(reportId: string): ReportConfirmationForReportRow[] {
    return [...this.rows.values()]
      .filter((r) => r.report_id === reportId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map(({ id, kind, status, created_at, decided_at, decided_by, payload_json }) => ({
        id,
        kind,
        status,
        created_at,
        decided_at,
        decided_by,
        payload_json,
      }));
  }
}

export class InMemoryScreenerPresetStore implements ScreenerPresetPort {
  private readonly rows = new Map<string, ScreenerPresetRow>();
  ensureSchema(): void {}
  listByUser(userLogin: string): ScreenerPresetRow[] {
    return [...this.rows.values()]
      .filter((r) => r.user_login === userLogin)
      .sort((a, b) =>
        a.updated_at < b.updated_at
          ? 1
          : a.updated_at > b.updated_at
            ? -1
            : a.created_at < b.created_at
              ? 1
              : -1
      )
      .map((r) => ({ ...r }));
  }
  insertPreset(row: ScreenerPresetRow): void {
    if (this.rows.has(row.id)) {
      throw new Error(`UNIQUE constraint failed: mas_screener_presets.id`);
    }
    this.rows.set(row.id, { ...row });
  }
  existsForUser(id: string, userLogin: string): boolean {
    const row = this.rows.get(id);
    return !!row && row.user_login === userLogin;
  }
  deleteForUser(id: string, userLogin: string): void {
    const row = this.rows.get(id);
    if (row && row.user_login === userLogin) this.rows.delete(id);
  }
  getResolutionRow(
    id: string,
    userLogin: string
  ): { asset_class: unknown; criteria_json: unknown } | null {
    const row = this.rows.get(id);
    if (!row || row.user_login !== userLogin) return null;
    return { asset_class: row.asset_class, criteria_json: row.criteria_json };
  }
}
