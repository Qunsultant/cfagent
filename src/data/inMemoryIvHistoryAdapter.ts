/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the IV-history port, with semantics identical to the
 * DO-SQLite and D1 adapters (first-write-wins per (symbol,
 * date)). Moved from src/trading/options/ivHistoryStore.ts
 * (now a shim).
 */
import {
  computeIvStats,
  normalizeIvBroker,
  type IvBroker,
  type IvHistoryCoverage,
  type IvHistoryRecord,
  type IvHistoryStore,
  type IvStats,
} from "./ivHistoryPorts";

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export class InMemoryIvHistoryStore implements IvHistoryStore {
  private records = new Map<string, IvHistoryRecord>();

  private key(symbol: string, date: string): string {
    return `${normalizeSymbol(symbol)}|${date}`;
  }

  async record(record: IvHistoryRecord): Promise<boolean> {
    // One observation per (symbol, date): the day's first write is the record,
    // whichever broker produced it (#3326).
    const key = this.key(record.symbol, record.date);
    if (this.records.has(key)) return false;
    this.records.set(key, {
      ...record,
      symbol: normalizeSymbol(record.symbol),
      broker: normalizeIvBroker(record.broker),
    });
    return true;
  }

  async get(symbol: string, date: string, broker?: IvBroker): Promise<IvHistoryRecord | null> {
    const record = this.records.get(this.key(symbol, date)) ?? null;
    if (!record) return null;
    if (broker && normalizeIvBroker(record.broker) !== normalizeIvBroker(broker)) return null;
    return record;
  }

  async listSeries(symbol: string, options: { limit?: number; broker?: IvBroker } = {}): Promise<IvHistoryRecord[]> {
    const sym = normalizeSymbol(symbol);
    const broker = options.broker ? normalizeIvBroker(options.broker) : undefined;
    const series = [...this.records.values()]
      .filter((r) => r.symbol === sym)
      .filter((r) => (broker ? normalizeIvBroker(r.broker) === broker : true))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return options.limit !== undefined ? series.slice(0, options.limit) : series;
  }

  async coverage(symbol: string, broker?: IvBroker): Promise<IvHistoryCoverage> {
    const series = await this.listSeries(symbol, broker ? { broker } : {});
    return {
      observations: series.length,
      firstDate: series.length ? series[series.length - 1].date : null,
      lastDate: series.length ? series[0].date : null,
    };
  }

  async listSymbols(options: { broker?: IvBroker } = {}): Promise<string[]> {
    const broker = options.broker ? normalizeIvBroker(options.broker) : undefined;
    return [
      ...new Set(
        [...this.records.values()]
          .filter((r) => (broker ? normalizeIvBroker(r.broker) === broker : true))
          .map((r) => r.symbol),
      ),
    ].sort();
  }
}
