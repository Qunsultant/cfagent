/**
 * MCP Tool Commands for Cloudflare Agents Advanced Capabilities
 *
 * Implements:
 * - browser_inspect_page & browser_screenshot (Browser Agent)
 * - dispatch_trading_webhook (Trading Webhooks)
 * - run_sandbox_command & run_quant_backtest (Sandbox Container)
 * - think_trade_validation (Think Harness)
 * - ai_search_financial_docs (AI Search)
 * - execute_durable_twap (Durable Fibers — TWAP preview planning; places no orders)
 * - ai_search_agent_search (AiSearchAgent door — the instance through the agent, #2250)
 */

import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { z } from "zod";
import {
  ETRADE_PREVIEW_MODE_SWITCH,
  etradeConfigErrorEvent,
  levelsForEtradeSwitch,
  resolveEtradePreviewMode,
} from "../../config/etradeModes";
import { ETradeBrowserService } from "../../services/browserAgent";
import { ETradeWebhookService } from "../../services/tradingWebhooks";
import { ETradeSandboxService } from "../../services/sandboxAgent";
import type {
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from "../../types";
import { ETradeThinkHarness } from "../../services/thinkHarness";
import { ETradeDurableFiberService } from "../../services/durableFibers";
import { ETradeService } from "../../services/etrade";
import { aiSearchAgentResultToQueryResponse } from "../../agents/aiSearchPaths";
import type {
  AiSearchAgentErrorToken,
  AiSearchAgentResultItem,
  AiSearchAgentSearchOptions,
  AiSearchAgentSearchResult,
  AiSearchPath,
} from "../../agents/aiSearchPaths";
import { AgentErrorCode } from "../../aspects/errorCodes";

/**
 * 1. Browser Inspect Page Command
 */
export class BrowserInspectCommand implements IMcpToolCommand<{ url: string; selector?: string }> {
  readonly name = "browser_inspect_page";
  readonly description = "Inspect rendered web page or financial portal using Cloudflare Browser Agent";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "URL to inspect" },
      selector: { type: "string", description: "Optional CSS selector to target" },
    },
    required: ["url"],
  };
  readonly zodSchema = z.object({
    url: z.string(),
    selector: z.string().optional(),
  });

  async execute(input: { url: string; selector?: string }, context: McpToolContext) {
    const browser = new ETradeBrowserService(context.env);
    const result = await browser.inspectPage({ url: input.url, selector: input.selector });
    context.audit("browser.inspect", "browser", { url: input.url, success: result.success });
    return result;
  }
}

/**
 * 2. Browser Screenshot Command
 */
export class BrowserScreenshotCommand implements IMcpToolCommand<{ url: string }> {
  readonly name = "browser_screenshot";
  readonly description = "Capture screenshot of financial charts or brokerage confirmations using Cloudflare Browser Agent. The result's screenshotKind field states the truth: \"capture\" means a real browser capture; \"placeholder\" means Browser Rendering was unavailable and the image is a labelled placeholder illustration with no page content — never present a placeholder as a screenshot of the page.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "URL of the page/chart to screenshot" },
    },
    required: ["url"],
  };
  readonly zodSchema = z.object({ url: z.string() });

  async execute(input: { url: string }, context: McpToolContext) {
    const browser = new ETradeBrowserService(context.env);
    const result = await browser.captureScreenshot(input.url);
    context.audit("browser.screenshot", "browser", { url: input.url, success: result.success, screenshotKind: result.screenshotKind });
    return result;
  }
}

/**
 * 3. Dispatch Trading Webhook Command
 */
