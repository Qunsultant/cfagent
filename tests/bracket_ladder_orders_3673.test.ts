import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateBracketLadderRungs,
  validateBracketLadderSpec,
  buildLadderFromPatternRange,
  executeBracketLadder,
  cancelBracketLadder,
  type BracketLadderSpec,
} from "../src/services/bracketLadder";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import type { Env } from "../src/types";

describe("Issue #3673 — TOS-style Multi-Bracket Ladder & Grid Orders", () => {
  describe("generateBracketLadderRungs (pure calculation)", () => {
    it("generates ascending buy ladder with $1 increments and paired TP/SL exits", () => {
      const spec: BracketLadderSpec = {
        symbol: "AAPL",
        side: "buy",
        basePrice: 175.0,
        stepIncrement: 1.0,
        tiers: 4,
        quantityPerTier: 10,
        takeProfitDelta: 1.0,
        stopLossDelta: 2.0,
        direction: "ascending",
      };

      const rungs = generateBracketLadderRungs(spec, "lad_test1");
      expect(rungs).toHaveLength(4);

      // Rung 1: 175.00 entry, TP 176.00, SL 173.00
      expect(rungs[0].rungIndex).toBe(1);
      expect(rungs[0].limitPrice).toBe(175.0);
      expect(rungs[0].quantity).toBe(10);
      expect(rungs[0].takeProfitPrice).toBe(176.0);
      expect(rungs[0].stopLossPrice).toBe(173.0);
      expect(rungs[0].clientOrderId).toBe("lad_test1-r1");

      // Rung 2: 176.00 entry, TP 177.00, SL 174.00
      expect(rungs[1].rungIndex).toBe(2);
      expect(rungs[1].limitPrice).toBe(176.0);
      expect(rungs[1].takeProfitPrice).toBe(177.0);
      expect(rungs[1].stopLossPrice).toBe(174.0);
      expect(rungs[1].clientOrderId).toBe("lad_test1-r2");

      // Rung 3: 177.00 entry, TP 178.00, SL 175.00
      expect(rungs[2].rungIndex).toBe(3);
      expect(rungs[2].limitPrice).toBe(177.0);
      expect(rungs[2].takeProfitPrice).toBe(178.0);
      expect(rungs[2].stopLossPrice).toBe(175.0);

      // Rung 4: 178.00 entry, TP 179.00, SL 176.00
      expect(rungs[3].rungIndex).toBe(4);
      expect(rungs[3].limitPrice).toBe(178.0);
      expect(rungs[3].takeProfitPrice).toBe(179.0);
      expect(rungs[3].stopLossPrice).toBe(176.0);
    });

    it("generates descending buy ladder for dip accumulation with custom quantities", () => {
      const spec: BracketLadderSpec = {
        symbol: "NVDA",
        side: "buy",
        basePrice: 120.0,
        stepIncrement: 2.0,
        tiers: 3,
        quantities: [10, 20, 30],
        takeProfitDelta: 3.0,
        stopLossDelta: 4.0,
        direction: "descending",
      };

      const rungs = generateBracketLadderRungs(spec, "lad_dip");
      expect(rungs).toHaveLength(3);

      expect(rungs[0]).toMatchObject({
        rungIndex: 1,
        limitPrice: 120.0,
        quantity: 10,
        takeProfitPrice: 123.0,
        stopLossPrice: 116.0,
      });

      expect(rungs[1]).toMatchObject({
        rungIndex: 2,
        limitPrice: 118.0,
        quantity: 20,
        takeProfitPrice: 121.0,
        stopLossPrice: 114.0,
      });

      expect(rungs[2]).toMatchObject({
        rungIndex: 3,
        limitPrice: 116.0,
        quantity: 30,
        takeProfitPrice: 119.0,
        stopLossPrice: 112.0,
      });
    });

    it("generates ascending sell ladder for profit scaling into resistance", () => {
      const spec: BracketLadderSpec = {
        symbol: "TSLA",
        side: "sell",
        basePrice: 250.0,
        stepIncrement: 5.0,
        tiers: 3,
        quantityPerTier: 15,
        takeProfitDelta: 5.0,
        stopLossDelta: 3.0,
        direction: "ascending",
      };

      const rungs = generateBracketLadderRungs(spec, "lad_sell");
      expect(rungs).toHaveLength(3);

      // Sell short or take profit ladder: TP < Entry < SL
      expect(rungs[0]).toMatchObject({
        rungIndex: 1,
        limitPrice: 250.0,
        takeProfitPrice: 245.0,
        stopLossPrice: 253.0,
      });

      expect(rungs[1]).toMatchObject({
        rungIndex: 2,
        limitPrice: 255.0,
        takeProfitPrice: 250.0,
        stopLossPrice: 258.0,
      });

      expect(rungs[2]).toMatchObject({
        rungIndex: 3,
        limitPrice: 260.0,
        takeProfitPrice: 255.0,
        stopLossPrice: 263.0,
      });
    });
  });

  describe("validateBracketLadderSpec (fail-closed guardrails)", () => {
    it("rejects non-positive step increment", () => {
      const result = validateBracketLadderSpec({
        symbol: "AAPL",
        side: "buy",
        basePrice: 150,
        stepIncrement: 0,
        tiers: 3,
        quantityPerTier: 10,
        takeProfitDelta: 2,
        stopLossDelta: 2,
      });
      expect(result.valid).toBe(false);
      expect(result.refusal).toBe("invalid_ladder_parameters");
      expect(result.message).toContain("stepIncrement must be greater than 0");
    });

    it("rejects tiers outside valid bounds (1 to 20)", () => {
      const tooMany = validateBracketLadderSpec({
        symbol: "AAPL",
        side: "buy",
        basePrice: 150,
        stepIncrement: 1,
        tiers: 25,
        quantityPerTier: 10,
        takeProfitDelta: 2,
        stopLossDelta: 2,
      });
      expect(tooMany.valid).toBe(false);
      expect(tooMany.refusal).toBe("invalid_ladder_parameters");
      expect(tooMany.message).toContain("tiers must be between 1 and 20");
    });

    it("rejects when stop loss price reaches zero or below", () => {
      const result = validateBracketLadderSpec({
        symbol: "PENNY",
        side: "buy",
        basePrice: 2.0,
        stepIncrement: 0.5,
        tiers: 5,
        quantityPerTier: 100,
        takeProfitDelta: 1.0,
        stopLossDelta: 2.5, // 2.0 - 2.5 < 0
        direction: "descending",
      });
      expect(result.valid).toBe(false);
      expect(result.refusal).toBe("invalid_bracket_prices");
      expect(result.message).toContain("Stop-loss price");
      expect(result.message).toContain("must be greater than 0");
    });
  });

  describe("buildLadderFromPatternRange", () => {
    it("computes ladder tiers bounded by support and resistance channel", () => {
      const spec = buildLadderFromPatternRange({
        symbol: "MSFT",
        side: "buy",
        support: 400.0,
        resistance: 420.0,
        tiers: 5,
        quantityPerTier: 5,
        stopLossPadding: 2.0,
      });

      expect(spec.basePrice).toBe(400.0);
      expect(spec.stepIncrement).toBe(5.0); // (420 - 400) / (5 - 1) = 5.0
      expect(spec.takeProfitDelta).toBe(5.0);
      expect(spec.stopLossDelta).toBe(2.0); // anchored just below support
      expect(spec.direction).toBe("ascending");
    });
  });

  describe("executeBracketLadder & cancelBracketLadder with mock service", () => {
    const mockEnv: Env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      ORCHESTRATOR_AGENT: {} as any,
      ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
      ALPACA_DATA_URL: "https://data.alpaca.markets",
      ALPACA_API_KEY: "PKTEST_KEY_3673",
      ALPACA_SECRET_KEY: "SKTEST_SECRET_3673",
      MARKET_DATA_PROVIDER: "hybrid",
    };

    let placedOrders: any[] = [];
    let cancelledOrderIds: string[] = [];

    beforeEach(() => {
      placedOrders = [];
      cancelledOrderIds = [];

      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || "GET";

        if (url.includes("/v2/orders") && method === "POST") {
          const body = JSON.parse(String(init?.body || "{}"));
          const id = `order_${placedOrders.length + 1}`;
          placedOrders.push({ id, ...body });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id,
              client_order_id: body.client_order_id,
              status: "accepted",
              symbol: body.symbol,
              qty: body.qty,
              side: body.side,
              order_class: body.order_class,
              limit_price: body.limit_price,
            }),
          };
        }

        if (url.includes("/v2/orders/") && method === "DELETE") {
          const id = url.split("/").pop() || "";
          cancelledOrderIds.push(id);
          return {
            ok: true,
            status: 204,
            text: async () => "",
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      });
    });

    it("executes all rungs of bracket ladder and produces batch receipt", async () => {
      const receipt = await executeBracketLadder(
        {
          symbol: "AAPL",
          side: "buy",
          basePrice: 175.0,
          stepIncrement: 1.0,
          tiers: 3,
          quantityPerTier: 10,
          takeProfitDelta: 1.5,
          stopLossDelta: 2.0,
          direction: "ascending",
        },
        mockEnv,
      );

      expect(receipt.success).toBe(true);
      expect(receipt.tiersRequested).toBe(3);
      expect(receipt.tiersPlaced).toBe(3);
      expect(receipt.totalQuantity).toBe(30);
      expect(placedOrders).toHaveLength(3);

      expect(placedOrders[0].order_class).toBe("bracket");
      expect(placedOrders[0].take_profit.limit_price).toBe(176.5);
      expect(placedOrders[0].stop_loss.stop_price).toBe(173.0);

      expect(receipt.rungs[0].orderId).toBe("order_1");
      expect(receipt.rungs[1].orderId).toBe("order_2");
      expect(receipt.rungs[2].orderId).toBe("order_3");
    });

    it("cancels multiple order rungs by orderIds", async () => {
      const cancelResult = await cancelBracketLadder(
        {
          orderIds: ["order_1", "order_2", "order_3"],
        },
        mockEnv,
      );

      expect(cancelResult.success).toBe(true);
      expect(cancelResult.cancelledCount).toBe(3);
      expect(cancelledOrderIds).toEqual(["order_1", "order_2", "order_3"]);
    });
  });

  describe("McpToolFactory Integration", () => {
    const mockEnv: Env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      ORCHESTRATOR_AGENT: {} as any,
      ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
      ALPACA_DATA_URL: "https://data.alpaca.markets",
      ALPACA_API_KEY: "PKTEST_KEY_3673",
      ALPACA_SECRET_KEY: "SKTEST_SECRET_3673",
      MARKET_DATA_PROVIDER: "hybrid",
    };

    beforeEach(() => {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || "GET";

        if (url.includes("/v2/orders") && method === "POST") {
          const body = JSON.parse(String(init?.body || "{}"));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: "mcp_order_123",
              client_order_id: body.client_order_id,
              status: "accepted",
              symbol: body.symbol,
              qty: body.qty,
              order_class: "bracket",
            }),
          };
        }

        if (url.includes("/v2/orders/") && method === "DELETE") {
          return {
            ok: true,
            status: 204,
            text: async () => "",
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      });
    });

    it("registers and executes alpaca_place_bracket_ladder via McpToolFactory", async () => {
      const context = {
        env: mockEnv,
        sessionId: "sess_ladder",
        audit: vi.fn(),
      };

      const result = await McpToolFactory.executeTool(
        "alpaca_place_bracket_ladder",
        {
          symbol: "AAPL",
          side: "buy",
          base_price: 180.0,
          step_increment: 1.0,
          tiers: 3,
          qty_per_tier: 5,
          take_profit_delta: 2.0,
          stop_loss_delta: 3.0,
          direction: "ascending",
        },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.tiersPlaced).toBe(3);
      expect(context.audit).toHaveBeenCalledWith(
        "alpaca.bracket_ladder_placed",
        "trading",
        expect.objectContaining({
          symbol: "AAPL",
          side: "buy",
          tiersPlaced: 3,
        }),
      );
    });

    it("registers and executes alpaca_cancel_bracket_ladder via McpToolFactory", async () => {
      const context = {
        env: mockEnv,
        sessionId: "sess_cancel_ladder",
        audit: vi.fn(),
      };

      const result = await McpToolFactory.executeTool(
        "alpaca_cancel_bracket_ladder",
        {
          order_ids: ["mcp_order_1", "mcp_order_2"],
        },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.cancelledCount).toBe(2);
      expect(context.audit).toHaveBeenCalledWith(
        "alpaca.bracket_ladder_cancelled",
        "trading",
        expect.objectContaining({
          cancelledCount: 2,
        }),
      );
    });
  });
});
