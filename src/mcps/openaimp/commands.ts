/**
 * GoF Command Pattern & Factory Pattern: Platform MCP Tools
 *
 * Implements:
 * - GoF Command Pattern: Every capability is an encapsulated IMcpToolCommand.
 * - GoF Factory Pattern: McpToolFactory instantiates, registers, and dispatches commands.
 * - SOLID Single Responsibility Principle (SRP): Each command class does only its designated task.
 * - SOLID Open/Closed Principle (OCP): New tools can be plugged in without modifying existing commands.
 * - SOLID Liskov Substitution Principle (LSP): All commands are polymorphically interchangeable.
 * - GRASP Information Expert: Database and payment domain queries delegate to the respective entities.
 * - GRASP Low Coupling & High Cohesion: Commands interact through McpToolContext / McpSystemFacade.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { computeMarketplaceRevenueSummary } from "../../data/marketplacePorts";
import {
  createProductionMcpPermissionPort,
  declareToolScope,
  executeWithPermissionGate,
  type McpScope,
} from "./mcpPermissionPorts";
import {
  isSupportedGateway,
  SUPPORTED_GATEWAYS,
  type SupportedGateway,
} from "../../services/payments";
import {
  AGENTIC_WALLET_MODE_SWITCH,
  paymentsConfigErrorEvent,
  PAYMENTS_CONFIRM_MODE_SWITCH,
  PAYMENTS_CREATE_MODE_SWITCH,
  PAYMENTS_TRANSACTIONS_MODE_SWITCH,
  PREMIUM_RESEARCH_MODE_SWITCH,
  PREMIUM_SCREENER_MODE_SWITCH,
  resolvePaymentsSwitchByKey,
  type PaymentsModeValues,
  type PaymentsSurfaceMode,
} from "../../config/agenticPaymentsModes";
import { AGENT_DIDS, createDidAttestation, getUserDid } from "../../agents/did";
import { executeNaturalLanguageQuery } from "../../agents/nlq";
import { registerDraftOwner } from "../../payments/draftOwners";
import {
  ETradeMarketScanCommand,
  ETradeGetQuoteCommand,
  ETradePreviewOrderCommand,
  ETradeExecuteOrderCommand,
  ETradeGetPositionsCommand,
  ETradeAuthStatusCommand,
  ETradeAccountDiscoveryCommand,
} from "./etradeCommands";
import {
  MarketDataGetQuoteCommand,
  MarketDataFundamentalsCommand,
  MarketDataHistoricalBarsCommand,
  MarketDataResearchCommand,
  AlpacaSnapshotCommand,
  AlpacaAccountCommand,
  AlpacaPositionsCommand,
  AlpacaOrdersCommand,
  AlpacaPlaceOrderCommand,
  DeprecatedToolAlias,
} from "./marketDataCommands";
import {
  PaidOptionsScreenerCommand,
  PaidMarketResearchCommand,
  AgenticWalletStatusCommand,
} from "./agenticPaymentCommands";
import {
  BrowserInspectCommand,
  BrowserScreenshotCommand,
  DispatchTradingWebhookCommand,
  SandboxRunCommand,
  QuantBacktestCommand,
  ThinkTradeValidationCommand,
  AISearchFinancialDocsCommand,
  AISearchAgentSearchCommand,
  DurableTWAPOrderCommand,
} from "./cloudflareAgentCommands";
import {
  ChainRunCommand,
  GoalCompileCommand,
  GoalScheduleCommand,
} from "./goalChainCommands";
import {
  AgentDbAuditHistoryCommand,
  AgentDbChainStatusCommand,
  AgentDbJobsHistoryCommand,
  AgentDbReportsListCommand,
  AgentDbTraceGetCommand,
} from "./agentDbReadCommands";
import {
  ListScheduledGoalsCommand,
  TriggerScheduledGoalCommand,
  CheckPaymentBudgetCommand,
  GetPaymentsOverviewCommand,
  ProposeStockTradeCommand,
  ProposeOptionsTradeCommand,
  GetTradingAccountsCommand,
  GetTradingPositionsCommand,
  GetTradingQuoteCommand,
  StartTradeApprovalCommand,
  DecideTradeApprovalCommand,
  GetTradeApprovalStatusCommand,
  ListReportAssetsCommand,
  GetReportAssetCommand,
  BrowserSnapTransactionCommand,
  BrowserCapturePageCommand,
  BrowserScrapeTablesCommand,
  SlackSendPreTradeApprovalCommand,
  SlackDispatchTransactionSnapCommand,
  RunStockScreenCommand,
} from "./meshDoorCommands";

import { searchPlatformKnowledge } from "../../services/platformKnowledge";
import {
  KNOWLEDGE_MODE_SWITCH,
  MEMORY_READ_MODE_SWITCH,
  applyMemoryReadCap,
  knowledgeConfigErrorEvent,
  levelsForKnowledge,
  levelsForMemory,
  memoryConfigErrorEvent,
  resolveKnowledgeMode,
  resolveMemoryReadMode,
  type KnowledgeMode,
  type MemoryReadMode,
} from "../../config/knowledgeMemoryModes";
import {
  NLQ_MODE_SWITCH,
  levelsForNlq,
  nlqConfigErrorEvent,
  resolveNlqMode,
} from "../../config/nlqModes";
import {
  JOB_LIST_ENVELOPE_SWITCH,
  applyJobListEnvelope,
  jobsConfigErrorEvent,
  levelsForJobListEnvelope,
  resolveJobListEnvelope,
  type JobListEnvelope,
} from "../../config/asyncJobModes";
import {
  ADS_REVENUE_SWITCHES,
  adsRevenueConfigErrorEvent,
  categoryCreateId,
  categoryCreateSlug,
  categoryCreateValues,
  categoryListOptions,
  categoryUpdatePatch,
  externalAdClickEarnings,
  externalAdCreateId,
  externalAdCreateValues,
  externalAdImpressionEarnings,
  externalAdListOptions,
  externalAdUpdatePatch,
  levelsForDomain,
  referralCreateValues,
  referralListOptions,
  resolveAdsRevenueMode,
  type AdsRevenueDomain,
  type AdsRevenueMode,
} from "../../config/adsRevenueModes";

/**
 * #1721: resolves one ads/revenue switch for an MCP execution in
 * run > session > user > env > builtin order. Run = the per-call
 * `mode` input; session/user = context.scopedModes carriers; env =
 * context.env. An invalid winning value fails closed to "route" and
 * is logged + audited as `<domain>.config_error`.
 */
function resolveCommandMode(
  context: McpToolContext,
  domain: AdsRevenueDomain,
  run: unknown
): AdsRevenueMode {
  const switchName = ADS_REVENUE_SWITCHES[domain];
  const resolved = resolveAdsRevenueMode(
    levelsForDomain(context.scopedModes, domain, run, (context.env as unknown as Record<string, unknown> | undefined)?.[switchName])
  );
  if (resolved.invalid) {
    console.error(
      `[ads-revenue] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "route"`
    );
    context.audit(adsRevenueConfigErrorEvent(domain), "orchestrator", {
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: "route",
    });
  }
  return resolved.mode;
}

/**
 * #1728: resolves one agentic-payments switch for an MCP execution in
 * run > session > user > env > builtin order. Run = the per-call
 * `mode` input; session/user = context.scopedPaymentsModes carriers;
 * env = context.env. `legacy` is the calling tool's own legacy
 * contract ("mcp" for every MCP command here). An invalid winning
 * value fails closed to `legacy` and is logged + audited as
 * payment.config_error.
 */