export class DispatchTradingWebhookCommand implements IMcpToolCommand<{
  eventType: string;
  data: Record<string, any>;
  targetUrl?: string;
}> {
  readonly name = "dispatch_trading_webhook";
  readonly description = "Dispatch HMAC-SHA256 signed trading webhook event to subscriber URL. Requires OUTBOUND_WEBHOOK_SECRET to be configured on the server: without a signing secret the webhook is NOT sent and the result is success:false — outbound webhooks are never signed with a default or fallback secret.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      eventType: { type: "string", description: "Event name e.g. order.executed or alert.triggered" },
      data: { type: "object", description: "Payload data dictionary" },
      targetUrl: { type: "string", description: "Optional target webhook URL" },
    },
    required: ["eventType", "data"],
  };
  readonly zodSchema = z.object({
    eventType: z.string(),
    data: z.record(z.string(), z.unknown()),
    targetUrl: z.string().optional(),
  });

  async execute(input: { eventType: string; data: Record<string, any>; targetUrl?: string }, context: McpToolContext) {
    const webhookService = new ETradeWebhookService(context.orm, context.env, context.sessionId);
    const result = await webhookService.dispatchOutboundWebhook(input.eventType, input.data, input.targetUrl);
    context.audit("webhook.dispatch", "webhook", { eventType: input.eventType, success: result.success });
    return result;
  }
}

/**
 * 4. Sandbox Run Command (issue #2732 — the #2253 follow-up,
 * tracker #2708 item A4)
 *
 * The chat/MCP door onto SandboxAgent (#2253): until this slice,
 * this command constructed ETradeSandboxService directly, bypassing
 * the fleet class every other door (A2A, HTTP onRequest) already
 * reaches the capability through — the census recorded SandboxAgent
 * as not-exposed on the chat-turn and mcp doors for exactly that
 * reason. The command now resolves the agent through the
 * SANDBOX_AGENT Durable Object binding on the fixed service
 * instance below and calls its runCommand door (the deterministic
 * RPC door — command execution is exact work, not a judgment turn),
 * following the AISearchAgentSearchCommand seam (#2250). The
 * instance is a SERVICE instance: the agent is stateless
 * sandboxing, the same instance the A2A door addresses (its
 * resolution carries no instance override, so its URL name is the
 * instance name). The caller's login is never the instance name:
 * this door consumes no identity on any surface (input parity with
 * the A2A dispatch and the onRequest /run handler: exactly
 * { command, timeoutMs }).
 *
 * The agent delegates to the ONE sandbox service, constructed with
 * no container backend, so the result today is the service's honest
 * not-executed shape (#121) — served via the class, unchanged. The
 * owner step that lifts the degradation is the containers
 * configuration for the class (tracker #2708 item D7), which now
 * lifts every door at once.
 *
 * The binding is declared in wrangler.jsonc and on the Env type
 * (optional, src/types.ts). Its absence answers honestly in the
 * same result shape — executed:false with a reason naming the
 * unconfigured binding — the tool never throws for configuration
 * and never fabricates output.
 */
const SANDBOX_AGENT_SERVICE_INSTANCE = "sandbox";

/** Structural minimum of the SandboxAgent stub this command calls. */
interface SandboxAgentStubLike {
  runCommand(
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionResult>;
}

export class SandboxRunCommand implements IMcpToolCommand<{ command: string; timeoutMs?: number }> {
  readonly name = "run_sandbox_command";
  readonly description = "Run a shell command in a Cloudflare Linux container sandbox, through the SandboxAgent — the fleet's sandbox agent class: the command resolves the agent on the SANDBOX_AGENT binding and delegates to the one sandbox service the agent wraps. The command executes ONLY when a container backend is bound to the agent; none is bound, so calls currently return executed:false with exitCode:null and an error stating the command was NOT run. Execution is never emulated and output is never fabricated — do not present a result with executed:false as command output.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
    },
    required: ["command"],
  };
  readonly zodSchema = z.object({
    command: z.string(),
    timeoutMs: z.number().optional(),
  });

  async execute(input: { command: string; timeoutMs?: number }, context: McpToolContext) {
    const namespace = context.env?.SANDBOX_AGENT;
    if (
      !namespace ||
      typeof namespace.get !== "function" ||
      typeof namespace.idFromName !== "function"
    ) {
      const startTime = Date.now();
      const result: SandboxExecutionResult = {
        executed: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startTime,
        error:
          "Command NOT executed: the SandboxAgent binding (SANDBOX_AGENT) is not configured in this environment, so the sandbox agent cannot be reached and there is nothing to run the command in. Shell execution is not emulated and no output was produced.",
      };
      context.audit("sandbox.execute", "sandbox", { command: input.command, executed: result.executed, exitCode: result.exitCode });
      return result;
    }
    const stub = namespace.get(
      namespace.idFromName(SANDBOX_AGENT_SERVICE_INSTANCE),
    ) as unknown as SandboxAgentStubLike;
    const result = await stub.runCommand({ command: input.command, timeoutMs: input.timeoutMs });
    context.audit("sandbox.execute", "sandbox", { command: input.command, executed: result.executed, exitCode: result.exitCode });
    return result;
  }
}

