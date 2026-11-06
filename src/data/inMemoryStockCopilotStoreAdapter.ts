/**
 * Issue #3391 (parent #3380) — the in-memory implementation of
 * the Stock Copilot position-store port (test double).
 * Semantics mirror the DO adapter: insert-or-throw on the id
 * primary key, open positions listed oldest first (insertion
 * order breaks opened_at ties, matching the DO's rowid order
 * for equal keys), and a close lands only on an existing row.
 */
import type {
  CloseCopilotPositionPatch,
  CopilotPositionRecord,
  StockCopilotPositionPort,
} from "./stockCopilotStorePorts";

interface StoredPosition {
  record: CopilotPositionRecord;
  seq: number;
}

export class InMemoryStockCopilotPositionStore
  implements StockCopilotPositionPort
{
  private readonly rows = new Map<string, StoredPosition>();
  private seq = 0;

  ensureSchema(): void {}

  insertPosition(record: CopilotPositionRecord): void {
    if (this.rows.has(record.id)) {
      throw new Error(
        `UNIQUE constraint failed: stock_copilot_positions.id`
      );
    }
    this.rows.set(record.id, { record: { ...record }, seq: this.seq++ });
  }

  listOpenPositions(userLogin: string): CopilotPositionRecord[] {
    return [...this.rows.values()]
      .filter(
        (s) => s.record.userLogin === userLogin && s.record.status === "open"
      )
      .sort((a, b) =>
        a.record.openedAt === b.record.openedAt
          ? a.seq - b.seq
          : a.record.openedAt < b.record.openedAt
            ? -1
            : 1
      )
      .map((s) => ({ ...s.record }));
  }

  closePosition(id: string, patch: CloseCopilotPositionPatch): void {
    const stored = this.rows.get(id);
    if (!stored) return;
    stored.record = {
      ...stored.record,
      status: "closed",
      exitBrokerOrderRef: patch.exitBrokerOrderRef,
      exitPrice: patch.exitPrice,
      exitReason: patch.exitReason,
      closedAt: patch.closedAt,
    };
  }

  listClosedPositions(
    userLogin: string,
    limit: number,
  ): CopilotPositionRecord[] {
    return [...this.rows.values()]
      .filter(
        (s) => s.record.userLogin === userLogin && s.record.status === "closed"
      )
      .sort((a, b) => {
        const ac = a.record.closedAt ?? "";
        const bc = b.record.closedAt ?? "";
        return ac === bc ? b.seq - a.seq : ac < bc ? 1 : -1;
      })
      .slice(0, Math.max(0, limit))
      .map((s) => ({ ...s.record }));
  }
}
