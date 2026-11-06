/**
 * Cloudflare Agentic Payments MCP Tools (x402 & MPP paidTool patterns)
 * Implements paid MCP tools matching Cloudflare Agents SDK specification:
 * https://developers.cloudflare.com/agents/tools/payments/x402/charge-for-mcp-tools/
 */

import { z } from "zod";
import { optionScreenerFilterFields, parseOptionScreenerFilter } from "../../trading";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { ETradeAgenticPaymentService, TRADING_PAID_SERVICES } from "../../services/agenticPayments";
import { UnifiedOptionsService } from "../../trading";
import { MarketDataResearchService } from "../../services/marketDataResearch";
import {
  AGENTIC_WALLET_MODE_SWITCH,
  paymentsConfigErrorEvent,
  PREMIUM_RESEARCH_MODE_SWITCH,
  PREMIUM_SCREENER_MODE_SWITCH,
  resolvePaymentsSwitchByKey,
  type PaymentsModeValues,
  type PaymentsSurfaceMode,
} from "../../config/agenticPaymentsModes";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "mcps/openaimp/agenticPaymentCommands",
});

/**
 * #1728: resolves one agentic-payments switch for an MCP execution in
 * run > session > user > env > builtin order (the commands.ts
 * resolvePaymentsCommandMode pattern, local to this module). An
 * invalid winning value fails closed to `legacy` and is logged +
 * audited as payment.config_error.
 */
