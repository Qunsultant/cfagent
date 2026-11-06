import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import {
  normalizeVoiceTradingTranscript,
  tuneFinancialPronunciation,
  ETradeVoiceTradingService,
  handleVoiceWebSocketConnection,
} from "../src/trading/voice/agent";
import type { AgentScheduleItem, Env, VoiceTradingTurnRequest } from "../src/types";
import type { NLQSchedulingPort } from "../src/agents/nlq";
import { ETradeRestClient } from "../src/trading/etrade/client";

/**
 * §7 adaptation (#2389): voice approvals now settle through the
 * broker client's placeOrder — the platform no longer settles
 * locally. Tests whose subject is the voice channel stub that
 * placement seam with a broker-confirmed result (restored by the
 * file's afterEach restoreAllMocks); the voice flows stay real.
 */
function stubBrokerPlacement() {
  return vi.spyOn(ETradeRestClient.prototype, "placeOrder").mockImplementation(async (params: any) => ({
    success: true,
    orderId: params.orderId,
    executionId: "et_order_voice",
    brokerOrderRef: "et_order_voice",
    authorizerDid: params.userLogin,
    status: "executed",
    symbol: params.symbol,
    action: params.action,
    quantity: params.quantity,
    executionPrice: params.limitPrice ?? 100,
    totalSettled: (params.limitPrice ?? 100) * params.quantity,
    didAttestation: {
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: params.userLogin,
      signature: ["sig", "0xbrokervoice"].join("_"),
    },
    message: "E*TRADE Execution Confirmed: Broker Order ID et_order_voice",
    timestamp: new Date().toISOString(),
  }) as any);
}

// Lightweight Mock WebSocket implementation for Vitest node environment
class MockDuplexWebSocket {
  listeners: Record<string, ((event: any) => void)[]> = {};
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  addEventListener(event: string, cb: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  async emitClientMessage(data: any) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const cb of this.listeners["message"] || []) {
      await cb({ data: payload });
    }
  }

  getParsedMessages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

// Issue #109: in-memory NLQSchedulingPort for voice scheduling turns.
// The NLQ executor now arms real schedules through the injected port,
// so voice tests provide this fake instead of relying on the old
// fabricated NLQ success path.
class FakeVoiceSchedulingPort implements NLQSchedulingPort {
  items: AgentScheduleItem[] = [];
  private seq = 0;

  constructor(seed: AgentScheduleItem[] = []) {
    this.items = [...seed];
  }

  async schedule(when: Date | string | number, callback: string, payload?: unknown): Promise<AgentScheduleItem> {
    const nowSec = Math.floor(Date.now() / 1000);
    const item: AgentScheduleItem = {
      id: `voice-port-id-${++this.seq}`,
      callback,
      payload,
      type: typeof when === "number" ? "delayed" : typeof when === "string" ? "cron" : "scheduled",
      time: typeof when === "number" ? nowSec + when : nowSec + 3600,
      ...(typeof when === "string" ? { cron: when } : {}),
      ...(typeof when === "number" ? { delayInSeconds: when } : {}),
    };
    this.items.push(item);
    return item;
  }

  async scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem> {
    const item: AgentScheduleItem = {
      id: `voice-port-id-${++this.seq}`,
      callback,
      payload,
      type: "interval",
      intervalSeconds,
      time: Math.floor(Date.now() / 1000) + intervalSeconds,
    };
    this.items.push(item);
    return item;
  }