/**
 * 5. Quant Backtest Command
 */
export class QuantBacktestCommand implements IMcpToolCommand<{
  symbol: string;
  strategy?: "sma_crossover" | "rsi_reversal" | "mean_reversion" | "breakout";
  startBars?: number;
}> {
  readonly name = "run_quant_backtest";
  readonly description = "Demonstrate a quantitative strategy calculation (Sharpe, Drawdown, Win Rate) over a SYNTHETIC generated price series — this is NOT a backtest over historical market data and says nothing about the real security. Metrics are genuinely and deterministically computed from the generated series (result carries dataSource:\"synthetic\"); a metric that cannot be computed from the run is returned as null, never estimated or randomised.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker symbol label for the synthetic series e.g. NVDA (selects the series' starting price only — no market data is fetched)" },
      strategy: { type: "string", enum: ["sma_crossover", "rsi_reversal", "mean_reversion", "breakout"] },
      startBars: { type: "number", description: "Number of synthetic bars to generate (default: 100)" },
    },
    required: ["symbol"],
  };
  readonly zodSchema = z.object({
    symbol: z.string(),
    strategy: z.enum(["sma_crossover", "rsi_reversal", "mean_reversion", "breakout"]).optional(),
    startBars: z.number().optional(),
  });

  async execute(input: { symbol: string; strategy?: any; startBars?: number }, context: McpToolContext) {
    const sandbox = new ETradeSandboxService(undefined, context.env);
    const result = await sandbox.runQuantBacktest({
      symbol: input.symbol,
      strategy: input.strategy || "sma_crossover",
      startBars: input.startBars || 100,
    });
    context.audit("quant.backtest", "sandbox", { symbol: input.symbol, dataSource: result.dataSource, sharpe: result.sharpeRatio });
    return result;
  }
}

/**
 * 6. Think Trade Validation Command
 */
export class ThinkTradeValidationCommand implements IMcpToolCommand<{
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP";
  price?: number;
  accountBalanceUSD?: number;
}> {
  readonly name = "think_trade_validation";
  readonly description = "Run Cloudflare Think extended reasoning harness on proposed trade across 5 risk & regulatory phases";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker e.g. NVDA" },
      action: { type: "string", enum: ["BUY", "SELL"] },
      quantity: { type: "number", description: "Number of shares" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP"] },
      price: { type: "number", description: "Optional limit price" },
      // #1734 (slice (n), confirmed pair with POST /etrade/think/evaluate):
      // the REST route already accepted accountBalanceUSD; the MCP tool
      // did not, so the harness could never take a caller-supplied
      // balance from MCP. Optional, additive — no existing input changes.
      accountBalanceUSD: { type: "number", description: "Optional caller-supplied account balance in USD (same input the REST route accepts; otherwise the harness resolves live broker state or fails closed INPUTS_UNAVAILABLE)" },
    },
    required: ["symbol", "action", "quantity"],
  };
  readonly zodSchema = z.object({
    symbol: z.string(),
    action: z.enum(["BUY", "SELL"]),
    quantity: z.number(),
    orderType: z.enum(["MARKET", "LIMIT", "STOP"]).optional(),
    price: z.number().optional(),
    accountBalanceUSD: z.number().optional(),
  });

  async execute(input: { symbol: string; action: "BUY" | "SELL"; quantity: number; orderType?: any; price?: number; accountBalanceUSD?: number }, context: McpToolContext) {
    const thinkHarness = new ETradeThinkHarness(context.orm, context.env);
    const result = await thinkHarness.evaluateTradeWithThinking({
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      orderType: input.orderType || "MARKET",
      price: input.price,
      accountBalanceUSD: input.accountBalanceUSD,
      userLogin: context.sessionId,
    });
    context.audit("think.evaluated", "think", {
      symbol: input.symbol,
      approved: result.approved,
      recommendation: result.recommendation,
    });
    return result;
  }
}

