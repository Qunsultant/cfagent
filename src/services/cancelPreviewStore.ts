/**
 * Issue #3885 — single-use preview tokens for "cancel everything".
 *
 * Cancel-all is the most dangerous operation the platform can offer an
 * autonomous agent, so it is always two steps: the first call returns a
 * preview (what would be cancelled) plus one token; the second call presents
 * the token and acts. A token is:
 *   - single use — a replayed token refuses, it never cancels twice;
 *   - short lived — `CANCEL_ALL_PREVIEW_TTL_MS`, so a stale preview cannot be
 *     redeemed against an account that has moved on;
 *   - bound to the exact order ids the user was shown, so an order placed
 *     after the preview is never swept up by it.
 *
 * The store lives in the caller's own Durable Object storage (one row per
 * preview), which is what makes the token survive a cold start between the
 * two calls without becoming a global secret.
 */

import type { SqlStorage } from "../orm";
import { remainderTableSql } from "../data/schemaComponent/remainderCatalogue";

export const CANCEL_ALL_PREVIEW_TTL_MS = 120_000;

export interface CancelPreviewRecord {
  token: string;
  ids: string[];
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface CancelPreviewStore {
  save(record: Omit<CancelPreviewRecord, "usedAt">): void;
  find(token: string): CancelPreviewRecord | null;
  markUsed(token: string, usedAt: string): void;
}

/** The DO-storage adapter. DDL runs on first use (one table, one index). */
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

/** A test double, and the shape a host without storage falls back to. */
export function createInMemoryCancelPreviewStore(): CancelPreviewStore {
  const rows = new Map<string, CancelPreviewRecord>();
  return {
    save(record) {
      rows.set(record.token, { ...record, usedAt: null });
    },
    find(token) {
      return rows.get(token) ?? null;
    },
    markUsed(token, usedAt) {
      const found = rows.get(token);
      if (found) rows.set(token, { ...found, usedAt });
    },
  };
}
