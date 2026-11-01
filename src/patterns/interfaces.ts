/**
 * SOLID, GoF, and GRASP Architectural Contracts
 *
 * Principles Applied:
 * - ISP (Interface Segregation Principle): Focused, cohesive contracts instead of monolithic types.
 * - DIP (Dependency Inversion Principle): High-level agents & MCP router depend on these abstractions.
 * - GoF Command Pattern: IMcpToolCommand encapsulates tool execution.
 * - GoF Strategy Pattern: IPaymentGatewayStrategy for multi-processor execution.
 * - GoF Observer Pattern: IAuditPublisher & IAuditObserver for decoupled event streaming.
 * - GoF Facade & GRASP Controller: IMcpSystemFacade coordinates platform subsystems.
 */

import type { z } from "zod";
import type { AsyncJobSubmission, Env, MarketDataResearchQuote, MarketDataResearchCompanyFundamentals, MarketDataResearchHistoricalBar, AlpacaMarketSnapshot } from "../types";
import type { DatabaseORM } from "../orm";
import type { AdsRevenueScopedModes } from "../config/adsRevenueModes";
import type { SupportedGateway, CreateCheckoutParams, CheckoutResult, RefundParams, RefundResult, GatewayStatus } from "../services/payments";
import type { DidAttestationProof } from "../agents/did";

/**
 * Context provided to every tool command during execution
 */
