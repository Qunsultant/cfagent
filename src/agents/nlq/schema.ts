import { z } from "zod";
import { CREATABLE_SCHEDULE_CALLBACKS } from "../orchestrator/scheduleCallbacks";
/**
 * Assessment P0 (#143): explicit allowlist of tables the NLQ engine is
 * permitted to read through the `table_data` domain. Derived from the
 * tables the product's own planner legitimately targets:
 *  - fast-path intents: mas_categories, mas_referrals, mas_external_ads,
 *    mas_ads, mas_transactions, mas_events, mas_memory
 *  - LLM planner intents (report/dashboard/market data): mas_trades,
 *    mas_watchlists, mas_messages, etrade_portfolio_live, options_flows,
 *    mas_agentic_wallet, etrade_options_screener, etrade_market_screener,
 *    etrade_market_quotes, cf_agent_schedules, yfinance_fundamentals,
 *    market_data_stock_comparison, market_data_research_report, market_data_quote,
 *    etrade_premium_research, etrade_premium_options, alpaca_snapshot,
 *    platform_capabilities
 *
 * Any table not on this list — including SQLite system tables
 * (sqlite_master, sqlite_sequence, …) — is refused at the execution seam.
 * Comparison is case-insensitive because SQLite resolves table names
 * case-insensitively.
 */
export const NLQ_TABLE_ALLOWLIST: ReadonlySet<string> = new Set([
  "mas_categories",
  "mas_referrals",
  "mas_external_ads",
  "mas_ads",
  "mas_transactions",
  "mas_events",
  "mas_memory",
  "mas_trades",
  "mas_watchlists",
  "mas_messages",
  "etrade_portfolio_live",
  "options_flows",
  "mas_agentic_wallet",
  "etrade_options_screener",
  "etrade_market_screener",
  "etrade_market_quotes",
  "cf_agent_schedules",
  "yfinance_fundamentals",
  "market_data_stock_comparison",
  "market_data_research_report",
  "market_data_quote",
  "etrade_premium_research",
  "etrade_premium_options",
  "alpaca_snapshot",
  "platform_capabilities",
]);

/** Returns true iff the NLQ engine may read `tableName` via table_data. */
export function isNlqTableAllowed(tableName: string | undefined | null): boolean {
  if (!tableName) return false;
  return NLQ_TABLE_ALLOWLIST.has(tableName.toLowerCase());
}

