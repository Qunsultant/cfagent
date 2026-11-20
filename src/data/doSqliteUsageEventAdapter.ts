/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the usage-event port: the usage_events statements from
 * src/services/scheduledReports.ts (ensure, insert, per-
 * tenant list), moved into the data layer
 * statement-for-statement. usage_events is the accepted
 * metering store of record (#792 determination recorded in
 * the seam module); it stays in whichever instance's seam
 * records the event.
 */
import type {
  CanonicalReportStoreSqlExecutor,
  InsertUsageEventRow,
  UsageEventDetailRow,
  UsageEventPort,
  UsageEventRow,
} from "./canonicalReportStorePorts";
import { DuplicateUsageEventError } from "./canonicalReportStorePorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import { remainderAlterSql } from "./schemaComponent/remainderCatalogue";

const TABLE = "usage_events";

/**
 * Issue #3185 (bridge slice) — the usage_events retention window,
 * days. The ONE runtime value; the retention registries
 * (storageRetention.ts, privacyDsar.ts) record the same 365d
 * PRUNE-CLASS. A prune pass must run in every DO instance that
 * holds rows plus the D1 mirror — a partial prune would misstate
 * tenant totals.
 */
export const USAGE_EVENTS_RETENTION_MAX_AGE_DAYS = 365;

export class DoSqliteUsageEventStore implements UsageEventPort {
  constructor(private readonly sql: CanonicalReportStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("usage_events"));
    // Issue #3185 (stamp slice): the tenant stamp, added when
    // missing so existing DO tables upgrade in place (the #3182
    // probed additive-column precedent). Legacy rows stay NULL.
    const cols = Array.from(
      this.sql.exec(`PRAGMA table_info(${TABLE})`)
    ) as Array<{ name?: unknown }>;
    const names = new Set(cols.map((c) => String(c?.name ?? "")));
    if (!names.has("tenant_id")) {
      this.sql.exec(remainderAlterSql("usage_events", "tenant_id"));
    }
    this.sql.exec(
      doIndexSql("idx_usage_events_user")
    );
    this.sql.exec(
      doIndexSql("idx_usage_events_tenant")
    );
  }

  insertEvent(row: InsertUsageEventRow): void {
    try {
      this.sql.exec(
        `INSERT INTO ${TABLE} (id, user_login, run_id, category, created_at, detail_json, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.userLogin,
        row.runId,
        row.category,
        row.createdAt,
        row.detailJson,
        row.tenantId
      );
    } catch (err) {
      // #5606 (G-3): a PRIMARY KEY collision is a duplicate retry —
      // the route answers 201 duplicate. Any other store failure
      // propagates unchanged.
      if (err instanceof Error && /UNIQUE constraint|PRIMARY KEY/i.test(err.message)) {
        throw new DuplicateUsageEventError(row.id);
      }
      throw err;
    }
  }

  listByUser(userLogin: string, limit: number): UsageEventRow[] {
    const rows = Array.from(
      this.sql.exec(
        `SELECT id, user_login, run_id, category, created_at, tenant_id FROM ${TABLE} WHERE user_login = ? ORDER BY created_at DESC LIMIT ?`,
        userLogin,
        limit
      )
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      userLogin: String(r.user_login ?? ""),
      runId: String(r.run_id ?? ""),
      category: String(r.category ?? ""),
      createdAt: String(r.created_at ?? ""),
      tenantId: r.tenant_id == null ? null : String(r.tenant_id),
    }));
  }

  listByTenant(tenantId: string, limit: number): UsageEventRow[] {
    const rows = Array.from(
      this.sql.exec(
        `SELECT id, user_login, run_id, category, created_at, tenant_id FROM ${TABLE} WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
        tenantId,
        limit
      )
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      userLogin: String(r.user_login ?? ""),
      runId: String(r.run_id ?? ""),
      category: String(r.category ?? ""),
      createdAt: String(r.created_at ?? ""),
      tenantId: r.tenant_id == null ? null : String(r.tenant_id),
    }));
  }

  listAllWithDetail(): UsageEventDetailRow[] {
    // Issue #5235: ensure first — a fresh instance with zero
    // metered calls reads empty instead of throwing on a
    // missing table (the meter only ensures on first insert).
    this.ensureSchema();
    const rows = Array.from(
      this.sql.exec(
        `SELECT id, user_login, run_id, category, created_at, detail_json, tenant_id FROM ${TABLE} ORDER BY created_at ASC, id ASC`
      )
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      userLogin: String(r.user_login ?? ""),
      runId: String(r.run_id ?? ""),
      category: String(r.category ?? ""),
      createdAt: String(r.created_at ?? ""),
      detailJson: r.detail_json == null ? null : String(r.detail_json),
      tenantId: r.tenant_id == null ? null : String(r.tenant_id),
    }));
  }

  /**
   * Issue #3185 (bridge slice) — retention prune (365d,
   * PRUNE-CLASS): deletes this instance's rows older than the
   * cutoff. Returns the deleted count (count-then-delete on the
   * same connection — exact inside a single-threaded DO turn).
   * The caller prunes the D1 mirror in the same pass.
   */
  pruneBefore(cutoffIso: string): number {
    this.ensureSchema();
    const rows = Array.from(
      this.sql.exec(
        `SELECT COUNT(*) AS count FROM ${TABLE} WHERE created_at < ?`,
        cutoffIso
      )
    ) as Array<{ count?: unknown }>;
    const n = rows[0]?.count;
    const count = typeof n === "number" ? n : 0;
    if (count > 0) {
      this.sql.exec(`DELETE FROM ${TABLE} WHERE created_at < ?`, cutoffIso);
    }
    return count;
  }

  /** Issue #3185 (bridge slice) — DSAR erasure for one login. */
  deleteByUser(userLogin: string): number {
    this.ensureSchema();
    const count = this.countByUser(userLogin);
    if (count > 0) {
      this.sql.exec(`DELETE FROM ${TABLE} WHERE user_login = ?`, userLogin);
    }
    return count;
  }

  countByUser(userLogin: string): number {
    this.ensureSchema();
    const rows = Array.from(
      this.sql.exec(
        `SELECT COUNT(*) AS count FROM ${TABLE} WHERE user_login = ?`,
        userLogin
      )
    ) as Array<{ count?: unknown }>;
    const n = rows[0]?.count;
    return typeof n === "number" ? n : 0;
  }
}
