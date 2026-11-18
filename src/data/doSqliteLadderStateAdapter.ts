/**
 * Issue #5034 — DO SQLite adapter for `mas_ladder_states` (#3887);
 * a rung is recorded only after the broker returned an id.
 */
import type { SqlStorage } from "../orm";
import type { LadderStateStore, StoredLadderRung, StoredLadderState } from "./ladderStatePorts";
import { remainderTableSql } from "./schemaComponent/remainderCatalogue";

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
    save(state: StoredLadderState) {
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
    load(ladderId: string): StoredLadderState | null {
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