export const nlqPlanSchema = z.object({
  domain: z.enum(["tables", "table_data", "category_mutation", "conversation", "trading", "research", "scheduling", "agentic_payments", "custom_query", "social"]).default("conversation"),
  operation: z.enum(["list", "count", "search", "create", "update"]).default("list"),
  targetTable: z.string().optional(),
  categoryData: z
    .object({
      action: z.enum(["create", "update"]).optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
    })
    .optional(),
  tradingData: z
    .object({
      action: z
        .enum([
          "screen",
          "quote",
          "preview_order",
          "execute_order",
          "approve_order",
          "cancel_order",
          "positions",
          "capabilities",
          "options_screen",
          "options_strategies",
          "options_best_trade",
          "options_opportunities",
          "options_fit_discovery",
          "options_comparison",
          "options_stage_control",
          "options_flow",
          "watchlist_save",
          "watchlist_list",
          "watchlist_details",
        ])
        .optional(),
      symbol: z.string().optional(),
      orderAction: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).optional(),
      quantity: z.number().optional(),
      orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
      limitPrice: z.number().optional(),
      relativePriceOffsetPercent: z.number().optional(),
      relativePriceDescription: z.string().optional(),
      takeProfitPercent: z.number().positive().optional(),
      stopLossPercent: z.number().positive().optional(),
      filters: z.record(z.string(), z.any()).optional(),
      strategyFilter: z.record(z.string(), z.any()).optional(),
      request: z.record(z.string(), z.any()).optional(),
      scope: z.record(z.string(), z.any()).optional(),
      watchlistName: z.string().optional(),
      symbols: z.array(z.string()).optional(),
    })
    .optional(),
  researchData: z
    .object({
      action: z.enum(["quote", "fundamentals", "bars", "report", "snapshot", "compare"]).optional(),
      symbol: z.string().optional(),
      symbols: z.array(z.string()).optional(),
      provider: z.enum(["yfinance", "alpaca", "hybrid"]).optional(),
    })
    .optional(),
  scheduleData: z
    .object({
      action: z.enum(["list", "create", "cancel"]),
      scheduleType: z.enum(["delayed", "scheduled", "cron", "interval"]).optional(),
      // Issue #3122 (F1): the NLQ schedule callback is an allow-list,
      // not a free-form string. The reminder plus exactly the four
      // creatable callbacks — a plan naming anything else (notably the
      // internal-only callbacks) fails validation before it can arm.
      callback: z
        .enum(["sendScheduledReminder", ...CREATABLE_SCHEDULE_CALLBACKS])
        .optional(),
      delayInSeconds: z.number().optional(),
      intervalSeconds: z.number().optional(),
      cron: z.string().optional(),
      date: z.string().optional(),
      scheduleId: z.string().optional(),
      description: z.string().optional(),
      // Issue #959: optional screening criteria for the three screening
      // callbacks (autonomousMarketScreen / autonomousOptionsAnalysis /
      // autonomousStrategyDiscovery). Kept loosely typed at the plan
      // layer — the executor validates them strictly through the shared
      // schemas in src/trading/screeningSchemas.ts (buildSchedulePayload)
      // before anything is armed, so a mis-shaped criterion fails the
      // action explicitly instead of arming a silently-wrong schedule.
      sector: z.string().optional(),
      universe: z.string().optional(),
      maxItems: z.number().optional(),
      symbols: z.array(z.string()).optional(),
      thesis: z.string().optional(),
      riskProfile: z.string().optional(),
      // Issue #3122 (F1): goal-screen criteria — without these the
      // builder refuses every autonomousGoalScreen plan (goalKind is
      // required when no scenarioId is supplied), so the allow-list's
      // fourth callback could never actually arm through NLQ.
      goalKind: z.string().optional(),
      scenarioId: z.string().optional(),
      filters: z.record(z.string(), z.unknown()).optional(),
      inputModel: z.string().optional(),
      requests: z.array(z.record(z.string(), z.unknown())).optional(),
      constraintSets: z.array(z.record(z.string(), z.unknown())).optional(),
      profileId: z.string().optional(),
      watchlistName: z.string().optional(),
      // Consolidation #1236 (discovery notifications): per-task
      // delivery recipients for discovery schedules (panel + NLQ
      // full surface). Loosely typed here like the other criteria;
      // buildSchedulePayload validates them strictly before arming.
      // NOTE: the executor copies these three keys ONLY for
      // autonomousStrategyDiscovery — other callbacks' NLQ behavior
      // stays byte-identical.
      emailTo: z.string().optional(),
      slackChannel: z.string().optional(),
      webhookUrl: z.string().optional(),
      // Consolidation C3 (#1277): stage-chain timing for a market
      // screen schedule — loosely typed here like the other criteria;
      // buildSchedulePayload validates it strictly before arming.
      stageChain: z
        .object({
          serveDelaySeconds: z.number().optional(),
          deliverDelaySeconds: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  agenticPaymentsData: z
    .object({
      action: z.enum(["wallet_status", "micropayments_list", "set_limit", "paid_scan", "paid_research"]),
      limitUSD: z.number().optional(),
      symbol: z.string().optional(),
      maxUnderlyings: z.number().int().positive().optional(),
      contractType: z.enum(["CALL", "PUT", "BOTH"]).optional(),
    })
    .optional(),
  socialData: z
    .object({
      action: z.enum(["set_brief"]).optional(),
      text: z.string().optional(),
      dayOffset: z.number().int().min(0).max(1).optional(),
    })
    .optional(),
  planSource: z.enum(["llm", "fastpath", "fallback", "llm_validated"]).optional(),
  terms: z.string().max(200).default(""),
  role: z.enum(["user", "assistant", "any"]).default("any"),
  since: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
});

export type NLQPlan = z.infer<typeof nlqPlanSchema>;
