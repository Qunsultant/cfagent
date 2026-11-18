/**
 * Issue #812: structured quote pipeline observability.
 *
 * Every screener run gets a QuoteTrace that records:
 * - Symbols received from Nasdaq
 * - Batches sent to E*TRADE (index, symbols, HTTP status, timing)
 * - Per-symbol outcomes (received, failed with categorized reason)
 * - Summary counts
 *
 * Logs are JSON for Cloudflare dashboard querying. No silent swallowing —
 * every exception is captured with context.
 */

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "trading/etrade/quoteTrace",
});

export type QuoteFailureCategory =
  | "http_error"
  | "timeout"
  | "empty_response"
  | "parse_error"
  | "no_price_data"
  | "auth_error"
  | "rate_limited"
  | "unknown";

export interface BatchTrace {
  index: number;
  totalBatches: number;
  symbols: string[];
  httpStatus: number | null;
  quotesReceived: number;
  failures: Array<{ symbol: string; category: QuoteFailureCategory; detail: string }>;
  durationMs: number;
  error: string | null;
}

export interface QuoteTraceSummary {
  traceId: string;
  nasdaqSymbolCount: number;
  uniqueSymbolCount: number;
  batchesTotal: number;
  batchesSucceeded: number;
  batchesFailed: number;
  quotesReceived: number;
  quotesFailed: number;
  failuresByCategory: Record<QuoteFailureCategory, number>;
  totalDurationMs: number;
}

export class QuoteTrace {
  readonly traceId: string;
  private batches: BatchTrace[] = [];
  private startTime: number;
  private nasdaqSymbols: string[] = [];

  constructor(traceId?: string) {
    this.traceId = traceId || `qt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.startTime = Date.now();
  }

  /** Record symbols received from Nasdaq listings. */
  setNasdaqSymbols(symbols: string[]): void {
    this.nasdaqSymbols = [...symbols];
    this.log("nasdaq_symbols", {
      count: symbols.length,
      symbols: symbols.slice(0, 20),
      truncated: symbols.length > 20,
    });
  }

  /** Start tracking a batch. Returns a handle to complete it. */
  startBatch(index: number, totalBatches: number, symbols: string[]): BatchHandle {
    const batch: BatchTrace = {
      index,
      totalBatches,
      symbols: [...symbols],
      httpStatus: null,
      quotesReceived: 0,
      failures: [],
      durationMs: 0,
      error: null,
    };
    const batchStart = Date.now();
    return {
      setHttpStatus: (status: number) => { batch.httpStatus = status; },
      addQuotes: (count: number) => { batch.quotesReceived += count; },
      addFailure: (symbol: string, category: QuoteFailureCategory, detail: string) => {
        batch.failures.push({ symbol, category, detail });
      },
      setError: (error: string) => { batch.error = error; },
      complete: () => {
        batch.durationMs = Date.now() - batchStart;
        this.batches.push(batch);
        this.log("batch_complete", {
          batchIndex: index,
          totalBatches,
          symbolCount: symbols.length,
          httpStatus: batch.httpStatus,
          quotesReceived: batch.quotesReceived,
          failureCount: batch.failures.length,
          failures: batch.failures.slice(0, 10),
          durationMs: batch.durationMs,
          error: batch.error,
        });
      },
    };
  }

  /** Categorize an error into a QuoteFailureCategory. */
  static categorizeError(error: unknown): { category: QuoteFailureCategory; detail: string } {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("oauth")) {
      return { category: "auth_error", detail: msg.slice(0, 200) };
    }
    if (lower.includes("429") || lower.includes("rate limit")) {
      return { category: "rate_limited", detail: msg.slice(0, 200) };
    }
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
      return { category: "timeout", detail: msg.slice(0, 200) };
    }
    if (lower.includes("http 4") || lower.includes("http 5")) {
      return { category: "http_error", detail: msg.slice(0, 200) };
    }
    if (lower.includes("empty response") || lower.includes("no quote data")) {
      return { category: "empty_response", detail: msg.slice(0, 200) };
    }
    if (lower.includes("no positive") || lower.includes("no price")) {
      return { category: "no_price_data", detail: msg.slice(0, 200) };
    }
    if (lower.includes("parse") || lower.includes("json") || lower.includes("unexpected token")) {
      return { category: "parse_error", detail: msg.slice(0, 200) };
    }
    return { category: "unknown", detail: msg.slice(0, 200) };
  }

  /** Log the final summary. Call when the run completes. */
  complete(): QuoteTraceSummary {
    const failuresByCategory = {} as Record<QuoteFailureCategory, number>;
    const categories: QuoteFailureCategory[] = [
      "http_error", "timeout", "empty_response", "parse_error",
      "no_price_data", "auth_error", "rate_limited", "unknown",
    ];
    for (const c of categories) failuresByCategory[c] = 0;

    let quotesReceived = 0;
    let quotesFailed = 0;
    let batchesSucceeded = 0;
    let batchesFailed = 0;

    for (const b of this.batches) {
      quotesReceived += b.quotesReceived;
      quotesFailed += b.failures.length;
      for (const f of b.failures) failuresByCategory[f.category]++;
      if (b.error || b.httpStatus === null || (b.httpStatus >= 400)) {
        batchesFailed++;
      } else {
        batchesSucceeded++;
      }
    }

    const summary: QuoteTraceSummary = {
      traceId: this.traceId,
      nasdaqSymbolCount: this.nasdaqSymbols.length,
      uniqueSymbolCount: new Set(this.nasdaqSymbols).size,
      batchesTotal: this.batches.length,
      batchesSucceeded,
      batchesFailed,
      quotesReceived,
      quotesFailed,
      failuresByCategory,
      totalDurationMs: Date.now() - this.startTime,
    };

    this.log("quote_trace_summary", summary as unknown as Record<string, unknown>);
    return summary;
  }

  private log(event: string, data: Record<string, unknown>): void {
    structuredLog.info(`quoteTrace.${event}`, {
      message: event,
      ...data,
    }, { traceId: this.traceId });
  }
}

export interface BatchHandle {
  setHttpStatus: (status: number) => void;
  addQuotes: (count: number) => void;
  addFailure: (symbol: string, category: QuoteFailureCategory, detail: string) => void;
  setError: (error: string) => void;
  complete: () => void;
}
