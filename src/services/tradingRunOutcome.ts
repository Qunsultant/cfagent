/**
 * Issue #3812 — record every Alpaca order preview/placement in the
 * Workflow Runs ledger (`mas_job_outcomes`).
 *
 * Before this module a chat-driven order attempt left no run record: the
 * Workflow Runs tab could show the quote job, but the draft/refusal itself
 * was invisible, so an RCA ("why didn't the agent place the order?") had to
 * be reconstructed from prose. The ledger already renders an outcome with
 * no job twin as its own run (docs/agents/workflow-runs.md), so one row
 * with id `order:<orderId>` is enough — no new writer, no second copy.
 *
 * Recording is best-effort: a ledger write failure must never turn a valid
 * preview or placement into a failure. The caller keeps its own result; a
 * console warning names the lost trace.
 */

import { DoSqliteJobOutcomeStore } from "../data/doSqliteJobOutcomeAdapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import type { SqlStorage } from "../orm";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/tradingRunOutcome",
});

export type TradingRunStatus = "completed" | "failed";

export interface TradingRunOutcomeInput {
  orderId: string;
  status: TradingRunStatus;
  action: string;
  symbol?: string;
  quantity?: number;
  orderType?: string;
  orderClass?: string;
  broker?: string;
  mode?: "paper" | "live";
  /** The coded refusal/error, when the attempt failed. */
  codedError?: string;
  /** The tool that produced the record, e.g. "alpaca_preview_order". */
  origin: string;
  /** Absolute exit prices, when the draft carries them. */
  takeProfitPrice?: number;
  stopLossPrice?: number;
  /** Percent exits as requested, when present. */
  takeProfitPercent?: number;
  stopLossPercent?: number;
  /** The live-quote or user price source, as a short string. */
  priceSource?: string;
  /** Issue #3897: Slack and Email notification delivery status on order placement. */
  slackNotification?: string;
  emailNotification?: string;
}

/**
 * The mode the trace must name. An explicit ALPACA_TRADING_TYPE wins; the
 * copilot's externalized STOCK_COPILOT_MODE is the next signal; unset is
 * paper, matching the resolver's default. Never inferred from a URL.
 */
export function alpacaModeFromEnv(env: {
  ALPACA_TRADING_TYPE?: string;
  STOCK_COPILOT_MODE?: string;
} | null | undefined): "live" | "paper" {
  const explicit = String(env?.ALPACA_TRADING_TYPE ?? "").trim().toLowerCase();
  if (explicit === "live" || explicit === "prod") return "live";
  if (explicit === "paper" || explicit === "test") return "paper";
  const copilot = String(env?.STOCK_COPILOT_MODE ?? "").trim().toLowerCase();
  if (copilot === "live" || copilot === "prod") return "live";
  return "paper";
}

export function tradingRunOutcomeId(orderId: string): string {
  return `order:${orderId}`;
}

export function recordTradingRunOutcome(
  sql: SqlStorage | null | undefined,
  input: TradingRunOutcomeInput,
): void {
  if (!sql) return;
  try {
    // The production adapter, not the deprecated re-export shim: new code
    // takes the port, never the shim.
    const store = new DoSqliteJobOutcomeStore(sql);
    store.ensureTables();
    store.record({
      id: tradingRunOutcomeId(input.orderId),
      kind: "trading",
      trigger: "manual",
      status: input.status,
      // One order attempt is one unit: scanned=1, matched=1 only when the
      // broker accepted the draft/order. A refusal records matched=0.
      scanned: 1,
      matched: input.status === "completed" ? 1 : 0,
      ...(input.codedError ? { codedError: input.codedError } : {}),
      deliveryStates: {
        broker: input.broker ?? "alpaca",
        mode: input.mode ?? "paper",
        action: input.action,
        symbol: input.symbol ?? "",
        quantity: input.quantity !== undefined ? String(input.quantity) : "",
        orderType: input.orderType ?? "",
        orderClass: input.orderClass ?? "",
        ...(input.priceSource ? { priceSource: input.priceSource } : {}),
        ...(input.takeProfitPercent !== undefined
          ? { takeProfitPercent: String(input.takeProfitPercent) }
          : {}),
        ...(input.stopLossPercent !== undefined
          ? { stopLossPercent: String(input.stopLossPercent) }
          : {}),
        ...(input.takeProfitPrice !== undefined
          ? { takeProfitPrice: String(input.takeProfitPrice) }
          : {}),
        ...(input.stopLossPrice !== undefined
          ? { stopLossPrice: String(input.stopLossPrice) }
          : {}),
        ...(input.slackNotification ? { slackNotification: input.slackNotification } : {}),
        ...(input.emailNotification ? { emailNotification: input.emailNotification } : {}),
      },
      origin: input.origin,
    });
  } catch (error) {
    structuredLog.warn("tradingRunOutcome.record_failed", {
      orderId: input.orderId,
      origin: input.origin,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