/**
 * 7. AI Search Financial Docs Command
 */
export class AISearchFinancialDocsCommand implements IMcpToolCommand<{ query: string; limit?: number }> {
  readonly name = "ai_search_financial_docs";
  readonly description = "Perform semantic search across SEC 10-K/10-Q filings, broker rules, and options disclosures. Answers come from the live AI Search instance only, reached through the AiSearchAgent (the namespace binding) since #3342 retired the public-endpoint REST transport: when the instance does not serve, the result carries zero documents and a `degraded` reason (the built-in fallback corpus was removed by #1169 S3) — never substitute documents. Generated-report results, when indexed, are served only to the report owner's login: the caller's session login is threaded through and other logins' reports are withheld.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language query e.g. NVDA data center revenue or PDT margin rules" },
      limit: { type: "number", description: "Maximum documents to return (default: 5)" },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string(),
    limit: z.number().optional(),
  });

  async execute(input: { query: string; limit?: number }, context: McpToolContext) {
    // Issue #3342: this command called AiSearchInstanceService
    // (the public-endpoint REST transport) directly. It now
    // dispatches through the AiSearchAgent's Durable Object door —
    // the same door the ai_search_agent_search command below uses
    // (fixed service instance; the caller's session login threaded
    // as callerLogin, which GIVES this command the #2246 per-login
    // report discipline the REST path never had) — and shapes the
    // typed result into the AISearchQueryResponse contract this
    // command has always returned, via the one mapping the Search
    // Hub /search/agent route shares. An absent binding answers
    // the degraded contract (endpoint_not_configured, zero
    // documents), exactly the answer the retired service gave when
    // its endpoint was unset — never a throw, never fabricated rows.
    const namespace = (context.env as any)?.AI_SEARCH_AGENT as
      | DurableObjectNamespace
      | undefined;
    let result;
    if (
      !namespace ||
      typeof namespace.get !== "function" ||
      typeof namespace.idFromName !== "function"
    ) {
      result = aiSearchAgentResultToQueryResponse(input.query, {
        ok: false,
        code: "not_configured",
        errorToken: AgentErrorCode.UNKNOWN_AGENT_ERROR,
        error:
          "the AI_SEARCH_AGENT Durable Object binding is not configured in this environment, so the AiSearchAgent cannot be reached",
        correlationId: crypto.randomUUID(),
      });
    } else {
      const stub = namespace.get(
        namespace.idFromName(AI_SEARCH_AGENT_SERVICE_INSTANCE),
      ) as unknown as AiSearchAgentStubLike;
      const callerLogin =
        typeof context.sessionId === "string" && context.sessionId.trim()
          ? context.sessionId
          : undefined;
      const agentResult = await stub.search(input.query, {
        callerLogin,
        limit: input.limit || 5,
      });
      result = aiSearchAgentResultToQueryResponse(input.query, agentResult);
    }
    context.audit("ai_search.query", "search", {
      query: input.query,
      matches: result.totalMatches,
      ...(result.degraded ? { degraded: result.degraded } : {}),
    });
    return result;
  }
}

/**
 * 8. Durable TWAP Order Preview Command
 *
 * Issue #135: this command previously counted each slice's broker order
 * PREVIEW as a fill and audited the plan as an execution. A preview places
 * no order and fills nothing. The command is now an honest TWAP previewer:
 * it returns per-slice preview drafts labelled as previews, and real
 * execution must go through the human-in-the-loop order flow
 * (etrade_preview_order → etrade_execute_order with an explicit human
 * decision) — an MCP tool cannot approve its own orders.
 */