function resolvePaymentsCommandMode(
  context: McpToolContext,
  key: keyof PaymentsModeValues,
  run: unknown,
  legacy: PaymentsSurfaceMode
): PaymentsSurfaceMode {
  const { resolved, switchName } = resolvePaymentsSwitchByKey(
    context.scopedPaymentsModes,
    key,
    run,
    (context.env as unknown as Record<string, unknown> | undefined)?.[PAYMENTS_SWITCH_NAMES[key]],
    legacy
  );
  if (resolved.invalid) {
    console.error(
      `[payments] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`
    );
    context.audit(paymentsConfigErrorEvent(), "orchestrator", {
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/** Env var name per switch key (for the env level lookup above). */
const PAYMENTS_SWITCH_NAMES: Record<keyof PaymentsModeValues, string> = {
  create: PAYMENTS_CREATE_MODE_SWITCH,
  confirm: PAYMENTS_CONFIRM_MODE_SWITCH,
  transactions: PAYMENTS_TRANSACTIONS_MODE_SWITCH,
  wallet: AGENTIC_WALLET_MODE_SWITCH,
  screener: PREMIUM_SCREENER_MODE_SWITCH,
  research: PREMIUM_RESEARCH_MODE_SWITCH,
};

/**
 * #1723: resolves KNOWLEDGE_MODE for one knowledge-tool execution in
 * run > session > user > env > builtin order. Run = the per-call
 * `mode` input; session/user = context.scopedKnowledgeModes carriers;
 * env = context.env. `legacy` is the calling tool's own legacy
 * contract. An invalid winning value fails closed to `legacy` and is
 * logged + audited as knowledge.config_error.
 */
function resolveKnowledgeForTool(
  context: McpToolContext,
  run: unknown,
  legacy: KnowledgeMode
): KnowledgeMode {
  const resolved = resolveKnowledgeMode(
    levelsForKnowledge(
      context.scopedKnowledgeModes,
      run,
      (context.env as unknown as Record<string, unknown> | undefined)?.[KNOWLEDGE_MODE_SWITCH]
    ),
    legacy
  );
  if (resolved.invalid) {
    console.error(
      `[knowledge] invalid ${KNOWLEDGE_MODE_SWITCH} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`
    );
    context.audit(knowledgeConfigErrorEvent(), "orchestrator", {
      setting: KNOWLEDGE_MODE_SWITCH,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/**
 * #1723: resolves MEMORY_READ_MODE for one memory-list execution in
 * run > session > user > env > builtin order. `legacy` is the calling
 * surface's own legacy cap. Invalid wins fail closed to `legacy`,
 * logged + audited as memory.config_error. Callers resolve ONLY for
 * list: remember/delete/clear never consult the switch.
 */
function resolveMemoryReadForList(
  context: McpToolContext,
  run: unknown,
  legacy: MemoryReadMode
): MemoryReadMode {
  const resolved = resolveMemoryReadMode(
    levelsForMemory(
      context.scopedMemoryModes,
      run,
      (context.env as unknown as Record<string, unknown> | undefined)?.[MEMORY_READ_MODE_SWITCH]
    ),
    legacy
  );
  if (resolved.invalid) {
    console.error(
      `[memory] invalid ${MEMORY_READ_MODE_SWITCH} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`
    );
    context.audit(memoryConfigErrorEvent(), "orchestrator", {
      setting: MEMORY_READ_MODE_SWITCH,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/**
 * #1724: resolves JOB_LIST_ENVELOPE for one list_async_jobs execution
 * in run > session > user > env > builtin order. `legacy` is the
 * calling surface's own legacy envelope (MCP list → "count"). Invalid
 * wins fail closed to `legacy`, logged + audited as jobs.config_error.
 * Callers resolve ONLY for list: the single-job full record is never
 * enveloped by this switch.
 */
function resolveJobListEnvelopeForTool(
  context: McpToolContext,
  run: unknown,
  legacy: JobListEnvelope
): JobListEnvelope {
  const resolved = resolveJobListEnvelope(
    levelsForJobListEnvelope(
      context.scopedJobListModes,
      run,
      (context.env as unknown as Record<string, unknown> | undefined)?.[JOB_LIST_ENVELOPE_SWITCH]
    ),
    legacy
  );
  if (resolved.invalid) {
    console.error(
      `[jobs] invalid ${JOB_LIST_ENVELOPE_SWITCH} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`
    );
    context.audit(jobsConfigErrorEvent(), "orchestrator", {
      setting: JOB_LIST_ENVELOPE_SWITCH,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/** #1723: maps a platform-knowledge result into the search `chunks` shape (score 1.0, legacy verbatim). */
function platformResultToChunks(result: ReturnType<typeof searchPlatformKnowledge>) {
  return result.results.map((r) => ({
    id: r.id,
    title: r.title,
    text: `${r.summary}\n\nDetails: ${r.details}\n\nHow to Use:\n${r.howToUse.join("\n")}`,
    targetTab: r.targetTab,
    samplePrompt: r.samplePrompt,
    score: 1.0,
  }));
}

/**
 * #1723: the "search" contract — KnowledgeSearchCommand legacy verbatim
 * (AI-search attempt, platform fallback max 3, chunks ≤5, no-throw
 * error shape). Shared by both tools when the switch resolves to
 * "search"; `toolName` is the invoked tool, for audit attribution.
 */
async function runSearchContract(query: string, context: McpToolContext, toolName: string) {
  const isPlatformQuery = /\b(platform|capability|capabilities|workflow|workflows|screener|screening|options\s*flow|builder|payoff|hitl|guardrail|etrade|did|schedule|cron|nlq|how\s+to|pickbesttrades|faq)\b/i.test(query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const endpoint = (context.env as any)?.AI_SEARCH_ENDPOINT;
    let chunks: any[] = [];
    if (endpoint) {
      const response = await fetch(`${endpoint}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: query }] }),
        signal: controller.signal,
      });
      if (response.ok) {
        const data = (await response.json()) as any;
        const rawChunks = data?.result?.chunks ?? (Array.isArray(data) ? data : []);
        chunks = Array.isArray(rawChunks) ? rawChunks : [];
      }
    }
    clearTimeout(timeout);

    // If no chunks from external AI search or if this is a platform query, ground with platform knowledge
    if (chunks.length === 0 || isPlatformQuery) {
      const platformResult = searchPlatformKnowledge(query, { maxResults: 3 });
      if (platformResult.count > 0) {
        context.audit("mcp.tool_called", "orchestrator", { tool: toolName, query, count: platformResult.count, source: "platform_knowledge" });
        return {
          query,
          count: platformResult.count,
          chunks: platformResultToChunks(platformResult),
          answer: platformResult.formattedAnswer,
          message: `Retrieved ${platformResult.count} platform capability documentation guides from the internal Platform Knowledge Base.`,
        };
      }
    }

    context.audit("mcp.tool_called", "orchestrator", { tool: toolName, query, count: chunks.length });
    return {
      query,
      count: chunks.length,
      chunks: chunks.slice(0, 5),
      message: chunks.length > 0
        ? `Retrieved ${chunks.length} factual documents from Cloudflare AI Search.`
        : "No custom indexed documents found in the Cloudflare AI Search knowledge base. Synthesize a helpful, authoritative response from general knowledge, clearly informing the user that no specific internal documents were indexed.",
    };
  } catch (err: any) {
    clearTimeout(timeout);
    const platformResult = searchPlatformKnowledge(query, { maxResults: 3 });
    if (platformResult.count > 0) {
      return {
        query,
        count: platformResult.count,
        chunks: platformResultToChunks(platformResult),
        answer: platformResult.formattedAnswer,
        message: `Retrieved ${platformResult.count} platform capability documentation guides from the internal Platform Knowledge Base.`,
      };
    }
    return { error: err.message || "Search request failed", query, count: 0, chunks: [] };
  }
}

/**
 * #1723: the "platform" contract — QueryPlatformKnowledgeCommand legacy
 * verbatim (always platform, max 5, optional category filter, `results`
 * shape). Shared by both tools when the switch resolves to "platform".
 */
function runPlatformContract(
  query: string,
  category: string | undefined,
  context: McpToolContext,
  toolName: string
) {
  const result = searchPlatformKnowledge(query, { category, maxResults: 5 });
  context.audit("mcp.tool_called", "orchestrator", { tool: toolName, query, count: result.count });
  return {
    query,
    count: result.count,
    results: result.results,
    answer: result.formattedAnswer,
  };
}

/**
 * 1. Knowledge Search Command (RAG Vectorize & Cloudflare AI Search)
 */
export class KnowledgeSearchCommand implements IMcpToolCommand<{ query: string; mode?: string; category?: string }> {
  readonly name = "knowledge_search";
  readonly description = "Search the organization's enterprise knowledge base using Cloudflare AI Search RAG with Vectorize index retrieval, with automatic fallback to platform capabilities and workflows.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query or natural language inquiry" },
      // #1723: run-level KNOWLEDGE_MODE ("search" | "platform"); unset = tool legacy ("search").
      mode: { type: "string", description: "Optional KNOWLEDGE_MODE run override: \"search\" (AI-first, default) or \"platform\" (always platform catalog)" },
      // #1723: honored only in "platform" mode (mirrors query_platform_knowledge).
      category: { type: "string", description: "Optional category filter, honored only in \"platform\" mode (e.g. stocks, options, flows, brokerage, scheduled, nlq, all)" },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string().min(1).describe("Search query or natural language inquiry"),
    mode: z.string().optional().describe("KNOWLEDGE_MODE run override"),
    category: z.string().optional().describe("Category filter, honored only in platform mode"),
  });

  async execute(input: { query: string; mode?: string; category?: string }, context: McpToolContext) {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query is required");

    // #1723: KNOWLEDGE_MODE dispatch. Legacy "search" is the builtin
    // default for this tool; an explicit run/session/user/env level
    // may select "platform" (category honored only in that mode).
    const mode = resolveKnowledgeForTool(context, input.mode, "search");
    if (mode === "platform") {
      return runPlatformContract(query, input.category, context, this.name);
    }
    return runSearchContract(query, context, this.name);
  }
}

/**
 * 1b. Query Platform Knowledge & Capabilities Command
 */
export class QueryPlatformKnowledgeCommand implements IMcpToolCommand<{ query: string; category?: string; mode?: string }> {
  readonly name = "query_platform_knowledge";
  readonly description = "Retrieve authoritative information on platform capabilities, 8 core workflows, 8 quantitative FAQs/playbooks, 6 decisioning & logic engines (including PickBestTrades and screeners), and step-by-step instructions on how to use them through chat or UI tabs.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Question or topic regarding platform capabilities, workflows, or usage" },
      category: { type: "string", description: "Optional category filter (e.g. stocks, options, flows, brokerage, scheduled, nlq, all)" },
      // #1723: run-level KNOWLEDGE_MODE ("search" | "platform"); unset = tool legacy ("platform").
      mode: { type: "string", description: "Optional KNOWLEDGE_MODE run override: \"platform\" (always platform catalog, default) or \"search\" (AI-first)" },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string().min(1).describe("Question or topic regarding platform capabilities, workflows, or usage"),
    category: z.string().optional().describe("Optional category filter"),
    mode: z.string().optional().describe("KNOWLEDGE_MODE run override"),
  });

  async execute(input: { query: string; category?: string; mode?: string }, context: McpToolContext) {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query is required");

    // #1723: KNOWLEDGE_MODE dispatch. Legacy "platform" is the builtin
    // default for this tool; an explicit run/session/user/env level
    // may select "search" (the AI-first contract; `category` is
    // ignored in that mode, matching knowledge_search legacy, which
    // has no category input on its fallback).
    const mode = resolveKnowledgeForTool(context, input.mode, "platform");
    if (mode === "search") {
      return runSearchContract(query, context, this.name);
    }
    return runPlatformContract(query, input.category, context, this.name);
  }
}

/**
 * 2. Draft Payment Command
 */
export class DraftPaymentCommand implements IMcpToolCommand<{
  amount: number;
  currency?: string;
  customer: string;
  gateway?: SupportedGateway;
  action?: "charge" | "refund" | "invoice";
  description?: string;
  mode?: string;
}> {
  readonly name = "draft_payment";
  readonly description = "Prepare an explicit human-authorized payment intent draft (charge, refund, invoice) with Agent Decentralized Identifier (DID) attestation across Stripe, PayPal, or Lemon Squeezy.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      amount: { type: "number", description: "Payment amount in dollars (e.g. 25.00)" },
      currency: { type: "string", description: "Currency code (default: USD)" },
      customer: { type: "string", description: "Customer name or organization" },
      gateway: { type: "string", enum: ["stripe", "paypal", "lemonsqueezy", "sandbox"], description: "Payment gateway processor" },
      action: { type: "string", enum: ["charge", "refund", "invoice"], description: "Payment action type" },
      description: { type: "string", description: "Order description or note" },
      mode: { type: "string", description: "#1728 run-level PAYMENTS_CREATE_MODE override (mcp | rest)" },
    },
    required: ["amount", "customer"],
  };
  readonly zodSchema = z.object({
    amount: z.number().positive().describe("Payment amount in dollars (e.g. 25.00)"),
    currency: z.string().default("USD").describe("Currency code (default: USD)"),
    customer: z.string().min(1).describe("Customer name or organization"),
    gateway: z.enum(["stripe", "paypal", "lemonsqueezy", "sandbox"]).default("stripe").describe("Payment gateway processor"),
    action: z.enum(["charge", "refund", "invoice"]).default("charge").describe("Payment action type"),
    description: z.string().optional().describe("Order description or note"),
    mode: z.string().optional().describe("#1728 run-level PAYMENTS_CREATE_MODE override (mcp | rest)"),
  });

  async execute(input: any, context: McpToolContext) {
    // #524: an omitted or unparseable amount is a validation error, never
    // a silent $10 charge.
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("amount is required and must be a positive number");
    }
    const currency = (input.currency || "USD").toUpperCase();
    // No invented customer name (issue #514), matching the create route.
    const customer = (input.customer || "").trim();
    const action = (input.action || "charge") as "charge" | "refund" | "invoice";
    // #1728: the create switch. Mode "rest" adopts the route contract
    // (gateway validated BEFORE any row is written, with the route's
    // UNSUPPORTED_GATEWAY wording; omitted description stores "").
    // Mode "mcp" (legacy) keeps the command's historic behavior. The
    // route still runs its own guard before delegation in both modes,
    // so the rest-mode validation below is unreachable from the route
    // — it exists for DIRECT MCP callers. Zod is not parsed at
    // execution time, so this check is written explicitly here, not
    // left to the zod enum.
    const createMode = resolvePaymentsCommandMode(context, "create", input.mode, "mcp");
    const gatewayInput =
      input.gateway == null || (typeof input.gateway === "string" && input.gateway.trim() === "")
        ? "stripe"
        : String(input.gateway);
    if (createMode === "rest" && !isSupportedGateway(gatewayInput)) {
      throw new Error(
        `Unsupported payment gateway: "${gatewayInput}". Supported gateways: ${SUPPORTED_GATEWAYS.join(", ")}.`
      );
    }
    const gateway = (input.gateway || "stripe") as SupportedGateway;
    // #1690/#514: an EXPLICITLY supplied description — including an
    // explicitly empty string, which the POST /payments/create route
    // passes when the caller omits one — stays exactly as supplied
    // (trimmed), so the route's pinned empty-note behavior survives
    // delegation. Only an OMITTED description falls back: to the
    // generic default in mcp mode, to "" in rest mode (the route pin).
    const description = (input.description == null
      ? (createMode === "rest" ? "" : `Payment intent for ${customer}`)
      : String(input.description)).trim();

    const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
    const userDid = getUserDid(context.sessionId);

    const didProof = await createDidAttestation({
      draftId,
      action,
      amount,
      currency,
      customer,
      gateway,
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid: userDid,
    }, context.env?.DID_ATTESTATION_KEY);

    const now = new Date().toISOString();
    const tx = context.orm.transactions.create({
      id: draftId,
      sessionId: context.sessionId,
      action,
      amount,
      currency,
      customer,
      gateway,
      gatewayRef: "",
      status: "awaiting_confirmation",
      checkoutUrl: "",
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature,
      note: description,
      createdAt: now,
      updatedAt: now,
    });

    // Issue #932: record this instance as the draft's owner so a gateway
    // settlement webhook (received by the shared system_webhook_receiver
    // instance) can be routed back here.
    await registerDraftOwner(context.env, draftId, context.sessionId);

    context.audit("payment.awaiting_confirmation", "payments", {
      draftId,
      action,
      amount,
      customer,
      gateway,
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
    });

    return {
      draftId,
      status: "awaiting_confirmation",
      requiresConfirmation: true,
      amount,
      currency,
      customer,
      gateway,
      action,
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature,
      securityNotice: "NO FUNDS HAVE BEEN MOVED. Stamped with Agent DID. Requires explicit human approval via confirm_payment_draft.",
      transaction: tx,
    };
  }
}

/**
 * 3. Confirm Payment Draft Command
 */
export class ConfirmPaymentDraftCommand implements IMcpToolCommand<{
  draftId: string;
  decision: "approved" | "rejected";
  note?: string;
  mode?: string;
}> {
  readonly name = "confirm_payment_draft";
  readonly description = "Authorize or reject a pending payment draft using Human-in-the-Loop (HITL) approval with cryptographic verification.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      draftId: { type: "string", description: "The unique payment draft identifier (e.g. pay_12345)" },
      decision: { type: "string", enum: ["approved", "rejected"], description: "Human authorization decision" },
      note: { type: "string", description: "Optional review note or justification" },
      mode: { type: "string", description: "#1728 run-level PAYMENTS_CONFIRM_MODE override (mcp | rest)" },
    },
    required: ["draftId", "decision"],
  };
  readonly zodSchema = z.object({
    draftId: z.string().describe("The unique payment draft identifier (e.g. pay_12345)"),
    decision: z.enum(["approved", "rejected"]).describe("Human authorization decision"),
    note: z.string().optional().describe("Optional review note or justification"),
    mode: z.string().optional().describe("#1728 run-level PAYMENTS_CONFIRM_MODE override (mcp | rest)"),
  });

  async execute(input: { draftId: string; decision: "approved" | "rejected"; note?: string; mode?: string }, context: McpToolContext) {
    const { draftId, decision, note } = input;
    const tx = context.orm.transactions.findById(draftId);
    if (!tx) {
      throw new Error(`Draft ${draftId} not found in transactions repository`);
    }
    // #1728: the confirm switch governs the RESPONSE ENVELOPE only.
    // The state transition, the HITL decision, and the audits are
    // identical in both modes. (The P-2 shared gap — no facade
    // success-flag check before writing "completed" — is NOT changed
    // here; see the #1728 §15 follow-up.)
    const confirmMode = resolvePaymentsCommandMode(context, "confirm", input.mode, "mcp");

    const now = new Date().toISOString();
    const userDid = getUserDid(context.sessionId);

    if (decision === "approved") {
      let checkoutUrl = tx.checkoutUrl || "";
      let gatewayRef = tx.gatewayRef || "";

      if (context.facade) {
        if (tx.action === "charge" || tx.action === "invoice") {
          const res = await context.facade.createCheckout({
            draftId,
            amount: tx.amount,
            currency: tx.currency,
            customer: tx.customer,
            gateway: tx.gateway as SupportedGateway,
            userLogin: context.sessionId,
            description: note || tx.note || `Payment for ${tx.customer}`,
          });
          checkoutUrl = res.checkoutUrl;
          gatewayRef = res.gatewayRef;
        } else if (tx.action === "refund") {
          const res = await context.facade.executeRefund({
            transactionId: draftId,
            amount: tx.amount,
            gateway: tx.gateway as SupportedGateway,
            gatewayRef: tx.gatewayRef,
            userLogin: context.sessionId,
            reason: note,
          });
          gatewayRef = res.refundId;
        }
      }

      const updated = context.orm.transactions.update(draftId, {
        status: "completed",
        authorizerDid: userDid,
        gatewayRef,
        checkoutUrl,
        note: note || "Approved by human authorizer",
        updatedAt: now,
      });

      context.audit("payment.confirmed", "payments", {
        draftId,
        status: "completed",
        decision: "approved",
        gatewayRef,
        checkoutUrl,
        authorizerDid: userDid,
      });

      // #1728: rest mode returns exactly the REST confirm envelope;
      // mcp mode (legacy) returns the full envelope.
      if (confirmMode === "rest") {
        return {
          success: true,
          status: "completed",
          draftId,
          checkoutUrl,
          gatewayRef,
          authorizerDid: userDid,
        };
      }
      return {
        draftId,
        status: "completed",
        decision: "approved",
        checkoutUrl,
        gatewayRef,
        authorizerDid: userDid,
        executorDid: AGENT_DIDS.ORCHESTRATOR,
        executedAt: now,
        transaction: updated,
      };
    } else {
      const updated = context.orm.transactions.update(draftId, {
        status: "rejected",
        authorizerDid: userDid,
        note: note || "Rejected by human reviewer",
        updatedAt: now,
      });

      context.audit("payment.rejected", "payments", { draftId, decision: "rejected", authorizerDid: userDid });

      if (confirmMode === "rest") {
        return { success: true, status: "rejected", draftId };
      }
      return {
        draftId,
        status: "rejected",
        decision: "rejected",
        authorizerDid: userDid,
        executedAt: now,
        transaction: updated,
      };
    }
  }
}

/**
 * 4. Get Payment Gateways Command
 */
export class GetPaymentGatewaysCommand implements IMcpToolCommand<{}> {
  readonly name = "get_payment_gateways";
  readonly description = "Query multi-gateway processor statuses (Stripe, PayPal, Lemon Squeezy) and registered agent W3C DID identifiers.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const statuses = context.facade ? context.facade.getGatewayStatuses() : [];
    return {
      gateways: statuses,
      agentDids: AGENT_DIDS,
      userDid: getUserDid(context.sessionId),
      count: statuses.length,
    };
  }
}

/**
 * 5. Get Transactions Command
 */
export class GetTransactionsCommand implements IMcpToolCommand<{ limit?: number; status?: string; mode?: string }> {
  readonly name = "get_transactions";
  readonly description = "Query settled payment transactions, drafts, and cryptographic proof signatures from the mas_transactions ledger.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Maximum number of transactions to return (default: 50)" },
      status: { type: "string", description: "Filter by status: completed, awaiting_confirmation, rejected" },
      mode: { type: "string", description: "#1728 run-level PAYMENTS_TRANSACTIONS_MODE override (mcp | rest)" },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().optional().default(50).describe("Maximum number of transactions to return"),
    status: z.string().optional().describe("Filter by status: completed, awaiting_confirmation, rejected"),
    mode: z.string().optional().describe("#1728 run-level PAYMENTS_TRANSACTIONS_MODE override (mcp | rest)"),
  });

  async execute(input: { limit?: number; status?: string; mode?: string }, context: McpToolContext) {
    const transactionsMode = resolvePaymentsCommandMode(context, "transactions", input.mode, "mcp");
    // #1728 rest mode: the REST list contract verbatim — limit fixed
    // at 50, the status filter ignored, rows coerced exactly as the
    // route remaps them, plus the route's summary. The route's own
    // rest branch re-applies the same mapping/summary, so the two
    // rest shapes are identical by construction (pinned by the #1728
    // test comparing them row-for-row).
    if (transactionsMode === "rest") {
      const rows = context.orm.transactions.findMany({
        orderBy: "created_at DESC",
        limit: 50,
      });
      const transactions = rows.map((t: any) => ({
        id: String(t.id),
        sessionId: String(t.sessionId),
        action: String(t.action),
        amount: Number(t.amount || 0),
        currency: String(t.currency || "USD"),
        customer: String(t.customer),
        gateway: String(t.gateway || "stripe"),
        gatewayRef: String(t.gatewayRef || ""),
        status: String(t.status),
        checkoutUrl: String(t.checkoutUrl || ""),
        proposerDid: String(t.proposerDid || AGENT_DIDS.PAYMENTS),
        authorizerDid: t.authorizerDid ? String(t.authorizerDid) : undefined,
        proofSignature: String(t.proofSignature || ""),
        note: String(t.note || ""),
        createdAt: String(t.createdAt),
        updatedAt: String(t.updatedAt),
      }));
      const totalVolume = transactions
        .filter((t) => t.status === "completed" || t.status === "authorized")
        .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : -t.amount), 0);
      const pendingCount = transactions.filter((t) => t.status === "awaiting_confirmation").length;
      const completedCount = transactions.filter((t) => t.status === "completed" || t.status === "authorized").length;
      return {
        count: transactions.length,
        transactions,
        summary: {
          totalVolume: Math.max(0, totalVolume),
          completedCount,
          pendingCount,
          verifiedDidCount: transactions.length,
        },
      };
    }
    const limit = Number(input.limit) || 50;
    const filter = input.status ? { status: input.status } : undefined;
    const transactions = context.orm.transactions.findMany({
      where: filter,
      orderBy: "created_at DESC",
      limit,
    });
    return { count: transactions.length, transactions };
  }
}

/**
 * #1722: resolves the NLQ_MODE switch for an MCP execution in
 * run > session > user > env > builtin order. Run = the per-call
 * `mode` input; session/user = context.scopedNlqModes carriers; env =
 * context.env. An invalid winning value fails closed to "rest" and
 * is logged + audited as nlq.config_error.
 */
function resolveNlqCommandMode(
  context: McpToolContext,
  run: unknown
): import("../../config/nlqModes").NlqMode {
  const resolved = resolveNlqMode(
    levelsForNlq(context.scopedNlqModes, run, (context.env as unknown as Record<string, unknown> | undefined)?.[NLQ_MODE_SWITCH])
  );
  if (resolved.invalid) {
    console.error(
      `[nlq] invalid ${NLQ_MODE_SWITCH} value ${JSON.stringify(resolved.raw)} — failing closed to "rest"`
    );
    context.audit(nlqConfigErrorEvent(), "orchestrator", {
      setting: NLQ_MODE_SWITCH,
      value: resolved.raw ?? "",
      resolved: "rest",
    });
  }
  return resolved.mode;
}

/**
 * 6. Execute NLQ Command (Natural Language Database Query Engine)
 */
export class ExecuteNlqCommand implements IMcpToolCommand<{ query: string; mode?: unknown }> {
  readonly name = "execute_nlq";
  readonly description = "Submit a natural-language database, market-data, or options-strategy query as an asynchronous job.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language query (e.g. 'List all tables and schema', 'Show referral categories')" },
      mode: { type: "string", description: "NLQ port contract for this call: 'rest' (full-function execution, default) or 'mcp' (this surface's legacy execution). Run-level override of the NLQ_MODE switch; see src/config/nlqModes.ts." },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string().min(1).describe("Natural language query to execute over SQLite database"),
    mode: z.string().optional().describe("NLQ port contract for this call: 'rest' or 'mcp'"),
  });

  async execute(input: { query: string; mode?: unknown }, context: McpToolContext) {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query is required");

    // #1722: "mcp" preserves this surface's own legacy execution
    // verbatim (facade path: planNLQ + executeNLQQueryAsync via the
    // facade, no validation patch; direct path: the full function
    // with no options). "rest" runs the full function everywhere —
    // for the facade path that RESTORES the LLM validation +
    // planSource patch the legacy facade path skipped; MCP contexts
    // bind no ports, so rest still carries no ports/stores/runners
    // here (the REST route and async job bind theirs). Identity is
    // not switched: userLogin stays sessionId in both modes.
    const mode = resolveNlqCommandMode(context, input.mode);
    if (mode === "mcp" && context.facade) {
      return context.facade.executeNlq(query);
    }

    const { plan, result } = await executeNaturalLanguageQuery(
      context.orm,
      context.sessionId,
      query,
      context.env,
      context.sessionId,
    );
    context.audit("nlq.executed", "nlq", { query, domain: result.domain, operation: plan.operation, count: result.count });
    return result;
  }
}

export class GetAsyncJobCommand implements IMcpToolCommand<{ jobId: string }> {
  readonly name = "get_async_job";
  readonly description = "Get status and completed result for an asynchronous platform job by its job ID.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { jobId: { type: "string", description: "Async job ID returned when work was submitted" } },
    required: ["jobId"],
  };
  readonly zodSchema = z.object({ jobId: z.string().uuid() });

  async execute(input: { jobId: string }, context: McpToolContext) {
    if (!context.getJob) throw new Error("Async job status is unavailable in this MCP context.");
    const job = context.getJob(input.jobId);
    if (!job) throw new Error("Async job not found.");
    return job;
  }
}

export class ListAsyncJobsCommand implements IMcpToolCommand<{ envelope?: string }> {
  readonly name = "list_async_jobs";
  readonly description = "List recent asynchronous jobs and their status for this session.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      envelope: { type: "string", description: "Optional JOB_LIST_ENVELOPE run override: \"count\" ({count, jobs}, default) or \"nocount\" ({jobs})" },
    },
  };
  // NOTE: z.string(), not z.enum(), deliberately (the #1723 `mode`
  // precedent): an unrecognized value must reach the resolver so it
  // fails closed WITH a jobs.config_error audit, not die in schema
  // validation with no audit trail.
  readonly zodSchema = z.object({
    envelope: z.string().optional().describe("JOB_LIST_ENVELOPE run override"),
  });

  async execute(input: { envelope?: string }, context: McpToolContext) {
    if (!context.listJobs) throw new Error("Async job listing is unavailable in this MCP context.");
    const jobs = context.listJobs();
    // #1724: run-level JOB_LIST_ENVELOPE (the per-call `envelope`
    // input); unset = MCP legacy ("count"). The rows themselves are
    // result-stripped by the route context, unchanged in both modes.
    const mode = resolveJobListEnvelopeForTool(context, input.envelope, "count");
    return applyJobListEnvelope(jobs, mode);
  }
}

/**
 * 7. List Database Tables Command
 */
export class ListDatabaseTablesCommand implements IMcpToolCommand<{}> {
  readonly name = "list_database_tables";
  readonly description = "Introspect relational SQLite database schema, table definitions, row counts, and column metadata via DatabaseORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const tables = context.orm.listTables();
    return { count: tables.length, tables };
  }
}

/**
 * 8. Query Table Data Command
 */
export class QueryTableDataCommand implements IMcpToolCommand<{
  tableName: string;
  search?: string;
  limit?: number;
  offset?: number;
}> {
  readonly name = "query_table_data";
  readonly description = "Query rows from any SQLite table (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_messages, mas_memory, mas_events) with optional filtering and pagination via ORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      tableName: { type: "string", description: "Table name to query (e.g. mas_categories)" },
      search: { type: "string", description: "Optional search keyword to filter text fields" },
      limit: { type: "number", description: "Maximum records to return (default: 50)" },
      offset: { type: "number", description: "Offset for pagination (default: 0)" },
    },
    required: ["tableName"],
  };
  readonly zodSchema = z.object({
    tableName: z.string().min(1).describe("Table name to query (e.g. mas_categories)"),
    search: z.string().optional().describe("Optional search keyword"),
    limit: z.number().optional().default(50).describe("Maximum records to return"),
    offset: z.number().optional().default(0).describe("Offset for pagination"),
  });

  async execute(input: { tableName: string; search?: string; limit?: number; offset?: number }, context: McpToolContext) {
    const result = context.orm.getTableData(input.tableName, {
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    });
    return result;
  }
}

/**
 * 9. Manage Categories Command
 * #1721: value contract switched by CATEGORIES_MODE (default route).
 * Audit parity: this command audits category.created/updated/deleted
 * in BOTH modes (pre-#1721 it audited nothing). New additive inputs:
 * `mode` (per-call run override), `slug` and `isActive` (needed for
 * route-mode create/update fidelity; ignored in mcp mode, where the
 * legacy contract never took them).
 */
export class ManageCategoriesCommand implements IMcpToolCommand<{
  action: "list" | "create" | "update" | "delete";
  id?: string;
  name?: string;
  slug?: string;
  icon?: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
  mode?: string;
}> {
  readonly name = "manage_categories";
  readonly description = "Full CRUD management for referral categories taxonomy in mas_categories via DatabaseORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "update", "delete"], description: "Category operation" },
      id: { type: "string", description: "Category ID (required for update/delete)" },
      name: { type: "string", description: "Category name (required for create)" },
      slug: { type: "string", description: "Category slug (route mode only; ignored in mcp mode)" },
      icon: { type: "string", description: "Emoji or icon for category" },
      description: { type: "string", description: "Category description" },
      sortOrder: { type: "number", description: "Sort priority order" },
      isActive: { type: "boolean", description: "Whether the category is active (route mode only; mcp mode forces true on create and never touches it on update)" },
      mode: { type: "string", description: "Per-call contract variant: route (default) or mcp" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "create", "update", "delete"]).describe("Category operation"),
    id: z.string().optional().describe("Category ID"),
    name: z.string().optional().describe("Category name"),
    slug: z.string().optional().describe("Category slug"),
    icon: z.string().optional().describe("Category icon"),
    description: z.string().optional().describe("Category description"),
    sortOrder: z.number().optional().describe("Sort priority order"),
    isActive: z.boolean().optional().describe("Whether the category is active"),
    mode: z.string().optional().describe("Per-call contract variant"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;
    const mode = resolveCommandMode(context, "categories", input.mode);
    // #2345: categories live behind the marketplace ports
    // (D1 when AGENT_DB is bound, the instance's own table
    // when not) — the facade's sync repository is no longer
    // the serving path for this table.
    const categoriesRepo = (await context.orm.marketplacePorts(context.env)).categories;

    if (action === "list") {
      const categories = await categoriesRepo.findMany(categoryListOptions());
      return { count: categories.length, categories };
    }

    if (action === "create") {
      const name = String(input.name || "").trim();
      if (!name) throw new Error("Category name is required for create");
      const slug = categoryCreateSlug(name, input.slug, mode);
      const id = categoryCreateId(slug, name, input.id, mode);
      const values = categoryCreateValues(name, input, mode, await categoriesRepo.count());
      const now = new Date().toISOString();
      const category = await categoriesRepo.create({
        id,
        name,
        slug,
        ...values,
        createdAt: now,
        updatedAt: now,
      });
      context.audit("category.created", "orchestrator", { id, name });
      return { success: true, created: true, category };
    }

    if (action === "update") {
      if (!input.id) throw new Error("Category id is required for update");
      const existing = await categoriesRepo.findById(input.id);
      if (mode === "route" && !existing) throw new Error(`Category ${input.id} not found`);
      const patch = existing
        ? categoryUpdatePatch(existing, input, mode)
        : categoryUpdatePatch(
            { name: "", slug: "", description: "", icon: "", isActive: true, sortOrder: 0 },
            input,
            mode
          );
      const updated = await categoriesRepo.update(input.id, {
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      if (updated) {
        context.audit("category.updated", "orchestrator", { id: input.id, name: updated.name });
      }
      return { success: true, updated: true, category: updated };
    }

    if (action === "delete") {
      // #1721: route mode is silent-success without an id (the route's
      // {success: true}); mcp mode keeps the legacy throw.
      if (!input.id) {
        if (mode === "route") return { success: true };
        throw new Error("Category id is required for delete");
      }
      const deleted = await categoriesRepo.delete(input.id);
      context.audit("category.deleted", "orchestrator", { id: input.id });
      return { success: true, deleted, id: input.id };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 10. Manage Referrals Command
 * #1721: value contract switched by REFERRALS_MODE (default route).
 * Audit parity: create/delete audit in BOTH modes (pre-#1721 this
 * command audited nothing); click audits on neither surface, in
 * either mode, as before. No update action exists on either surface
 * and this slice adds none. New additive input: `mode` (per-call
 * run override).
 */
export class ManageReferralsCommand implements IMcpToolCommand<{
  action: "list" | "create" | "track_click" | "delete";
  id?: string;
  title?: string;
  url?: string;
  category?: string;
  rewardText?: string;
  mode?: string;
}> {
  readonly name = "manage_referrals";
  readonly description = "Manage developer referral links and track click attribution in mas_referrals via DatabaseORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "track_click", "delete"], description: "Referrals operation" },
      id: { type: "string", description: "Referral ID (for track_click/delete)" },
      title: { type: "string", description: "Service or tool title" },
      url: { type: "string", description: "Destination referral URL" },
      category: { type: "string", description: "Associated category name" },
      rewardText: { type: "string", description: "Reward bonus offer text" },
      mode: { type: "string", description: "Per-call contract variant: route (default) or mcp" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "create", "track_click", "delete"]).describe("Referrals operation"),
    id: z.string().optional().describe("Referral ID"),
    title: z.string().optional().describe("Service or tool title"),
    url: z.string().optional().describe("Destination referral URL"),
    category: z.string().optional().describe("Associated category name"),
    rewardText: z.string().optional().describe("Reward bonus offer text"),
    mode: z.string().optional().describe("Per-call contract variant"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;
    const mode = resolveCommandMode(context, "referrals", input.mode);
    // #2345: referrals live behind the marketplace ports.
    const referralsRepo = (await context.orm.marketplacePorts(context.env)).referrals;

    if (action === "list") {
      const options = referralListOptions(mode);
      const referrals = await referralsRepo.findMany(options);
      return { count: referrals.length, referrals };
    }

    if (action === "create") {
      const title = String(input.title || "").trim();
      const url = String(input.url || "").trim();
      if (!title || !url) throw new Error("title and url are required for referral creation");

      const defaults = referralCreateValues(input, mode);
      const referral = await referralsRepo.create({
        id: `ref_${crypto.randomUUID().slice(0, 8)}`,
        userLogin: context.sessionId,
        title,
        url,
        ...defaults,
        clicks: 0,
        signups: 0,
        createdAt: new Date().toISOString(),
      });
      context.audit("referral.created", "orchestrator", { id: referral.id, title, targetUrl: url });
      return { success: true, created: true, referral };
    }

    if (action === "track_click") {
      // #1721: route mode is silent-success (the route's {success:
      // true} even with no id or a nonexistent id); mcp mode keeps
      // the legacy throw + new-count return.
      if (!input.id) {
        if (mode === "route") return { success: true };
        throw new Error("Referral id is required for track_click");
      }
      const current = await referralsRepo.findById(input.id);
      if (!current) {
        if (mode === "route") return { success: true };
        throw new Error(`Referral ${input.id} not found`);
      }
      const updated = await referralsRepo.update(input.id, { clicks: (current.clicks || 0) + 1 });
      if (mode === "route") return { success: true };
      return { success: true, clicks: updated?.clicks || 1 };
    }

    if (action === "delete") {
      if (!input.id) {
        if (mode === "route") return { success: true };
        throw new Error("Referral id is required for delete");
      }
      const deleted = await referralsRepo.delete(input.id);
      context.audit("referral.deleted", "orchestrator", { id: input.id });
      return { success: true, deleted, id: input.id };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 11. Manage External Ads Command
 * #1721: value contract switched by EXTERNAL_ADS_MODE (default route:
 * cpm 15.0 / cpc 1.25, initial impression, 3dp/2dp rounding). Audit
 * parity: create/update/click audit in BOTH modes (pre-#1721 this
 * command audited nothing); impression audits on neither surface, in
 * either mode, as before. New action: `update` — it works in route
 * mode (the route field set) and throws `Unsupported action: update`
 * in mcp mode, preserving the legacy MCP contract verbatim. New
 * additive inputs: `mode` (per-call run override), `name` and
 * `isActive` (route-mode update only).
 */
export class ManageExternalAdsCommand implements IMcpToolCommand<{
  action: "list" | "create" | "update" | "impression" | "click";
  id?: string;
  title?: string;
  name?: string;
  network?: "ethicalads" | "carbon" | "adsense" | "direct" | "google";
  placement?: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  tagline?: string;
  targetUrl?: string;
  ctaText?: string;
  cpmRate?: number;
  cpcRate?: number;
  isActive?: boolean;
  mode?: string;
}> {
  readonly name = "manage_external_ads";
  readonly description = "Manage external ad placements (EthicalAds, Carbon Ads, AdSense, Direct) and record CPM/CPC revenue monetization.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "update", "impression", "click"], description: "Ad operation" },
      id: { type: "string", description: "Ad placement ID (required for update/impression/click)" },
      title: { type: "string", description: "Campaign title" },
      name: { type: "string", description: "Placement name (route-mode update only)" },
      network: { type: "string", enum: ["ethicalads", "carbon", "adsense", "direct", "google"], description: "Ad network partner" },
      placement: { type: "string", enum: ["header_leaderboard", "in_stream", "footer_deck", "sidebar"], description: "Placement slot" },
      tagline: { type: "string", description: "Promotional copy" },
      targetUrl: { type: "string", description: "Destination URL" },
      ctaText: { type: "string", description: "Button text" },
      cpmRate: { type: "number", description: "CPM rate ($/1,000 impressions)" },
      cpcRate: { type: "number", description: "CPC rate ($/click)" },
      isActive: { type: "boolean", description: "Whether the ad is active (route-mode update only)" },
      mode: { type: "string", description: "Per-call contract variant: route (default) or mcp" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "create", "update", "impression", "click"]).describe("Ad operation"),
    id: z.string().optional().describe("Ad placement ID"),
    title: z.string().optional().describe("Campaign title"),
    name: z.string().optional().describe("Placement name"),
    network: z.enum(["ethicalads", "carbon", "adsense", "direct", "google"]).optional().describe("Ad network partner"),
    placement: z.enum(["header_leaderboard", "in_stream", "footer_deck", "sidebar"]).optional().describe("Placement slot"),
    tagline: z.string().optional().describe("Promotional copy"),
    targetUrl: z.string().optional().describe("Destination URL"),
    ctaText: z.string().optional().describe("Button text"),
    cpmRate: z.number().optional().describe("CPM rate"),
    cpcRate: z.number().optional().describe("CPC rate"),
    isActive: z.boolean().optional().describe("Whether the ad is active"),
    mode: z.string().optional().describe("Per-call contract variant"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;
    const mode = resolveCommandMode(context, "externalAds", input.mode);
    // #2345: external ads live behind the marketplace ports.
    const externalAdsRepo = (await context.orm.marketplacePorts(context.env)).externalAds;

    if (action === "list") {
      const ads = await externalAdsRepo.findMany(externalAdListOptions(mode));
      return { count: ads.length, ads };
    }

    if (action === "create") {
      const title = String(input.title || "").trim();
      const targetUrl = String(input.targetUrl || "").trim();
      if (!title || !targetUrl) throw new Error("title and targetUrl are required for external ad creation");

      const values = externalAdCreateValues(title, input, mode);
      const ad = await externalAdsRepo.create({
        id: externalAdCreateId(input.network, mode),
        title,
        targetUrl,
        ...values,
        createdAt: new Date().toISOString(),
      });
      context.audit("external_ad.created", "orchestrator", { id: ad.id, title });
      return { success: true, created: true, ad };
    }

    if (action === "update") {
      // #1721: legacy MCP had no update action — mcp mode keeps the
      // verbatim throw; route mode applies the route field set.
      if (mode === "mcp") throw new Error("Unsupported action: update");
      if (!input.id) throw new Error("Ad id is required for update");
      const existing = await externalAdsRepo.findById(input.id);
      if (!existing) throw new Error(`Ad ${input.id} not found`);
      const updated = await externalAdsRepo.update(input.id, externalAdUpdatePatch(existing, input));
      if (updated) {
        context.audit("external_ad.updated", "orchestrator", { id: updated.id, title: updated.title });
      }
      return { success: true, updated: true, ad: updated };
    }

    if (action === "impression") {
      // #1721: route mode returns {success: false} for a missing id
      // or a missing ad (the route's silent shape); mcp mode throws.
      if (!input.id) {
        if (mode === "route") return { success: false };
        throw new Error("Ad id is required for impression recording");
      }
      const ad = await externalAdsRepo.findById(input.id);
      if (!ad) {
        if (mode === "route") return { success: false };
        throw new Error(`Ad ${input.id} not found`);
      }
      const newImp = (ad.impressions || 0) + 1;
      const updated = await externalAdsRepo.update(input.id, {
        impressions: newImp,
        earnings: externalAdImpressionEarnings(ad.earnings || 0, ad.cpmRate, mode),
      });
      return { success: true, impressions: updated?.impressions, earnings: updated?.earnings };
    }

    if (action === "click") {
      if (!input.id) {
        if (mode === "route") return { success: false };
        throw new Error("Ad id is required for click recording");
      }
      const ad = await externalAdsRepo.findById(input.id);
      if (!ad) {
        if (mode === "route") return { success: false };
        throw new Error(`Ad ${input.id} not found`);
      }
      const newClicks = (ad.clicks || 0) + 1;
      const updated = await externalAdsRepo.update(input.id, {
        clicks: newClicks,
        earnings: externalAdClickEarnings(ad.earnings || 0, ad.cpcRate, mode),
      });
      if (updated) {
        context.audit("external_ad.clicked", "orchestrator", { id: input.id, clicks: updated.clicks, earnings: updated.earnings });
      }
      return { success: true, clicks: updated?.clicks, earnings: updated?.earnings };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 12. Get Revenue Summary Command (GRASP Information Expert)
 */
export class GetRevenueSummaryCommand implements IMcpToolCommand<{}> {
  readonly name = "get_revenue_summary";
  readonly description = "Compute platform financial analytics across ad networks (CPM/CPC), marketplace direct ads, payment transaction fees, referral payouts, and net profit.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    // #2345: the summary computes over the marketplace ports
    // (fleet counters when D1-bound) + the DO-resident ledger.
    const mp = await context.orm.marketplacePorts(context.env);
    return computeMarketplaceRevenueSummary(mp, context.orm.transactions);
  }
}

/**
 * 13. Manage Session Memory Command
 */
export class ManageSessionMemoryCommand implements IMcpToolCommand<{
  action: "list" | "remember" | "delete" | "clear";
  key?: string;
  value?: string;
  mode?: string;
}> {
  readonly name = "manage_session_memory";
  readonly description = "Read, persist, or clear persistent grounding session facts stored in mas_memory SQLite key-value store.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "remember", "delete", "clear"], description: "Memory action" },
      key: { type: "string", description: "Memory key (e.g. preferred_gateway)" },
      value: { type: "string", description: "Memory value fact to store" },
      // #1723: run-level MEMORY_READ_MODE ("capped" | "uncapped"),
      // honored ONLY for action:"list" (read cap). Unset = MCP legacy
      // ("uncapped"). Remember/delete/clear are never gated by it.
      mode: { type: "string", description: "Optional MEMORY_READ_MODE run override for list only: capped (first 100) or uncapped (all, default)" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "remember", "delete", "clear"]).describe("Memory action"),
    key: z.string().optional().describe("Memory key"),
    value: z.string().optional().describe("Memory value fact"),
    mode: z.string().optional().describe("MEMORY_READ_MODE run override, list only"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;

    if (action === "list") {
      // #1723: the switch covers the read cap only. MCP legacy is
      // "uncapped"; an explicit run/session/user/env level may cap.
      const mode = resolveMemoryReadForList(context, input.mode, "uncapped");
      const memories = applyMemoryReadCap(
        context.orm.memory.findMany({ orderBy: "updated_at DESC" }),
        mode
      );
      return { count: memories.length, memories };
    }

    if (action === "remember") {
      const key = String(input.key || "").trim();
      const value = String(input.value || "").trim();
      if (!key || !value) throw new Error("key and value are required to remember fact");
      const now = new Date().toISOString();
      const existing = context.orm.memory.findById(key);
      let record;
      if (existing) {
        record = context.orm.memory.update(key, { value, updatedAt: now });
      } else {
        record = context.orm.memory.create({ key, value, updatedAt: now });
      }
      context.audit("memory.remembered", "memory", { key, value });
      return { success: true, stored: true, key, value, memory: record };
    }

    if (action === "delete") {
      if (!input.key) throw new Error("key is required to delete memory fact");
      const key = input.key.trim();
      const deleted = context.orm.memory.delete(key);
      return { success: true, deleted, key };
    }

    if (action === "clear") {
      // #2345: the whole-table delete is the memory port's
      // clear() now — the (orm as any).sql bypass is retired.
      context.orm.memory.clear();
      return { success: true, cleared: true };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 14. Get Audit Events Command
 *
 * #1968: filters are pushed INTO the query — the pre-fix version fetched
 * the newest `limit` events overall and left every filter to the caller,
 * so high-volume event types (async_job.*) crowded out older matching
 * events before any filter could see them (LIMIT-before-FILTER). The
 * equality filters (session, type, agent) go into the ORM where-clause;
 * the time bounds go through a bounded in-memory pass because the ORM
 * where-clause supports equality only — the fetch window is widened to
 * 1000 rows when a time filter is present so in-window rows are not
 * crowded out by newer out-of-window rows, and the limit is applied
 * AFTER all filters. Invalid time bounds are ignored (the bound is a
 * narrowing aid, not a security boundary); before/after are exclusive.
 */
export class GetAuditEventsCommand implements IMcpToolCommand<{ limit?: number; type?: string; agent?: string; before?: string; after?: string }> {
  readonly name = "get_audit_events";
  readonly description = "Query real-time observability events stream (routing decisions, judge evaluations, payment lifecycle, errors) from mas_events.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Maximum events to return (default: 50)" },
      type: { type: "string", description: "Exact event type to match (e.g. etrade.auth_blocked)" },
      agent: { type: "string", description: "Exact agent to match" },
      before: { type: "string", description: "Exclusive upper bound: only events created before this ISO timestamp" },
      after: { type: "string", description: "Exclusive lower bound: only events created after this ISO timestamp" },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().optional().default(50).describe("Maximum events to return"),
    type: z.string().optional().describe("Exact event type to match"),
    agent: z.string().optional().describe("Exact agent to match"),
    before: z.string().optional().describe("Exclusive upper bound (ISO timestamp)"),
    after: z.string().optional().describe("Exclusive lower bound (ISO timestamp)"),
  });

  async execute(input: { limit?: number; type?: string; agent?: string; before?: string; after?: string }, context: McpToolContext) {
    const limit = Number(input.limit) || 50;
    const where: Record<string, unknown> = {};
    // The REST route always carries the caller's session; a direct MCP
    // call without one keeps the previous unscoped behavior.
    if (context.sessionId) where.sessionId = context.sessionId;
    if (input.type) where.type = input.type;
    if (input.agent) where.agent = input.agent;
    const hasTimeFilter = Boolean(input.before || input.after);
    const scanLimit = hasTimeFilter ? 1000 : limit;
    let events = context.orm.events.findMany({
      where,
      orderBy: "created_at DESC",
      limit: scanLimit,
    });
    if (hasTimeFilter) {
      const beforeMs = input.before ? Date.parse(input.before) : NaN;
      const afterMs = input.after ? Date.parse(input.after) : NaN;
      events = events.filter((e) => {
        const ms = Date.parse(e.createdAt);
        if (Number.isNaN(ms)) return true;
        if (!Number.isNaN(beforeMs) && ms >= beforeMs) return false;
        if (!Number.isNaN(afterMs) && ms <= afterMs) return false;
        return true;
      });
    }
    const sliced = events.slice(0, limit);
    return { count: sliced.length, events: sliced };
  }
}

/**
 * GoF Factory Pattern & GRASP Creator: McpToolFactory
 * Central registry and instantiation factory for all platform MCP commands.
 */
export class McpToolFactory {
  private static tools: Map<string, IMcpToolCommand> = new Map();

  /** #1744: default gate port (production policy) when the caller supplies none. */
  private static defaultPermissionPort = createProductionMcpPermissionPort();

  static {
    // Register platform, async-job, and domain capability commands.
    this.registerTool(new KnowledgeSearchCommand());
    this.registerTool(new QueryPlatformKnowledgeCommand());
    this.registerTool(new DraftPaymentCommand());
    this.registerTool(new ConfirmPaymentDraftCommand());
    this.registerTool(new GetPaymentGatewaysCommand());
    this.registerTool(new GetTransactionsCommand());
    this.registerTool(new ExecuteNlqCommand());
    this.registerTool(new GetAsyncJobCommand());
    this.registerTool(new ListAsyncJobsCommand());
    this.registerTool(new ListDatabaseTablesCommand());
    this.registerTool(new QueryTableDataCommand());
    this.registerTool(new ManageCategoriesCommand());
    this.registerTool(new ManageReferralsCommand());
    this.registerTool(new ManageExternalAdsCommand());
    this.registerTool(new GetRevenueSummaryCommand());
    this.registerTool(new ManageSessionMemoryCommand());
    this.registerTool(new GetAuditEventsCommand());

    // E*TRADE Trading & Screening Commands
    this.registerTool(new ETradeMarketScanCommand());
    this.registerTool(new ETradeGetQuoteCommand());
    this.registerTool(new ETradePreviewOrderCommand());
    this.registerTool(new ETradeExecuteOrderCommand());
    this.registerTool(new ETradeGetPositionsCommand());
    this.registerTool(new ETradeAuthStatusCommand());
    this.registerTool(new ETradeAccountDiscoveryCommand());

    // Market Data Research & Quoting Commands (yfinance & Alpaca)
    this.registerTool(new MarketDataGetQuoteCommand());
    this.registerTool(new MarketDataFundamentalsCommand());
    this.registerTool(new MarketDataHistoricalBarsCommand());
    this.registerTool(new MarketDataResearchCommand());
    this.registerTool(new AlpacaSnapshotCommand());
    this.registerTool(new AlpacaAccountCommand());
    this.registerTool(new AlpacaPositionsCommand());
    this.registerTool(new AlpacaOrdersCommand());
    this.registerTool(new AlpacaPlaceOrderCommand());

    // #1906: deprecated aliases for the renamed market-data tools above.
    // Same commands, legacy names; use canonical tool names instead.
    // Removal is a follow-up slice.
    this.registerTool(new DeprecatedToolAlias("foss_get_quote", new MarketDataGetQuoteCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_company_fundamentals", new MarketDataFundamentalsCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_historical_bars", new MarketDataHistoricalBarsCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_market_research", new MarketDataResearchCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_alpaca_snapshot", new AlpacaSnapshotCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_alpaca_account", new AlpacaAccountCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_alpaca_positions", new AlpacaPositionsCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_alpaca_orders", new AlpacaOrdersCommand()));
    this.registerTool(new DeprecatedToolAlias("foss_alpaca_place_order", new AlpacaPlaceOrderCommand()));

    // Cloudflare Agentic Payments (x402 & MPP paidTool patterns)
    this.registerTool(new PaidOptionsScreenerCommand());
    this.registerTool(new PaidMarketResearchCommand());
    this.registerTool(new AgenticWalletStatusCommand());

    // Cloudflare Agents Advanced Capabilities (Browser, Webhooks, Sandbox, Think, AI Search, Fibers)
    this.registerTool(new BrowserInspectCommand());
    this.registerTool(new BrowserScreenshotCommand());
    this.registerTool(new DispatchTradingWebhookCommand());
    this.registerTool(new SandboxRunCommand());
    this.registerTool(new QuantBacktestCommand());
    this.registerTool(new ThinkTradeValidationCommand());
    this.registerTool(new AISearchFinancialDocsCommand());
    this.registerTool(new AISearchAgentSearchCommand());
    this.registerTool(new DurableTWAPOrderCommand());

    // Agentic goal/chain tools (#1362 Phase 5, #1466): compiled from
    // the SAME registry + compiler + synthesis definitions the
    // planner uses. No existing tool is modified or duplicated here.
    this.registerTool(new GoalCompileCommand());
    this.registerTool(new GoalScheduleCommand());
    this.registerTool(new ChainRunCommand());

    // AgentDB projection reads (#1546 slice 4, #1697): read-only
    // tools over the slices 1–3 projections. Registered here so
    // they appear in tools/list and — through SDK discovery
    // (#2496) — in the chat turn automatically; they ride the
    // same /mcp auth path as every other tool in the factory.
    this.registerTool(new AgentDbChainStatusCommand());
    this.registerTool(new AgentDbJobsHistoryCommand());
    this.registerTool(new AgentDbAuditHistoryCommand());
    this.registerTool(new AgentDbReportsListCommand());
    // Agent Mesh S17 (#2428, G13a): the unified-trace read
    // surface, in this same AgentDB-read family (see
    // agentDbReadCommands.ts header).
    this.registerTool(new AgentDbTraceGetCommand());

    // Agent Mesh G1 doors (#2341, S5 batch A): the chat turn reaches
    // ScheduledAgent and PaymentsAgent through typed doors
    // (src/agents/orchestrator/meshDoors.ts). The commands require
    // the tool context's actingLogin carrier — the identified chat
    // turn — and fail closed without it; scopes are declared in
    // MCP_TOOL_SCOPES like every other tool (#1744).
    this.registerTool(new ListScheduledGoalsCommand());
    this.registerTool(new TriggerScheduledGoalCommand());
    this.registerTool(new CheckPaymentBudgetCommand());
    this.registerTool(new GetPaymentsOverviewCommand());

    // Agent Mesh G1 doors (#2349, S6 batch B): the chat turn reaches
    // TradingAgent (proposals + reads) and ReportAssetAgent
    // (list/get) through the same typed doors. Same identity
    // discipline as batch A; no command reaches TradingAgent's
    // approval door — execution stays behind it until S9/G4.
    this.registerTool(new ProposeStockTradeCommand());
    this.registerTool(new ProposeOptionsTradeCommand());
    this.registerTool(new GetTradingAccountsCommand());
    this.registerTool(new GetTradingPositionsCommand());
    this.registerTool(new GetTradingQuoteCommand());
    this.registerTool(new ListReportAssetsCommand());
    this.registerTool(new GetReportAssetCommand());

    // Agent Mesh S9/G4 (#2375, batch D): the chat turn crosses the
    // TradingAgent approval-door boundary — through the door, not
    // around it. A proposal is submitted to the approval door
    // (start_trade_approval: the durable TradingTradeWorkflow run
    // starts and waits), the human's decision is delivered through
    // the door (decide_trade_approval: authorizer derived
    // server-side, never an argument), and the run's status reads
    // from the workflow binding (get_trade_approval_status). The
    // synchronous settle still has no command.
    this.registerTool(new StartTradeApprovalCommand());
    this.registerTool(new DecideTradeApprovalCommand());
    this.registerTool(new GetTradeApprovalStatusCommand());

    // Agent Mesh G1 doors (#2351, S7 batch C): the chat turn reaches
    // BrowserAgent (snap/capture/scrape) and SlackAgent (approval
    // ticket + transaction snap) through the same typed doors. Same
    // identity discipline as batches A/B; no command accepts a
    // webhookUrl — delivery targets are env configuration only.
    this.registerTool(new BrowserSnapTransactionCommand());
    this.registerTool(new BrowserCapturePageCommand());
    this.registerTool(new BrowserScrapeTablesCommand());
    this.registerTool(new SlackSendPreTradeApprovalCommand());
    this.registerTool(new SlackDispatchTransactionSnapCommand());

    // Agent Mesh #2488 (the NLQ-independent mesh): the chat
    // turn's universe stock screen as a mesh door command over
    // the door layer's own screen execution service
    // (src/agents/orchestrator/meshScreenDoor.ts) — the path
    // the prompt steers universe screens to, with execute_nlq
    // flagged off in the turn (CHAT_NLQ_MODE). Same identity
    // discipline as batches A–D; the door has no
    // direct-ScreenerAgent fallback.
    this.registerTool(new RunStockScreenCommand());
  }

  /**
   * Registers an IMcpToolCommand.
   * Demonstrates the Open/Closed Principle (OCP): New tools register without modifying the factory internals.
   * #1744: a dynamically registered tool must declare its scope
   * (second argument) or the gate denies it — the static table
   * covers only the boot-time registry. A scope for a statically
   * declared tool is rejected by declareToolScope, so runtime
   * registration can never weaken a static tool's scope.
   */
  static registerTool(command: IMcpToolCommand, scope?: McpScope): void {
    if (scope !== undefined) declareToolScope(command.name, scope);
    this.tools.set(command.name, command);
  }

  static getTool(name: string): IMcpToolCommand | undefined {
    return this.tools.get(name);
  }

  static getAllTools(): IMcpToolCommand[] {
    return Array.from(this.tools.values());
  }

  static getToolDefinitions(): Array<{ name: string; description: string; inputSchema: any }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }));
  }

  static async executeTool(name: string, input: any, context: McpToolContext): Promise<any> {
    const command = this.tools.get(name);
    if (!command) {
      throw new Error(`MCP Tool '${name}' is not registered`);
    }
    // #1744: permission gate. Lookup precedes the gate, so unknown
    // tools keep the pre-existing not-registered error (pinned by
    // tests/rest_mcp_commands_p1644.test.ts). Principal defaults to
    // system for in-process platform callers (REST bridge, job
    // executor) whose route layer already authenticated; the /mcp
    // boundary and agent turns always set an explicit principal.
    const port = context.permissionPort ?? McpToolFactory.defaultPermissionPort;
    const principal = context.principal ?? { kind: "system" as const, login: null };
    return executeWithPermissionGate({
      port,
      principal,
      toolName: name,
      sessionId: context.sessionId,
      audit: context.audit,
      decisionSink: context.permissionDecisionSink,
      run: (executionId) => command.execute(input, { ...context, executionId }),
    });
  }
}