  async cancelSchedule(id: string): Promise<boolean> {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  async listSchedules(): Promise<AgentScheduleItem[]> {
    return [...this.items];
  }
}

describe("Cloudflare Voice Trading Agent (E*TRADE Desk)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const sessionId = "voice_test_trader";

  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
  };

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    DynamicMarketScreener.setTestListingsFixture(MOCK_TEST_UNIVERSE.map((stock) => ({
      symbol: stock.symbol,
      companyName: stock.companyName,
      exchange: "nasdaq" as const,
      lastPrice: stock.lastPrice,
      change: stock.change,
      changePercent: stock.changePercent,
      marketCap: (stock.marketCap || 0) * 1e9,
    })));
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    DynamicMarketScreener.setTestListingsFixture(null);
  });

  // =========================================================================
  // 1. Spoken Transcript Normalization
  // =========================================================================
  describe("normalizeVoiceTradingTranscript", () => {
    it("strips verbal hesitation and filler words", () => {
      const input = "um uh buy five shares like please you know";
      const normalized = normalizeVoiceTradingTranscript(input);
      expect(normalized).toBe("buy 5 shares");
    });

    it("maps spoken company names to canonical stock tickers", () => {
      expect(normalizeVoiceTradingTranscript("quote for nvidia")).toBe("quote for NVDA");
      expect(normalizeVoiceTradingTranscript("what is apple trading at")).toBe("what is AAPL trading at");
      expect(normalizeVoiceTradingTranscript("price of microsoft")).toBe("price of MSFT");
      expect(normalizeVoiceTradingTranscript("buy tesla stock")).toBe("buy TSLA stock");
      expect(normalizeVoiceTradingTranscript("screen palantir and coinbase")).toBe("screen PLTR and COIN");
    });

    it("normalizes spoken number words to integers", () => {
      expect(normalizeVoiceTradingTranscript("buy ten shares of NVDA")).toBe("buy 10 shares of NVDA");
      expect(normalizeVoiceTradingTranscript("sell twenty shares of AAPL")).toBe("sell 20 shares of AAPL");
      expect(normalizeVoiceTradingTranscript("purchase hundred shares of AMD")).toBe("purchase 100 shares of AMD");
    });

    it("handles complex spoken phrases cleanly", () => {
      const complex = "Um please quote price for amazon and then buy five shares of nvidia";
      const cleaned = normalizeVoiceTradingTranscript(complex);
      expect(cleaned).toBe("quote price for AMZN and then buy 5 shares of NVDA");
    });
  });

  // =========================================================================
  // 2. Financial Pronunciation Tuning Engine
  // =========================================================================
  describe("tuneFinancialPronunciation", () => {
    it("converts currency figures into verbal dollars and cents", () => {
      expect(tuneFinancialPronunciation("NVDA is at $228.38")).toBe("NVDA is at 228 dollars and 38 cents");
      expect(tuneFinancialPronunciation("Limit price $150")).toBe("Limit price 150 dollars");
    });

    it("converts positive and negative percentages into spoken directionals", () => {
      expect(tuneFinancialPronunciation("up +0.51% today")).toBe("up up 0.51 percent today");
      expect(tuneFinancialPronunciation("down -1.25% today")).toBe("down down 1.25 percent today");
      expect(tuneFinancialPronunciation("margin is 5.0%")).toBe("margin is 5.0 percent");
    });

    it("converts financial acronyms to phonetically clear speech", () => {
      expect(tuneFinancialPronunciation("RSI(14) is overbought")).toBe("R-S-I is overbought");
      expect(tuneFinancialPronunciation("Check the MACD line")).toBe("Check the M-A-C-D line");
      expect(tuneFinancialPronunciation("Current P/E ratio")).toBe("Current P to E ratio");
    });

    it("spaces out order IDs so text-to-speech articulates each character", () => {
      const tuned = tuneFinancialPronunciation("Your order ord_abc123 has been staged");
      expect(tuned).toContain("order a b c 1 2 3");
    });

    it("avoids stuttering 'order order' when order is already in the prompt", () => {
      const tuned = tuneFinancialPronunciation('Say "Confirm order ord_6d737343" to execute, or say "Cancel order" to discard.');
      expect(tuned).not.toContain("order order");
      expect(tuned).toContain("Confirm order 6 d 7 3 7 3 4 3");
    });

    it("formats 'Order ID is ord_xxx' naturally without stutter", () => {
      const tuned = tuneFinancialPronunciation("Order ID is ord_6d737343.");
      expect(tuned).toBe("Order ID is 6 d 7 3 7 3 4 3.");
    });

    it("strips markdown symbols that distort voice synthesizers", () => {
      const raw = "### **Order Confirmed** for `NVDA` *now*";
      const tuned = tuneFinancialPronunciation(raw);
      expect(tuned).not.toContain("*");
      expect(tuned).not.toContain("`");
      expect(tuned).not.toContain("#");
      expect(tuned).toBe("Order Confirmed for NVDA now");
    });
  });

  // =========================================================================
  // 3. ETradeVoiceTradingService Core Operations
  // =========================================================================
  describe("ETradeVoiceTradingService", () => {
    it("provides an executive voice welcome greeting", () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const greeting = service.getWelcomeGreeting();

      expect(greeting.spokenText).toContain("Welcome to the E*TRADE Voice Trading Desk");
      expect(greeting.displayMarkdown).toContain("Voice Trading Desk Connected");
    });

    it("handles verbal stock quote inquiries", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "What is nvidia trading at?",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("quote");
      expect(res.marketQuote).toBeDefined();
      expect(res.marketQuote?.symbol).toBe("NVDA");
      expect(res.spokenText).toContain("NVIDIA Corporation");
      expect(res.spokenText).toContain("dollars and");
      expect(res.spokenText).toContain("percent");
      expect(res.displayMarkdown).toContain("Quote: **NVDA**");
      expect(res.proposerDid).toBe("did:agent:openaimp:trading");
    });

    it("handles verbal market screener requests", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Screen stocks priced between $20 and $500",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("screener");
      expect(res.screenedStocks).toBeDefined();
      expect(res.screenedStocks!.length).toBeGreaterThan(0);
      expect(res.spokenText).toContain("screened");
      expect(res.spokenText).toContain("daily change");
      expect(res.displayMarkdown).toContain("Market Listings");
      expect(res.proposerDid).toBe("did:agent:openaimp:trading");
    });

    it("handles verbal market screener with a supported price range", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Screen stocks priced between $20 and $500",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("screener");
      expect(res.screenedStocks).toBeDefined();
      expect(res.screenedStocks!.length).toBeGreaterThan(0);

      // Verify all returned live listing prices satisfy the requested range.
      for (const stock of res.screenedStocks!) {
        const price = Number(String(stock.price).replace(/[^0-9.]/g, ""));
        expect(price).toBeGreaterThanOrEqual(20);
        expect(price).toBeLessThanOrEqual(500);
      }

      expect(res.spokenText).toContain("screened");
      expect(res.spokenText).not.toContain("equities in the universe");
      expect(res.displayMarkdown).toContain("Market Listings");
      expect(res.displayMarkdown).toContain("Exchange");
    });

    it("gracefully guides trader when zero equities match extreme criteria: 'Screen tech stocks with RSI under 15'", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Screen tech stocks with RSI under 15",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("screener");
      expect(res.screenedStocks).toBeDefined();
      expect(res.screenedStocks!.length).toBe(0);
      expect(res.spokenText).toContain("does not provide sector, R-S-I data");
      expect(res.displayMarkdown).toContain("Stock Screen Unavailable");
    });

    it("handles open-ended discovery 'Find' by presenting 14 integrated platform capabilities rather than conversation records", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Find",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("capabilities");
      expect(res.spokenText).toContain("14 integrated market capabilities");
      expect(res.spokenText).not.toContain("conversation records");
      expect(res.displayMarkdown).toContain("Platform Capabilities");
      expect(res.displayMarkdown).toContain("Market Analysis Capabilities");
      expect(res.displayMarkdown).toContain("Execution & Automation Capabilities");
    });

    it("handles verbal market movers query 'Find the top Gainers and losers' with dual gainers and losers breakdown", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Find the top Gainers and losers",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("screener");
      expect(res.spokenText).toContain("top market movers");
      expect(res.spokenText).toContain("Top gainers include");
      expect(res.spokenText).toContain("Top losers include");
      expect(res.displayMarkdown).toContain("Market Movers: Top Gainers & Losers");
      expect(res.displayMarkdown).toContain("Top Daily Gainers");
      expect(res.displayMarkdown).toContain("Top Daily Losers");
    });

    it("handles phonetic misrecognition 'Screen all text talks' by normalizing to tech stocks and filtering technology equities", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Screen all text talks",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("screener");
      expect(res.screenedStocks).toBeDefined();
      expect(res.screenedStocks!.length).toBeGreaterThan(0);
      for (const stock of res.screenedStocks!) {
        const sec = (stock.sector || "").toLowerCase();
        expect(["technology", "semiconductors"]).toContain(sec);
      }
      expect(res.spokenText).toContain("Technology");
      expect(res.displayMarkdown).toContain("Technology");
    });

    it("handles verbal sector screening 'Screen all tech stocks' returning technology leaders sorted by market cap", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Screen all tech stocks",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("screener");
      expect(res.screenedStocks).toBeDefined();
      expect(res.screenedStocks!.length).toBeGreaterThan(0);
      expect(res.spokenText).toContain("Technology");
      expect(res.displayMarkdown).toContain("Technology");
    });

    it("handles verbal platform capabilities query 'What are your capabilities'", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "What are your capabilities",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("capabilities");
      expect(res.spokenText).toContain("14 integrated market capabilities");
      expect(res.displayMarkdown).toContain("Platform Capabilities");
    });

    it("handles verbal portfolio and balance queries", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "What is my portfolio balance?",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("portfolio");
      expect(res.spokenText).toContain("reconciled");
      expect(res.displayMarkdown).toContain("Portfolio");
    });

    it("verbally schedules a reminder task: 'Remind me to check apple in ten minutes'", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId, new FakeVoiceSchedulingPort());
      const req: VoiceTradingTurnRequest = {
        transcript: "Remind me to check apple in ten minutes",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("schedule");
      expect(res.spokenText).toContain("scheduled a reminder to check AAPL in 10 minutes");
      expect(res.spokenText).toContain("Schedule ID is");
      expect(res.displayMarkdown).toContain("Scheduled Task Activated");
      expect(res.displayMarkdown).toContain("check AAPL");
      expect(res.displayMarkdown).toContain("sendScheduledReminder");
    });

    it("verbally schedules recurring market screen: 'Schedule market screen every five minutes'", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId, new FakeVoiceSchedulingPort());
      const req: VoiceTradingTurnRequest = {
        transcript: "Schedule market screen every five minutes",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("schedule");
      expect(res.spokenText).toContain("scheduled autonomous market screening every 5 minutes");
      expect(res.displayMarkdown).toContain("autonomousMarketScreen");
    });

    it("verbally lists active background tasks: 'Show scheduled tasks'", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const port = new FakeVoiceSchedulingPort([
        { id: "baseline-renew-id", callback: "autoRenewETradeTokens", type: "cron", cron: "0 3 * * *", time: nowSec + 3600, payload: { userLogin: sessionId } },
        { id: "baseline-screen-id", callback: "autonomousMarketScreen", type: "interval", intervalSeconds: 300, time: nowSec + 300, payload: { sector: "Technology", maxItems: 5 } },
      ]);
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId, port);
      const req: VoiceTradingTurnRequest = {
        transcript: "Show scheduled tasks",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("schedule");
      expect(res.spokenText).toMatch(/active scheduled tasks|no active background/);
      expect(res.displayMarkdown).toContain("Active Scheduled Tasks");
    });

    it("verbally cancels a scheduled task: 'Cancel schedule sched_test_123'", async () => {
      const port = new FakeVoiceSchedulingPort([
        { id: "sched_test_123", callback: "sendScheduledReminder", type: "delayed", delayInSeconds: 600, time: Math.floor(Date.now() / 1000) + 600, payload: { message: "test reminder" } },
      ]);
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId, port);
      const req: VoiceTradingTurnRequest = {
        transcript: "Cancel schedule sched_test_123",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("schedule");
      expect(res.spokenText).toMatch(/Task schedule sched.*123 has been cancelled successfully/i);
      expect(res.displayMarkdown).toContain("Task Schedule Cancelled");
      expect(res.displayMarkdown).toContain("sched_test_123");
      // Issue #109: the cancellation really removed the schedule from the port.
      expect(port.items).toHaveLength(0);
    });

    it("strictly drafts trade orders in 'previewed' status without moving funds", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Buy ten shares of apple at market",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("preview");
      expect(res.orderStatus).toBe("previewed");
      expect(res.orderId).toBeDefined();
      expect(res.orderDraft).toBeDefined();
      expect(res.orderDraft?.symbol).toBe("AAPL");
      expect(res.orderDraft?.quantity).toBe(10);
      expect(res.orderDraft?.status).toBe("previewed");

      // Verify safety spoken warning
      expect(res.spokenText).toContain("drafted an order to BUY 10 shares of AAPL");
      expect(res.spokenText).toContain("Safety guarantee: no capital has been moved");
      expect(res.spokenText).toContain("Confirm order");

      // Verify order ledger state in SQLite ORM
      const savedTrade = orm.trades.findById(res.orderId!);
      expect(savedTrade).toBeDefined();
      expect(savedTrade?.status).toBe("previewed");
      expect(savedTrade?.symbol).toBe("AAPL");
      expect(savedTrade?.quantity).toBe(10);
    });

    it("correctly parses and stages relative discount limit orders: 'buy 1 order of nvda at 30% below market price'", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "buy 1 order of nvda at 30% below market price",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("preview");
      expect(res.orderStatus).toBe("previewed");
      expect(res.orderDraft).toBeDefined();
      expect(res.orderDraft?.symbol).toBe("NVDA");
      expect(res.orderDraft?.quantity).toBe(1);
      expect(res.orderDraft?.orderType).toBe("LIMIT");
      expect(res.orderDraft?.estimatedPrice).toBeGreaterThan(0);
      expect(res.orderDraft?.estimatedTotal).toBeGreaterThan(0);

      // Verify spoken text grammar: "1 share" (not "1 shares"), "NVDA" (not "ORDER"), "a LIMIT order"
      expect(res.spokenText).toContain("drafted a LIMIT order to BUY 1 share of NVDA");
      expect(res.spokenText).not.toContain("1 shares");
      expect(res.spokenText).not.toContain("ORDER");
      expect(res.spokenText).not.toContain("order order");
      expect(res.spokenText).toContain("30 percent below market price");
      expect(res.spokenText).toContain("Confirm order");

      // Verify SQLite state
      const savedTrade = orm.trades.findById(res.orderId!);
      expect(savedTrade).toBeDefined();
      expect(savedTrade?.symbol).toBe("NVDA");
      expect(savedTrade?.quantity).toBe(1);
      expect(savedTrade?.orderType).toBe("LIMIT");
    });

    it("verbally confirms order using spaced-out voice characters e.g. 'Confirm order 6 d 7 3 7 3 4 3'", async () => {
      stubBrokerPlacement();
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);

      const orderId = "ord_6d737343";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "NVDA",
        action: "BUY",
        orderType: "LIMIT",
        quantity: 1,
        price: 89.60,
        totalValue: 89.60,
        status: "previewed",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: `did:user:voice:${sessionId}`,
        proofSignature: "sig_test_123",
        createdAt: new Date().toISOString(),
      });

      const confirmReq: VoiceTradingTurnRequest = {
        transcript: "Confirm order 6 d 7 3 7 3 4 3",
        sessionId,
      };

      const res = await service.processVoiceTurn(confirmReq);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("approval");
      expect(res.orderStatus).toBe("executed");
      expect(res.spokenText).toMatch(/successfully executed/i);

      const executedTrade = orm.trades.findById(orderId);
      expect(executedTrade?.status).toBe("executed");
    });

    it("verbally executes order upon receiving explicit confirmation: 'Confirm order <orderId>'", async () => {
      stubBrokerPlacement();
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);

      // Stage an order in SQLite
      const orderId = "ord_voice_exec_789";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "NVDA",
        action: "BUY",
        orderType: "MARKET",
        quantity: 15,
        price: 228.38,
        totalValue: 3425.7,
        status: "previewed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const req: VoiceTradingTurnRequest = {
        transcript: `Confirm order ${orderId}`,
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("approval");
      expect(res.orderStatus).toBe("executed");
      expect(res.orderId).toBe(orderId);
      expect(res.brokerOrderRef).toBeDefined();
      expect(res.spokenText).toMatch(/successfully executed on E\*?TRADE/i);
      expect(res.spokenText).toContain("Broker reference is");
      expect(res.displayMarkdown).toContain("Order Executed on E*TRADE");

      // Verify status transitioned to 'executed' in SQLite
      const updated = orm.trades.findById(orderId);
      expect(updated?.status).toBe("executed");
      expect(updated?.authorizerDid).toBe(`did:user:voice:${sessionId}`);
    });

    it("verbally executes the most recent preview when trader says 'Approve order'", async () => {
      stubBrokerPlacement();
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);

      const orderId = "ord_recent_preview_555";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "MSFT",
        action: "BUY",
        orderType: "MARKET",
        quantity: 5,
        price: 450.0,
        totalValue: 2250.0,
        status: "previewed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const req: VoiceTradingTurnRequest = {
        transcript: "Approve order",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("approval");
      expect(res.orderStatus).toBe("executed");
      expect(res.orderId).toBe(orderId);

      const updated = orm.trades.findById(orderId);
      expect(updated?.status).toBe("executed");
    });

    it("verbally cancels an order draft upon trader saying 'Cancel order <orderId>'", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);

      const orderId = "ord_voice_cancel_111";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "TSLA",
        action: "SELL",
        orderType: "LIMIT",
        quantity: 20,
        price: 260.0,
        totalValue: 5200.0,
        status: "previewed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const req: VoiceTradingTurnRequest = {
        transcript: `Cancel order ${orderId}`,
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(true);
      expect(res.actionType).toBe("rejection");
      expect(res.orderStatus).toBe("rejected");
      expect(res.spokenText).toContain("has been cancelled");
      expect(res.spokenText).toContain("no funds or equities were moved");

      // Verify status transitioned to 'rejected' in SQLite
      const updated = orm.trades.findById(orderId);
      expect(updated?.status).toBe("rejected");
    });

    it("returns a clear spoken message when attempting to approve without a pending preview", async () => {
      const service = new ETradeVoiceTradingService(mockEnv, orm, sessionId);
      const req: VoiceTradingTurnRequest = {
        transcript: "Confirm execution of order ord_nonexistent",
        sessionId,
      };

      const res = await service.processVoiceTurn(req);

      expect(res.success).toBe(false);
      expect(res.orderStatus).toBe("not_found");
      expect(res.spokenText).toContain("could not find an active pending order preview");
      expect(res.displayMarkdown).toContain("Voice Approval Failed");
    });
  });

  // =========================================================================
  // 4. Duplex WebSocket Voice Session Protocol
  // =========================================================================
  describe("Duplex WebSocket Voice Protocol (handleVoiceWebSocketConnection)", () => {
    it("handles 'start_call' handshake and returns 'call_accepted'", async () => {
      const ws = new MockDuplexWebSocket();
      await handleVoiceWebSocketConnection(ws as any, mockEnv, orm, sessionId);

      await ws.emitClientMessage({ type: "start_call" });

      const messages = ws.getParsedMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("call_accepted");
      expect(messages[0].protocol).toBe("cloudflare_voice_v1");
      expect(messages[0].message).toContain("Welcome to the E*TRADE Voice Trading Desk");
    });

    it("handles speech turn and returns thinking status followed by assistant_turn", async () => {
      const ws = new MockDuplexWebSocket();
      await handleVoiceWebSocketConnection(ws as any, mockEnv, orm, sessionId);

      await ws.emitClientMessage({
        type: "turn",
        transcript: "What is nvidia trading at?",
      });

      const messages = ws.getParsedMessages();
      expect(messages.length).toBe(2);
      expect(messages[0].type).toBe("status");
      expect(messages[0].status).toBe("thinking");

      expect(messages[1].type).toBe("assistant_turn");
      expect(messages[1].actionType).toBe("quote");
      expect(messages[1].marketQuote?.symbol).toBe("NVDA");
      expect(messages[1].spokenText).toContain("NVIDIA Corporation");
    });

    it("handles trade drafting and confirmation over WebSocket", async () => {
      stubBrokerPlacement();
      const ws = new MockDuplexWebSocket();
      await handleVoiceWebSocketConnection(ws as any, mockEnv, orm, sessionId);

      // Step 1: Draft order
      await ws.emitClientMessage({
        type: "turn",
        transcript: "Buy 10 shares of NVDA at market",
      });

      let msgs = ws.getParsedMessages();
      const draftMsg = msgs.find((m) => m.type === "assistant_turn" && m.actionType === "preview");
      expect(draftMsg).toBeDefined();
      expect(draftMsg.orderDraft).toBeDefined();
      expect(draftMsg.orderStatus).toBe("previewed");
      const orderId = draftMsg.orderId;

      // Step 2: Confirm order
      await ws.emitClientMessage({
        type: "turn",
        transcript: `Confirm order ${orderId}`,
      });

      msgs = ws.getParsedMessages();
      const execMsg = msgs.filter((m) => m.type === "assistant_turn" && m.actionType === "approval")[0];
      expect(execMsg).toBeDefined();
      expect(execMsg.orderStatus).toBe("executed");
      expect(execMsg.spokenText).toMatch(/successfully executed on E\*?TRADE/i);

      // Verify in SQLite
      const trade = orm.trades.findById(orderId);
      expect(trade?.status).toBe("executed");
    });

    it("handles user interruption signal ('interrupt')", async () => {
      const ws = new MockDuplexWebSocket();
      await handleVoiceWebSocketConnection(ws as any, mockEnv, orm, sessionId);

      await ws.emitClientMessage({ type: "interrupt" });

      const messages = ws.getParsedMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("interrupted");
      expect(messages[0].status).toBe("listening");
    });

    it("handles 'end_call' signal and closes socket cleanly", async () => {
      const ws = new MockDuplexWebSocket();
      await handleVoiceWebSocketConnection(ws as any, mockEnv, orm, sessionId);

      await ws.emitClientMessage({ type: "end_call" });

      const messages = ws.getParsedMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("call_ended");
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(1000);
    });
  });
});
