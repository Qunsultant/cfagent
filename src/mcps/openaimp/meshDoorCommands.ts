/**
 * Issue #2341 (Agent Mesh S5, programme #2225 G1 batch A) — the
 * chat-turn commands over the mesh doors.
 *
 * Four thin commands, registered in McpToolFactory alongside (never
 * instead of) the existing catalog, each declaring exactly one
 * scope in MCP_TOOL_SCOPES (#1744):
 *   - `list_scheduled_goals`  (mcp:read)     — list/inspect the
 *     scheduled-goal catalogue through the ScheduledAgent door.
 *   - `trigger_scheduled_goal` (mcp:write)   — trigger one goal;
 *     the returned tick is the agent's real outcome.
 *   - `check_payment_budget`  (mcp:payments) — PaymentsAgent budget
 *     verdict for a proposed spend, against the orchestrator bucket.
 *   - `get_payments_overview` (mcp:payments) — today's spend +
 *     recent payments, read through PaymentsAgent.
 *
 * The commands are thin by design (doors-and-layers §11.1): resolve
 * identity -> gate -> dispatch. Identity comes ONLY from the tool
 * context's actingLogin carrier — populated server-side by the
 * chat-turn context owner and threaded through the async-job path —
 * never from tool arguments (a caller-supplied login argument would
 * be a forgery surface, and the schemas deliberately carry none).
 * Without an identified chat turn the door refuses (fail-closed);
 * external MCP callers reach these agents through the A2A doors
 * (#2223) instead. All behavior lives in the door module
 * (src/agents/orchestrator/meshDoors.ts); these classes validate
 * input shape, dispatch, and audit.
 *
 * Batch B (#2349) adds seven commands over the TradingAgent and
 * ReportAssetAgent doors, each also declaring exactly one scope:
 *   - `propose_stock_trade`   (mcp:trade) — create a stock trade
 *     proposal (preview only; the result is a pending-approval
 *     proposal, never a placed order).
 *   - `propose_options_trade` (mcp:trade) — create an options
 *     trade proposal (preview only).
 *   - `get_trading_accounts`  (mcp:read)  — the acting user's
 *     broker accounts through TradingAgent.
 *   - `get_trading_positions` (mcp:read)  — their positions.
 *   - `get_trading_quote`     (mcp:read)  — a symbol quote.
 *   - `list_report_assets`    (mcp:read)  — the acting user's
 *     report assets (metadata) through ReportAssetAgent.
 *   - `get_report_asset`      (mcp:read)  — one asset by key.
 * Batch B deliberately had no command reaching TradingAgent's
 * approval door: no execute/approve/decide command existed in this
 * family, by design — order execution stayed behind the existing
 * approval door until S9/G4.
 *
 * Batch D (#2375, S9/G4) adds three commands over the approval
 * door, each also declaring exactly one scope:
 *   - `start_trade_approval`    (mcp:trade) — submit an existing
 *     proposal (orderId) to the approval door: starts the durable
 *     TradingTradeWorkflow run that waits for the human decision.
 *     Places nothing.
 *   - `decide_trade_approval`   (mcp:trade) — deliver the human's
 *     approved/rejected decision to that run. The schema carries
 *     NO identity field: the authorizer DID is derived server-side
 *     from the acting identity by the door.
 *   - `get_trade_approval_status` (mcp:read) — the run's status
 *     from the TRADE_WORKFLOW binding's own status surface.
 * The synchronous settle (executeApprovedOrder) still has no
 * command: it is reached only by the workflow's settle step.
 *
 * Batch C (#2351) adds five commands over the BrowserAgent and
 * SlackAgent doors, each also declaring exactly one scope:
 *   - `browser_snap_transaction`      (mcp:write) — a transaction
 *     snap receipt delivered to the configured Slack destination
 *     through BrowserAgent.
 *   - `browser_capture_page`          (mcp:write) — a page
 *     snapshot delivered the same way.
 *   - `browser_scrape_tables`         (mcp:read)  — DOM tables
 *     scraped through BrowserAgent; a placeholder-labelled
 *     screenshot stays labelled in the result.
 *   - `slack_send_pre_trade_approval` (mcp:trade) — post the
 *     strict HITL pre-trade approval ticket through SlackAgent.
 *     The command only requests the human decision; it approves
 *     and executes nothing.
 *   - `slack_dispatch_transaction_snap` (mcp:write) — a
 *     transaction snap dispatched through SlackAgent.
 * No command in this batch accepts a webhookUrl: delivery targets
 * are env configuration only (the #2223 A2A delivery-target
 * discipline, adopted as the mesh-door policy in meshDoors.ts).
 * Slack ingress is not served here — S13/G10 owns it.
 *
 * Batch E (#2488, the NLQ-independent mesh) adds one command
 * over the mesh screen door (src/agents/orchestrator/
 * meshScreenDoor.ts), declaring mcp:write:
 *   - `run_stock_screen` (mcp:write) — run a universe stock
 *     screen as a ScreenerScreenWorkflow run through the door:
 *     the door's own NLQ-free execution service (workflow start
 *     → awaited mas_reports read-back; the paid branch when
 *     monetization is on). This is the chat screen path the
 *     prompt steers to; it replaces no NLQ surface — the NLQ
 *     stock-screen port keeps serving the async nlq.execute
 *     capability, A2A, and the chat error fallback, and
 *     `execute_nlq` itself is flagged off in the turn by
 *     CHAT_NLQ_MODE (#2488), not removed. Unlike the NLQ port,
 *     the door has NO direct-ScreenerAgent fallback: an
 *     unavailable workflow port is a coded refusal.
 *
 * Batch F (#2581) adds one command over the mesh
 * options-strategy door (src/agents/orchestrator/
 * meshOptionsStrategyDoor.ts), declaring mcp:write:
 *   - `run_options_strategy_screen` (mcp:write) — screen
 *     options strategies over a universe by structured
 *     constraints (catalog strategy type, max loss, min
 *     profit, reward/risk, DTE window) through the door: the
 *     door assembles the engine's structured filters and calls
 *     the existing evaluation seam the NLQ
 *     options_opportunities action dispatches to
 *     (runOptionsStrategyAction), returning its ranked result
 *     directly — the engine's carriage is a direct awaited
 *     call, so this door has no workflow/job carriage. This is
 *     the chat options-strategy path the prompt steers to; it
 *     replaces no NLQ surface (the NLQ options actions keep
 *     serving their own callers) and routes nothing through
 *     NLQ.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import type {
  BrowserAgentSnapResult,
  BrowserInspectResult,
} from "../../types";
import {
  listScheduledGoalsViaDoor,
  triggerScheduledGoalViaDoor,
  checkPaymentBudgetViaDoor,
  getPaymentsOverviewViaDoor,
  proposeStockTradeViaDoor,
  proposeOptionsTradeViaDoor,
  getTradingAccountsViaDoor,
  getTradingPositionsViaDoor,
  getTradingQuoteViaDoor,
  startTradeApprovalViaDoor,
  decideTradeApprovalViaDoor,
  getTradeApprovalStatusViaDoor,
  listReportAssetsViaDoor,
  getReportAssetViaDoor,
  sendTransactionSnapViaDoor,
  capturePageSnapshotViaDoor,
  scrapePageTablesViaDoor,
  sendPreTradeApprovalTicketViaDoor,
  dispatchTransactionSnapViaDoor,
  type ScheduledGoalsDoorResult,
  type ScheduledGoalTriggerDoorResult,
  type PaymentBudgetDoorResult,
  type PaymentsOverviewDoorResult,
  type TradeProposalDoorResult,
  type StockTradeProposalInput,
  type OptionsTradeProposalInput,
  type TradeApprovalStartDoorResult,
  type TradeApprovalDecisionDoorResult,
  type TradeApprovalStatusDoorResult,
  type ReportAssetsDoorResult,
  type ReportAssetDoorResult,
  type TransactionSnapDoorInput,
  type PreTradeApprovalDraftDoorInput,
  type PreTradeApprovalTicketDoorResult,
} from "../../agents/orchestrator/meshDoors";
import { recordTraceHopBestEffort } from "../../data/createMeshTracePorts";
import { childContextOfTraceparent } from "../../observability/meshTrace";
import {
  meshScreenDoorContextFromMcp,
  runStockScreenViaDoor,
  type MeshScreenDoorInput,
  type MeshScreenRunResult,
} from "../../agents/orchestrator/meshScreenDoor";
import {
  meshOptionsStrategyDoorContextFromMcp,
  runOptionsStrategyScreenViaDoor,
  type MeshOptionsStrategyDoorInput,
  type MeshOptionsStrategyScreenResult,
} from "../../agents/orchestrator/meshOptionsStrategyDoor";
import { UNIVERSES, type UniverseId } from "../../trading";

/**
 * Issue #2428 (Agent Mesh S17): record this door call's hop on
 * the turn's mesh trace. Every command in this family calls it
 * once, right after resolving the acting identity and before
 * dispatch — the hop records the ATTEMPT under the door's own
 * discipline (a refused call still leaves its hop, with the
 * refusal in the command's audit; the trace observes, it does
 * not gate). No traceparent carrier (external MCP callers,
 * untraced turns) → no hop: the registry's recorded break,
 * never a fabricated trace.
 */
