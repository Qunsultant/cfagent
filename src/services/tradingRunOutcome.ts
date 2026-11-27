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
import { vocabularyDefaults } from "../config/vocabulary";

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import type { Env } from "../types";
import { createJobRunRecordAdapter } from "../data/createJobRunRecordPorts";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
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
  /**
   * Issue #3883: a cancel records its own outcome word (the shared run
   * status vocabulary is completed/failed/partial) and the broker's own
   * status, so a run says both what the platform asked and what happened.
   */
  cancelOutcome?: "cancelled" | "cancel_failed";
  brokerStatus?: string;
  /**
   * Issue #3884/#3885: a batch (ticker/all) cancel is one run with real
   * counts, not a single unit — the caller supplies how many it targeted and
   * how many the broker actually cancelled.
   */
  scanned?: number;
  matched?: number;
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

export async function recordTradingRunOutcome(
  sql: SqlStorage | null | undefined,
  input: TradingRunOutcomeInput,
  // Issue #6101 — when the caller passes `project` (its env), the
  // outcome facts fold directly onto the D1 run ledger; best-effort,
  // never fails the run.
  project?: { env: Partial<Env>; userLogin?: string | null },
): Promise<void> {
  // Issue #6101 — `sql` is kept for call compatibility only; the
  // outcome no longer touches the DO. The fold runs when the caller
  // passes `project` (its env).
  void sql;
  try {
    // Issue #6101 — the outcome folds directly onto D1 (no DO row,
    // no projection); best-effort, never fails the run.
    if (project?.env) {
      const ledgerStore = createJobRunRecordAdapter(project.env);
      if (!ledgerStore) {
        throw new Error("[run-ledger] D1 run-ledger binding unbound (AGENT_DB) (#6101).");
      }
      await ledgerStore.foldJobOutcome(
        {
          id: tradingRunOutcomeId(input.orderId),
          kind: "trading",
          trigger: "manual",
          status: input.status,
        // One order attempt is one unit: scanned=1, matched=1 only when the
        // broker accepted the draft/order. A refusal records matched=0. A
        // batch cancel supplies its own counts (#3884/#3885).
        scanned: input.scanned ?? 1,
        matched: input.matched ?? (input.status === "completed" ? 1 : 0),
        ...(input.codedError ? { codedError: input.codedError } : {}),
        deliveryStates: {
          broker: input.broker ?? vocabularyDefaults().broker,
          mode: input.mode ?? vocabularyDefaults().mode,
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
          ...(input.cancelOutcome ? { outcome: input.cancelOutcome } : {}),
          ...(input.brokerStatus ? { brokerStatus: input.brokerStatus } : {}),
        },
          origin: input.origin,
        },
        resolveIaaaTenant(project.env),
        Date.now(),
      );
    }
  } catch (error) {
    structuredLog.warn("tradingRunOutcome.record_failed", {
      orderId: input.orderId,
      origin: input.origin,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
