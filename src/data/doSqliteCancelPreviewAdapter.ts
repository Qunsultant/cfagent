/**
 * Issue #5034 — DO SQLite adapter for `mas_cancel_previews` (#3885).
 */
import type { SqlStorage } from "../orm";
import type { CancelPreviewRecord, CancelPreviewStore } from "./cancelPreviewPorts";
import { remainderTableSql } from "./schemaComponent/remainderCatalogue";

export function createSqlCancelPreviewStore(sql: SqlStorage): CancelPreviewStore {
  let ensured = false;
  const ensure = () => {
    if (ensured) return;
    try {
      sql.exec(remainderTableSql("mas_cancel_previews"));
      ensured = true;
    } catch {
      // A store that cannot create its table still fails loud on save/find.
    }
  };
  const parse = (row: Record<string, any> | undefined): CancelPreviewRecord | null => {
    if (!row) return null;
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(String(row.ids_json ?? "[]"));
      ids = Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
    } catch {
      ids = [];
    }
    return {
      token: String(row.token),
      ids,
      createdAt: String(row.created_at ?? ""),
      expiresAt: String(row.expires_at ?? ""),
      usedAt: row.used_at ? String(row.used_at) : null,
    };
  };

  return {
    save(record) {
      ensure();
      sql.exec("DELETE FROM mas_cancel_previews WHERE token = ?", record.token);
      sql.exec(
        "INSERT INTO mas_cancel_previews (token, ids_json, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)",
        record.token,
        JSON.stringify(record.ids),
        record.createdAt,
        record.expiresAt,
      );
    },
    find(token) {
      ensure();
      const row = Array.from(sql.exec("SELECT * FROM mas_cancel_previews WHERE token = ?", token))[0] as
        | Record<string, any>
        | undefined;
      return parse(row);
    },
    markUsed(token, usedAt) {
      ensure();
      sql.exec("UPDATE mas_cancel_previews SET used_at = ? WHERE token = ?", usedAt, token);
    },
  };
}
