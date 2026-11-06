/**
 * Stock Copilot position store (issue #3391) — the copilot's own
 * working state: every position the copilot opened, WITH the
 * exit plan it was opened under (stop/target). An entry without
 * a paired exit plan is a defect (#3391 acceptance), so the plan
 * is part of the record this module builds, and the record is
 * written in the same step as the entry decision, immediately
 * after the order is accepted. The cycle reads its open rows at
 * the start of every pass to evaluate exits; a row closes when
 * its exit order is accepted.
 *
 * The storage itself lives behind the data layer's position
 * port (src/data/stockCopilotStorePorts.ts; DO adapter +
 * in-memory adapter, composed by
 * src/data/createStockCopilotStorePorts.ts) — this module holds
 * no statements, only the record construction (id, timestamps,
 * defaults) and the store's async API over the port.
 *
 * Scope note: this is operational state for the loop's own
 * position management — not a decision history. Durable
 * persistence of cycle decisions for performance measurement
 * is MVP2 (issue #3397) and is deliberately not built here.
 */
import type {
  CopilotPositionRecord,
  StockCopilotPositionPort,
} from "../data/stockCopilotStorePorts";

export { COPILOT_POSITIONS_TABLE } from "../data/stockCopilotStorePorts";
export type { CopilotPositionRecord } from "../data/stockCopilotStorePorts";

export class StockCopilotPositionStore {
  constructor(private readonly positions: StockCopilotPositionPort) {}

  ensureTables(): void {
    this.positions.ensureSchema();
  }

  async openPosition(input: {
    userLogin: string;
    symbol: string;
    strategy: string;
    quantity: number;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    brokerOrderRef: string;
    /** #3398: the session + order type the entry was placed
     *  under, recorded with the position. */
    entrySession?: string | null;
    entryOrderType?: string | null;
    openedAt?: string;
  }): Promise<CopilotPositionRecord> {
    this.ensureTables();
    const record: CopilotPositionRecord = {
      id: crypto.randomUUID(),
      userLogin: input.userLogin,
      symbol: input.symbol.toUpperCase(),
      strategy: input.strategy,
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      targetPrice: input.targetPrice,
      brokerOrderRef: input.brokerOrderRef,
      entrySession: input.entrySession ?? null,
      entryOrderType: input.entryOrderType ?? null,
      status: "open",
      openedAt: input.openedAt ?? new Date().toISOString(),
      closedAt: null,
      exitBrokerOrderRef: null,
      exitPrice: null,
      exitReason: null,
    };
    this.positions.insertPosition(record);
    return record;
  }

  async listOpenPositions(userLogin: string): Promise<CopilotPositionRecord[]> {
    this.ensureTables();
    return this.positions.listOpenPositions(userLogin);
  }

  async closePosition(
    id: string,
    patch: {
      exitBrokerOrderRef: string;
      exitPrice: number;
      exitReason: string;
      closedAt?: string;
    },
  ): Promise<void> {
    this.ensureTables();
    this.positions.closePosition(id, {
      exitBrokerOrderRef: patch.exitBrokerOrderRef,
      exitPrice: patch.exitPrice,
      exitReason: patch.exitReason,
      closedAt: patch.closedAt ?? new Date().toISOString(),
    });
  }
}
