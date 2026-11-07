/**
 * Issue #291 — TradingAgent: the trading competency as agent-as-a-service.
 *
 * Owner directive (Venus, 2026-10-22): the trading competency is an
 * agent-as-a-service — an agent-as-a-tool, a Think agent, and an A2A
 * agent with its own Think workflow. It is provider-NEUTRAL: each provider sits behind the TradingPlatformRegistry seam; new providers onboard by registering a platform, with no agent changes.
 * The architecture is configurable, pluggable, extensible, flexible:
 *
 * - PLUGGABLE providers — services resolve an ITradingPlatform from
 *   TradingPlatformRegistry by id and never name a broker.
 * - CONFIGURABLE — src/config/tradingAgentConfig.ts: enabled providers,
 *   default provider, per-service enablement, all env-overridable.
 * - EXTENSIBLE services — services are modules in TRADING_SERVICE_REGISTRY
 *   behind one interface. The Think tool set and the A2A operation list
 *   are GENERATED from registry + config, so the surfaces cannot drift;
 *   adding a service is one module + one registry line.
 * - FLEXIBLE invocation — one execution path (executeTradingService)
 *   behind three doors: Think tools, A2A structured operations
 *   (handleA2A), and typed RPC (executeService). A service cannot tell
 *   which door it was called through.
 *
 * Safety: trading keeps the platform HITL discipline. Screening services
 * are read-only. Order placement (arriving in later slices) flows only
 * through the existing approval path; tool/A2A trading operations are
 * preview-only unless an approved execution context is presented.
 *
 * Data locality: v1 services are broker-API operations — OAuth tokens
 * resolve from env (SessionStore), so they run inside this agent.
 * ORM-backed persistence (trade records, watchlists) stays with the
 * orchestrator; services receive any such state as call parameters.
 */

import { PortThink, createThinkActorPort } from "../actors/thinkAdapter";
import type {
  ActorPort,
  ActorTurnHooks,
  ChatResponseResult,
  TurnConfig,
  TurnContext,
  TurnInput,
} from "../actors/actorPorts";
import { tool, type ToolSet } from "ai";
import { getServiceUserLogin } from "../security/serviceIdentity";
import { createApprovalWorkflow } from "../services/cloudflareApprovalWorkflow";
import type {
  ApprovalWorkflow,
  ApprovalWorkflowHost,
} from "../services/approvalWorkflowPorts";
import { recordBlockingAudit } from "../security/auditChain";
import { z } from "zod";
import { resolveAiModelName } from "./model";
import type { Env } from "../types";
import { DatabaseORM } from "../orm";
import {
  TradingPlatformRegistry,
  UnifiedOptionsService,
  type ExpectedTradeTerms,
  type ITradingPlatform,
  type TradingPlatformId,
} from "../trading";
import {
  getTradingAgentConfig,
  isTradingServiceEnabled,
  type TradingAgentConfig,
} from "../config/tradingAgentConfig";
import {
  AGENT_ERROR_CATALOG,
  AgentErrorCode,
} from "../aspects/errorCodes";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/trading-agent",
});

// ---------------------------------------------------------------------------
// Stable error tokens (cfpay convention, #291 A3): failures on the A2A and
// tool surfaces carry a machine-stable `code`; raw exception text from
// unclassified failures never reaches the wire (it is logged server-side
// and replaced by a generic message + the internal_error token).
// ---------------------------------------------------------------------------

export type TradingErrorToken =
  | "unknown_service"
  | "unknown_operation"
  | "missing_operation"
  | "service_disabled"
  | "provider_not_enabled"
  | "provider_not_registered"
  | "provider_unsupported"
  | "invalid_input"
  | "internal_error";

/**
 * Issue #1763 (scan row F-60) — stable error tokens from the EXISTING
 * AGENT_ERROR_CATALOG, carried on A2ADataResult as `errorToken`
 * alongside the existing trading `code`. Consumers judge failures
 * by token, not prose: `code` keeps the precise trading failure
 * class (backward compatible, #291 A3), `errorToken` is the
 * catalog token (ERR_*) whose catalog entry supplies the stable
 * title/remediation/httpStatus. No new taxonomy is invented here;
 * every value below is a key of AGENT_ERROR_CATALOG (pinned by
 * test), and an unmapped future token falls back to
 * ERR_UNKNOWN_AGENT_ERROR, never to free text.
 *
 * Mapping rationale (nearest catalog class, not a 1:1 claim):
 * - unknown/missing operation or service → the request named
 *   something the agent does not know (ERR_UNKNOWN_AGENT_ERROR).
 * - disabled / not-enabled / not-registered / unsupported provider
 *   → the execution itself could not run (ERR_TOOL_EXECUTION_FAILED).
 * - invalid_input → the caller's input failed validation; the
 *   catalog has no validation class, so it maps to the generic
 *   unknown-agent fallback and the precise class stays in `code`.
 * - internal_error → execution failed (ERR_TOOL_EXECUTION_FAILED).
 */
