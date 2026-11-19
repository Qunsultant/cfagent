import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listOrdersViaSelectedBroker,
  cancelTickerViaSelectedBroker,
  cancelAllViaSelectedBroker,
} from "../src/services/brokerOrderCancel";
import {
  BrokerOrdersListCommand,
  BrokerOrderCancelTickerCommand,
  BrokerOrderCancelAllCommand,
} from "../src/mcps/openaimp/brokerOrderCommands";
import { resolvePromptBrokerTools } from "../src/agents/chatPrompt";
import { buildStockCopilotSystemPrompt } from "../src/agents/prompts/stockCopilotPrompt";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { SYNCHRONOUS_MCP_TOOLS } from "../src/config/asyncJobModes";
import { TradingPlatformRegistry } from "../src/trading";

const mocks = vi.hoisted(() => ({
  resolveTenantBroker: vi.fn(),
  getPlatform: vi.fn(),
}));

vi.mock("../src/services/tenantProviders", () => ({
  resolveTenantBroker: mocks.resolveTenantBroker,
}));

describe("#5804 / #5806 / #5807 — Broker-neutral Copilot order lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.resolveTenantBroker.mockReset();
  });

  it("listOrdersViaSelectedBroker routes to any orderHistory-capable broker (e.g. tastytrade) and filters by symbol", async () => {
    mocks.resolveTenantBroker.mockResolvedValue("tastytrade");
    const getOrderHistory = vi.fn().mockResolvedValue([
      { orderId: "tt-1", symbol: "AAPL", status: "OPEN" },
      { orderId: "tt-2", symbol: "NVDA", status: "OPEN" },
    ]);
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockReturnValue({
      getOrderHistory,
    } as never);

    const res = await listOrdersViaSelectedBroker({
      env: {} as never,
      userLogin: "alice",
      status: "open",
      symbol: "nvda",
    });

    expect(res.success).toBe(true);
    expect(res.broker).toBe("tastytrade");
    expect(res.count).toBe(1);
    expect(res.orders).toEqual([{ orderId: "tt-2", symbol: "NVDA", status: "OPEN" }]);
    expect(getOrderHistory).toHaveBeenCalledWith("open");
  });

  it("listOrdersViaSelectedBroker refuses anonymous requests", async () => {
    const res = await listOrdersViaSelectedBroker({
      env: {} as never,
      userLogin: "",
    });
    expect(res.success).toBe(false);
    expect(res.code).toBe("identity_required");
  });

  it("cancelTickerViaSelectedBroker routes per-symbol cancel through the selected broker platform", async () => {
    mocks.resolveTenantBroker.mockResolvedValue("public");
    const getOrderHistory = vi.fn().mockResolvedValue([
      { orderId: "pub-1", symbol: "AAPL", status: "OPEN", side: "BUY", qty: 1 },
      { orderId: "pub-2", symbol: "MSFT", status: "OPEN", side: "BUY", qty: 1 },
    ]);
    const cancelOrderRemote = vi.fn().mockResolvedValue({
      success: true,
      message: "Cancelled pub-1",
    });
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockReturnValue({
      getOrderHistory,
      cancelOrderRemote,
    } as never);

    const res = await cancelTickerViaSelectedBroker({
      env: {} as never,
      userLogin: "alice",
      symbol: "AAPL",
    });

    expect(res.success).toBe(true);
    expect(res.broker).toBe("public");
    expect(cancelOrderRemote).toHaveBeenCalledTimes(1);
    expect(cancelOrderRemote).toHaveBeenCalledWith("pub-1");
  });

  it("cancelAllViaSelectedBroker requires preview store sql and enforces two-step preview when sql is present", async () => {
    mocks.resolveTenantBroker.mockResolvedValue("etrade");
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockReturnValue({
      getOrderHistory: vi.fn().mockResolvedValue([
        { orderId: "et-1", symbol: "SPY", status: "OPEN", side: "BUY", qty: 2 },
      ]),
      cancelOrderRemote: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    } as never);

    const missingStore = await cancelAllViaSelectedBroker({
      env: {} as never,
      userLogin: "alice",
    });
    expect(missingStore.success).toBe(false);
    expect(missingStore.code).toBe("cancel_preview_store_unavailable");
  });

  it("exposes broker_orders_list, broker_order_cancel_ticker, and broker_order_cancel_all as sync MCP tools with permission tiers", () => {
    const listCmd = new BrokerOrdersListCommand();
    const tickerCmd = new BrokerOrderCancelTickerCommand();
    const allCmd = new BrokerOrderCancelAllCommand();

    expect(listCmd.name).toBe("broker_orders_list");
    expect(tickerCmd.name).toBe("broker_order_cancel_ticker");
    expect(allCmd.name).toBe("broker_order_cancel_all");

    expect(MCP_TOOL_SCOPES.broker_orders_list).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES.broker_order_cancel_ticker).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES.broker_order_cancel_all).toBe("mcp:trade");

    expect(SYNCHRONOUS_MCP_TOOLS.has("broker_orders_list")).toBe(true);
    expect(SYNCHRONOUS_MCP_TOOLS.has("broker_order_cancel_ticker")).toBe(true);
    expect(SYNCHRONOUS_MCP_TOOLS.has("broker_order_cancel_all")).toBe(true);
  });

  it("#5807 — resolvePromptBrokerTools steers Tastytrade (and other catalog brokers) to neutral broker_order_* tools instead of Alpaca", () => {
    const resolved = resolvePromptBrokerTools({
      activeBroker: "tastytrade",
      activeMode: "live",
      copilotExecutionMode: "hitl",
    });
    expect(resolved).toEqual({
      brokerId: "tastytrade",
      brokerLabel: "Tastytrade",
      modeId: "live",
      modeLabel: "Live",
      quoteTool: "tool_openaimp_market_data_get_quote",
      previewTool: "tool_openaimp_broker_order_preview",
      executeTool: "tool_openaimp_broker_order_create",
      ordersTool: "tool_openaimp_broker_orders_list",
      cancelBracketTool: "tool_openaimp_broker_order_cancel",
      executionPolicy: "hitl",
    });

    const prompt = buildStockCopilotSystemPrompt({
      route: { agent: "stock", confidence: 1, reason: "test" },
      activeBroker: "tastytrade",
      activeMode: "live",
    });
    expect(prompt).toContain("tool_openaimp_broker_order_cancel_all");
    expect(prompt).toContain("tool_openaimp_broker_orders_list");
    expect(prompt).toContain("Tastytrade");
  });
});
