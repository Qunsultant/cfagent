/**
 * Pinning & completeness tests for #5041 — MCP registry completeness:
 *  - H-9: Sync-set completeness (every registered MCP tool is explicitly
 *         classified as synchronous or queued; no silent uncategorized queueing)
 *  - H-15: Paid-tool queueing guarantee (queueing paid_options_screener /
 *          paid_market_research does not charge at queue time)
 *  - H-15 / H-9: query_table_data allowlist gating (ALLOWED_QUERY_TABLES)
 */
import { describe, expect, it, vi } from "vitest";
import { isSynchronousMcpTool, SYNCHRONOUS_MCP_TOOLS } from "../src/config/asyncJobModes";
import {
  ALLOWED_QUERY_TABLES,
  McpToolFactory,
  QueryTableDataCommand,
} from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { McpAgentToolAdapter } from "../src/agents/mcpAdapter";

/**
 * Explicit set of registered MCP tools intentionally routed to async job
 * queueing when `submitJob` is available (#5041). Adding a new tool to
 * `McpToolFactory` without classifying it in `SYNCHRONOUS_MCP_TOOLS` or
 * `QUEUED_MCP_TOOLS` fails the completeness pin below.
 */
const QUEUED_MCP_TOOLS = new Set<string>([
  "list_database_tables",
  "query_table_data",
  "manage_categories",
  "manage_ads",
  "manage_watchlists",
  "manage_referrals",
  "get_revenue_summary",
  "list_scheduled_reports",
  "get_scheduled_report",
  "run_stock_screen",
  "run_options_strategy_screen",
  "paid_options_screener",
  "paid_market_research",
  "discover_stock_opportunities",
  "run_trade_evaluation",
  "list_agent_learnings",
  "record_agent_learning",
  "trigger_agent_reflection",
  "get_trade_history",
  "get_audit_log",
  "create_scheduled_task",
  "list_scheduled_tasks",
  "toggle_scheduled_task",
  "delete_scheduled_task",
  "trigger_scheduled_task",
  "get_pipeline_definition",
  "list_pipeline_definitions",
  "get_job_artifacts",
  "list_job_run_records",
  "get_latest_feed_dataset",
  "get_index_list",
  "list_index_lists",
  "upsert_index_list",
  "get_autopilot_status",
  "set_autopilot_mode",
  "trigger_autopilot_cycle",
  "list_strategy_reviews",
  "approve_strategy_promotion",
  "reject_strategy_promotion",
  "get_calibration_decisions",
  "apply_calibration_decision",
  "reject_calibration_decision",
  "browser_scrape_tables",
  "knowledge_search",
  "query_platform_knowledge",
  "draft_payment",
  "confirm_payment_draft",
  "get_payment_gateways",
  "get_transactions",
  "execute_nlq",
  "manage_external_ads",
  "manage_session_memory",
  "get_audit_events",
  "alpaca_get_option_chain",
  "trading_limits",
  "alpaca_cancel_order",
  "alpaca_replace_order",
  "alpaca_exercise_option",
  "alpaca_cancel_ticker",
  "alpaca_cancel_all",
  "broker_account_binding",
  "foss_get_quote",
  "foss_company_fundamentals",
  "foss_historical_bars",
  "foss_market_research",
  "foss_alpaca_snapshot",
  "foss_alpaca_account",
  "foss_alpaca_positions",
  "foss_alpaca_orders",
  "foss_alpaca_place_order",
  "run_research_job",
  "define_pipeline_chain",
  "ai_search_financial_docs",
  "ai_search_agent_search",
  "execute_durable_twap",
  "goal.compile",
  "goal.schedule",
  "chain.run",
  "list_scheduled_goals",
  "trigger_scheduled_goal",
  "get_trading_accounts",
  "get_trading_positions",
  "get_trading_quote",
  "list_report_assets",
  "get_report_asset",
  "get_trade_approval_status",
  "options_copilot_stage_control",
]);

describe("#5041 MCP registry completeness", () => {
  it("reconciles McpToolFactory registered tools against MCP_TOOL_SCOPES and sync/queued sets", () => {
    const registered = McpToolFactory.getAllTools().map((t) => t.name);
    expect(registered.length).toBeGreaterThan(0);

    // Every registered tool must have a permission scope
    const missingScopes = registered.filter((name) => !(name in MCP_TOOL_SCOPES));
    expect(missingScopes).toEqual([]);

    // Every registered tool must be explicitly classified as synchronous or queued
    const unclassified = registered.filter(
      (name) => !isSynchronousMcpTool(name) && !QUEUED_MCP_TOOLS.has(name),
    );
    if (unclassified.length > 0) {
      throw new Error(`Unclassified MCP tools (add to SYNCHRONOUS_MCP_TOOLS or QUEUED_MCP_TOOLS): ${unclassified.join(", ")}`);
    }
    expect(SYNCHRONOUS_MCP_TOOLS.size).toBeGreaterThan(0);
  });

  it("gates query_table_data to ALLOWED_QUERY_TABLES and rejects sensitive tables", async () => {
    const cmd = new QueryTableDataCommand();
    const getTableData = vi.fn().mockReturnValue({ rows: [], total: 0 });
    const ctx = { orm: { getTableData } } as never;

    expect(ALLOWED_QUERY_TABLES.has("mas_categories")).toBe(true);
    await cmd.execute({ tableName: "mas_categories" }, ctx);
    expect(getTableData).toHaveBeenCalledTimes(1);

    for (const sensitive of ["mas_events", "mas_transactions", "mas_trades", "mas_policy_verdicts", "mas_settings"]) {
      await expect(cmd.execute({ tableName: sensitive }, ctx)).rejects.toThrow(
        /not in ALLOWED_QUERY_TABLES/,
      );
    }
    expect(getTableData).toHaveBeenCalledTimes(1);
  });

  it("queueing paid_options_screener returns queued receipt without executing payment", async () => {
    const cmd = McpToolFactory.getTool("paid_options_screener")!;
    expect(cmd).toBeDefined();
    const submitJob = vi.fn().mockResolvedValue({ jobId: "job-paid-1", status: "queued" });
    const authorize = vi.fn().mockResolvedValue({ allowed: true });
    const adapted = McpAgentToolAdapter.adapt(cmd, {
      submitJob,
      permissionPort: {
        getScopesForPrincipal: async () => new Set(["mcp:payments"]),
        authorize,
      } as never,
      principal: { kind: "user", login: "alice" },
      sessionId: "sess-1",
    } as never);

    const out = await adapted.execute({ symbols: ["AAPL"] });
    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out)).toContain("job-paid-1");
  });
});
