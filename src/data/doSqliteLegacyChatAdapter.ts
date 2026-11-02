/**
 * Issue #1776 (#1717 Adapter S2) — the DO-SQLite implementation
 * of the legacy chat-message lift: the cf_ai_chat_agent_messages
 * statements from OrchestratorAgent.liftLegacyChatMessages, moved
 * into the data layer statement-for-statement.
 *
 * This store owns the SQL ONLY. The lift's domain logic — row
 * validation, the addMessages import, and drop-only-on-a-fully-
 * clean lift (otherwise the table stays in place so its rows
 * remain recoverable) — stays in the orchestrator. The table is
 * pre-SDK and SDK-owned, so there is deliberately no DDL and no
 * ensureSchema here: the table is never created by this store,
 * only probed, read, and dropped on a clean lift.
 *
 * #CISO-bhdm
 */
import type { SqlStorage } from "./repositoryPorts";

/** One legacy row, exactly as the table holds it. */
export interface LegacyChatMessageRow {
  id: string;
  message: string;
  created_at: unknown;
}

export class SqlLegacyChatStore {
  constructor(private readonly sql: SqlStorage) {}

  /** The sqlite_master existence probe from the legacy lift. */
  tableExists(): boolean {
    return (
      Array.from(
        this.sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'"
        )
      ).length > 0
    );
  }

  /** Legacy rows oldest-first, the lift's exact projection + order. */
  listLegacyRows(): LegacyChatMessageRow[] {
    return Array.from(
      this.sql.exec(
        "SELECT id, message, created_at FROM cf_ai_chat_agent_messages ORDER BY created_at ASC, rowid ASC"
      )
    ) as LegacyChatMessageRow[];
  }

  /** Drop the legacy table (clean lift only — the caller decides). */
  dropTable(): void {
    this.sql.exec("DROP TABLE cf_ai_chat_agent_messages");
  }
}
