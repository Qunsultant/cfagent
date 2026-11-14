/**
 * Issue #2842 — DO-SQLite implementation of the user-request-
 * quota port. The statements are this table family's ONE home;
 * the in-memory adapter mirrors them statement-for-statement
 * in behavior (same idempotency, same counts).
 *
 * Idempotency is the PRIMARY KEY: (tenant, user, window,
 * window key, run id). A repeated chargeWindow for the same
 * run id inserts nothing (INSERT OR IGNORE) and reports the
 * unchanged count — a retried submission never double-charges.
 */
import type {
  UserRequestQuotaChargeInput,
  UserRequestQuotaOverride,
  UserRequestQuotaOverrideInput,
  UserRequestQuotaPort,
  UserRequestQuotaProbe,
  UserRequestQuotaProbeInput,
  UserRequestQuotaSqlExecutor,
} from "./userRequestQuotaPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

type Row = Record<string, unknown>;

const CHARGES_DDL = doTableSql("user_request_quota_charges");

const OVERRIDES_DDL = doTableSql("user_request_quota_overrides");

function toOverride(row: Row): UserRequestQuotaOverride {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userLogin: String(row.user_login),
    windowKind: row.window_kind as UserRequestQuotaOverride["windowKind"],
    windowKey: String(row.window_key),
    extraRuns: Number(row.extra_runs),
    grantedBy: String(row.granted_by),
    reason: String(row.reason),
    createdMs: Number(row.created_ms),
    expiresMs: row.expires_ms === null || row.expires_ms === undefined ? null : Number(row.expires_ms),
  };
}

export class DoSqliteUserRequestQuota implements UserRequestQuotaPort {
  constructor(private readonly sql: UserRequestQuotaSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(CHARGES_DDL);
    this.sql.exec(OVERRIDES_DDL);
  }

  probe(input: UserRequestQuotaProbeInput): UserRequestQuotaProbe {
    this.ensureSchema();
    const countRows = Array.from(
      this.sql.exec(
        `SELECT COUNT(*) AS n FROM user_request_quota_charges
         WHERE tenant_id = ? AND user_login = ? AND window_kind = ? AND window_key = ?`,
        input.tenantId,
        input.userLogin,
        input.windowKind,
        input.windowKey,
      ),
    ) as Row[];
    let alreadyCounted = false;
    if (input.runId !== undefined) {
      const hit = Array.from(
        this.sql.exec(
          `SELECT 1 AS one FROM user_request_quota_charges
           WHERE tenant_id = ? AND user_login = ? AND window_kind = ? AND window_key = ? AND run_id = ?`,
          input.tenantId,
          input.userLogin,
          input.windowKind,
          input.windowKey,
          input.runId,
        ),
      ) as Row[];
      alreadyCounted = hit.length > 0;
    }
    const overrideRows = Array.from(
      this.sql.exec(
        `SELECT * FROM user_request_quota_overrides
         WHERE tenant_id = ? AND user_login = ? AND window_kind = ? AND window_key = ?
         ORDER BY created_ms DESC`,
        input.tenantId,
        input.userLogin,
        input.windowKind,
        input.windowKey,
      ),
    ) as Row[];
    return {
      usage: Number(countRows[0]?.n ?? 0),
      overrides: overrideRows.map(toOverride),
      alreadyCounted,
    };
  }

  chargeWindow(input: UserRequestQuotaChargeInput): { usage: number } {
    this.ensureSchema();
    this.sql.exec(
      `INSERT OR IGNORE INTO user_request_quota_charges
       (tenant_id, user_login, window_kind, window_key, kind, run_id, charged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.tenantId,
      input.userLogin,
      input.windowKind,
      input.windowKey,
      input.kind,
      input.runId,
      input.nowMs,
    );
    const countRows = Array.from(
      this.sql.exec(
        `SELECT COUNT(*) AS n FROM user_request_quota_charges
         WHERE tenant_id = ? AND user_login = ? AND window_kind = ? AND window_key = ?`,
        input.tenantId,
        input.userLogin,
        input.windowKind,
        input.windowKey,
      ),
    ) as Row[];
    return { usage: Number(countRows[0]?.n ?? 0) };
  }

  grantOverride(input: UserRequestQuotaOverrideInput): UserRequestQuotaOverride {
    this.ensureSchema();
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO user_request_quota_overrides
       (id, tenant_id, user_login, window_kind, window_key, extra_runs, granted_by, reason, created_ms, expires_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.tenantId,
      input.userLogin,
      input.windowKind,
      input.windowKey,
      input.extraRuns,
      input.grantedBy,
      input.reason,
      input.createdMs,
      input.expiresMs,
    );
    return { id, ...input };
  }

  listOverrides(input: { tenantId: string; userLogin: string }): UserRequestQuotaOverride[] {
    this.ensureSchema();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM user_request_quota_overrides
         WHERE tenant_id = ? AND user_login = ?
         ORDER BY created_ms DESC`,
        input.tenantId,
        input.userLogin,
      ),
    ) as Row[];
    return rows.map(toOverride);
  }
}