export const TRADING_ERROR_CATALOG_CODES: Record<TradingErrorToken, AgentErrorCode> = {
  unknown_service: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  service_disabled: AgentErrorCode.TOOL_EXECUTION_FAILED,
  provider_not_enabled: AgentErrorCode.TOOL_EXECUTION_FAILED,
  provider_not_registered: AgentErrorCode.TOOL_EXECUTION_FAILED,
  provider_unsupported: AgentErrorCode.TOOL_EXECUTION_FAILED,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a trading error token to its AGENT_ERROR_CATALOG token. */
export function tradingErrorCatalogCode(token: TradingErrorToken): AgentErrorCode {
  const code = TRADING_ERROR_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export class TradingServiceError extends Error {
  readonly code: TradingErrorToken;
  constructor(code: TradingErrorToken, message: string) {
    super(message);
    this.name = "TradingServiceError";
    this.code = code;
  }
}

/** Classify any thrown value into a wire-safe { code, message } pair. */
export function classifyTradingError(err: unknown): { code: TradingErrorToken; message: string } {
  if (err instanceof TradingServiceError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof z.ZodError) {
    return {
      code: "invalid_input",
      message: `Invalid input: ${err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  }
  return { code: "internal_error", message: "Internal error in the trading service." };
}

/** Aspects-lite dispatch log (#291 A6): one structured line per execution. */
export function logTradingDispatch(entry: {
  correlationId: string;
  door: string;
  service: string;
  provider?: string;
  access?: string;
  ok: boolean;
  code?: string;
  durationMs: number;
}): void {
  structuredLog.info("tradingAgent.dispatch", {
    message: "[TradingAgent]",
    ...entry,
  });
}

// ---------------------------------------------------------------------------
// Service registry
// ---------------------------------------------------------------------------

export interface TradingServiceContext {
  env: Env;
  config: TradingAgentConfig;
  userLogin: string;
  /**
   * #1686: optional ORM + DO blob handle for full capture on the
   * listings-screen leg. Unset → today's missing-seam error result.
   */
  orm?: DatabaseORM;
  storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"];
  /** Resolve the platform for a provider id (or the configured default). */
  resolvePlatform: (providerId?: string) => ITradingPlatform;
}

export interface TradingServiceDef {
  /** Stable service id (matches TradingAgentConfig.enabledServices). */
  id: string;
  /** Think tool name. */
  toolName: string;
  /** A2A structured operation name. */
  a2aOperation: string;
  /**
   * Access class (cfpay A2A_OPS convention): "read" observes, "write"
   * mutates account/portfolio state, "action" executes in the world
   * (order placement). Write/action services get the stricter gates
   * (edge auth + approval flow) as they land.
   */
  access: "read" | "write" | "action";
  description: string;
  inputSchema: z.ZodType<any>;
  execute: (ctx: TradingServiceContext, input: any) => Promise<unknown>;
}

const providerField = z
  .string()
  .optional()
  .describe("Provider id (e.g. \"etrade\"). Omit for the configured default provider.");
const userLoginField = z
  .string()
  .optional()
  .describe("User login the call acts for. Defaults to the agent instance's user.");

const stockScreeningService: TradingServiceDef = {
  id: "stock_screening",
  toolName: "screen_stocks",
  a2aOperation: "trading.screen_stocks",
  access: "read",
  description:
    "Screen stocks on a provider against price/sector/momentum filters. Read-only. " +
    "Returns the screen result (matches, filter summary, counts).",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    filter: z
      .object({
        sector: z.string().optional(),
        minPrice: z.number().optional(),
        maxPrice: z.number().optional(),
        exchange: z.enum(["ALL", "NASDAQ", "NYSE", "AMEX"]).optional(),
        minMarketCap: z.number().optional(),
        maxPeRatio: z.number().optional(),
        minRsi: z.number().optional(),
        maxRsi: z.number().optional(),
        minVolume: z.number().optional(),
        gainersOnly: z.boolean().optional(),
        losersOnly: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (typeof platform.screenMarkets !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support stock screening.`,
      );
    }
    return platform.screenMarkets(input.filter ?? {});
  },
};

const optionsScreeningService: TradingServiceDef = {
  id: "options_screening",
  toolName: "screen_options",
  a2aOperation: "trading.screen_options",
  access: "read",
  description:
    "Screen options contracts across underlyings with the unified options pipeline " +
    "(the same engine behind the scanner UI): filter by underlying symbols, expiry, " +
    "moneyness, greeks and liquidity. Read-only. The pipeline is E*TRADE-backed today; " +
    "other providers return provider_unsupported until their pipeline lands.",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    symbols: z.array(z.string()).max(100).optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (platform.platformId !== "etrade") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Options screening runs on the unified options pipeline, which is E*TRADE-backed ` +
          `today; provider "${platform.platformId}" does not support it yet.`,
      );
    }
    const service = new UnifiedOptionsService(ctx.env, ctx.userLogin);
    return service.execute({
      action: "screen",
      symbols: input.symbols,
      symbol: input.symbol,
      filter: input.filter as never,
      limit: input.limit,
    });
  },
};

const stockTradingService: TradingServiceDef = {
  id: "stock_trading",
  toolName: "trade_stock",
  a2aOperation: "trading.trade_stock",
  access: "action",
  description:
    "Propose a stock order (preview only): validates the intent against the provider " +
    "and returns the broker preview as a pending-approval proposal. This surface NEVER " +
    "places an order — placement happens only through the agent's approval door " +
    "(executeApprovedOrder) with an explicit authorizer identity and decision, " +
    "the cfpay proposal -> approval -> verify -> execute shape.",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    symbol: z.string().min(1),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]),
    quantity: z.number().positive(),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (typeof platform.previewOrder !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support order preview.`,
      );
    }
    const draft = await platform.previewOrder({
      assetClass: "equity",
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
    });
    return {
      status: "pending_approval",
      proposal: draft,
      note:
        "Preview only — no order was placed. Placement requires an approved " +
        "decision via the TradingAgent approval door (executeApprovedOrder).",
    };
  },
};