export class DurableTWAPOrderCommand implements IMcpToolCommand<{
  symbol: string;
  action: "BUY" | "SELL";
  totalQuantity: number;
  slices: number;
  intervalSeconds?: number;
  mode?: string;
  runId?: string;
}> {
  readonly name = "execute_durable_twap";
  readonly description = "Preview a durable TWAP order PLAN: splits the order into slices and runs each slice through the broker order preview with Cloudflare durable checkpointing. This tool does NOT place orders and nothing fills — it returns preview drafts only (status: \"previewed\", executed: false). Real execution requires the human-in-the-loop order flow: etrade_preview_order followed by etrade_execute_order with an explicit human decision. Preview engine: #1734 adopts #1726 ETRADE_PREVIEW_MODE (local | broker) — mode input, session/user carrier, env, then local (legacy); broker previews slices through previewOrderRemote. Preview-only in BOTH modes. Durable resume (#2763): pass the same optional runId on a re-invocation to resume an interrupted run from its last checkpoint — checkpointed slices are not re-previewed and the result reports resumed/resumedFromStep; a corrupt or plan-mismatched checkpoint fails loud instead of silently restarting the plan.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker e.g. NVDA" },
      action: { type: "string", enum: ["BUY", "SELL"] },
      totalQuantity: { type: "number", description: "Total shares in the TWAP plan (previewed slice by slice; nothing is executed)" },
      slices: { type: "number", description: "Number of preview slices" },
      intervalSeconds: { type: "number", description: "Interval in seconds between slice previews" },
      mode: { type: "string", description: "#1726 run-level ETRADE_PREVIEW_MODE override (local | broker); unset = local legacy" },
      runId: { type: "string", description: "Optional durable run identity (#2763): re-invoke with the same runId to resume an interrupted TWAP preview run from its last checkpoint instead of re-previewing completed slices. Omit for a one-off run." },
    },
    required: ["symbol", "action", "totalQuantity", "slices"],
  };
  readonly zodSchema = z.object({
    symbol: z.string(),
    action: z.enum(["BUY", "SELL"]),
    totalQuantity: z.number(),
    slices: z.number(),
    intervalSeconds: z.number().optional(),
    mode: z.string().optional(),
    runId: z.string().optional(),
  });

  async execute(input: { symbol: string; action: "BUY" | "SELL"; totalQuantity: number; slices: number; intervalSeconds?: number; mode?: string; runId?: string }, context: McpToolContext) {
    // #1734 (slice (n)): TWAP previously hardcoded the LOCAL draft,
    // bypassing #1726's preview pair — the appendix (n) requirement
    // that a TWAP slice adopt the E03/E04 gate posture, not inherit
    // the local draft's. The switch is CONSUMED from #1726 (not
    // re-declared): run > session > user > global env > local.
    // Invalid fails closed to local + etrade.config_error audit.
    // Preview-only in both modes; the E04 execute gate is never
    // switched and real execution still needs the HITL flow.
    const resolved = resolveEtradePreviewMode(
      levelsForEtradeSwitch(
        context.scopedEtradeModes,
        "preview",
        input.mode,
        (context.env as any)?.[ETRADE_PREVIEW_MODE_SWITCH]
      ),
      "local"
    );
    if (resolved.invalid) {
      context.audit(etradeConfigErrorEvent(), "trading", {
        switch: ETRADE_PREVIEW_MODE_SWITCH,
        raw: resolved.raw,
        level: resolved.level,
        failedClosedTo: resolved.mode,
      });
    }
    const previewMode = resolved.mode;
    const fiberService = new ETradeDurableFiberService(context.orm, context.env, context.sessionId);
    const tradingService = new ETradeService(context.orm, context.env, context.sessionId);

    const plan = await fiberService.previewDurableTWAP(
      {
        symbol: input.symbol,
        action: input.action,
        totalQuantity: input.totalQuantity,
        slices: input.slices,
        intervalSeconds: input.intervalSeconds || 1,
      },
      async (_sliceNum, sliceQty) => {
        if (previewMode === "broker") {
          return tradingService.previewOrderRemote({
            symbol: input.symbol,
            action: input.action,
            quantity: sliceQty,
            orderType: "MARKET",
            sessionId: context.sessionId,
          });
        }
        return tradingService.previewOrder({
          symbol: input.symbol,
          action: input.action,
          quantity: sliceQty,
          orderType: "MARKET",
          sessionId: context.sessionId,
        });
      },
      { runId: input.runId }
    );

    context.audit("twap.previewed", "trading", {
      symbol: input.symbol,
      action: input.action,
      slicesPreviewed: plan.slicesPreviewed,
      totalPreviewed: plan.totalPreviewed,
      executed: false,
      previewMode,
      resumed: plan.resumed,
      resumedFromStep: plan.resumedFromStep,
      ...(input.runId ? { runId: input.runId } : {}),
    });

    return {
      status: "previewed",
      executed: false,
      previewMode,
      planCompleted: plan.completed,
      note: "TWAP preview plan only — every slice was run through the broker order PREVIEW. No orders were placed and no shares were filled. To execute for real, each slice must go through the human-in-the-loop order flow (etrade_preview_order → etrade_execute_order with an explicit human decision).",
      symbol: input.symbol,
      action: input.action,
      totalPreviewed: plan.totalPreviewed,
      slicesPreviewed: plan.slicesPreviewed,
      previews: plan.previews.map((entry) => ({
        slice: entry.slice,
        quantity: entry.quantity,
        orderId: entry.preview?.orderId,
        status: entry.preview?.status ?? "previewed",
        estimatedPrice: entry.preview?.estimatedPrice,
        estimatedTotal: entry.preview?.estimatedTotal,
        pricingQuoteStatus: entry.preview?.pricingQuoteStatus,
      })),
      fiberId: plan.fiberId,
      resumed: plan.resumed,
      resumedFromStep: plan.resumedFromStep,
    };
  }
}

