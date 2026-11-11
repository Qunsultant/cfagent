/**
 * Issue #3839 — Stock Copilot on any declared broker/mode.
 *
 * Pins:
 * 1. The catalog declares Alpaca paper/live, E*TRADE paper/live, and
 *    Public paper/live as copilot-capable; the list is derived, never
 *    hand-written. (Public joins in #3990: TEST maps to the paper
 *    bucket and placement there is refused with
 *    FAILURE_PUBLIC_NO_PAPER_MODE — Public has no paper trading.)
 * 2. The copilot selection resolves each of the six combinations, and an
 *    absent selection still resolves to Alpaca paper.
 * 3. The prompt steering names the ACTIVE broker's tools/mode and bracket
 *    semantics; Alpaca/paper keeps the byte-identical default block.
 * 4. E*TRADE preview converts +4%/-2% to exact legs and refuses bracket
 *    placement honestly (no unprotected parent).
 * 5. Alpaca refuses a GTC bracket before broker contact.
 * 6. E*TRADE and mesh trading tools are synchronous under HTTP delivery.
 * 7. The NLQ order parser reads take-profit/stop-loss percentages.
 */
import { describe, it, expect, vi } from "vitest";
import {
  brokerCopilotCapability,
  copilotBrokerIds,
  resolveBrokerSelection,
} from "../src/trading";
import { resolveCopilotTradingSelection } from "../src/agents/copilotTradingMode";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";
import {
  buildStockCopilotMcpSteering,
  STOCK_COPILOT_MCP_STEERING,
} from "../src/agents/chatPrompt";
import { extractOrderParameters } from "../src/agents/nlq/orderParams";
import { isSynchronousMcpTool } from "../src/config/asyncJobModes";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import type { Env } from "../src/types";

const COMBOS = [
  { broker: "alpaca", environment: "TEST", mode: "paper" },
  { broker: "alpaca", environment: "PROD", mode: "live" },
  { broker: "etrade", environment: "TEST", mode: "paper" },
  { broker: "etrade", environment: "PROD", mode: "live" },
  // Issue #3990: Public joins the copilot brokers — TEST is the paper
  // bucket (placement refused, no paper mode) and PROD is live.
  { broker: "public", environment: "TEST", mode: "paper" },
  { broker: "public", environment: "PROD", mode: "live" },
] as const;

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("broker_3839");
  return orm;
}