async function recordDoorHop(
  context: McpToolContext,
  commandName: string,
  targetClass: string,
): Promise<void> {
  const child = childContextOfTraceparent(context.traceparent?.());
  if (!child) return;
  await recordTraceHopBestEffort(context.env, {
    traceId: child.traceId,
    spanId: child.spanId,
    parentSpanId: child.parentSpanId,
    kind: "door",
    operation: commandName,
    timestampMs: Date.now(),
    caller: context.actingLogin?.() ?? undefined,
    agent: targetClass,
  });
}

/* ------------------------------------------------------------------ */
/* list_scheduled_goals                                                */
/* ------------------------------------------------------------------ */

export class ListScheduledGoalsCommand implements IMcpToolCommand<{
  goalId?: string;
}> {
  readonly name = "list_scheduled_goals";
  readonly description =
    "List the scheduled-goal catalogue through the ScheduledAgent door, or inspect one goal when goalId is given. Read-only. Requires the chat turn's acting identity; the catalogue is the shared operator catalogue the schedule routes expose to any signed-in user.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goalId: {
        type: "string",
        description: "Optional: return only the goal with this id (an unknown id is an error, not an empty list).",
      },
    },
  };
  readonly zodSchema = z.object({
    goalId: z.string().min(1).optional().describe("Optional goal id to inspect"),
  });

  async execute(
    input: { goalId?: string },
    context: McpToolContext,
  ): Promise<ScheduledGoalsDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "ScheduledAgent");
    const result = await listScheduledGoalsViaDoor(context.env, actingLogin, input.goalId);
    context.audit("list_scheduled_goals", "mcp", {
      actingLogin: actingLogin ?? null,
      goalId: input.goalId ?? null,
      count: result.goals.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* trigger_scheduled_goal                                              */
/* ------------------------------------------------------------------ */

export class TriggerScheduledGoalCommand implements IMcpToolCommand<{
  goalId: string;
}> {
  readonly name = "trigger_scheduled_goal";
  readonly description =
    "Trigger one scheduled goal now through the ScheduledAgent door. Returns the agent's real tick outcome (jobs created/skipped, errors) — a budget-denied firing is reported in the tick, never as success. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goalId: {
        type: "string",
        description: "The id of the scheduled goal to trigger.",
      },
    },
    required: ["goalId"],
  };
  readonly zodSchema = z.object({
    goalId: z.string().min(1).describe("The scheduled goal id"),
  });

  async execute(
    input: { goalId: string },
    context: McpToolContext,
  ): Promise<ScheduledGoalTriggerDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "ScheduledAgent");
    const result = await triggerScheduledGoalViaDoor(context.env, actingLogin, input.goalId);
    context.audit("trigger_scheduled_goal", "mcp", {
      actingLogin: actingLogin ?? null,
      goalId: input.goalId,
      jobsCreated: result.tick.jobsCreated,
      jobsSkipped: result.tick.jobsSkipped,
      errors: result.tick.errors.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* check_payment_budget                                                */
/* ------------------------------------------------------------------ */

export class CheckPaymentBudgetCommand implements IMcpToolCommand<{
  operation: string;
  amountCents: number;
}> {
  readonly name = "check_payment_budget";
  readonly description =
    "Ask PaymentsAgent whether a proposed spend is within budget: evaluates the BudgetGuard against the orchestrator spend bucket (the bucket chat-executed spend is attributed to in the ledger). A check records nothing. The verdict, including a denial's reason, is the guard's own. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      operation: {
        type: "string",
        description: "The budget-guarded operation name (must be on the guard allowlist, e.g. search.query, nlq.execute).",
      },
      amountCents: {
        type: "number",
        description: "The proposed spend, in cents (positive integer).",
      },
    },
    required: ["operation", "amountCents"],
  };
  readonly zodSchema = z.object({
    operation: z.string().min(1).describe("The budget-guarded operation name"),
    amountCents: z.number().int().positive().describe("The proposed spend, in cents"),
  });

  async execute(
    input: { operation: string; amountCents: number },
    context: McpToolContext,
  ): Promise<PaymentBudgetDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "PaymentsAgent");
    const result = await checkPaymentBudgetViaDoor(context.env, actingLogin, input);
    context.audit("check_payment_budget", "mcp", {
      actingLogin: actingLogin ?? null,
      operation: input.operation,
      amountCents: input.amountCents,
      agentId: result.agentId,
      allowed: result.allowed,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_payments_overview                                               */
/* ------------------------------------------------------------------ */

export class GetPaymentsOverviewCommand implements IMcpToolCommand<{
  limit?: number;
}> {
  readonly name = "get_payments_overview";
  readonly description =
    "Read the payments overview through PaymentsAgent: total spent today (cents) and the most recent payments from the ledger of record. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: "How many recent payments to include (default 10).",
      },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().int().positive().max(50).optional().describe("Recent payments to include (default 10)"),
  });

  async execute(
    input: { limit?: number },
    context: McpToolContext,
  ): Promise<PaymentsOverviewDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "PaymentsAgent");
    const result = await getPaymentsOverviewViaDoor(context.env, actingLogin, input.limit);
    context.audit("get_payments_overview", "mcp", {
      actingLogin: actingLogin ?? null,
      todaySpentCents: result.todaySpentCents,
      count: result.recentPayments.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* propose_stock_trade (#2349)                                         */
/* ------------------------------------------------------------------ */

const tradeActionSchema = z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]);
const tradeOrderTypeSchema = z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]);