export interface McpToolContext {
  env: Env;
  orm: DatabaseORM;
  sessionId: string;
  /**
   * #1686: optional DO blob handle for full capture, populated by the
   * execution-context owner (chat turns); unset → today's outcome-only
   * contract. Tools that ignore it are unaffected.
   */
  storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"];
  /**
   * #1721: optional session/user carriers for the categories /
   * referrals / external-ads switches (run comes from the per-call
   * `mode` input, global env from `env`). Populated by the
   * execution-context owner; unset carriers fall through to env.
   */
  scopedModes?: AdsRevenueScopedModes;
  /**
   * #1722: optional session/user carriers for the NLQ_MODE switch
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/nlqModes.ts.
   */
  scopedNlqModes?: import("../config/nlqModes").NlqScopedModes;
  /**
   * #2488: optional session/user carriers for the CHAT_NLQ_MODE
   * switch (global env from `env`). Populated by the
   * execution-context owner; unset carriers fall through to env
   * and then to the built-in default (off). See
   * src/config/chatNlqModes.ts. Governs the turn's tool assembly
   * only — never NLQ execution itself.
   */
  scopedChatNlqModes?: import("../config/chatNlqModes").ChatNlqScopedModes;
  /**
   * #2488: binding-seam overrides for the mesh screen door
   * (run_stock_screen), populated ONLY by test harnesses through
   * the executor-shaped context. Production contexts (turn,
   * async-job executor, /mcp) never set it: the door then
   * derives every seam from `env` (see
   * src/agents/orchestrator/meshScreenDoor.ts,
   * MeshScreenDoorSeams).
   */
  meshScreenDoorSeams?: import("../agents/orchestrator/meshScreenDoor").MeshScreenDoorSeams;
  /**
   * #2581: binding-seam overrides for the mesh options-strategy
   * door (run_options_strategy_screen), populated ONLY by test
   * harnesses through the executor-shaped context. Production
   * contexts (turn, async-job executor, /mcp) never set it: the
   * door then composes every seam from env/orm (see
   * src/agents/orchestrator/meshOptionsStrategyDoor.ts,
   * MeshOptionsStrategyDoorSeams).
   */
  meshOptionsStrategyDoorSeams?: import("../agents/orchestrator/meshOptionsStrategyDoor").MeshOptionsStrategyDoorSeams;
  /**
   * #1723: optional session/user carriers for the KNOWLEDGE_MODE switch
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/knowledgeMemoryModes.ts.
   */
  scopedKnowledgeModes?: import("../config/knowledgeMemoryModes").KnowledgeScopedModes;
  /**
   * #1723: optional session/user carriers for the MEMORY_READ_MODE
   * switch (run comes from the per-call `mode` input / REST `?mode=`,
   * global env from `env`). Populated by the execution-context
   * owner; unset carriers fall through to env. Covers the read cap
   * only — never remember/delete/clear.
   */
  scopedMemoryModes?: import("../config/knowledgeMemoryModes").MemoryScopedModes;
  /**
   * #1724: optional session/user carriers for the HTTP_DELIVERY_MODE
   * switch (run comes from the per-request `x-delivery-mode` header
   * on the /mcp POST, global env from `env`). Populated by the
   * execution-context owner; unset carriers fall through to env.
   * See src/config/asyncJobModes.ts. Governs tools/call wrapping
   * only — get_async_job / list_async_jobs are never wrapped.
   */
  scopedHttpDeliveryModes?: import("../config/asyncJobModes").HttpDeliveryScopedModes;
  /**
   * #1724: optional session/user carriers for the JOB_LIST_ENVELOPE
   * switch (run comes from the per-call `envelope` input, global env
   * from `env`). Populated by the execution-context owner; unset
   * carriers fall through to env. Covers the list envelope only —
   * never the single-job full record. See src/config/asyncJobModes.ts.
   */
  scopedJobListModes?: import("../config/asyncJobModes").JobListScopedModes;
  /**
   * #1726: optional session/user carriers for the E*TRADE switches
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/etradeModes.ts. The execute
   * gate is never carried here — it is not configurable.
   */
  scopedEtradeModes?: import("../config/etradeModes").EtradeScopedModes;
  /**
   * #1727: optional session/user carriers for the market-data switches
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/marketDataModes.ts.
   */
  scopedMarketDataModes?: import("../config/marketDataModes").MarketDataScopedModes;
  /**
   * #1728: optional session/user carriers for the agentic-payments +
   * premium-gating switches (run comes from the per-call `mode`
   * input, global env from `env`). Populated by the execution-context
   * owner; unset carriers fall through to env. See
   * src/config/agenticPaymentsModes.ts. The confirm gap and the
   * premium gate are never carried here — they are not configurable.
   */
  scopedPaymentsModes?: import("../config/agenticPaymentsModes").PaymentsScopedModes;
  /**
   * #1729: optional session/user carriers for the GOAL_COMPILE_MODE
   * switch (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/goalChainModes.ts. The
   * carrier NEVER carries a tenant: tenant resolution stays
   * resolveIaaaTenant(env) on both surfaces (G04 guard).
   */
  scopedGoalChainModes?: import("../config/goalChainModes").GoalChainScopedModes;
  requestId?: string;
  /**
   * #1744: MCP tool permission carriers, populated by the
   * execution-context owner; unset carriers fall through to the
   * factory defaults (system principal for in-process platform
   * callers, production port, no stream sink). The /mcp boundary
   * (mcpChatNlq) always sets `principal` from the forwarded
   * identity headers; agent turns set kind agent-turn.
   */
  principal?: import("../mcps/openaimp/mcpPermissionPorts").McpPrincipal;
  permissionPort?: import("../mcps/openaimp/mcpPermissionPorts").ToolPermissionPort;
  permissionDecisionSink?: import("../observability/observabilityPorts").ObservabilitySink;
  /** #1744: execution id of the gated execution running this command (correlation only). */
  executionId?: string;
  /**
   * #2341 (Agent Mesh S5): resolver for the acting user's login,
   * populated ONLY by a server-side context owner — the chat turn
   * (from its turn stash) and the async-job executor (from the
   * identity the turn adapter stamped into the job payload at queue
   * time). It is a resolver, not a value, so turn contexts built
   * before the turn stash exists still read the identity at
   * execution time. Never populated from tool arguments or caller
   * headers. Unset (external MCP callers, unattended paths) means
   * NO acting identity: identity-gated commands (the mesh doors)
   * fail closed.
   */
  actingLogin?: () => string | undefined;
  /**
   * #2428 (Agent Mesh S17): resolver for the current mesh
   * trace's W3C traceparent, populated ONLY by a server-side
   * context owner — the chat turn (minted on the turn stash)
   * and the async-job executor (from the traceparent the turn
   * adapter stamped into the job payload at queue time), under
   * exactly the S5 actingLogin discipline. It is a resolver,
   * not a value, and it is never populated from tool arguments
   * or caller headers. Unset means the call runs outside a
   * traced turn: trace recording for the call is skipped (a
   * recorded break in the registry spine), never fabricated.
   */
  traceparent?: () => string | undefined;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
  facade?: IMcpSystemFacade;
  submitJob?: (job: AsyncJobSubmission) => Promise<{
    jobId: string;
    status: "queued";
    statusUrl: string;
  }>;
  getJob?: (jobId: string) => unknown;
  listJobs?: () => unknown[];
}

