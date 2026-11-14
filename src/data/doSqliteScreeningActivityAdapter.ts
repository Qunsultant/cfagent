/**
 * Issue #2356 (#1976 step 4c) — the DO-SQLite implementation
 * of the screening-activity port: the legacy src/services/
 * screeningActivity.ts storage statements, moved into the
 * data layer statement-for-statement (including the
 * promotion read-through SELECT; the challenger tables'
 * ensure stays with its owner, called by the service shim
 * exactly as the legacy feed called it). The service module
 * is now a re-export shim over this adapter and
 * screeningActivityPorts.
 */
import {
  SCREENING_ACTIVITY_TABLE,
  type PromotionFeedRow,
  type RecordScreeningActivityInput,
  type ScreeningActivityEntry,
  type ScreeningActivitySqlExecutor,
  type ScreeningActivityStore,
} from "./screeningActivityPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

function activityId(): string {
  return `sact_${
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  }`;
}

export class DoSqliteScreeningActivityStore implements ScreeningActivityStore {
  constructor(private readonly sql: ScreeningActivitySqlExecutor) {}

  ensureTable(): void {
    const sql = this.sql;
    sql.exec(doTableSql("mas_screening_activity"));
    sql.exec(
      doIndexSql("idx_screening_activity_user")
    );
  }

  record(input: RecordScreeningActivityInput): string | null {
    try {
      if (!input?.userLogin || !input?.kind || !input?.summary) return null;
      this.ensureTable();
      const id = activityId();
      this.sql.exec(
        `INSERT INTO ${SCREENING_ACTIVITY_TABLE} (id, user_login, kind, summary, detail_json, ref_id, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.userLogin,
        input.kind,
        input.summary,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        input.refId ?? null,
        input.actor ?? null,
        input.createdAt ?? new Date().toISOString()
      );
      return id;
    } catch (err) {
      console.error(
        `[screeningActivity] record failed for ${input?.userLogin ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
      return null;
    }
  }

  list(userLogin: string, limit = 100): ScreeningActivityEntry[] {
    try {
      if (!userLogin) return [];
      this.ensureTable();
      const capped = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
      const rows = Array.from(
        this.sql.exec(
          `SELECT id, user_login, kind, summary, detail_json, ref_id, actor, created_at FROM ${SCREENING_ACTIVITY_TABLE} WHERE user_login = ? ORDER BY created_at DESC LIMIT ?`,
          userLogin,
          capped
        )
      ) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        let detail: unknown = null;
        if (typeof r.detail_json === "string" && r.detail_json) {
          try {
            detail = JSON.parse(r.detail_json);
          } catch {
            detail = { raw: r.detail_json };
          }
        }
        return {
          id: String(r.id ?? ""),
          userLogin: String(r.user_login ?? ""),
          kind: String(r.kind ?? "") as ScreeningActivityEntry["kind"],
          summary: String(r.summary ?? ""),
          detail,
          refId: (r.ref_id as string | null) ?? null,
          actor: (r.actor as string | null) ?? null,
          createdAt: String(r.created_at ?? ""),
        };
      });
    } catch (err) {
      console.error(
        `[screeningActivity] list failed for ${userLogin}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
      return [];
    }
  }

  listPromotionRows(userLogin: string, limit = 100): PromotionFeedRow[] {
    const capped = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
    const rows = Array.from(
      this.sql.exec(
        `SELECT id, challenger_id, action, actor, reason, weights_version, created_at FROM mas_challenger_promotions WHERE user_login = ? ORDER BY created_at DESC LIMIT ?`,
        userLogin,
        capped
      )
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      challenger_id: r.challenger_id,
      action: r.action,
      actor: r.actor,
      reason: r.reason,
      weights_version: r.weights_version,
      created_at: String(r.created_at ?? ""),
    }));
  }
}