/**
 * 9. AI Search Agent Search Command (issue #2250)
 *
 * The orchestrator's chat door onto AiSearchAgent (#2223): until
 * this command, the agent was reachable over A2A and by direct
 * method call, but NOT from a chat turn, so there was no way to ask
 * in chat for a search over the AI Search instance — or over the
 * generated reports #2246 indexes into it.
 *
 * The call is the agent's direct search() (the deterministic RPC
 * door — retrieval is exact work, not a judgment turn), resolved
 * through the AI_SEARCH_AGENT Durable Object binding on the fixed
 * service instance below. The instance is a SERVICE instance: the
 * agent is stateless search, the same instance the A2A door
 * addresses (the aisearch resolution carries no instance override,
 * so its URL name is the instance name). The caller's login is
 * NEVER the instance name and NEVER read from tool arguments (the
 * schemas declare no login field): it is the turn's verified
 * session login, context.sessionId — the carrier every sibling
 * command uses — threaded as the search's callerLogin argument so
 * the agent's #2246 discipline serves report-type results only to
 * their owner. An empty session id passes NO callerLogin, leaving
 * the agent's safe default in force (report results withheld).
 *
 * The binding is declared in wrangler.jsonc but is not on the Env
 * type (the #2223 posture; the A2A dispatcher reads it the same
 * way). Its absence answers honestly as not_configured — the tool
 * never throws for configuration and never fabricates rows.
 *
 * Shaping never launders: a degraded agent answer is a degraded
 * tool answer — the text says so and carries the agent's degraded
 * note verbatim — and rows pass through with their S2 fields and
 * provenance exactly as the agent returned them.
 */
const AI_SEARCH_AGENT_SERVICE_INSTANCE = "aisearch";

/** Structural minimum of the AiSearchAgent stub this command calls. */
interface AiSearchAgentStubLike {
  search(
    query: string,
    opts?: AiSearchAgentSearchOptions,
  ): Promise<AiSearchAgentSearchResult>;
}