const optionsTradingService: TradingServiceDef = {
  id: "options_trading",
  toolName: "trade_options",
  a2aOperation: "trading.trade_options",
  access: "action",
  description:
    "Propose an options order (preview only): single-leg or multi-leg (spreads) via " +
    "optionLegs, priced from the strategy net debit when given. Returns the broker " +
    "preview as a pending-approval proposal. This surface NEVER places an order — " +
    "placement happens only through the agent's approval door (executeApprovedOrder), " +
    "shared with stock trading.",
  inputSchema: z.object({
    provider: providerField,
    userLogin: userLoginField,
    symbol: z.string().min(1),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]),
    quantity: z.number().positive(),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    strategyNetDebit: z.number().optional(),
    optionLegs: z
      .array(
        z.object({
          underlyingSymbol: z.string().min(1),
          securityType: z.literal("OPTN"),
          side: z.enum(["BUY", "SELL"]),
          quantity: z.number().positive(),
          optionType: z.enum(["CALL", "PUT"]).optional(),
          strike: z.number().positive().optional(),
          expirationDate: z.string().optional(),
        }),
      )
      .min(1),
  }),
  execute: async (ctx, input) => {
    const platform = ctx.resolvePlatform(input.provider);
    if (typeof platform.previewOrder !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support order preview.`,
      );
    }
    const draft = await platform.previewOrder({
      assetClass: "options",
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
      optionLegs: input.optionLegs,
      strategyNetDebit: input.strategyNetDebit,
    });
    return {
      status: "pending_approval",
      proposal: draft,
      note:
        "Preview only — no order was placed. Placement requires an approved " +
        "decision via the TradingAgent approval door (executeApprovedOrder).",
    };
  },
};

/** The service registry. Add a service = one module + one line here. */
export const TRADING_SERVICE_REGISTRY: TradingServiceDef[] = [
  stockScreeningService,
  optionsScreeningService,
  stockTradingService,
  optionsTradingService,
];

export function getTradingService(serviceId: string): TradingServiceDef | undefined {
  return TRADING_SERVICE_REGISTRY.find((s) => s.id === serviceId);
}

export function getTradingServiceByOperation(
  operation: string,
): TradingServiceDef | undefined {
  return TRADING_SERVICE_REGISTRY.find((s) => s.a2aOperation === operation);
}

/** Services that are both registered and enabled — the live surface. */
export function liveTradingServices(config: TradingAgentConfig): TradingServiceDef[] {
  return TRADING_SERVICE_REGISTRY.filter((s) => isTradingServiceEnabled(config, s.id));
}

// ---------------------------------------------------------------------------
// Provider resolution + the single execution path
// ---------------------------------------------------------------------------

export function resolveTradingPlatform(
  env: Env,
  config: TradingAgentConfig,
  providerId: string | undefined,
  userLogin: string,
  // Issue #1686: optional ORM + DO blob handle. Without an ORM the
  // platform builds an undefined seam and screens return the
  // missing-seam error result (the pre-#1686 trading-agent behavior).
  orm?: DatabaseORM,
  storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"],
): ITradingPlatform {
  const provider = (providerId ?? config.defaultProvider).toLowerCase();
  if (!config.enabledProviders.includes(provider)) {
    throw new TradingServiceError(
      "provider_not_enabled",
      `Provider "${provider}" is not enabled for the TradingAgent ` +
        `(enabled: ${config.enabledProviders.join(", ") || "none"}).`,
    );
  }
  // Issue #1185: the platform is per-user — an explicit login is
  // required; there is no default identity to resolve under.
  if (!userLogin) {
    throw new TradingServiceError(
      "invalid_input",
      "resolveTradingPlatform requires an explicit userLogin.",
    );
  }
  const registered = TradingPlatformRegistry.getRegisteredPlatforms() as string[];
  if (!registered.includes(provider)) {
    throw new TradingServiceError(
      "provider_not_registered",
      `Provider "${provider}" is enabled but no platform is registered for it ` +
        `(registered: ${registered.join(", ") || "none"}).`,
    );
  }
  return TradingPlatformRegistry.getPlatform(
    provider as TradingPlatformId,
    env,
    orm,
    userLogin,
    undefined,
    storage,
  );
}

export interface TradingServiceCall {
  serviceId: string;
  input?: Record<string, unknown>;
  /**
   * The caller's login, threaded by the door (issue #1185): the
   * TradingAgent DO passes its own instance-derived login; external
   * dispatchers pass the authenticated session login. `input.userLogin`
   * takes precedence. Without either, execution fails closed.
   */
  userLogin?: string;
  /** Which door the call came through ("tool" | "a2a" | "rpc") — logging only. */
  door?: string;
  /** Correlation id for the dispatch log; generated when absent. */
  traceId?: string;
  /**
   * #1686: optional ORM + DO blob handle, supplied by the door when the
   * caller runs inside a DO (Think tools, typed RPC, A2A handler). Unset
   * → today's missing-seam error result for the listings-screen leg.
   */
  orm?: DatabaseORM;
  storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"];
}

/**
 * The single execution path behind every door (tool / A2A / RPC).
 * Validates the service exists and is enabled, parses the input against
 * the service schema, then executes. Failures throw TradingServiceError
 * with a stable token; adapters shape them per surface. Every execution —
 * success or failure — emits one structured dispatch log line (A6).
 */
export async function executeTradingService(
  env: Env,
  config: TradingAgentConfig,
  call: TradingServiceCall,
): Promise<unknown> {
  const correlationId = call.traceId ?? crypto.randomUUID();
  const started = Date.now();
  const service = getTradingService(call.serviceId);
  const log = (ok: boolean, code?: string) =>
    logTradingDispatch({
      correlationId,
      door: call.door ?? "rpc",
      service: call.serviceId,
      provider:
        typeof call.input?.provider === "string"
          ? (call.input.provider as string)
          : config.defaultProvider,
      access: service?.access,
      ok,
      code,
      durationMs: Date.now() - started,
    });
  try {
    if (!service) {
      throw new TradingServiceError(
        "unknown_service",
        `Unknown trading service: "${call.serviceId}".`,
      );
    }
    if (!isTradingServiceEnabled(config, service.id)) {
      throw new TradingServiceError(
        "service_disabled",
        `Trading service "${service.id}" is disabled by configuration.`,
      );
    }
    const input = service.inputSchema.parse(call.input ?? {});
    // Issue #1185: services execute under an explicit login — the
    // input's, or the door-threaded caller's (call.userLogin). A missing
    // one fails closed instead of resolving to a synthetic user.
    const userLogin =
      typeof input.userLogin === "string" && input.userLogin.length > 0
        ? input.userLogin
        : typeof call.userLogin === "string" && call.userLogin.length > 0
          ? call.userLogin
          : null;
    if (!userLogin) {
      throw new TradingServiceError(
        "invalid_input",
        `Trading service "${service.id}" requires an explicit userLogin.`,
      );
    }
    const ctx: TradingServiceContext = {
      env,
      config,
      userLogin,
      orm: call.orm,
      storage: call.storage,
      resolvePlatform: (providerId) =>
        resolveTradingPlatform(env, config, providerId, userLogin, call.orm, call.storage),
    };
    const result = await service.execute(ctx, input);
    log(true);
    return result;
  } catch (err) {
    const { code, message } = classifyTradingError(err);
    if (code === "internal_error" && !(err instanceof TradingServiceError)) {
      // The real failure stays server-side; the wire gets the token only.
      structuredLog.error("tradingAgent.unclassified_service_failure", {
        message: "[TradingAgent] unclassified service failure:",
        serviceId: service?.id ?? call.serviceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log(false, code);
    throw new TradingServiceError(code, message);
  }
}

// ---------------------------------------------------------------------------
// Door 1: Think tools (agent-as-a-tool), generated from the registry
// ---------------------------------------------------------------------------

export function buildTradingTools(env: Env, config: TradingAgentConfig, userLogin?: string, deps?: { orm?: DatabaseORM; storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"] }): ToolSet {
  const tools: ToolSet = {};
  for (const service of liveTradingServices(config)) {
    tools[service.toolName] = tool({
      description: service.description,
      inputSchema: service.inputSchema,
      execute: async (input: any) => {
        try {
          const result = await executeTradingService(env, config, {
            serviceId: service.id,
            input,
            userLogin,
            door: "tool",
            orm: deps?.orm,
            storage: deps?.storage,
          });
          return JSON.stringify({ ok: true, service: service.id, result });
        } catch (err) {
          const { code, message } = classifyTradingError(err);
          return JSON.stringify({ ok: false, service: service.id, code, errorToken: tradingErrorCatalogCode(code), error: message });
        }
      },
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Door 2: A2A structured operations
// ---------------------------------------------------------------------------

/**
 * Extract { operation, args } from an A2A request body: either the
 * JSON-RPC message/send envelope (a data part carrying
 * { operation, ...args } — the cfpay convention) or a bare
 * { operation, ...args } object.
 */
export function extractA2AOperation(body: unknown): { operation: string; args: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const parts = b.params?.message?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part?.kind === "data" && part.data && typeof part.data === "object") {
        const { operation, ...args } = part.data as Record<string, unknown>;
        if (typeof operation === "string") return { operation, args };
      }
    }
  }
  if (typeof b.operation === "string") {
    const { operation, ...args } = b;
    return { operation: operation as string, args };
  }
  return null;
}

export interface A2ADataResult {
  ok: boolean;
  operation?: string;
  service?: string;
  /** Stable error token (#291 A3) when ok is false. */
  code?: TradingErrorToken;
  /**
   * Stable catalog token (#1763, F-60) when ok is false: a key of
   * AGENT_ERROR_CATALOG (src/aspects/errorCodes.ts), resolved from
   * `code` by tradingErrorCatalogCode. `error` prose is retained
   * only for the mandatory human-readable text part — machines
   * must judge by `code` + `errorToken`, never by prose.
   */
  errorToken?: AgentErrorCode;
  correlationId?: string;
  result?: unknown;
  error?: string;
}

/** Dispatch one A2A body through the single execution path. Never throws. */
export async function dispatchTradingA2A(
  env: Env,
  config: TradingAgentConfig,
  body: unknown,
  userLogin?: string,
  // Issue #1686: optional ORM + DO blob handle, supplied by the A2A
  // handler when it runs inside a DO. Unset → missing-seam error
  // result for the listings-screen leg, as before.
  deps?: { orm?: DatabaseORM; storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"] },
): Promise<A2ADataResult> {
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: tradingErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const service = getTradingServiceByOperation(extracted.operation);
  if (!service) {
    return {
      ok: false,
      operation: extracted.operation,
      code: "unknown_operation",
      errorToken: tradingErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${extracted.operation}".`,
    };
  }
  try {
    const result = await executeTradingService(env, config, {
      serviceId: service.id,
      input: extracted.args,
      userLogin,
      door: "a2a",
      traceId: correlationId,
      orm: deps?.orm,
      storage: deps?.storage,
    });
    return { ok: true, operation: extracted.operation, service: service.id, correlationId, result };
  } catch (err) {
    const { code, message } = classifyTradingError(err);
    return {
      ok: false,
      operation: extracted.operation,
      service: service.id,
      code,
      errorToken: tradingErrorCatalogCode(code),
      correlationId,
      error: message,
    };
  }
}

