import { describe, it, expect, vi, beforeEach } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { InMemoryScanRunStore } from "../src/trading/options/scanRunStore";
import type { ETradeOptionChain } from "../src/types";

describe("Autonomous Options Screening & Scheduling Pipeline", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;
  let inMemoryDb: any[];

  beforeEach(() => {
    inMemoryDb = [];
    const mockSql = {
      exec: vi.fn((query: string, ...args: any[]) => {
        return [];
      }),
    };

    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
      SLACK_BOT_TOKEN: "xoxb-mock-token",
      OUTBOUND_WEBHOOK_URL: "https://example.com/webhook",
      OUTBOUND_WEBHOOK_SECRET: "secret123",
    } as unknown as Env;

    mockOrm = new DatabaseORM(mockSql as any);

    const mockFixture: ETradeOptionChain = {
      symbol: "NVDA",
      underlyingPrice: 130,
      quoteTime: Date.now(),
      selectedExpiry: { year: 2026, month: 11, day: 20 },
      pairs: [
        {
          call: {
            symbol: "NVDA",
            optionType: "CALL",
            strikePrice: 130,
            bid: 5.5,
            ask: 5.8,
            volume: 800,
            openInterest: 2000,
            impliedVolatility: 0.45,
            delta: 0.52,
            gamma: 0.04,
            theta: -0.05,
            vega: 0.12,
            rho: 0.02,
          },
          put: {
            symbol: "NVDA",
            optionType: "PUT",
            strikePrice: 130,
            bid: 5.4,
            ask: 5.7,
            volume: 600,
            openInterest: 1800,
            impliedVolatility: 0.45,
            delta: -0.48,
            gamma: 0.04,
            theta: -0.05,
            vega: 0.12,
            rho: -0.02,
          },
        },
        {
          call: {
            symbol: "NVDA",
            optionType: "CALL",
            strikePrice: 140,
            bid: 2.5,
            ask: 2.8,
            volume: 1200,
            openInterest: 3500,
            impliedVolatility: 0.42,
            delta: 0.35,
            gamma: 0.03,
            theta: -0.04,
            vega: 0.10,
            rho: 0.01,
          },
        },
      ],
    };

    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: mockFixture,
      AAPL: { ...mockFixture, symbol: "AAPL" },
    });
  });

  describe("ScheduledTasksService.autonomousOptionsAnalysis()", () => {
    it("executes autonomous options analysis and populates opportunities", async () => {
      const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
      const result = await service.autonomousOptionsAnalysis({
        symbols: ["AAPL", "NVDA"],
        thesis: "bullish",
        riskProfile: "balanced",
      });

      expect(result.success).toBe(true);
      expect(result.taskType).toBe("options_analysis");
      expect(result.data).toBeDefined();
      expect(result.data?.totalScanned).toBeGreaterThan(0);
      expect(result.data?.summary).toBeDefined();
      expect(result.data?.symbols).toEqual(["AAPL", "NVDA"]);
    });

    it("persists the scheduled scan run when a ScanRunStore is injected (issue #27)", async () => {
      const store = new InMemoryScanRunStore({ idFactory: () => "scheduled-run-1" });
      const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader", store);
      const result = await service.autonomousOptionsAnalysis({
        symbols: ["NVDA"],
        thesis: "bullish",
        riskProfile: "balanced",
      });

      expect(result.success).toBe(true);
      expect(result.taskType).toBe("options_analysis");
      expect(result.data?.totalScanned).toBe(1);

      // The run the scheduled path produced is retrievable from the store,
      // carrying the scan's mode and provenance. Issue #103: the save is
      // stamped with the service's userLogin, so the read-backs name the
      // owner scope.
      const summaries = await store.list({ userLogin: "test_trader" });
      expect(summaries).toHaveLength(1);
      expect(summaries[0].id).toBe("scheduled-run-1");
      expect(summaries[0].userLogin).toBe("test_trader");
      expect(summaries[0].mode).toBe("per_name_best");
      expect(summaries[0].modelVersion).toBeDefined();

      const stored = await store.get("scheduled-run-1", { userLogin: "test_trader" });
      expect(stored).not.toBeNull();
      expect(stored!.mode).toBe(summaries[0].mode);
      expect(stored!.generatedAt).toBe(stored!.result.generatedAt);
      expect(stored!.result.requestSnapshot.mode).toBe("per_name_best");
      expect(stored!.result.requestSnapshot.template.thesis).toBe("bullish");
      expect(stored!.result.coverage.scanned).toBe(1);
      expect(stored!.result.coverage.considered).toBe(1);
    });

    it("behaves exactly as before when constructed without a ScanRunStore", async () => {
      const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
      const result = await service.autonomousOptionsAnalysis({
        symbols: ["AAPL"],
        thesis: "bullish",
        riskProfile: "balanced",
      });

      expect(result.success).toBe(true);
      expect(result.taskType).toBe("options_analysis");
      expect(result.data).toBeDefined();
      expect(result.data?.totalScanned).toBe(1);
      expect(result.data?.summary).toBeDefined();
      expect(result.data?.symbols).toEqual(["AAPL"]);
    });

    it("generates Slack Block Kit interactive buttons with [✓ Approve & Preview Order]", async () => {
      const unifiedService = new UnifiedOptionsService(mockEnv, "test_trader", "TEST", mockOrm);
      const res = await unifiedService.execute({
        action: "strategies",
        symbol: "NVDA",
        thesis: "bullish",
        channel: "slack",
      });

      const slackPayload = res.toSlack();
      expect(slackPayload.blocks).toBeDefined();
      expect(slackPayload.text).toBeDefined();

      // Locate interactive actions block
      const actionsBlock = slackPayload.blocks?.find((b: any) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toBeDefined();

      const approveBtn = actionsBlock.elements.find(
        (e: any) => e.action_id === "etrade_approve_options_order"
      );
      expect(approveBtn).toBeDefined();
      expect(approveBtn.text.text).toContain("Approve & Preview Order");

      const dismissBtn = actionsBlock.elements.find(
        (e: any) => e.action_id === "etrade_dismiss_options_alert"
      );
      expect(dismissBtn).toBeDefined();
      expect(dismissBtn.text.text).toContain("Dismiss Alert");
    });

    it("generates rich dark-mode HTML briefs with payoff metrics, breakevens, and Greeks", async () => {
      const unifiedService = new UnifiedOptionsService(mockEnv, "test_trader", "TEST", mockOrm);
      const res = await unifiedService.execute({
        action: "best_trade",
        symbol: "NVDA",
        thesis: "bullish",
        channel: "email",
      });

      const emailHtml = res.toEmailHtml();
      expect(emailHtml).toContain("E*TRADE Options Intelligence: NVDA");
      expect(emailHtml).toContain("Max Profit");
      expect(emailHtml).toContain("Max Loss");
      expect(emailHtml).toContain("Reward / Risk");
      expect(emailHtml).toContain("Breakevens");
      expect(emailHtml).toContain("Net Delta");
      expect(emailHtml).toContain("Preview &amp; Authorize Order");
    });
  });

  describe("Slack HITL Interaction for Options Trades", () => {
    it("handles etrade_approve_options_order and queues order preview", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, mockOrm, "slack_user");
      const sampleOptionPayload = JSON.stringify({
        symbol: "NVDA",
        strategy: "Bull Call Spread",
        action: "bullish",
        score: 88,
        maxLoss: 450,
        legs: [
          { symbol: "NVDA", strike: 120, type: "CALL", side: "BUY", quantity: 1 },
          { symbol: "NVDA", strike: 130, type: "CALL", side: "SELL", quantity: 1 },
        ],
      });

      const result = await slackService.processSlackInteraction({
        type: "block_actions",
        user: { id: "U123456", name: "trader_alice" },
        actions: [
          {
            action_id: "etrade_approve_options_order",
            value: sampleOptionPayload,
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("executed");
      expect(result.orderId).toMatch(/^opt_NVDA_/);
      expect(result.message).toContain("approved by user");
      expect(result.replacementBlocks).toBeDefined();
      expect(result.replacementBlocks?.[0]?.text?.text).toContain("OPTIONS ORDER PREVIEW APPROVED");
    });

    it("fails loudly when the options order draft fails to persist (issue #2165)", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, mockOrm, "slack_user");
      vi.spyOn(mockOrm.trades, "create").mockImplementation(() => {
        throw new Error("SQLITE_FULL: database or disk is full");
      });
      const auditSpy = vi.spyOn(mockOrm.events, "create").mockImplementation((r: any) => r);
      const postSpy = vi.spyOn(slackService, "postResponseUrl").mockResolvedValue(true);
      const sampleOptionPayload = JSON.stringify({
        symbol: "NVDA",
        strategy: "Bull Call Spread",
        action: "bullish",
        score: 88,
        maxLoss: 450,
        legs: [
          { symbol: "NVDA", strike: 120, type: "CALL", side: "BUY", quantity: 1 },
          { symbol: "NVDA", strike: 130, type: "CALL", side: "SELL", quantity: 1 },
        ],
      });

      const result = await slackService.processSlackInteraction({
        type: "block_actions",
        user: { id: "U123456", name: "trader_alice" },
        response_url: "https://example.com/response",
        actions: [
          {
            action_id: "etrade_approve_options_order",
            value: sampleOptionPayload,
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("error");
      expect(result.orderId).toMatch(/^opt_NVDA_/);
      expect(result.message).toContain("failed");
      expect(result.replacementBlocks).toBeUndefined();
      expect(postSpy).toHaveBeenCalledTimes(1);
      const posted = JSON.stringify(postSpy.mock.calls[0][1]);
      expect(posted).not.toContain("QUEUED FOR E*TRADE ROUTING");
      expect(posted).toContain("failed");
      expect(auditSpy).toHaveBeenCalledTimes(1);
      const auditRow = auditSpy.mock.calls[0][0] as any;
      expect(auditRow.type).toContain("draft");
      expect(JSON.stringify(auditRow.payload)).toContain(result.orderId);
      expect(JSON.stringify(auditRow.payload)).toContain("SQLITE_FULL");
    });

    it("handles etrade_dismiss_options_alert gracefully", async () => {
      const slackService = new ETradeSlackTradingService(mockEnv, mockOrm, "slack_user");
      const result = await slackService.processSlackInteraction({
        type: "block_actions",
        user: { id: "U123456", name: "trader_alice" },
        actions: [
          {
            action_id: "etrade_dismiss_options_alert",
            value: "NVDA",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("rejected");
      expect(result.message).toContain("Options alert dismissed");
    });
  });
});