export interface AiSearchAgentToolData {
  ok: boolean;
  path?: AiSearchPath;
  degraded?: string;
  results: AiSearchAgentResultItem[];
  code?: AiSearchAgentErrorToken;
  errorToken?: AgentErrorCode;
  error?: string;
  correlationId: string;
}

export interface AiSearchAgentToolAnswer {
  text: string;
  data: AiSearchAgentToolData;
}

/** Shape one agent search result into the tool's { text, data } answer. */
function shapeAiSearchAgentAnswer(
  result: AiSearchAgentSearchResult,
): AiSearchAgentToolAnswer {
  const results = result.results ?? [];
  const data: AiSearchAgentToolData = {
    ok: result.ok,
    ...(result.path ? { path: result.path } : {}),
    ...(result.degraded ? { degraded: result.degraded } : {}),
    results,
    ...(result.code ? { code: result.code } : {}),
    ...(result.errorToken ? { errorToken: result.errorToken } : {}),
    ...(result.error ? { error: result.error } : {}),
    correlationId: result.correlationId,
  };
  let text: string;
  if (result.ok) {
    text = `AiSearchAgent search completed via the ${result.path ?? "unknown"} path: ${results.length} result(s) from the Cloudflare AI Search instance.`;
  } else {
    text = `AiSearchAgent search did not serve live results${result.code ? ` (${result.code})` : ""}: ${result.error ?? "unknown error"}`;
  }
  if (result.degraded && !text.includes(result.degraded)) {
    text += ` Degraded: ${result.degraded}`;
  }
  return { text, data };
}

export class AISearchAgentSearchCommand implements IMcpToolCommand<{ query: string; limit?: number }> {
  readonly name = "ai_search_agent_search";
  readonly description = "Search the Cloudflare AI Search instance through the AiSearchAgent — the fleet's agent door onto the same instance the SearchHub knowledge surface serves. Searches the knowledge corpus, plus generated reports that have been indexed into the instance (report results are served only to the report's owner, and exist only when report indexing has run). Results are labelled with the serving path and keep their provenance; a degraded answer is returned as degraded — stated in the answer text — never dressed up as live results.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language query e.g. NVDA data center revenue, PDT margin rules, or the topic of a generated report" },
      limit: { type: "number", description: "Maximum results to return (default: 5)" },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string(),
    limit: z.number().optional(),
  });

  async execute(input: { query: string; limit?: number }, context: McpToolContext): Promise<AiSearchAgentToolAnswer> {
    const namespace = (context.env as any)?.AI_SEARCH_AGENT as
      | DurableObjectNamespace
      | undefined;
    if (
      !namespace ||
      typeof namespace.get !== "function" ||
      typeof namespace.idFromName !== "function"
    ) {
      const detail =
        "the AI_SEARCH_AGENT Durable Object binding is not configured in this environment, so the AiSearchAgent cannot be reached";
      context.audit("ai_search_agent.query", "search", {
        query: input.query,
        ok: false,
        code: "not_configured",
      });
      return {
        text: `AiSearchAgent search did not serve live results (not_configured): ${detail}.`,
        data: {
          ok: false,
          code: "not_configured",
          errorToken: AgentErrorCode.UNKNOWN_AGENT_ERROR,
          error: detail,
          results: [],
          correlationId: crypto.randomUUID(),
        },
      };
    }
    const stub = namespace.get(
      namespace.idFromName(AI_SEARCH_AGENT_SERVICE_INSTANCE),
    ) as unknown as AiSearchAgentStubLike;
    const callerLogin =
      typeof context.sessionId === "string" && context.sessionId.trim()
        ? context.sessionId
        : undefined;
    const result = await stub.search(input.query, {
      callerLogin,
      limit: input.limit || 5,
    });
    const answer = shapeAiSearchAgentAnswer(result);
    context.audit("ai_search_agent.query", "search", {
      query: input.query,
      ok: result.ok,
      path: result.path,
      matches: answer.data.results.length,
      degraded: Boolean(result.degraded),
    });
    return answer;
  }
}
