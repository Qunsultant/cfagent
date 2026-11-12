import { type OptionsStrategyDeps } from "../nlqOptionsStrategy";
import type { ProfileRef, ScanRunStore } from "../../trading";
import type { AgentScheduleItem, OptionScreenRejection, StockScreenerFilter, StockScreenLedger, StockScreenResult } from "../../types";
import { NLQPlan } from "./schema";
export interface NLQValidationResult {
  validated: boolean;
  isValid?: boolean;
  model: string;
  domain: string;
  detectedDomain?: string;
  action?: string;
  suggestedAction?: string;
  interpretation: string;
  confidence?: number;
  corrected?: boolean;
  preventedStockScreenerFallback?: boolean;
}

export interface NLQQueryResult {
  plan: NLQPlan;
  count: number;
  domain: string;
  targetTable?: string;
  summary?: string;
  rows: Array<Record<string, unknown>>;
  executedAt: string;
  status?: string;
  reconciled?: boolean;
  planSource?: "llm" | "fastpath" | "fallback" | "llm_validated";
  llmValidation?: NLQValidationResult;
  discrepancy?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  /** Issue #27: id of the persisted scan run (options_opportunities
   *  only, when the caller threaded a ScanRunStore through). */
  scanRunId?: string;
  /** Issue #14: id of the persisted discovery run (the unified
   *  options_fit_discovery action's scope leg only, when the caller
   *  threaded a discovery runner through). */
  discoveryRunId?: string;
  /** Issue #27: whether the scan run was persisted; false means a
   *  store was supplied but its save failed (the scan still succeeded). */
  persisted?: boolean;
  /** Issue #28: the saved strategy profile an options action ran under
   *  (id + name + version), when one was selected in the question. */
  profileRef?: ProfileRef | null;
  scanLedger?: StockScreenLedger | Record<string, unknown>;
  discovery?: StockScreenResult["discovery"];
  validationError?: string;
  quoteQuality?: {
    maxAgeSeconds?: number;
    referenceAgeSeconds?: number;
    staleContractsReturned: number;
    unknownFreshnessContracts: number;
    freshestStaleQuoteAgeSeconds?: number;
  };
  rejections?: OptionScreenRejection[];
  fetchErrors?: Array<{ symbol: string; reason: string }>;
  warnings?: string[];
  displayMarkdown?: string;
  movers?: StockScreenResult["movers"];
}

/**
 * Issue #109: narrow port over the hosting Agent's Cloudflare Agents
 * scheduling API. The orchestrator binds its own schedule /
 * scheduleEvery / cancelSchedule / listSchedules methods into this
 * shape and injects it through the NLQ execution deps, so scheduling
 * plans arm REAL SDK schedules (persisted in cf_agent_schedules) and
 * return REAL schedule ids. Contexts without a port (e.g. the MCP
 * facade) get honest failures from the scheduling executor instead of
 * fabricated success.
 */
export interface NLQSchedulingPort {
  schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean }
  ): Promise<AgentScheduleItem>;
  scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem>;
  cancelSchedule(id: string): Promise<boolean>;
  listSchedules(): Promise<AgentScheduleItem[]>;
}

/** The service-run shape the stock-screen port returns: the fields of
 *  the ScreenerAgent's run result the NLQ envelope is built from
 *  (structural — the agent's ScreenerRunResult satisfies it). */
export interface NLQStockScreenRunResult {
  timestamp: string;
  universe: string;
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  filterSummary?: string;
  discoveryMessage: string;
  error?: string;
  pdfKey?: string;
  rejections?: Array<{ symbol: string; reason: string }>;
  allStocks: Array<{
    symbol: string;
    companyName: string;
    sector?: string;
    lastPrice: number;
    changePercent: number;
    source: string;
  }>;
  opportunities: Array<{ symbol: string }>;
}

/**
 * Issue #982: narrow port over the stock screening service — the
 * ScreenerAgent pipeline the REST /etrade/screen route delegates to
 * (issue #261). The orchestrator binds its getScreenerAgent stub into
 * this shape and injects it through the NLQ execution deps, so NLQ
 * stock screens run through the same service (and persist like REST
 * runs) instead of the executor's local listings screener. Contexts
 * without a port (e.g. the MCP facade, the synchronous executor —
 * a Durable Object call is async-only, the #109 constraint) keep the
 * pre-#982 behaviour, exactly as store-less scan contexts do (#27).
 */
export interface NLQStockScreenPort {
  runScreen(req: {
    filters: StockScreenerFilter;
    userLogin: string;
  }): Promise<NLQStockScreenRunResult>;
}

/** Issue #1077 Phase 5b slice 2: narrow port over the durable social
 *  brief store — the NLQ executor's only write path for briefs. The
 *  orchestrator binds it from SESSION_STORE for the trusted agent
 *  /nlq route; contexts without a port (MCP facade, Slack, async
 *  jobs, the webhook-forwarded route) get honest failures from the
 *  executor instead of fabricated success. */
export interface NLQSocialBriefPort {
  setBrief(req: { date: string; text: string }): Promise<void>;
}

/** Execution deps for executeNLQQueryAsync: the options-strategy deps
 *  plus the optional scheduling port (issue #109) and the optional
 *  stock-screen port (issue #982). */
export interface NLQExecutionDeps extends OptionsStrategyDeps {
  schedulingPort?: NLQSchedulingPort;
  /**
   * Issue #3122 — the agent schedule capability, bound by the
   * orchestrator (which owns the env + DO sql + audit sink). When
   * present, NLQ schedule actions route through it (PDP, classifier,
   * approval gate, agent provenance, ledger audit); when absent the
   * executor still enforces the F1 allow-list and stamps agent
   * provenance, but cannot PDP-enforce — those callers are recorded
   * in #3122's §15 as remaining work.
   */
  agentScheduleCapability?: import("../../services/agentScheduleCapability").AgentScheduleExecutorDeps;
  stockScreenPort?: NLQStockScreenPort;
  socialBriefPort?: NLQSocialBriefPort;
  /**
   * #1686: optional DO blob handle for full capture on the port-less
   * listings-screener fallback legs. Unset → today's outcome-only contract.
   */
  storage?: import("../../trading").NasdaqUniverseRouteBundleInput["storage"];
}

export interface NLQPlanOptions {
  preferLLM?: boolean;
  skipLLM?: boolean;
  context?: string;
  validateWithLLM?: boolean;
  /**
   * #767/#862: the question is untrusted inbound content (e.g. an external
   * email body). The LLM planner and validator then apply instruction/data
   * separation: a system rule that delimited content is data, never
   * instructions, and the question is wrapped in untrusted-content
   * delimiters. Trusted channels (chat/MCP) leave this unset and their
   * prompt assembly is unchanged.
   */
  untrustedContent?: boolean;
}