/**
 * GoF Command Pattern: Encapsulates a platform capability as an executable tool.
 * Satisfies SRP (single responsibility per command) and LSP (substitutable execution).
 */
export interface IMcpToolCommand<TInput = any, TOutput = any> {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  readonly zodSchema: z.ZodType<TInput>;

  execute(input: TInput, context: McpToolContext): Promise<TOutput>;
}

/**
 * GoF Strategy Pattern: Encapsulates payment provider processing algorithms.
 * Allows runtime switching between Stripe, PayPal, Lemon Squeezy, and Sandbox.
 */
export interface IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway;
  readonly name: string;
  
  isConfigured(env: Env): boolean;
  getStatus(env: Env): GatewayStatus;
  createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult>;
  executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult>;
}

/**
 * Audit Event Payload
 */
export interface AuditEvent {
  id: string;
  sessionId: string;
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * GoF Observer Pattern: Observer contract for audit/observability listeners.
 */
export interface IAuditObserver {
  onAuditEvent(event: AuditEvent): Promise<void> | void;
}

/**
 * GoF Observer Pattern: Subject contract for publishing system events.
 */
export interface IAuditPublisher {
  subscribe(observer: IAuditObserver): () => void;
  publish(type: string, agent: any, payload: Record<string, unknown>): void;
}

/**
 * GoF Facade & GRASP Controller Pattern:
 * Unified high-level interface encapsulating ORM, Payments, NLQ, Memory, and DIDs.
 */
export interface IMcpSystemFacade {
  readonly orm: DatabaseORM;
  readonly env: Env;
  readonly sessionId: string;
  readonly auditPublisher: IAuditPublisher;

  // Subsystem Operations
  executeNlq(query: string): Promise<any>;
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult>;
  executeRefund(params: RefundParams): Promise<RefundResult>;
  getGatewayStatuses(): GatewayStatus[];
  createAttestation(params: {
    draftId: string;
    action: string;
    amount: number;
    currency: string;
    customer: string;
    gateway: SupportedGateway;
    proposerDid?: string;
  }): Promise<DidAttestationProof>;
  publishAudit(type: string, agent: any, payload: Record<string, unknown>): void;
}

/**
 * GoF Strategy Pattern: Market Data Provider Strategy contract for market-data research & quoting
 * Implemented by YahooFinanceProvider, AlpacaMarketDataProvider, and HybridMarketDataProvider.
 */
export interface IMarketDataProvider {
  readonly providerId: "yfinance" | "alpaca" | "hybrid";
  readonly name: string;
  isConfigured(env?: Env): boolean;
  getQuote(symbol: string): Promise<MarketDataResearchQuote>;
  getFundamentals(symbol: string): Promise<MarketDataResearchCompanyFundamentals>;
  getHistoricalBars(symbol: string, timeframe?: string, limit?: number): Promise<MarketDataResearchHistoricalBar[]>;
  getMarketSnapshot?(symbol: string): Promise<AlpacaMarketSnapshot>;
}