/**
 * The collected A2A outcome (cfpay shape): every capability reply is
 * `{ text, data? }` — a human-readable text part is MANDATORY, the data
 * part carries the structured result. A DO method returns this plain
 * object; the HTTP transport (src/a2a) shapes it onto the wire, because
 * a Request/Response cannot cross the DO RPC boundary.
 */
export interface TradingA2AOutcome {
  text: string;
  data: A2ADataResult;
}

export function tradingA2AOutcome(data: A2ADataResult): TradingA2AOutcome {
  if (data.ok) {
    return {
      text: `${data.operation} completed${data.service ? ` (${data.service})` : ""}.`,
      data,
    };
  }
  return {
    text: `${data.operation ?? "trading operation"} failed: ${data.error ?? "unknown error"}`,
    data,
  };
}

/**
 * Extract the { text, data } reply from a collected outcome (cfpay's
 * a2aReplyFromOutcome) — the way in-process callers read an A2A result
 * without the HTTP transport.
 */
export function a2aReplyFromOutcome(outcome: unknown): { text: string; data?: unknown } {
  if (outcome && typeof outcome === "object") {
    const o = outcome as Record<string, unknown>;
    if (typeof o.text === "string") {
      return { text: o.text, data: o.data };
    }
  }
  return { text: "" };
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Order settlement — the shared core behind the approval door (T3) and the
// durable trade workflow (T3b)
// ---------------------------------------------------------------------------

/** Wrangler binding name of the trade approval workflow (#291 T3b). */
export const TRADE_WORKFLOW_BINDING = "TRADE_WORKFLOW" as const;

/** Params carried by the trade approval workflow — ids only, never credentials. */
export interface TradeApprovalParams {
  orderId: string;
  provider?: string;
  userLogin: string;
  /**
   * Issue #2730 — W3C traceparent for the run (#1743's field,
   * the WorkflowJobCommand contract): the start_trade_approval
   * door stamps it from the turn's traceparent resolver,
   * server-side only — never a tool argument. The workflow's
   * step hops record under it (the S17 mechanism); absent →
   * the run's steps record nothing, never minted mid-flight.
   */
  traceparent?: string;
}

/** The decision event payload delivered to a waiting trade workflow. */
export interface TradeApprovalDecision {
  decision: "approved" | "rejected";
  authorizerDid: string;
  reason?: string;
  /**
   * Issue #1393 (invariant 5): the approval's frozen proposal terms.
   * When present, the settle core forwards them to the platform,
   * which refuses execution if the current draft no longer matches.
   * Absent, settle keeps its historical orderId-only behaviour.
   */
  expectedTerms?: ExpectedTradeTerms;
}

export interface SettleTradingOrderInput {
  provider?: string;
  userLogin?: string;
  orderId: string;
  authorizerDid: string;
  decision: "approved" | "rejected";
  expectedTerms?: ExpectedTradeTerms;
}

/**
 * Settle one previewed order from an explicit, authorized decision:
 * validates the decision triple, resolves the platform through the
 * registry, and calls its executeOrder — which re-validates the draft
 * state and records the authorizer (claim-then-execute at the platform).
 * Shared by the synchronous approval door and the durable workflow, so
 * both paths enforce identical rules. Emits the A6 dispatch log line
 * under the caller's door name.
 *
 * #2375: the optional `orm` is the draft store the platform resolves
 * against. Drafts are written at preview time through the ORM of
 * whichever surface previewed them — for door previews, the order
 * owner's TradingAgent instance store — so an agent-side settle must
 * thread its own instance ORM in, or the platform cannot find the
 * draft. Callers without an instance store (the channel-email settle,
 * which reaches this core through ETradeService) leave it undefined,
 * unchanged.
 */
export async function settleTradingOrder(
  env: Env,
  config: TradingAgentConfig,
  input: SettleTradingOrderInput,
  door: string,
  orm?: DatabaseORM,
): Promise<unknown> {
  const started = Date.now();
  const correlationId = crypto.randomUUID();
  try {
    if (!input?.orderId || typeof input.orderId !== "string") {
      throw new TradingServiceError("invalid_input", "settleTradingOrder requires an orderId.");
    }
    if (!input.authorizerDid || typeof input.authorizerDid !== "string") {
      throw new TradingServiceError(
        "invalid_input",
        "settleTradingOrder requires an authorizerDid — anonymous approvals are refused.",
      );
    }
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new TradingServiceError(
        "invalid_input",
        `settleTradingOrder decision must be "approved" or "rejected".`,
      );
    }
    // Issue #1185: settling an order acts on a specific user's platform —
    // the login is required, never defaulted.
    if (!input.userLogin) {
      throw new TradingServiceError(
        "invalid_input",
        "settleTradingOrder requires an explicit userLogin.",
      );
    }
    const platform = resolveTradingPlatform(
      env,
      config,
      input.provider,
      input.userLogin,
      orm,
    );
    if (typeof platform.executeOrder !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not support order execution.`,
      );
    }
    const result = await platform.executeOrder(input.orderId, input.authorizerDid, input.decision, input.expectedTerms);
    logTradingDispatch({
      correlationId,
      door,
      service: "stock_trading",
      provider: platform.platformId,
      access: "action",
      ok: true,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    const { code, message } = classifyTradingError(err);
    logTradingDispatch({
      correlationId,
      door,
      service: "stock_trading",
      access: "action",
      ok: false,
      code,
      durationMs: Date.now() - started,
    });
    throw new TradingServiceError(code, message);
  }
}

export class TradingAgent extends PortThink {
  // Issue #1954 (think-fleet): TradingAgent is a Think agent behind
  // the existing actor port (shape (a), tracker #1951). PortThink
  // extends Think, which extends Agent, so the workflow doors
  // (runWorkflow/sendWorkflowEvent) live on the base itself —
  // verified against agents 0.24.0 types — and the approval workflow
  // path is unchanged by the base change. The trade workflow class
  // itself stays on ThinkWorkflow (ADR 0004 W13); that is not an
  // agent class and is out of this slice's scope.
  //
  // Turn path: this class drives turns ONLY through the actor port
  // (getThinkActorPort().turn / runThinkTurn), i.e. through the
  // foundation's ThinkActorTurn. That adapter owns the lifecycle
  // boot (await lifecycle.start() before any turn — idempotent;
  // never lifecycle.ready?.(), which silently no-ops), the one-shot
  // beforeTurn override, and the append -> onChatResponse hook
  // order; this class does not re-implement any of them. The flat
  // port session and Think's tree session coexist (dual stores);
  // tree operations (branching, compaction, FTS) have no port
  // equivalent and stay outside the port. TradingAgent schedules
  // nothing, so it defines no scheduler callbacks (the SDK
  // validates callback names at schedule time; the port's schedule
  // facet delegates to the base scheduler and is unused here).
  private config(): TradingAgentConfig {
    return getTradingAgentConfig(this.env as unknown as Record<string, unknown>);
  }

  getModel() {
    return resolveAiModelName(this.env, "tradingAgent");
  }

  getSystemPrompt(): string {
    const config = this.config();
    const services = liveTradingServices(config)
      .map((s) => `- ${s.toolName}: ${s.description}`)
      .join("\n");
    return [
      "You are the TradingAgent: the platform's provider-neutral trading competency.",
      `Providers enabled: ${config.enabledProviders.join(", ")} (default: ${config.defaultProvider}). ` +
        "Never assume a broker — resolve the provider per call; a new provider onboards without any change to your services.",
      "Services available to you:",
      services || "- (none enabled)",
      "Screening is read-only. Trading actions follow the platform's human-in-the-loop approval discipline: " +
        "preview first, and execute only with an approved execution context.",
    ].join("\n");
  }

  getTools(): ToolSet {
    return buildTradingTools(this.env, this.config(), this.instanceUserLogin() ?? undefined, { orm: this.getOrm(), storage: this.ctx.storage });
  }

  // -- Actor-port turn hooks (issue #1954) -------------------------------
  // The port hooks for a Think turn, as an OBJECT — never as class
  // methods named beforeTurn/onChatResponse/onChatError. PortThink
  // already defines those names with Think's signatures, and its
  // translations (one-shot override, record-then-flush ordering,
  // adapter-turn error accounting) are the dispatch path: a class
  // method with the same name would override the translation and
  // break the protocol (and fails typecheck — Think's hook shapes
  // are not assignable from the port's). TradingAgent is a non-chat
  // actor (actorPorts: it exposes the model/tool identity facet);
  // beforeTurn therefore supplies exactly the identity the class
  // already exposes — system prompt, tools, model — and nothing
  // else, so a port turn behaves like the class's own tool surface.
  // onChatResponse has no side effects to preserve (the class never
  // had a chat turn); onChatError is SYNCHRONOUS by requirement —
  // Think calls it fire-and-forget without awaiting, so a Promise
  // return could not control the error text (see thinkAdapter).

  /** The port hooks object, bound to this instance. */
  private tradingTurnHooks(): ActorTurnHooks {
    return {
      getModel: () => this.getModel(),
      getSystemPrompt: () => this.getSystemPrompt(),
      getTools: () => this.getTools(),
      beforeTurn: (_ctx: TurnContext): Promise<TurnConfig | void> =>
        Promise.resolve({
          instructions: this.getSystemPrompt(),
          tools: this.getTools(),
          model: this.getModel(),
        }),
      onChatResponse: async (_result: ChatResponseResult): Promise<void> => {
        // No chat side effects: the assistant message is already in
        // the port session by the time this fires (adapter append order).
      },
      onChatError: (error: unknown): string =>
        error instanceof Error ? error.message : String(error),
    };
  }

  private thinkPort?: ActorPort;

  /**
   * The Think-backed actor port for this instance (memoized; the
   * session is storage-backed, so rebuilding callers share one
   * transcript). Wires portHooks for direct Think turns too, so a
   * direct turn delegates to these hooks exactly once per turn via
   * PortThink. The scheduler facet defaults to this instance (the
   * base scheduler); TradingAgent schedules nothing through it.
   */
  getThinkActorPort(): ActorPort {
    const hooks = (this.portHooks ??= this.tradingTurnHooks());
    return (this.thinkPort ??= createThinkActorPort({
      think: this,
      hooks,
      storage: {
        get: (key) => this.ctx.storage.get(key) as Promise<unknown>,
        put: (key, value) => this.ctx.storage.put(key, value),
        delete: async (key) => {
          await this.ctx.storage.delete(key);
        },
        sql: this.ctx.storage.sql,
      },
    }));
  }

  /**
   * Drive one Think turn through the actor port. The adapter boots
   * the lifecycle, applies the input delta, runs the one-shot
   * beforeTurn, appends the assistant message, then fires
   * onChatResponse (or onChatError + rethrow on model failure).
   * A configOverride turn with an empty stored history completes
   * with no message via Think's "skipped" path — never an
   * identity-factory shape (see thinkAdapter).
   */
  async runThinkTurn(input: TurnInput): Promise<ChatResponseResult> {
    return this.getThinkActorPort().turn.runTurn(input);
  }

  /**
   * Issue #1686: the DO's ORM, mirroring OrchestratorAgent.getOrm —
   * the SQL handle the listings-seam build needs. The trading-agent
   * leg previously passed no ORM at all, so its screens returned the
   * missing-seam error result; with this + storage they fetch + capture.
   */
  private getOrm(): DatabaseORM {
    const orm = new DatabaseORM(this.ctx.storage.sql);
    orm.initializeSchema(this.ctx.id.toString());
    return orm;
  }

  /** Door 3: typed RPC for in-process callers. */
  async executeService(call: TradingServiceCall): Promise<unknown> {
    return executeTradingService(this.env, this.config(), {
      ...call,
      userLogin: call.userLogin ?? this.instanceUserLogin() ?? undefined,
      door: "rpc",
      // Issue #1686: instance handles as fallback, so RPC screens
      // capture like tool screens; an explicit call orm/storage wins.
      orm: call.orm ?? this.getOrm(),
      storage: call.storage ?? this.ctx.storage,
    });
  }

  // -- Read surface (#291 T5a) ---------------------------------------------
  // The platform reads, exposed as typed RPC so callers can stop
  // constructing broker services directly. Each resolves the platform
  // through the registry for THIS instance's user (the instance name
  // encodes the login) — provider-pluggable, env-only, no ORM: the
  // positions read here is the broker's live view; the caller's
  // ORM-merged view stays caller-side by design (see #291 T5 note).

  /**
   * This instance's user login (issue #1185): "trading:<login>"
   * instances encode their owner; the bare "trading" instance is the
   * configured service identity. Null when the bare instance has no
   * service identity configured — reads then fail closed.
   */
  private instanceUserLogin(): string | null {
    return tradingAgentUserLogin(this.name ?? "trading", getServiceUserLogin(this.env));
  }

  /**
   * Issue #1780 (Adapter S6, program #1717): the ApprovalWorkflow
   * port for this instance, built fresh per call so the adapter
   * resolves the host doors at call time (a door stubbed on the
   * instance after construction still flows through the port —
   * the existing approval tests' idiom). The host is this agent
   * itself, so a run keeps its existing agent origin (this
   * instance's name, addressed via tradingAgentName by the S5
   * gateway / mesh door), and the binding stays
   * TRADE_WORKFLOW_BINDING — no new naming, no new binding.
   */
  private approvalWorkflow(): ApprovalWorkflow {
    return createApprovalWorkflow(
      this as unknown as ApprovalWorkflowHost,
      TRADE_WORKFLOW_BINDING,
    );
  }

  private readPlatform(provider?: string): ITradingPlatform {
    const userLogin = this.instanceUserLogin();
    if (!userLogin) {
      throw new TradingServiceError(
        "invalid_input",
        "This TradingAgent instance has no user identity (the shared instance requires SERVICE_USER_LOGIN to be configured).",
      );
    }
    return resolveTradingPlatform(
      this.env,
      this.config(),
      provider,
      userLogin,
    );
  }

  async getStatus(provider?: string): Promise<unknown> {
    return this.readPlatform(provider).getStatus();
  }

  async getQuote(symbol: string, provider?: string): Promise<unknown> {
    return this.readPlatform(provider).getQuote(symbol);
  }

  async getAccounts(provider?: string): Promise<unknown> {
    return this.readPlatform(provider).getAccounts();
  }

  async getPositions(accountKey?: string, provider?: string): Promise<unknown> {
    return this.readPlatform(provider).getPositions(accountKey);
  }

  async getOptionChains(
    params: {
      symbol: string;
      expiryYear?: number;
      expiryMonth?: number;
      expiryDay?: number;
      strikePrice?: number;
      noOfStrikes?: number;
      includeWeekly?: boolean;
      chainType?: "CALL" | "PUT" | "CALLPUT";
      includeRawResponse?: boolean;
    },
    provider?: string,
  ): Promise<unknown> {
    const platform = this.readPlatform(provider);
    if (typeof platform.getOptionChains !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not expose options chain data.`,
      );
    }
    return platform.getOptionChains(params);
  }

  async getOptionExpireDates(symbol: string, provider?: string): Promise<unknown> {
    const platform = this.readPlatform(provider);
    if (typeof platform.getOptionExpireDates !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not expose options expiry data.`,
      );
    }
    return platform.getOptionExpireDates(symbol);
  }

  async getQuoteDetailed(symbol: string, provider?: string): Promise<unknown> {
    const platform = this.readPlatform(provider);
    if (typeof platform.getQuoteDetailed !== "function") {
      throw new TradingServiceError(
        "provider_unsupported",
        `Provider "${platform.platformId}" does not expose detailed quote reads.`,
      );
    }
    return platform.getQuoteDetailed(symbol);
  }

  /**
   * The approval door — the ONLY path that can place an order (#291 T3,
   * cfpay proposal -> approval -> verify -> execute). Deliberately NOT a
   * registry service: no Think tool and no A2A operation reaches it. The
   * caller must present the previewed order id, an explicit authorizer
   * identity, and the decision; the platform's executeOrder re-validates
   * the draft and records the authorizer. Rejection flows through the
   * same door with decision "rejected".
   */
  async executeApprovedOrder(input: {
    provider?: string;
    userLogin?: string;
    orderId: string;
    authorizerDid: string;
    decision: "approved" | "rejected";
  }): Promise<unknown> {
    // Issue #1185: settle under the caller's explicit login or this
    // instance's own owner login — settleTradingOrder fails closed
    // when neither exists.
    const userLogin = input.userLogin ?? this.instanceUserLogin() ?? undefined;
    // Issue #2178 (Q7 S2): fail-closed validation BEFORE any audit
    // row — an invalid call is not an approval decision and must not
    // create one (mirrors settleTradingOrder's own guards).
    if (!input?.orderId || typeof input.orderId !== "string") {
      throw new TradingServiceError("invalid_input", "settleTradingOrder requires an orderId.");
    }
    if (!input.authorizerDid || typeof input.authorizerDid !== "string") {
      throw new TradingServiceError(
        "invalid_input",
        "settleTradingOrder requires an authorizerDid — anonymous approvals are refused.",
      );
    }
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new TradingServiceError(
        "invalid_input",
        `settleTradingOrder decision must be "approved" or "rejected".`,
      );
    }
    if (!userLogin) {
      throw new TradingServiceError("invalid_input", "settleTradingOrder requires an explicit userLogin.");
    }
    const events = this.getOrm().events;
    // Decision audit BEFORE settle: a throwing store blocks execution.
    recordBlockingAudit(events, {
      id: crypto.randomUUID(),
      sessionId: userLogin,
      type: "trade.approval_decision",
      agent: "trading",
      payload: {
        orderId: input.orderId,
        authorizerDid: input.authorizerDid,
        decision: input.decision,
        door: "rpc-approval",
      },
      createdAt: new Date().toISOString(),
    });
    const result = await settleTradingOrder(
    // Issue #2375: thread this instance's ORM — door previews drafted
    // into this instance's store, so the settle must look there.
      this.env,
      this.config(),
      { ...input, userLogin },
      "rpc-approval",
      this.getOrm(),
    );
    // Result audit AFTER settle. Execution already happened and
    // cannot be undone — but a failed audit write surfaces as a
    // throw naming the unrecorded execution, never as success.
    try {
      recordBlockingAudit(events, {
        id: crypto.randomUUID(),
        sessionId: userLogin,
        type: "trade.order_executed",
        agent: "trading",
        payload: {
          orderId: input.orderId,
          authorizerDid: input.authorizerDid,
          decision: input.decision,
          door: "rpc-approval",
        },
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      throw new TradingServiceError(
        "internal_error",
        `Trade execution for order ${input.orderId} completed but the execution audit write failed; the execution may be unrecorded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result;
  }

  /**
   * Start the durable approval workflow for a previewed order (#291 T3b).
   * Returns the workflow id; the workflow waits up to 24h for a decision
   * delivered via decideTradeApproval, then settles through the same core
   * as the synchronous door. Fails closed when the workflow binding is
   * not configured.
   */
  async startTradeApproval(input: {
    provider?: string;
    userLogin?: string;
    orderId: string;
    /** Issue #2730: the caller's W3C traceparent (server-side carrier only), carried into the run's params. */
    traceparent?: string;
  }): Promise<{ workflowId: string; orderId: string; status: "awaiting_approval" }> {
    if (!input?.orderId || typeof input.orderId !== "string") {
      throw new TradingServiceError("invalid_input", "startTradeApproval requires an orderId.");
    }
    if (!(TRADE_WORKFLOW_BINDING in this.env)) {
      throw new TradingServiceError(
        "internal_error",
        "The trade approval workflow is not configured (TRADE_WORKFLOW binding missing).",
      );
    }
    // Issue #1185: the approval workflow runs under the order owner's
    // login — the caller's explicit login, or this instance's own
    // (the instance name encodes its owner). Absent both, fail closed.
    const ownerLogin = input.userLogin ?? this.instanceUserLogin() ?? undefined;
    if (!ownerLogin) {
      throw new TradingServiceError(
        "invalid_input",
        "startTradeApproval requires an explicit userLogin.",
      );
    }
    const params: TradeApprovalParams = {
      orderId: input.orderId,
      provider: input.provider,
      userLogin: ownerLogin,
      ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    };
    const workflowId = await this.approvalWorkflow().start(params);
    // Issue #2989: the trade approval start's job record at start
    // time. Best-effort, never blocking: the workflow already
    // started, so a failing audit store must warn, not strand
    // the run (contrast decideTradeApproval's blocking audit,
    // where an unaudited decision must never take effect).
    try {
      recordBlockingAudit(this.getOrm().events, {
        id: crypto.randomUUID(),
        sessionId: this.instanceUserLogin() ?? "unknown",
        type: "trade.approval_started",
        agent: "trading",
        payload: {
          orderId: input.orderId,
          workflowId,
          userLogin: ownerLogin,
        },
        createdAt: new Date().toISOString(),
      });
    } catch (auditErr) {
      structuredLog.warn("tradingAgent.trade_approval_started_audit_failed", {
        message: `[trading] trade.approval_started audit failed for order ${input.orderId}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
        orderId: input.orderId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    return { workflowId, orderId: input.orderId, status: "awaiting_approval" };
  }

  /**
   * Deliver a decision to a waiting trade approval workflow (#291 T3b).
   * The authorizer identity is mandatory and travels in the event payload
   * — the workflow re-verifies it at settle time through the shared core.
   */
  async decideTradeApproval(input: {
    workflowId: string;
    authorizerDid: string;
    decision: "approved" | "rejected";
    reason?: string;
    expectedTerms?: ExpectedTradeTerms;
  }): Promise<{ workflowId: string; delivered: true }> {
    if (!input?.workflowId || typeof input.workflowId !== "string") {
      throw new TradingServiceError("invalid_input", "decideTradeApproval requires a workflowId.");
    }
    if (!input.authorizerDid || typeof input.authorizerDid !== "string") {
      throw new TradingServiceError(
        "invalid_input",
        "decideTradeApproval requires an authorizerDid — anonymous decisions are refused.",
      );
    }
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new TradingServiceError(
        "invalid_input",
        `decideTradeApproval decision must be "approved" or "rejected".`,
      );
    }
    // Issue #2178 (Q7 S2): decision audit BEFORE delivery. A throwing
    // store propagates, so an unaudited decision never reaches the
    // workflow and cannot take effect. The delivery carries no owner
    // login, so the session is the instance owner's when known and an
    // explicit "unknown" marker otherwise — never a defaulted
    // "system" identity (G-AUD-3).
    recordBlockingAudit(this.getOrm().events, {
      id: crypto.randomUUID(),
      sessionId: this.instanceUserLogin() ?? "unknown",
      type: "trade.approval_decision",
      agent: "trading",
      payload: {
        workflowId: input.workflowId,
        authorizerDid: input.authorizerDid,
        decision: input.decision,
        reason: input.reason,
      },
      createdAt: new Date().toISOString(),
    });
    await this.approvalWorkflow().decide(input.workflowId, {
      decision: input.decision,
      authorizerDid: input.authorizerDid,
      reason: input.reason,
      expectedTerms: input.expectedTerms,
    });
    return { workflowId: input.workflowId, delivered: true };
  }

  /**
   * Door 2: A2A endpoint, cfpay signature — the dispatcher in src/a2a
   * parses the HTTP request at the edge and calls this with the plain
   * body + origin (a Request cannot cross the DO RPC boundary). Returns
   * the collected { text, data } outcome; the transport shapes the wire.
   */
  async handleA2A(body: unknown, origin: string): Promise<TradingA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchTradingA2A(this.env, this.config(), body, this.instanceUserLogin() ?? undefined, { orm: this.getOrm(), storage: this.ctx.storage });
    return tradingA2AOutcome(data);
  }
}

/**
 * The one instance-name scheme, shared by every door: the SERVICE
 * identity's instance is the bare "trading" — the same name the A2A
 * dispatcher resolves from the URL — and other users get
 * "trading:<login>". (Before the #291 A2 fix, the RPC helper used
 * "default"/"trading:<login>" while A2A used "trading", forking state
 * per door.) Issue #1185: the bare name belongs to the configured
 * service identity (getServiceUserLogin) — the only login that maps to
 * it — so the live state behind it is never orphaned and no other
 * login inherits it.
 */
export function tradingAgentName(userLogin: string, serviceUserLogin?: string | null): string {
  return serviceUserLogin && userLogin === serviceUserLogin
    ? "trading"
    : `trading:${userLogin}`;
}

/**
 * Inverse of tradingAgentName: the user login an instance name
 * encodes. The bare "trading" instance encodes the service identity —
 * null when none is configured (callers fail closed).
 */
export function tradingAgentUserLogin(instanceName: string, serviceUserLogin?: string | null): string | null {
  return instanceName.startsWith("trading:")
    ? instanceName.slice("trading:".length)
    : (serviceUserLogin ?? null);
}

/**
 * Caller helper: the TradingAgent stub for a user, or null when the
 * TRADING_AGENT binding is not configured (callers degrade gracefully,
 * matching the ReportAssetAgent helper pattern).
 */
export function getTradingAgentStub(env: Env, userLogin: string): any | null {
  const ns = (env as any).TRADING_AGENT;
  if (!ns) return null;
  return ns.get(ns.idFromName(tradingAgentName(userLogin, getServiceUserLogin(env))));
}
