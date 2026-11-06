import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { planNLQ, executeNLQQuery } from "../src/agents/nlq";
import { ETradeService } from "../src/services/etrade";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import type { Env, AgentScheduleItem } from "../src/types";

// In-memory KV mock for testing token storage
class MockKVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    return item.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe("Cloudflare Agents: Task Scheduling & Durable Timers", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let mockKv: MockKVNamespace;
  let lastScreenerRequest: any;
  let env: Env;
  const sessionId = "scheduler_test_trader";

  beforeEach(() => {
    vi.restoreAllMocks();
    lastScreenerRequest = undefined;
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    mockKv = new MockKVNamespace();
    const { namespace: sessionStoreNs } = makeFakeSessionStore();

    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_KV: mockKv as any,
      SESSION_STORE: sessionStoreNs,
      ORCHESTRATOR_AGENT: {} as any,
      // Issue #261: mock ScreenerAgent — the service delegates screening to it.
      SCREENER_AGENT: {
        idFromName: () => "mock-screener-id",
        get: () => ({
          runScreen: async (req: any) => {
            lastScreenerRequest = req;
            return {
            timestamp: new Date().toISOString(),
            trigger: req.trigger,
            pdfKey: "stock-report.pdf",
            pdfStatus: "generated",
            pdfError: undefined,
            xlsxKey: "stock-report.xlsx",
            xlsxStatus: "generated",
            xlsxError: undefined,
            csvKey: "stock-report.csv",
            csvStatus: "generated",
            csvError: undefined,
            sector: req.sector || "Technology",
            success: true,
            totalScanned: 3,
            matchedCount: 2,
            opportunities: [
              {
                symbol: "AAPL",
                companyName: "Apple Inc",
                signal: "BULLISH_MOMENTUM",
                momentumScore: 75,
                lastPrice: 230.5,
                changePercent: 1.8,
                indicators: {
                  sentiment: "bullish",
                  directional: false,
                  rangeZone: "neutral",
                  valueZone: "fair",
                  screenScore: 72,
                  intradayPosition: 0.7,
                  rangePosition: 0.6,
                  summary: "bullish",
                },
                factorGrades: {
                  value: "B+",
                  momentum: "A-",
                  growth: null,
                  profitability: null,
                  revisions: null,
                  quantRating: "Buy",
                  valueScore: 72,
                  momentumScore: 82,
                  compositeScore: 77,
                  gradedFactors: ["Value", "Momentum"],
                },
              },
            ],
            allStocks: [
              {
                symbol: "AAPL",
                companyName: "Apple Inc",
                signal: "BULLISH_MOMENTUM",
                momentumScore: 75,
                lastPrice: 230.5,
                changePercent: 1.8,
                rsi14: null,
                source: "E*TRADE live",
                indicators: {
                  sentiment: "bullish",
                  directional: false,
                  rangeZone: "neutral",
                  valueZone: "fair",
                  screenScore: 72,
                  intradayPosition: 0.7,
                  rangePosition: 0.6,
                  summary: "bullish",
                },
                factorGrades: {
                  value: "B+",
                  momentum: "A-",
                  growth: null,
                  profitability: null,
                  revisions: null,
                  quantRating: "Buy",
                  valueScore: 72,
                  momentumScore: 82,
                  compositeScore: 77,
                  gradedFactors: ["Value", "Momentum"],
                },
              },
              {
                symbol: "MSFT",
                companyName: "Microsoft Corp",
                signal: "RANGE_BOUND",
                momentumScore: 52,
                lastPrice: 428.1,
                changePercent: 0.2,
                rsi14: null,
                source: "E*TRADE live",
                indicators: {
                  sentiment: "neutral",
                  directional: false,
                  rangeZone: "neutral",
                  valueZone: "fair",
                  screenScore: 55,
                  intradayPosition: 0.5,
                  rangePosition: 0.55,
                  summary: "neutral",
                },
              },
              {
                symbol: "NVDA",
                companyName: "NVIDIA Corp",
                signal: "BULLISH_MOMENTUM",
                momentumScore: 81,
                lastPrice: 195.3,
                changePercent: 2.6,
                rsi14: null,
                source: "E*TRADE live",
                indicators: {
                  sentiment: "bullish",
                  directional: true,
                  rangeZone: "neutral",
                  valueZone: "fair",
                  screenScore: 78,
                  intradayPosition: 0.8,
                  rangePosition: 0.7,
                  summary: "bullish · directional",
                },
              },
            ],
            discoveryMessage: "E*TRADE-only live quotes (mock); 3 of 3 symbols quoted.",
            };
          },
        }),
      } as any,
    } as Env;
  });

  // =========================================================================
  // 1. ScheduledTasksService Domain Tests
  // =========================================================================
  describe("ScheduledTasksService", () => {
    it("handles E*TRADE token auto-renewal when no tokens exist gracefully", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autoRenewETradeTokens("new_user_without_tokens");

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("etrade_token_renewal");
      expect(res.data?.renewed).toBe(false);
      expect(res.data?.message).toContain("No active E*TRADE tokens found");
    });

    it("successfully auto-renews valid E*TRADE access tokens and records audit event", async () => {
      // Store a renewable token in mock KV
      await storeAccessTokens(env, sessionId, "mock_token_abc", "mock_secret_xyz", "TEST");

      // Mock upstream renew_access_token endpoint
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("oauth_token=renewed_tok_123&oauth_token_secret=renewed_sec_456", { status: 200 })
      );

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autoRenewETradeTokens(sessionId, "TEST");

      expect(res.success).toBe(true);
      expect(res.data?.renewed).toBe(true);
      expect(res.data?.userLogin).toBe(sessionId);

      // Verify audit event in mas_events
      const auditEvents = orm.events.findMany({ where: { type: "etrade.token_auto_renewed" } });
      expect(auditEvents.length).toBe(1);

      fetchSpy.mockRestore();
    });

    it("runs autonomous market screen and identifies standout opportunities", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousMarketScreen({ sector: "Technology", maxItems: 3 });

      expect(res.success).toBe(true);
      expect(lastScreenerRequest.userLogin).toBe(sessionId);
      expect(res.taskType).toBe("market_screen");
      expect(res.data?.totalScanned).toBeGreaterThan(0);
      expect(res.data).toMatchObject({
        pdfKey: "stock-report.pdf",
        pdfStatus: "generated",
        xlsxKey: "stock-report.xlsx",
        xlsxStatus: "generated",
        csvKey: "stock-report.csv",
        csvStatus: "generated",
      });
      expect(Array.isArray(res.data?.opportunities)).toBe(true);

      // Issue #253: full scanned set is retained, not just standouts.
      expect(Array.isArray(res.data?.allStocks)).toBe(true);
      expect(res.data?.allStocks.length).toBe(res.data?.totalScanned);
      for (const s of res.data?.allStocks || []) {
        expect(s.symbol).toBeTruthy();
        expect(typeof s.lastPrice).toBe("number");
        expect(typeof s.momentumScore).toBe("number");
      }

      // Verify audit event in mas_events if opportunities detected
      const events = orm.events.findMany({ where: { type: "screener.opportunities_detected" } });
      const runEvent = orm.events.findMany({ where: { type: "screener.run_completed" } })[0];
      // #2178 S1: stored payload is JSON text — parse the stored form.
      expect(JSON.parse(runEvent.payload as unknown as string)).toMatchObject({
        screenType: "stock",
        runType: "scheduled",
        runId: expect.stringMatching(/^screener:/),
      });
      if (res.data?.opportunities && res.data.opportunities.length > 0) {
        expect(events.length).toBeGreaterThan(0);
      }
    });

    it("passes the selected E*TRADE identity and environment to the screener", async () => {
      // #1200: a scheduled PROD run with NO stored session is blocked by
      // the auth pre-flight — seed a fresh session for the selected
      // identity so this test exercises the identity/environment
      // passthrough it pins, not the auth gate.
      await storeAccessTokens(env, "live_account_owner", "mock_token_prod", "mock_secret_prod", "PROD");
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousMarketScreen({
        universe: "SP100",
        userLogin: "live_account_owner",
        environment: "PROD",
      });

      expect(res.success).toBe(true);
      expect(lastScreenerRequest).toMatchObject({
        universe: "SP100",
        userLogin: "live_account_owner",
        environment: "PROD",
      });
    });

    it("automatically expires a stale order draft after 15m HITL window", async () => {
      const orderId = "ord_test_stale_101";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "NVDA",
        action: "BUY",
        orderType: "MARKET",
        quantity: 10,
        price: 228.38,
        totalValue: 2283.8,
        status: "previewed",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:key:user123",
        proofSignature: "sig_0x123",
        previewNotes: "Previewed via Voice Agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.expireStaleOrderDraft(orderId);

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("order_expiration");
      expect(res.data?.expired).toBe(true);
      expect(res.data?.previousStatus).toBe("previewed");

      // Verify updated status in SQLite
      const updatedTrade = orm.trades.findById(orderId);
      expect(updatedTrade?.status).toBe("expired");
      expect(updatedTrade?.previewNotes).toContain("Auto-expired");

      // Verify audit event
      const auditEvents = orm.events.findMany({ where: { type: "order.auto_expired" } });
      expect(auditEvents.length).toBe(1);
    });

    it("HITL Safety Boundary: blocks execution of an expired order draft", async () => {
      const orderId = "ord_test_expired_block";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "MSFT",
        action: "BUY",
        orderType: "MARKET",
        quantity: 5,
        price: 400.0,
        totalValue: 2000.0,
        status: "expired",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:key:user123",
        proofSignature: "sig_0x123",
        previewNotes: "[Auto-expired: 15-minute HITL window elapsed]",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const etrade = new ETradeService(orm, env, sessionId, "sandbox");
      // #2389: executeOrder is async now (approval places through the
      // broker client), so the status gate surfaces as a rejection.
      await expect(etrade.executeOrder(orderId, "did:key:user123", "approved")).rejects.toThrow(
        /cannot be executed.*current status is 'expired'/i
      );
    });

    it("does not overwrite already executed or rejected orders upon expiration timer firing", async () => {
      const orderId = "ord_test_already_executed";
      orm.trades.create({
        id: orderId,
        sessionId,
        symbol: "AAPL",
        action: "BUY",
        orderType: "MARKET",
        quantity: 20,
        price: 240.0,
        totalValue: 4800.0,
        status: "executed",
        orderRef: "exec_broker_999",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:key:user123",
        proofSignature: "sig_0x123",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.expireStaleOrderDraft(orderId);

      expect(res.success).toBe(true);
      expect(res.data?.expired).toBe(false);
      expect(res.data?.previousStatus).toBe("executed");

      const trade = orm.trades.findById(orderId);
      expect(trade?.status).toBe("executed");
    });

    it("dispatches scheduled user reminders and records message to assistant history", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.dispatchReminder("rem_456", "Review AAPL quarterly earnings release");

      expect(res.success).toBe(true);
      expect(res.taskType).toBe("reminder");
      expect(res.data?.reminderId).toBe("rem_456");

      // Verify audit event
      const auditEvents = orm.events.findMany({ where: { type: "reminder.dispatched" } });
      expect(auditEvents.length).toBe(1);

      // Verify message in ORM
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(messages.some(m => m.content.includes("Review AAPL quarterly earnings"))).toBe(true);
    });

    it("blocks options reports when E*TRADE cannot cover every requested underlying", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousOptionsAnalysis({
        symbols: ["AAPL", "MSFT"],
        thesis: "bullish",
        trigger: "manual",
        pushToSlack: false,
      });

      expect(res.success).toBe(false);
      expect(res.taskType).toBe("options_analysis");
      expect(res.error).toContain("Incomplete options universe");

      // A partial/auth-failed run must never become a completed report.
      const auditEvents = orm.events.findMany({ where: { type: "options.scheduled_analysis_failed" } });
      expect(auditEvents.length).toBe(1);
      const failurePayload = typeof auditEvents[0].payload === "string"
        ? JSON.parse(auditEvents[0].payload)
        : auditEvents[0].payload;
      expect(failurePayload).toMatchObject({
        screenType: "options",
        runType: "manual",
        runId: expect.stringMatching(/^options_scanner:/),
      });
      expect(orm.events.findMany({ where: { type: "options.scheduled_analysis_completed" } })).toHaveLength(0);

      // The failure remains visible to the user.
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(messages.some(m => m.content.includes("Scheduled Options Intelligence failed"))).toBe(true);
    });

    it("names the dominant skip reason in the coverage failure error (#915)", async () => {
      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousOptionsAnalysis({
        symbols: ["AAPL", "MSFT"],
        thesis: "bullish",
        pushToSlack: false,
      });

      expect(res.success).toBe(false);
      // Counts alone left the 2026-10-21 hourly failures undiagnosable
      // from the run record; the error must carry the modal reason from
      // the scan's skipped list (here: no stored E*TRADE session in the
      // test env, so every symbol skips with the token-missing reason).
      expect(res.error).toContain("Top skip reason:");
      expect(res.error).toContain("OAuth Token Missing");
      expect(res.error).toMatch(/\(2 of 2 failed symbols\)/);
    });
  });

  // =========================================================================
  // 2. Cloudflare Agent Scheduling Engine Primitives
  // =========================================================================
  describe("Agent Scheduling Lifecycle & Timers", () => {
    // Simulator for the Cloudflare Agent scheduler methods
    class AgentSchedulerHarness {
      schedules: AgentScheduleItem[] = [];

      async schedule(when: any, callback: string, payload?: any, options?: any): Promise<AgentScheduleItem> {
        const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const type = typeof when === "number" ? "delayed" : typeof when === "string" ? "cron" : "scheduled";
        const item: AgentScheduleItem = {
          id,
          callback,
          payload,
          type,
          time: typeof when === "number" ? Math.floor(Date.now() / 1000) + when : Math.floor(Date.now() / 1000) + 3600,
          cron: typeof when === "string" ? when : undefined,
          delayInSeconds: typeof when === "number" ? when : undefined,
        };
        this.schedules.push(item);
        return item;
      }

      async scheduleEvery(intervalSeconds: number, callback: string, payload?: any): Promise<AgentScheduleItem> {
        const id = `sched_every_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const item: AgentScheduleItem = {
          id,
          callback,
          payload,
          type: "interval",
          intervalSeconds,
          time: Math.floor(Date.now() / 1000) + intervalSeconds,
        };
        this.schedules.push(item);
        return item;
      }

      async listSchedules(criteria?: { type?: string }): Promise<AgentScheduleItem[]> {
        if (!criteria?.type) return this.schedules;
        return this.schedules.filter(s => s.type === criteria.type);
      }

      async getScheduleById(id: string): Promise<AgentScheduleItem | undefined> {
        return this.schedules.find(s => s.id === id);
      }

      async cancelSchedule(id: string): Promise<boolean> {
        const idx = this.schedules.findIndex(s => s.id === id);
        if (idx !== -1) {
          this.schedules.splice(idx, 1);
          return true;
        }
        return false;
      }
    }

    it("registers baseline cron and interval tasks on initialization", async () => {
      const harness = new AgentSchedulerHarness();

      // Simulate onStart baseline registration (renewal cron is
      // "0 3 * * *" UTC = 23:00 EDT / 22:00 EST since issue #107)
      await harness.schedule("0 3 * * *", "autoRenewETradeTokens", { userLogin: sessionId }, { idempotent: true });
      await harness.scheduleEvery(300, "autonomousMarketScreen", { sector: "Technology" });

      const all = await harness.listSchedules();
      expect(all.length).toBe(2);

      const cron = await harness.listSchedules({ type: "cron" });
      expect(cron.length).toBe(1);
      expect(cron[0].callback).toBe("autoRenewETradeTokens");
      expect(cron[0].cron).toBe("0 3 * * *");

      const interval = await harness.listSchedules({ type: "interval" });
      expect(interval.length).toBe(1);
      expect(interval[0].callback).toBe("autonomousMarketScreen");
      expect(interval[0].intervalSeconds).toBe(300);
    });

    it("schedules 15m expiration timer on order preview and cancels on user decision", async () => {
      const harness = new AgentSchedulerHarness();

      // 1. Preview order -> schedule 15m timer
      const expTimer = await harness.schedule(900, "expireStaleOrderDraft", { orderId: "ord_flow_123" });
      expect(expTimer.id).toBeDefined();
      expect(expTimer.type).toBe("delayed");
      expect(expTimer.delayInSeconds).toBe(900);

      // Verify timer is listed
      const found = await harness.getScheduleById(expTimer.id);
      expect(found).toBeDefined();

      // 2. User confirms or rejects order -> cancels timer
      const cancelled = await harness.cancelSchedule(expTimer.id);
      expect(cancelled).toBe(true);

      const afterCancel = await harness.getScheduleById(expTimer.id);
      expect(afterCancel).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. Natural Language Query (NLQ) Scheduling Intents Tests
  // =========================================================================
  describe("NLQ Scheduling Intent Integration", () => {
    it("plans schedule list intent from natural language query", async () => {
      const plan = await planNLQ(env, "show all active schedules and alarms");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("list");
    });

    it("plans schedule cancellation intent with target schedule ID", async () => {
      const plan = await planNLQ(env, "cancel schedule sched_abc123");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("cancel");
      expect(plan.scheduleData?.scheduleId).toBe("sched_abc123");
    });

    it("plans delayed reminder intent with parsed duration", async () => {
      const plan = await planNLQ(env, "remind me to check NVDA in 15 minutes");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("create");
      expect(plan.scheduleData?.scheduleType).toBe("delayed");
      expect(plan.scheduleData?.delayInSeconds).toBe(900);
      expect(plan.scheduleData?.description).toContain("check NVDA");
    });

    it("plans interval market screen intent with parsed frequency", async () => {
      const plan = await planNLQ(env, "schedule market screen every 5 minutes");
      expect(plan.domain).toBe("scheduling");
      expect(plan.scheduleData?.action).toBe("create");
      expect(plan.scheduleData?.scheduleType).toBe("interval");
      expect(plan.scheduleData?.intervalSeconds).toBe(300);
    });

    it("sync executeNLQQuery refuses scheduling actions honestly (issue #109)", async () => {
      // The sync executor cannot call the async Agent scheduling API.
      // Before issue #109 it invented a `sched_<type>_<ts>` id, wrote a
      // schedule.created audit event against a nonexistent mas_schedules
      // table, and reported success for schedules that did not exist.
      // It now refuses honestly; real scheduling runs through
      // executeNLQQueryAsync with an injected NLQSchedulingPort
      // (covered in tests/nlq_scheduling.test.ts).
      const createPlan = await planNLQ(env, "remind me to check AAPL in 10 minutes");
      const createResult = executeNLQQuery(orm, sessionId, createPlan, env);

      expect(createResult.domain).toBe("scheduling");
      expect(createResult.status).toBe("error");
      expect(createResult.count).toBe(0);
      expect(createResult.summary).not.toContain("Task scheduled successfully");
      expect(createResult.summary).toContain("executeNLQQueryAsync");

      const listPlan = await planNLQ(env, "list all scheduled tasks");
      const listResult = executeNLQQuery(orm, sessionId, listPlan, env);

      expect(listResult.status).toBe("error");
      expect(listResult.rows).toEqual([]);

      const cancelPlan = await planNLQ(env, "cancel schedule sched_delayed_test");
      const cancelResult = executeNLQQuery(orm, sessionId, cancelPlan, env);

      expect(cancelResult.status).toBe("error");
      expect(cancelResult.summary).not.toContain("cancelled successfully");

      // No phantom audit writes from the sync path.
      expect(orm.events.findMany({ where: { type: "schedule.created" } }).length).toBe(0);
      expect(orm.events.findMany({ where: { type: "schedule.cancelled" } }).length).toBe(0);
    });
  });
});