function resolveAgenticPaymentsCommandMode(
  context: McpToolContext,
  key: keyof PaymentsModeValues,
  run: unknown,
  legacy: PaymentsSurfaceMode
): PaymentsSurfaceMode {
  const { resolved, switchName } = resolvePaymentsSwitchByKey(
    context.scopedPaymentsModes,
    key,
    run,
    (context.env as unknown as Record<string, unknown> | undefined)?.[AGENTIC_PAYMENTS_SWITCH_NAMES[key]],
    legacy
  );
  if (resolved.invalid) {
    structuredLog.error(paymentsConfigErrorEvent(), {
      message: `[payments] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`,
      switch: switchName,
      raw: resolved.raw ?? null,
      resolved: legacy,
    });
    context.audit(paymentsConfigErrorEvent(), "orchestrator", {
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/** Env var name per switch key (for the env level lookup above). */
const AGENTIC_PAYMENTS_SWITCH_NAMES: Record<keyof PaymentsModeValues, string> = {
  create: "PAYMENTS_CREATE_MODE",
  confirm: "PAYMENTS_CONFIRM_MODE",
  transactions: "PAYMENTS_TRANSACTIONS_MODE",
  wallet: AGENTIC_WALLET_MODE_SWITCH,
  screener: PREMIUM_SCREENER_MODE_SWITCH,
  research: PREMIUM_RESEARCH_MODE_SWITCH,
};

/**
 * 1. Paid Options Screener Command ($0.05 USDC)
 */
export class PaidOptionsScreenerCommand implements IMcpToolCommand<{
  underlying?: string;
  underlyingSymbols?: string[];
  symbol?: string;
  maxUnderlyings?: number;
  contractType?: "CALL" | "PUT" | "BOTH";
  minDelta?: number;
  maxDelta?: number;
  minDte?: number;
  maxDte?: number;
  minVolume?: number;
  minOpenInterest?: number;
  maxSpreadPct?: number;
  maxQuoteAgeSeconds?: number;
  limit?: number;
  paymentSignature?: string;
  mode?: string;
}> {
  readonly name = "paid_options_screener";
  readonly description =
    "Screen live option chains with explicit DTE, Greeks, liquidity, spread, and quote-age inputs. Supply an underlying or a maximum-underlyings limit. Requires Cloudflare Agentic Payment ($0.05 USDC).";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      underlying: { type: "string", description: "Optional underlying ticker; omit to discover from current all-exchange listings" },
      maxUnderlyings: { type: "number", description: "Required for broad scans; maximum underlying symbols to query (clamped to 20)" },
      contractType: { type: "string", enum: ["CALL", "PUT", "BOTH"], description: "Optional option type; omitted screens both" },
      minDelta: { type: "number", description: "Minimum absolute delta (0.0 to 1.0)" },
      maxDelta: { type: "number", description: "Maximum absolute delta (0.0 to 1.0)" },
      minDte: { type: "number", description: "Minimum days to expiration" },
      maxDte: { type: "number", description: "Maximum days to expiration (defaults to 90 when no DTE bounds are supplied)" },
      minVolume: { type: "number", description: "Minimum daily contract volume" },
      minOpenInterest: { type: "number", description: "Minimum open interest" },
      maxSpreadPct: { type: "number", description: "Maximum bid/ask spread as percent of midpoint" },
      maxQuoteAgeSeconds: { type: "number", description: "Quote age reference for freshness labels; does not discard stale rows" },
      limit: { type: "number", description: "Maximum contracts to return (clamped to 500); omitted returns up to 500 matches" },
      paymentSignature: { type: "string", description: "x402 PAYMENT-SIGNATURE proof (base64 JSON or hex)" },
      underlyingSymbols: { type: "array", items: { type: "string" }, description: "#1728 input alias: REST filter spelling for the underlying list" },
      symbol: { type: "string", description: "#1728 input alias: REST GET query spelling for a single underlying" },
      mode: { type: "string", description: "#1728 run-level PREMIUM_SCREENER_MODE override (mcp | rest)" },
    },
  };
  // Issue #959: the filter constraints are composed from the ONE
  // shared options-filter definition (optionScreenerFilterFields in
  // src/trading/screeningSchemas.ts); this command's own tighter
  // bounds (0..1 deltas, positive maxDte, integer open interest) are
  // layered on the shared field schemas, not re-declared.
  readonly zodSchema = z.object({
    underlying: z.string().optional(),
    maxUnderlyings: optionScreenerFilterFields.maxUnderlyings,
    contractType: optionScreenerFilterFields.contractType,
    minDelta: optionScreenerFilterFields.minDelta.unwrap().min(0).max(1).optional(),
    maxDelta: optionScreenerFilterFields.maxDelta.unwrap().min(0).max(1).optional(),
    minDte: optionScreenerFilterFields.minDte,
    maxDte: optionScreenerFilterFields.maxDte.unwrap().min(1).optional(),
    minVolume: optionScreenerFilterFields.minVolume,
    minOpenInterest: optionScreenerFilterFields.minOpenInterest.unwrap().int().min(0).optional(),
    maxSpreadPct: optionScreenerFilterFields.maxSpreadPct,
    maxQuoteAgeSeconds: optionScreenerFilterFields.maxQuoteAgeSeconds,
    limit: optionScreenerFilterFields.limit,
    paymentSignature: z.string().optional(),
    underlyingSymbols: z.array(z.string()).optional(),
    symbol: z.string().optional(),
    mode: z.string().optional().describe("#1728 run-level PREMIUM_SCREENER_MODE override (mcp | rest)"),
  });

  async execute(
    input: {
      underlying?: string;
      underlyingSymbols?: string[];
      symbol?: string;
      maxUnderlyings?: number;
      contractType?: "CALL" | "PUT" | "BOTH";
      minDelta?: number;
      maxDelta?: number;
      minDte?: number;
      maxDte?: number;
      minVolume?: number;
      minOpenInterest?: number;
      maxSpreadPct?: number;
      maxQuoteAgeSeconds?: number;
      limit?: number;
      paymentSignature?: string;
      mode?: string;
    },
    context: McpToolContext
  ) {
    // #1728: the screener switch governs the paid RESPONSE ENVELOPE
    // only. Gate (x402-only), price, engine, channel ("mcp"), and
    // identity (sessionId) are identical in both modes.
    const screenerMode = resolveAgenticPaymentsCommandMode(context, "screener", input.mode, "mcp");
    const paymentService = new ETradeAgenticPaymentService(context.orm, context.env, context.sessionId);
    const serviceDef = TRADING_PAID_SERVICES.OPTIONS_SCREENER;
    const extractedNonce = paymentService.extractNonce(input.paymentSignature);
    const challenge = paymentService.createX402Challenge(serviceDef.resource, serviceDef.priceUSD, serviceDef.description, extractedNonce);

    // If no payment proof supplied, return 402 challenge
    if (!input.paymentSignature) {
      return {
        status: 402,
        paid: false,
        error: "Payment Required",
        priceUSD: serviceDef.priceUSD,
        currency: challenge.currency,
        challenge,
        paymentHeader: "PAYMENT-SIGNATURE",
        message: `Tool 'paid_options_screener' requires $${serviceDef.priceUSD.toFixed(2)} ${challenge.currency}. Sign the challenge and retry with paymentSignature.`,
      };
    }

    // Verify payment signature
    const verification = await paymentService.verifyPayment(
      { "PAYMENT-SIGNATURE": input.paymentSignature },
      challenge
    );

    if (!verification.valid || !verification.receipt) {
      return {
        status: 402,
        error: "Payment Verification Failed",
        reason: verification.reason || "Invalid payment signature.",
        challenge,
      };
    }

    // Payment verified: execute options screen. Issue #959: the
    // assembled filter validates through the ONE shared options-filter
    // schema before the engine sees it.
    // #1728 input aliases (additive spellings, not mode behavior):
    // the REST filter's underlyingSymbols list and the REST GET
    // query's `symbol` are accepted alongside the MCP `underlying`.
    // Precedence: explicit list > underlying > symbol.
    const underlyingList =
      input.underlyingSymbols && input.underlyingSymbols.length > 0
        ? input.underlyingSymbols.map((s) => String(s).toUpperCase().trim()).filter(Boolean)
        : input.underlying
          ? [input.underlying.toUpperCase().trim()]
          : input.symbol
            ? [input.symbol.toUpperCase().trim()]
            : undefined;
    const parsedFilter = parseOptionScreenerFilter({
      underlyingSymbols: underlyingList,
      maxUnderlyings: input.maxUnderlyings,
      contractType: input.contractType,
      minDelta: input.minDelta,
      maxDelta: input.maxDelta,
      minDte: input.minDte,
      maxDte: input.maxDte,
      minVolume: input.minVolume,
      minOpenInterest: input.minOpenInterest,
      maxSpreadPct: input.maxSpreadPct,
      maxQuoteAgeSeconds: input.maxQuoteAgeSeconds,
      limit: input.limit,
    });
    if (!parsedFilter.ok) {
      return { status: 400, error: parsedFilter.error };
    }
    // Issue #982: the paid tool executes through UnifiedOptionsService
    // (the service the REST routes call); its screen data is the raw
    // screen result the response below is built from.
    // Issue #1185: context.sessionId is the bound caller identity
    // (post-#180) — used directly, never a synthetic fallback.
    const service = new UnifiedOptionsService(context.env, context.sessionId, undefined, context.orm);
    const serviceResponse = await service.execute({
      action: "screen",
      channel: "mcp",
      filter: parsedFilter.value,
      symbols: parsedFilter.value.underlyingSymbols,
      limit: parsedFilter.value.limit,
    });
    const result = serviceResponse.data;

    context.audit("agentic_payment.tool_executed", "trading", {
      tool: "paid_options_screener",
      price: serviceDef.priceUSD,
      receiptId: verification.receipt.receiptId,
      txHash: verification.receipt.txHash,
    });

    // #1728: rest mode returns exactly the REST options-scan envelope
    // (success/service/receipt/screenResult); mcp mode (legacy)
    // returns the flat MCP envelope below.
    if (screenerMode === "rest") {
      const failed = result.status === "error";
      return {
        success: !failed,
        service: serviceDef.name,
        receipt: verification.receipt,
        screenResult: result,
        ...(failed
          ? {
              error:
                result.validationError ||
                result.fetchErrors?.[0]?.reason ||
                "Options screen failed upstream; no data could be fetched.",
            }
          : {}),
      };
    }

    return {
      status: 200,
      paid: true,
      receipt: verification.receipt,
      matchesCount: result.matchedCount,
      totalMatches: result.totalMatches,
      screenStatus: result.status,
      rejectionCount: result.rejectionCount,
      ...(result.status === "error"
        ? {
            error:
              result.validationError ||
              result.fetchErrors?.[0]?.reason ||
              "Options screen failed upstream; no data could be fetched.",
          }
        : {}),
      ...(result.fetchErrors && result.fetchErrors.length > 0 ? { fetchErrors: result.fetchErrors } : {}),
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      quoteQuality: result.quoteQuality,
      contracts: result.contracts,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 2. Paid Market Research Command ($0.10 USDC)
 */
export class PaidMarketResearchCommand implements IMcpToolCommand<{
  symbol?: string;
  paymentSignature?: string;
  mode?: string;
}> {
  readonly name = "paid_market_research";
  readonly description =
    "Generate deep institutional equity research report. Requires Cloudflare Agentic Payment ($0.10 USDC). Supply paymentSignature or call without to receive 402 challenge.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL)" },
      paymentSignature: { type: "string", description: "x402 PAYMENT-SIGNATURE proof (base64 JSON or hex)" },
      mode: { type: "string", description: "#1728 run-level PREMIUM_RESEARCH_MODE override (mcp | rest)" },
    },
  };
  readonly zodSchema = z.object({
    symbol: z.string().optional().default("NVDA"),
    paymentSignature: z.string().optional(),
    mode: z.string().optional().describe("#1728 run-level PREMIUM_RESEARCH_MODE override (mcp | rest)"),
  });

  async execute(input: { symbol?: string; paymentSignature?: string; mode?: string }, context: McpToolContext) {
    // #1728: the research switch governs the paid RESPONSE ENVELOPE
    // only (same boundaries as the screener switch above).
    const researchMode = resolveAgenticPaymentsCommandMode(context, "research", input.mode, "mcp");
    const paymentService = new ETradeAgenticPaymentService(context.orm, context.env, context.sessionId);
    const serviceDef = TRADING_PAID_SERVICES.MARKET_RESEARCH;
    const extractedNonce = paymentService.extractNonce(input.paymentSignature);
    const challenge = paymentService.createX402Challenge(serviceDef.resource, serviceDef.priceUSD, serviceDef.description, extractedNonce);

    if (!input.paymentSignature) {
      return {
        status: 402,
        paid: false,
        error: "Payment Required",
        priceUSD: serviceDef.priceUSD,
        currency: challenge.currency,
        challenge,
        paymentHeader: "PAYMENT-SIGNATURE",
        message: `Tool 'paid_market_research' requires $${serviceDef.priceUSD.toFixed(2)} ${challenge.currency}. Sign the challenge and retry with paymentSignature.`,
      };
    }

    const verification = await paymentService.verifyPayment(
      { "PAYMENT-SIGNATURE": input.paymentSignature },
      challenge
    );

    if (!verification.valid || !verification.receipt) {
      return {
        status: 402,
        error: "Payment Verification Failed",
        reason: verification.reason || "Invalid payment signature.",
        challenge,
      };
    }

    const marketDataResearch = new MarketDataResearchService(context.env);
    const report = await marketDataResearch.generateResearchReport(input.symbol || "NVDA");

    context.audit("agentic_payment.tool_executed", "research", {
      tool: "paid_market_research",
      price: serviceDef.priceUSD,
      receiptId: verification.receipt.receiptId,
      symbol: input.symbol || "NVDA",
    });

    // #1728: rest mode returns exactly the REST market-research
    // envelope; mcp mode (legacy) returns the flat MCP envelope.
    if (researchMode === "rest") {
      return {
        success: true,
        service: serviceDef.name,
        receipt: verification.receipt,
        report,
      };
    }
    return {
      status: 200,
      paid: true,
      receipt: verification.receipt,
      report,
    };
  }
}

/**
 * 3. Agentic Wallet Status Command
 */
export class AgenticWalletStatusCommand implements IMcpToolCommand<{
  action?: "status" | "set_limit";
  limitUSD?: number;
  limit?: number;
  mode?: string;
}> {
  readonly name = "agentic_wallet_status";
  readonly description =
    "Check Cloudflare Agentic Payments (x402/MPP) wallet status, auto-approval threshold, and transaction metrics. NOTE: the balance is a SIMULATED local-ledger figure (a $50.00 local starting credit plus/minus locally recorded entries) — this service does not read any on-chain wallet balance.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["status", "set_limit"], description: "Action to perform" },
      limitUSD: { type: "number", description: "New auto-approval threshold in USD (e.g. 0.10)" },
      limit: { type: "number", description: "#1728 input alias (rest mode): same as limitUSD, the REST POST spelling" },
      mode: { type: "string", description: "#1728 run-level AGENTIC_WALLET_MODE override (mcp | rest)" },
    },
  };
  readonly zodSchema = z.object({
    action: z.enum(["status", "set_limit"]).optional().default("status"),
    limitUSD: z.number().optional(),
    limit: z.number().optional(),
    mode: z.string().optional().describe("#1728 run-level AGENTIC_WALLET_MODE override (mcp | rest)"),
  });

  async execute(input: { action?: "status" | "set_limit"; limitUSD?: number; limit?: number; mode?: string }, context: McpToolContext) {
    // #1728: the wallet switch. Mode "rest" adopts the route
    // contract: status is raw, set_limit validates (missing /
    // negative / NaN → the route's 400 message, as a throw on this
    // transport), honors the `limit` alias, audits
    // agentic_payment.limit_updated, and returns the route POST
    // shape. Mode "mcp" (legacy) keeps the wrapped status, the
    // message-string set_limit shape, the silent status fall-through
    // on a missing limit, and no audit. The balance stays simulated
    // and per-identity scoped in both modes.
    const walletMode = resolveAgenticPaymentsCommandMode(context, "wallet", input.mode, "mcp");
    const paymentService = new ETradeAgenticPaymentService(context.orm, context.env, context.sessionId);

    if (input.action === "set_limit") {
      if (walletMode === "rest") {
        const raw = input.limitUSD !== undefined ? input.limitUSD : input.limit;
        const limit = Number(raw);
        if (raw === undefined || !Number.isFinite(limit) || limit < 0) {
          throw new Error("Invalid limitUSD. Must be non-negative number.");
        }
        paymentService.setAutoApproveLimit(limit);
        context.audit("agentic_payment.limit_updated", "payments", { limitUSD: limit });
        return {
          success: true,
          autoApproveLimitUSD: limit,
        };
      }
      if (input.limitUSD !== undefined) {
        paymentService.setAutoApproveLimit(input.limitUSD);
        return {
          success: true,
          message: `Agentic payment auto-approval limit set to $${input.limitUSD.toFixed(2)} USD.`,
          autoApproveLimitUSD: input.limitUSD,
        };
      }
    }

    const status = await paymentService.getWalletStatus();
    if (walletMode === "rest") {
      return status;
    }
    return {
      success: true,
      ...status,
    };
  }
}