export class ProposeStockTradeCommand implements IMcpToolCommand<StockTradeProposalInput> {
  readonly name = "propose_stock_trade";
  readonly description =
    "Create a stock trade PROPOSAL through the TradingAgent door: the broker preview for the acting user's own account, returned as a pending-approval proposal. Preview only — this command never places an order; placement happens only through TradingAgent's approval door with an explicit authorizer decision. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The stock symbol, e.g. AAPL." },
      action: { type: "string", description: "BUY, SELL, BUY_TO_COVER, or SELL_SHORT." },
      quantity: { type: "number", description: "Share quantity (positive)." },
      orderType: { type: "string", description: "MARKET, LIMIT, STOP, or STOP_LIMIT (optional)." },
      limitPrice: { type: "number", description: "Limit price for LIMIT/STOP_LIMIT orders (optional)." },
      stopPrice: { type: "number", description: "Stop price for STOP/STOP_LIMIT orders (optional)." },
      provider: { type: "string", description: "Broker provider id (optional; the agent's default otherwise)." },
    },
    required: ["symbol", "action", "quantity"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("The stock symbol"),
    action: tradeActionSchema.describe("BUY, SELL, BUY_TO_COVER, or SELL_SHORT"),
    quantity: z.number().positive().describe("Share quantity"),
    orderType: tradeOrderTypeSchema.optional().describe("Order type (optional)"),
    limitPrice: z.number().positive().optional().describe("Limit price (optional)"),
    stopPrice: z.number().positive().optional().describe("Stop price (optional)"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: StockTradeProposalInput,
    context: McpToolContext,
  ): Promise<TradeProposalDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await proposeStockTradeViaDoor(context.env, actingLogin, input);
    context.audit("propose_stock_trade", "mcp", {
      actingLogin: actingLogin ?? null,
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      status: result.status,
      orderId: result.proposal?.orderId ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* propose_options_trade (#2349)                                       */
/* ------------------------------------------------------------------ */

const optionLegSchema = z.object({
  underlyingSymbol: z.string().min(1).describe("The leg's underlying symbol"),
  securityType: z.literal("OPTN").describe("Leg security type (OPTN)"),
  side: z.enum(["BUY", "SELL"]).describe("Leg side"),
  quantity: z.number().positive().describe("Leg quantity"),
  optionType: z.enum(["CALL", "PUT"]).optional().describe("CALL or PUT (optional)"),
  strike: z.number().positive().optional().describe("Strike price (optional)"),
  expirationDate: z.string().optional().describe("Expiration date (optional)"),
});

export class ProposeOptionsTradeCommand implements IMcpToolCommand<OptionsTradeProposalInput> {
  readonly name = "propose_options_trade";
  readonly description =
    "Create an options trade PROPOSAL through the TradingAgent door: single-leg or multi-leg (spreads) via optionLegs, priced from the strategy net debit when given. Returns the broker preview as a pending-approval proposal. Preview only — this command never places an order; placement happens only through TradingAgent's approval door with an explicit authorizer decision. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The underlying symbol, e.g. AAPL." },
      action: { type: "string", description: "BUY, SELL, BUY_TO_COVER, or SELL_SHORT." },
      quantity: { type: "number", description: "Contract quantity (positive)." },
      optionLegs: {
        type: "array",
        description: "The option legs (at least one): underlyingSymbol, securityType OPTN, side, quantity, and optionally optionType, strike, expirationDate.",
      },
      orderType: { type: "string", description: "MARKET, LIMIT, STOP, or STOP_LIMIT (optional)." },
      limitPrice: { type: "number", description: "Limit price (optional)." },
      stopPrice: { type: "number", description: "Stop price (optional)." },
      strategyNetDebit: { type: "number", description: "Strategy net debit for spreads (optional)." },
      provider: { type: "string", description: "Broker provider id (optional)." },
    },
    required: ["symbol", "action", "quantity", "optionLegs"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("The underlying symbol"),
    action: tradeActionSchema.describe("BUY, SELL, BUY_TO_COVER, or SELL_SHORT"),
    quantity: z.number().positive().describe("Contract quantity"),
    optionLegs: z.array(optionLegSchema).min(1).describe("The option legs (at least one)"),
    orderType: tradeOrderTypeSchema.optional().describe("Order type (optional)"),
    limitPrice: z.number().positive().optional().describe("Limit price (optional)"),
    stopPrice: z.number().positive().optional().describe("Stop price (optional)"),
    strategyNetDebit: z.number().optional().describe("Strategy net debit (optional)"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: OptionsTradeProposalInput,
    context: McpToolContext,
  ): Promise<TradeProposalDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await proposeOptionsTradeViaDoor(context.env, actingLogin, input);
    context.audit("propose_options_trade", "mcp", {
      actingLogin: actingLogin ?? null,
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      legs: input.optionLegs.length,
      status: result.status,
      orderId: result.proposal?.orderId ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_trading_accounts (#2349)                                        */
/* ------------------------------------------------------------------ */

export class GetTradingAccountsCommand implements IMcpToolCommand<{ provider?: string }> {
  readonly name = "get_trading_accounts";
  readonly description =
    "Read the acting user's broker accounts through their own TradingAgent instance. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      provider: { type: "string", description: "Broker provider id (optional; the agent's default otherwise)." },
    },
  };
  readonly zodSchema = z.object({
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(input: { provider?: string }, context: McpToolContext): Promise<unknown> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await getTradingAccountsViaDoor(context.env, actingLogin, input.provider);
    context.audit("get_trading_accounts", "mcp", {
      actingLogin: actingLogin ?? null,
      provider: input.provider ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_trading_positions (#2349)                                       */
/* ------------------------------------------------------------------ */

export class GetTradingPositionsCommand implements IMcpToolCommand<{
  accountKey?: string;
  provider?: string;
}> {
  readonly name = "get_trading_positions";
  readonly description =
    "Read the acting user's broker positions through their own TradingAgent instance, optionally for one account. Read-only — this is the broker's live view. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      accountKey: { type: "string", description: "Account key to read positions for (optional)." },
      provider: { type: "string", description: "Broker provider id (optional)." },
    },
  };
  readonly zodSchema = z.object({
    accountKey: z.string().min(1).optional().describe("Account key (optional)"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: { accountKey?: string; provider?: string },
    context: McpToolContext,
  ): Promise<unknown> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await getTradingPositionsViaDoor(context.env, actingLogin, input);
    context.audit("get_trading_positions", "mcp", {
      actingLogin: actingLogin ?? null,
      accountKey: input.accountKey ?? null,
      provider: input.provider ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_trading_quote (#2349)                                           */
/* ------------------------------------------------------------------ */

export class GetTradingQuoteCommand implements IMcpToolCommand<{
  symbol: string;
  provider?: string;
}> {
  readonly name = "get_trading_quote";
  readonly description =
    "Read a quote for one symbol through the acting user's own TradingAgent instance. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The symbol to quote, e.g. AAPL." },
      provider: { type: "string", description: "Broker provider id (optional)." },
    },
    required: ["symbol"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("The symbol to quote"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: { symbol: string; provider?: string },
    context: McpToolContext,
  ): Promise<unknown> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await getTradingQuoteViaDoor(context.env, actingLogin, input);
    context.audit("get_trading_quote", "mcp", {
      actingLogin: actingLogin ?? null,
      symbol: input.symbol,
      provider: input.provider ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* start_trade_approval (#2375)                                        */
/* ------------------------------------------------------------------ */

export class StartTradeApprovalCommand implements IMcpToolCommand<{
  orderId: string;
  provider?: string;
}> {
  readonly name = "start_trade_approval";
  readonly description =
    "Submit an existing trade proposal (the orderId returned by propose_stock_trade / propose_options_trade) to TradingAgent's approval door: starts the durable TradingTradeWorkflow run that waits for the human's decision (up to 24h) and, on an approved decision, settles the trade exactly once through TradingAgent. Returns the workflowId and awaiting_approval status. Places nothing by itself. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: { type: "string", description: "The proposal's order id from propose_stock_trade / propose_options_trade." },
      provider: { type: "string", description: "Broker provider id the proposal was previewed under (optional; the agent's default otherwise)." },
    },
    required: ["orderId"],
  };
  readonly zodSchema = z.object({
    orderId: z.string().min(1).describe("The proposal's order id"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: { orderId: string; provider?: string },
    context: McpToolContext,
  ): Promise<TradeApprovalStartDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await startTradeApprovalViaDoor(context.env, actingLogin, input);
    context.audit("start_trade_approval", "mcp", {
      actingLogin: actingLogin ?? null,
      orderId: input.orderId,
      workflowId: result.workflowId,
      status: result.status,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* decide_trade_approval (#2375)                                       */
/* ------------------------------------------------------------------ */

export class DecideTradeApprovalCommand implements IMcpToolCommand<{
  workflowId: string;
  decision: "approved" | "rejected";
  reason?: string;
}> {
  readonly name = "decide_trade_approval";
  readonly description =
    "Deliver the human's approval decision for a trade approval run started by start_trade_approval. The authorizer identity is derived from the chat turn's acting identity server-side — it cannot be supplied as an argument. An approved decision settles the trade exactly once through TradingAgent; a rejected decision settles the proposal as rejected and places nothing. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      workflowId: { type: "string", description: "The approval run's workflowId from start_trade_approval." },
      decision: { type: "string", description: "approved or rejected." },
      reason: { type: "string", description: "Decision reason (optional)." },
    },
    required: ["workflowId", "decision"],
  };
  readonly zodSchema = z.object({
    workflowId: z.string().min(1).describe("The approval run's workflowId"),
    decision: z.enum(["approved", "rejected"]).describe("approved or rejected"),
    reason: z.string().min(1).optional().describe("Decision reason (optional)"),
  });

  async execute(
    input: { workflowId: string; decision: "approved" | "rejected"; reason?: string },
    context: McpToolContext,
  ): Promise<TradeApprovalDecisionDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await decideTradeApprovalViaDoor(context.env, actingLogin, input);
    context.audit("decide_trade_approval", "mcp", {
      actingLogin: actingLogin ?? null,
      workflowId: input.workflowId,
      decision: input.decision,
      delivered: result.delivered,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_trade_approval_status (#2375)                                   */
/* ------------------------------------------------------------------ */

export class GetTradeApprovalStatusCommand implements IMcpToolCommand<{
  workflowId: string;
}> {
  readonly name = "get_trade_approval_status";
  readonly description =
    "Read the status of a trade approval run (from start_trade_approval) from the TradingTradeWorkflow binding's own status surface: the run's status, and its outcome (settled/expired) once complete. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      workflowId: { type: "string", description: "The approval run's workflowId from start_trade_approval." },
    },
    required: ["workflowId"],
  };
  readonly zodSchema = z.object({
    workflowId: z.string().min(1).describe("The approval run's workflowId"),
  });

  async execute(
    input: { workflowId: string },
    context: McpToolContext,
  ): Promise<TradeApprovalStatusDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "TradingAgent");
    const result = await getTradeApprovalStatusViaDoor(context.env, actingLogin, input);
    context.audit("get_trade_approval_status", "mcp", {
      actingLogin: actingLogin ?? null,
      workflowId: input.workflowId,
      status: result.status,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* list_report_assets (#2349)                                          */
/* ------------------------------------------------------------------ */

export class ListReportAssetsCommand implements IMcpToolCommand<{ limit?: number }> {
  readonly name = "list_report_assets";
  readonly description =
    "List the acting user's report assets through their own ReportAssetAgent instance: storage key, file name, and stored-at for each generated report PDF, newest first. Metadata only — no asset bytes. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "How many assets to list (default 20, max 200)." },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().int().positive().max(200).optional().describe("Assets to list (default 20)"),
  });

  async execute(
    input: { limit?: number },
    context: McpToolContext,
  ): Promise<ReportAssetsDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "ReportAssetAgent");
    const result = await listReportAssetsViaDoor(context.env, actingLogin, input.limit);
    context.audit("list_report_assets", "mcp", {
      actingLogin: actingLogin ?? null,
      count: result.assets.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_report_asset (#2349)                                            */
/* ------------------------------------------------------------------ */

export class GetReportAssetCommand implements IMcpToolCommand<{ key: string }> {
  readonly name = "get_report_asset";
  readonly description =
    "Fetch one of the acting user's report assets by its storage key through their own ReportAssetAgent instance. Returns the file name, byte length, and the asset bytes base64-encoded (the shape the report-asset A2A door uses). An unknown key is an error, not an empty result. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      key: { type: "string", description: "The asset's storage key (from list_report_assets)." },
    },
    required: ["key"],
  };
  readonly zodSchema = z.object({
    key: z.string().min(1).describe("The asset's storage key"),
  });

  async execute(
    input: { key: string },
    context: McpToolContext,
  ): Promise<ReportAssetDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "ReportAssetAgent");
    const result = await getReportAssetViaDoor(context.env, actingLogin, input.key);
    context.audit("get_report_asset", "mcp", {
      actingLogin: actingLogin ?? null,
      key: input.key,
      fileName: result.fileName,
      byteLength: result.byteLength,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* Batch C shared input shapes (#2351)                                 */
/* ------------------------------------------------------------------ */

const transactionSnapLegSchema = z.object({
  action: z.string().min(1).describe("Leg action"),
  symbol: z.string().min(1).describe("Leg symbol"),
  strike: z.number().optional().describe("Leg strike (optional)"),
  expiry: z.string().optional().describe("Leg expiry (optional)"),
  type: z.string().optional().describe("Leg type (optional)"),
});

const transactionSnapSchema = z.object({
  transactionId: z.string().min(1).describe("The transaction id"),
  symbol: z.string().min(1).describe("The transaction symbol"),
  action: z.string().min(1).describe("The transaction action, e.g. BUY"),
  quantity: z.number().describe("The transaction quantity"),
  status: z.string().min(1).describe("The transaction status, e.g. executed"),
  price: z.number().optional().describe("Execution price (optional)"),
  orderType: z.string().optional().describe("Order type (optional)"),
  totalValue: z.number().optional().describe("Total value (optional)"),
  environment: z.string().optional().describe("Environment label (optional)"),
  accountKey: z.string().optional().describe("Account key (optional)"),
  commission: z.number().optional().describe("Commission (optional)"),
  timestamp: z.string().optional().describe("Transaction timestamp (optional)"),
  humanApproved: z
    .boolean()
    .optional()
    .describe("Set ONLY when a flow recorded an actual human approval for this transaction (optional)"),
  notes: z.string().optional().describe("Notes (optional)"),
  legs: z.array(transactionSnapLegSchema).optional().describe("Option legs (optional)"),
});

const transactionSnapJsonProperties = {
  transactionId: { type: "string", description: "The transaction id." },
  symbol: { type: "string", description: "The transaction symbol." },
  action: { type: "string", description: "The transaction action, e.g. BUY." },
  quantity: { type: "number", description: "The transaction quantity." },
  status: { type: "string", description: "The transaction status, e.g. executed." },
  price: { type: "number", description: "Execution price (optional)." },
  orderType: { type: "string", description: "Order type (optional)." },
  totalValue: { type: "number", description: "Total value (optional)." },
  environment: { type: "string", description: "Environment label (optional)." },
  accountKey: { type: "string", description: "Account key (optional)." },
  commission: { type: "number", description: "Commission (optional)." },
  timestamp: { type: "string", description: "Transaction timestamp (optional)." },
  humanApproved: {
    type: "boolean",
    description: "Set ONLY when a flow recorded an actual human approval for this transaction (optional).",
  },
  notes: { type: "string", description: "Notes (optional)." },
  legs: { type: "array", description: "Option legs: action, symbol, and optionally strike, expiry, type (optional)." },
};

/* ------------------------------------------------------------------ */
/* browser_snap_transaction (#2351)                                    */
/* ------------------------------------------------------------------ */

export interface BrowserSnapTransactionInput {
  transaction: TransactionSnapDoorInput;
  channel?: string;
  caption?: string;
}

export class BrowserSnapTransactionCommand implements IMcpToolCommand<BrowserSnapTransactionInput> {
  readonly name = "browser_snap_transaction";
  readonly description =
    "Generate a transaction snap receipt through BrowserAgent and deliver it to the configured Slack destination. Delivery goes only where environment configuration sends it — this command accepts no webhook URL. The agent's result is returned verbatim: a not-delivered outcome is reported as such, never as a success. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      transaction: {
        type: "object",
        description: "The transaction to snap: transactionId, symbol, action, quantity, status, and optional price/orderType/totalValue/environment/accountKey/commission/timestamp/humanApproved/notes/legs.",
        properties: transactionSnapJsonProperties,
        required: ["transactionId", "symbol", "action", "quantity", "status"],
      },
      channel: { type: "string", description: "Slack channel override within the configured destination (optional)." },
      caption: { type: "string", description: "Caption for the snap (optional)." },
    },
    required: ["transaction"],
  };
  readonly zodSchema = z.object({
    transaction: transactionSnapSchema.describe("The transaction to snap"),
    channel: z.string().min(1).optional().describe("Slack channel override (optional)"),
    caption: z.string().optional().describe("Caption (optional)"),
  });

  async execute(
    input: BrowserSnapTransactionInput,
    context: McpToolContext,
  ): Promise<BrowserAgentSnapResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "BrowserAgent");
    const result = await sendTransactionSnapViaDoor(context.env, actingLogin, input);
    context.audit("browser_snap_transaction", "mcp", {
      actingLogin: actingLogin ?? null,
      transactionId: input.transaction.transactionId,
      symbol: input.transaction.symbol,
      success: result.success,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* browser_capture_page (#2351)                                        */
/* ------------------------------------------------------------------ */

export interface BrowserCapturePageInput {
  url: string;
  caption?: string;
  channel?: string;
}

export class BrowserCapturePageCommand implements IMcpToolCommand<BrowserCapturePageInput> {
  readonly name = "browser_capture_page";
  readonly description =
    "Capture a rendered page snapshot through BrowserAgent and deliver it to the configured Slack destination. Delivery goes only where environment configuration sends it — this command accepts no webhook URL. The agent's result is returned verbatim, including a not-delivered outcome. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The page URL to capture." },
      caption: { type: "string", description: "Caption for the snapshot (optional)." },
      channel: { type: "string", description: "Slack channel override within the configured destination (optional)." },
    },
    required: ["url"],
  };
  readonly zodSchema = z.object({
    url: z.string().min(1).describe("The page URL to capture"),
    caption: z.string().optional().describe("Caption (optional)"),
    channel: z.string().min(1).optional().describe("Slack channel override (optional)"),
  });

  async execute(
    input: BrowserCapturePageInput,
    context: McpToolContext,
  ): Promise<BrowserAgentSnapResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "BrowserAgent");
    const result = await capturePageSnapshotViaDoor(context.env, actingLogin, input);
    context.audit("browser_capture_page", "mcp", {
      actingLogin: actingLogin ?? null,
      url: input.url,
      success: result.success,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* browser_scrape_tables (#2351)                                       */
/* ------------------------------------------------------------------ */

export class BrowserScrapeTablesCommand implements IMcpToolCommand<{ url: string }> {
  readonly name = "browser_scrape_tables";
  readonly description =
    "Scrape structured DOM tables from a rendered page through BrowserAgent. Read-only. The inspect result is returned verbatim, including its provenance labelling: when no real browser capture was available, the screenshot is labelled a placeholder and must not be presented as a capture of the page. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The page URL to scrape." },
    },
    required: ["url"],
  };
  readonly zodSchema = z.object({
    url: z.string().min(1).describe("The page URL to scrape"),
  });

  async execute(
    input: { url: string },
    context: McpToolContext,
  ): Promise<BrowserInspectResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "BrowserAgent");
    const result = await scrapePageTablesViaDoor(context.env, actingLogin, input.url);
    context.audit("browser_scrape_tables", "mcp", {
      actingLogin: actingLogin ?? null,
      url: input.url,
      success: result.success,
      screenshotKind: result.screenshotKind ?? null,
      tables: result.tables?.length ?? 0,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* slack_send_pre_trade_approval (#2351)                               */
/* ------------------------------------------------------------------ */

const approvalDraftSchema = z.object({
  orderId: z.string().min(1).describe("The draft order id"),
  symbol: z.string().min(1).describe("The draft symbol"),
  action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).describe("The draft action"),
  quantity: z.number().positive().describe("The draft quantity"),
  orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional().describe("Order type (optional)"),
  limitPrice: z.number().positive().optional().describe("Limit price (optional)"),
  estimatedPrice: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Estimated price (optional)"),
  estimatedTotal: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Estimated total (optional)"),
  commission: z.union([z.number(), z.string()]).optional().describe("Commission (optional)"),
  proposerDid: z.string().optional().describe("Proposer DID (optional)"),
  expiresAt: z.string().optional().describe("Expiry (optional)"),
  notes: z.string().optional().describe("Notes (optional)"),
});

export interface SlackSendPreTradeApprovalInput {
  draft: PreTradeApprovalDraftDoorInput;
  channel?: string;
  threadTs?: string;
}

export class SlackSendPreTradeApprovalCommand implements IMcpToolCommand<SlackSendPreTradeApprovalInput> {
  readonly name = "slack_send_pre_trade_approval";
  readonly description =
    "Post a pre-trade approval ticket — the strict human-in-the-loop gate card — for an existing order draft to the configured Slack destination through SlackAgent. This command only REQUESTS the human decision: it approves nothing and executes nothing, and no trade can proceed without the human authorization the ticket asks for. Delivery goes only where environment configuration sends it — this command accepts no webhook URL. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      draft: {
        type: "object",
        description: "The order draft the ticket asks a human to authorize: orderId, symbol, action, quantity, and optional orderType/limitPrice/estimatedPrice/estimatedTotal/commission/proposerDid/expiresAt/notes.",
        properties: {
          orderId: { type: "string", description: "The draft order id." },
          symbol: { type: "string", description: "The draft symbol." },
          action: { type: "string", description: "BUY, SELL, BUY_TO_COVER, or SELL_SHORT." },
          quantity: { type: "number", description: "The draft quantity (positive)." },
          orderType: { type: "string", description: "MARKET, LIMIT, STOP, or STOP_LIMIT (optional)." },
          limitPrice: { type: "number", description: "Limit price (optional)." },
          estimatedPrice: { type: "number", description: "Estimated price (optional)." },
          estimatedTotal: { type: "number", description: "Estimated total (optional)." },
          commission: { type: "number", description: "Commission (optional)." },
          proposerDid: { type: "string", description: "Proposer DID (optional)." },
          expiresAt: { type: "string", description: "Expiry (optional)." },
          notes: { type: "string", description: "Notes (optional)." },
        },
        required: ["orderId", "symbol", "action", "quantity"],
      },
      channel: { type: "string", description: "Slack channel override within the configured destination (optional)." },
      threadTs: { type: "string", description: "Thread timestamp to reply under (optional)." },
    },
    required: ["draft"],
  };
  readonly zodSchema = z.object({
    draft: approvalDraftSchema.describe("The order draft"),
    channel: z.string().min(1).optional().describe("Slack channel override (optional)"),
    threadTs: z.string().min(1).optional().describe("Thread timestamp (optional)"),
  });

  async execute(
    input: SlackSendPreTradeApprovalInput,
    context: McpToolContext,
  ): Promise<PreTradeApprovalTicketDoorResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "SlackAgent");
    const result = await sendPreTradeApprovalTicketViaDoor(context.env, actingLogin, input);
    context.audit("slack_send_pre_trade_approval", "mcp", {
      actingLogin: actingLogin ?? null,
      orderId: result.orderId,
      symbol: input.draft.symbol,
      success: result.success,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* slack_dispatch_transaction_snap (#2351)                             */
/* ------------------------------------------------------------------ */

export interface SlackDispatchTransactionSnapInput {
  transaction: TransactionSnapDoorInput;
  channel?: string;
  caption?: string;
}

export class SlackDispatchTransactionSnapCommand implements IMcpToolCommand<SlackDispatchTransactionSnapInput> {
  readonly name = "slack_dispatch_transaction_snap";
  readonly description =
    "Dispatch a transaction snap to the configured Slack destination through SlackAgent (which coordinates BrowserAgent for the receipt image). Delivery goes only where environment configuration sends it — this command accepts no webhook URL. The agent's result is returned verbatim, including a not-delivered outcome. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      transaction: {
        type: "object",
        description: "The transaction to snap: transactionId, symbol, action, quantity, status, and optional price/orderType/totalValue/environment/accountKey/commission/timestamp/humanApproved/notes/legs.",
        properties: transactionSnapJsonProperties,
        required: ["transactionId", "symbol", "action", "quantity", "status"],
      },
      channel: { type: "string", description: "Slack channel override within the configured destination (optional)." },
      caption: { type: "string", description: "Caption for the snap (optional)." },
    },
    required: ["transaction"],
  };
  readonly zodSchema = z.object({
    transaction: transactionSnapSchema.describe("The transaction to snap"),
    channel: z.string().min(1).optional().describe("Slack channel override (optional)"),
    caption: z.string().optional().describe("Caption (optional)"),
  });

  async execute(
    input: SlackDispatchTransactionSnapInput,
    context: McpToolContext,
  ): Promise<BrowserAgentSnapResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "SlackAgent");
    const result = await dispatchTransactionSnapViaDoor(context.env, actingLogin, input);
    context.audit("slack_dispatch_transaction_snap", "mcp", {
      actingLogin: actingLogin ?? null,
      transactionId: input.transaction.transactionId,
      symbol: input.transaction.symbol,
      success: result.success,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* run_stock_screen (#2488)                                            */
/* ------------------------------------------------------------------ */

const SCREEN_UNIVERSE_IDS = Object.keys(UNIVERSES) as UniverseId[];

export class RunStockScreenCommand implements IMcpToolCommand<MeshScreenDoorInput> {
  readonly name = "run_stock_screen";
  readonly description =
    "Run a stock screen over a named universe (NASDAQ100, SP500, SP100, RUSSELL2000, TECH, ETF, LEV_ETF, or ALL universes) through the mesh screen door: a durable ScreenerScreenWorkflow run whose standout picks are read back from the canonical report store. This is the universe-screen path — for raw listings rows by price/cap/gainers filters use etrade_market_scan instead. When monetization is on, the door runs the paid path (budget check, then a PaymentWorkflow run — one charge per run-request). Requires the chat turn's acting identity; the result is the completed run's stored result.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      universe: {
        type: "string",
        enum: SCREEN_UNIVERSE_IDS,
        description: "The universe to screen (default NASDAQ100; ALL shards every shardable universe).",
      },
      filters: {
        type: "object",
        description: "Optional structured screener filters (sector, minPrice, maxPrice, exchange, minMarketCap, minRsi, maxRsi).",
        properties: {
          sector: { type: "string", description: "Sector filter." },
          minPrice: { type: "number", description: "Minimum last price." },
          maxPrice: { type: "number", description: "Maximum last price." },
          exchange: { type: "string", enum: ["ALL", "NASDAQ", "NYSE", "AMEX"], description: "Exchange filter." },
          minMarketCap: { type: "number", description: "Minimum market cap." },
          minRsi: { type: "number", description: "Minimum 14-period RSI." },
          maxRsi: { type: "number", description: "Maximum 14-period RSI." },
        },
      },
    },
  };
  readonly zodSchema = z.object({
    universe: z
      .enum(SCREEN_UNIVERSE_IDS as [UniverseId, ...UniverseId[]])
      .optional()
      .describe("The universe to screen (default NASDAQ100)"),
    filters: z
      .object({
        sector: z.string().min(1).optional().describe("Sector filter"),
        minPrice: z.number().nonnegative().optional().describe("Minimum last price"),
        maxPrice: z.number().positive().optional().describe("Maximum last price"),
        exchange: z.enum(["ALL", "NASDAQ", "NYSE", "AMEX"]).optional().describe("Exchange filter"),
        minMarketCap: z.number().nonnegative().optional().describe("Minimum market cap"),
        minRsi: z.number().min(0).max(100).optional().describe("Minimum 14-period RSI"),
        maxRsi: z.number().min(0).max(100).optional().describe("Maximum 14-period RSI"),
      })
      .optional()
      .describe("Optional structured screener filters"),
  });

  async execute(
    input: MeshScreenDoorInput,
    context: McpToolContext,
  ): Promise<MeshScreenRunResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "ScreenerAgent");
    const result = await runStockScreenViaDoor(
      meshScreenDoorContextFromMcp(context),
      actingLogin,
      input,
    );
    context.audit("run_stock_screen", "mcp", {
      actingLogin: actingLogin ?? null,
      universe: result.universe,
      success: result.success,
      matchedCount: result.matchedCount,
      totalScanned: result.totalScanned,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* run_options_strategy_screen (#2581)                                 */
/* ------------------------------------------------------------------ */

export class RunOptionsStrategyScreenCommand implements IMcpToolCommand<MeshOptionsStrategyDoorInput> {
  readonly name = "run_options_strategy_screen";
  readonly description =
    "Screen options strategies over a named universe (NASDAQ100, SP500, SP100, RUSSELL2000, TECH, ETF, LEV_ETF) by structured constraints through the mesh options-strategy door: the strategy type is validated against the engine's strategy catalog (an id, label, or alias — e.g. \"put_credit_spread\" or \"Bull Put Credit Spread\"), the universe resolves to its symbol batch, and the existing options evaluation engine ranks candidate spreads under the stated caps (maxLoss, minProfit, minRewardRisk, DTE window). Returns the engine's ranked candidates with the constraint echo; an empty result is an honest no-qualifying-spreads payload, not an error. Research only — places no orders. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      universe: {
        type: "string",
        enum: SCREEN_UNIVERSE_IDS.filter((u) => u !== "ALL"),
        description: "The universe to screen (default NASDAQ100).",
      },
      strategyType: {
        type: "string",
        description: "Strategy to screen for: a strategy-catalog id, label, or alias (e.g. \"put_credit_spread\", \"Bull Put Credit Spread\", \"iron_condor\"). Omit to screen every strategy.",
      },
      maxLoss: {
        type: "number",
        description: "Max loss cap per spread in dollars (the engine's maxPlannedLoss; default 500).",
      },
      minProfit: {
        type: "number",
        description: "Minimum max-profit floor per spread in dollars (the engine's minMaxProfit screen filter). Pass a positive value to require max profit above zero.",
      },
      minRewardRisk: {
        type: "number",
        description: "Reward/risk scoring floor (the engine's minRewardRisk; default 1.5).",
      },
      thesis: {
        type: "string",
        enum: ["bullish", "bearish", "range_bound", "large_move"],
        description: "Scan thesis (default: the strategy's catalog thesis).",
      },
      riskProfile: {
        type: "string",
        enum: ["conservative", "balanced", "aggressive"],
        description: "Ranking posture (default balanced).",
      },
      minDte: { type: "number", description: "Minimum days to expiration (default 14)." },
      maxDte: { type: "number", description: "Maximum days to expiration (default 60)." },
      minProbabilityOfProfit: {
        type: "number",
        description: "Probability-of-profit floor, 0–1 (the engine's minProbabilityOfProfit screen filter).",
      },
      requireFresh: {
        type: "boolean",
        description: "Require fresh quotes only (the engine's requireFresh screen filter).",
      },
    },
  };
  readonly zodSchema = z.object({
    universe: z
      .enum(SCREEN_UNIVERSE_IDS.filter((u) => u !== "ALL") as [UniverseId, ...UniverseId[]])
      .optional()
      .describe("The universe to screen (default NASDAQ100)"),
    strategyType: z.string().min(1).optional().describe("Strategy catalog id, label, or alias"),
    maxLoss: z.number().positive().optional().describe("Max loss cap per spread in dollars"),
    minProfit: z.number().nonnegative().optional().describe("Minimum max-profit floor per spread in dollars"),
    minRewardRisk: z.number().nonnegative().optional().describe("Reward/risk scoring floor"),
    thesis: z
      .enum(["bullish", "bearish", "range_bound", "large_move"])
      .optional()
      .describe("Scan thesis (default: the strategy's catalog thesis)"),
    riskProfile: z
      .enum(["conservative", "balanced", "aggressive"])
      .optional()
      .describe("Ranking posture (default balanced)"),
    minDte: z.number().int().positive().optional().describe("Minimum days to expiration"),
    maxDte: z.number().int().positive().optional().describe("Maximum days to expiration"),
    minProbabilityOfProfit: z.number().min(0).max(1).optional().describe("Probability-of-profit floor, 0–1"),
    requireFresh: z.boolean().optional().describe("Require fresh quotes only"),
  });

  async execute(
    input: MeshOptionsStrategyDoorInput,
    context: McpToolContext,
  ): Promise<MeshOptionsStrategyScreenResult> {
    const actingLogin = context.actingLogin?.();
    await recordDoorHop(context, this.name, "ScreenerAgent");
    const result = await runOptionsStrategyScreenViaDoor(
      meshOptionsStrategyDoorContextFromMcp(context),
      actingLogin,
      input,
    );
    context.audit("run_options_strategy_screen", "mcp", {
      actingLogin: actingLogin ?? null,
      universe: result.universe,
      status: result.status,
      count: result.count,
      strategyTypes: result.constraints.strategyTypes,
    });
    return result;
  }
}
