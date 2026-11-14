/**
 * Issue #3887 — the continuation ladder's durable state.
 *
 * A base-breakout ladder lives across calls: rung 1 is placed when the base
 * confirms, and each later rung is placed by a later observation. The machine
 * in `src/trading/baseBreakout.ts` is pure; this store keeps the facts it
 * needs to resume — the spec, the plan, and which rungs were actually placed
 * (with their broker ids) — in the caller's own Durable Object storage.
 *
 * Honesty rules:
 *   - a missing ladder row is "unknown ladder", never "no rungs placed";
 *   - a rung is recorded only after the broker returned an id;
 *   - the row keeps the stop that ended the ladder, so a later call can
 *     explain why it refuses to place another rung.
 */

import type { SqlStorage } from "../orm";
import { remainderTableSql } from "../data/schemaComponent/remainderCatalogue";

export interface StoredLadderRung {
  rungIndex: number;
  limitPrice: number;
  quantity: number;
  orderId: string | null;
  clientOrderId: string;
}

export interface StoredLadderState {
  ladderId: string;
  symbol: string;
  entryMode: "baseBreakout";
  specJson: string;
  planJson: string;
  placed: StoredLadderRung[];
  committedNotional: number;
  stoppedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LadderStateStore {
  save(state: StoredLadderState): void;
  load(ladderId: string): StoredLadderState | null;
}

export function createSqlLadderStateStore(sql: SqlStorage): LadderStateStore {
  let ensured = false;
  const ensure = () => {
    if (ensured) return;
    try {
      sql.exec(remainderTableSql("mas_ladder_states"));
      ensured = true;
    } catch {
      // A store that cannot create its table fails loud on the next save.
    }
  };

  return {
    save(state) {
      ensure();
      sql.exec("DELETE FROM mas_ladder_states WHERE ladder_id = ?", state.ladderId);
      sql.exec(
        "INSERT INTO mas_ladder_states (ladder_id, symbol, entry_mode, spec_json, plan_json, placed_json, committed_notional, stopped_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        state.ladderId,
        state.symbol,
        state.entryMode,
        state.specJson,
        state.planJson,
        JSON.stringify(state.placed),
        state.committedNotional,
        state.stoppedBy,
        state.createdAt,
        state.updatedAt,
      );
    },
    load(ladderId) {
      ensure();
      const row = Array.from(
        sql.exec("SELECT * FROM mas_ladder_states WHERE ladder_id = ?", ladderId),
      )[0] as Record<string, any> | undefined;
      if (!row) return null;
      let placed: StoredLadderRung[] = [];
      try {
        const parsed = JSON.parse(String(row.placed_json ?? "[]"));
        placed = Array.isArray(parsed) ? (parsed as StoredLadderRung[]) : [];
      } catch {
        placed = [];
      }
      return {
        ladderId: String(row.ladder_id),
        symbol: String(row.symbol ?? ""),
        entryMode: "baseBreakout",
        specJson: String(row.spec_json ?? "{}"),
        planJson: String(row.plan_json ?? "{}"),
        placed,
        committedNotional: Number(row.committed_notional ?? 0),
        stoppedBy: row.stopped_by ? String(row.stopped_by) : null,
        createdAt: String(row.created_at ?? ""),
        updatedAt: String(row.updated_at ?? ""),
      };
    },
  };
}

/** A test/host fallback when no Durable Object storage is bound. */
export function createInMemoryLadderStateStore(): LadderStateStore {
  const rows = new Map<string, StoredLadderState>();
  return {
    save(state) {
      rows.set(state.ladderId, state);
    },
    load(ladderId) {
      return rows.get(ladderId) ?? null;
    },
  };
}