describe("catalog-derived copilot capability (#3839)", () => {
  it("declares every current broker and mode, including all six copilot combinations", () => {
    for (const combo of COMBOS) {
      const resolved = resolveBrokerSelection({
        broker: combo.broker,
        environment: combo.environment,
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.broker).toBe(combo.broker);
      expect(resolved!.tradingType).toBe(combo.mode);
      expect(brokerCopilotCapability(combo.broker).supported).toBe(true);
    }
    expect(copilotBrokerIds().sort()).toEqual(["alpaca", "etrade", "public"]);
  });

  it("declares bracket semantics per broker: Alpaca native, E*TRADE preview", () => {
    expect(brokerCopilotCapability("alpaca").bracketOrders).toBe("native");
    expect(brokerCopilotCapability("etrade").bracketOrders).toBe("preview");
    expect(brokerCopilotCapability("alpaca").percentBrackets).toBe(true);
    expect(brokerCopilotCapability("etrade").percentBrackets).toBe(true);
  });

  it("resolves each stored broker + environment as the copilot selection", async () => {
    for (const combo of COMBOS) {
      const commercial = {
        getTenantBrokerSelection: vi.fn(async () => combo.broker),
      } as any;
      const selection = await resolveCopilotTradingSelection({
        env: {} as Env,
        commercial,
        readSettingRaw: (key) =>
          key === BROKER_ENVIRONMENT_SETTING_KEY ? combo.environment : null,
      });
      expect(selection.resolved).toBe(true);
      if (!selection.resolved) continue;
      expect(selection.selection.brokerId).toBe(combo.broker);
      expect(selection.selection.mode).toBe(combo.mode);
      expect(selection.selection.environment).toBe(combo.environment);
    }
  });

  it("keeps Alpaca paper as the absent-selection default", async () => {
    const selection = await resolveCopilotTradingSelection({
      env: {} as Env,
      commercial: { getTenantBrokerSelection: async () => null } as any,
      readSettingRaw: () => null,
    });
    expect(selection.resolved).toBe(true);
    if (!selection.resolved) return;
    expect(selection.selection.brokerId).toBe("alpaca");
    expect(selection.selection.mode).toBe("paper");
  });
});

describe("broker-aware Stock Copilot steering (#3839)", () => {
  const etrade = brokerCopilotCapability("etrade");
  const alpaca = brokerCopilotCapability("alpaca");

  it("names E*TRADE tools and paper mode for an E*TRADE selection", () => {
    const steering = buildStockCopilotMcpSteering({
      brokerId: "etrade",
      brokerLabel: "E*TRADE",
      mode: "paper",
      environment: "TEST",
      tools: etrade.tools,
      bracketOrders: etrade.bracketOrders,
      percentBrackets: etrade.percentBrackets,
    });
    expect(steering).toContain("E*TRADE · paper (TEST)");
    expect(steering).toContain("tool_openaimp_etrade_preview_order");
    expect(steering).toContain("tool_openaimp_etrade_execute_order");
    expect(steering).not.toContain("tool_openaimp_alpaca_preview_order");
    expect(steering).toMatch(/Bracket exits are a DRAFT/);
  });

  it("names Alpaca tools and live mode for an Alpaca live selection", () => {
    const steering = buildStockCopilotMcpSteering({
      brokerId: "alpaca",
      brokerLabel: "Alpaca",
      mode: "live",
      environment: "PROD",
      tools: alpaca.tools,
      bracketOrders: alpaca.bracketOrders,
      percentBrackets: alpaca.percentBrackets,
    });
    expect(steering).toContain("Alpaca · live (PROD)");
    expect(steering).toContain("tool_openaimp_alpaca_place_order");
    expect(steering).not.toContain("tool_openaimp_etrade_preview_order");
    expect(steering).toMatch(/Bracket exits are NATIVE/);
  });

  it("keeps the original Alpaca/paper steering byte-identical", () => {
    const steering = buildStockCopilotMcpSteering({
      brokerId: "alpaca",
      brokerLabel: "Alpaca",
      mode: "paper",
      environment: "TEST",
      tools: alpaca.tools,
      bracketOrders: alpaca.bracketOrders,
      percentBrackets: alpaca.percentBrackets,
    });
    expect(steering).toBe(STOCK_COPILOT_MCP_STEERING);
  });
});

describe("E*TRADE percent bracket preview (#3839)", () => {
  it("converts +4%/-2% from the user limit and marks the draft preview-only", async () => {
    const orm = makeOrm();
    const platform = new ETradeTradingPlatform(
      { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env,
      orm,
      "trader_3839",
    );
    const draft = await platform.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 100,
      takeProfitPercent: 4,
      stopLossPercent: 2,
    });
    expect(draft.orderClass).toBe("bracket");
    expect(draft.takeProfit).toEqual({ limitPrice: 104 });
    expect(draft.stopLoss).toEqual({ stopPrice: 98 });
    expect(draft.takeProfitPercent).toBe(4);
    expect(draft.stopLossPercent).toBe(2);
    expect(draft.previewMessage).toContain("take-profit $104.00");
    expect(draft.previewMessage).toContain("E*TRADE preview only");
  });

  it("refuses to place a bracket draft rather than leaving the parent unprotected", async () => {
    const orm = makeOrm();
    const platform = new ETradeTradingPlatform(
      { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env,
      orm,
      "trader_3839",
    );
    const draft = await platform.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 100,
      takeProfitPercent: 4,
      stopLossPercent: 2,
    });
    await expect(
      platform.executeOrder(draft.orderId, "did:user:github:trader_3839", "approved"),
    ).rejects.toThrow(/E\*TRADE bracket preview/);
    expect(orm.trades.findById(draft.orderId)?.status).toBe("previewed");
  });
});

describe("RCA residuals (#3839)", () => {
  it("refuses an Alpaca GTC bracket before broker contact", async () => {
    const cmd = McpToolFactory.getTool("alpaca_place_order")!;
    const res = await cmd.execute(
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "limit",
        limit_price: 100,
        take_profit_pct: 4,
        stop_loss_pct: 2,
        time_in_force: "gtc",
      },
      { env: {} as Env, orm: makeOrm(), sessionId: "s", audit: vi.fn() } as any,
    );
    expect(res.success).toBe(false);
    expect(res.refusal).toBe("bracket_requires_day_tif");
  });

  it("keeps E*TRADE and mesh trading tools synchronous", () => {
    for (const name of [
      "etrade_get_quote",
      "etrade_preview_order",
      "etrade_execute_order",
      "propose_stock_trade",
      "propose_options_trade",
      "start_trade_approval",
      "decide_trade_approval",
    ]) {
      expect(isSynchronousMcpTool(name)).toBe(true);
    }
  });

  it("parses +4% take-profit and -2% stop-loss from the order prompt", () => {
    const params = extractOrderParameters(
      "Draft a limit buy order for 10 AAPL with +4% take-profit and -2% stop-loss bracket exits",
    );
    expect(params).not.toBeNull();
    expect(params!.symbol).toBe("AAPL");
    expect(params!.quantity).toBe(10);
    expect(params!.takeProfitPercent).toBe(4);
    expect(params!.stopLossPercent).toBe(2);
  });
});
