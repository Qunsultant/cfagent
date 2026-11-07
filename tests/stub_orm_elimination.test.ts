/**
 * Issue #781 — stub-ORM elimination pins.
 *
 * Seven construction sites used to fall back to a DatabaseORM built on an
 * exec stub that returns an empty array whenever no ORM was injected:
 * against it every read silently returned empty and every write silently
 * vanished (the persistAudit failure class, generalized). These pins hold
 * the new contract:
 *
 *  - No stub-ORM pattern may exist anywhere in src/ (source pin).
 *  - Persistence-backed flows FAIL LOUD with a named MissingOrmError when
 *    no ORM was injected (slack event handling, inbound email, voice NLQ).
 *  - Legitimate ORM-free modes keep working: the Slack url_verification
 *    handshake, outbound-only email sending, and the client-only options
 *    flows (UnifiedOptionsService.execute, ScheduledTasksService IV
 *    collection) that forward the ORM to ETradeService, whose own ORM
 *    contract is optional and fully guarded.
 *  - With a real ORM wired, the previously stub-reachable Slack approval
 *    ledger flow genuinely reads and writes the trade ledger.
 *
 * Red/green note: the MissingOrmError pins and the source pin fail on
 * pre-change code; the ORM-free-mode and wired-ORM pins are
 * characterization pins that pass on both sides by design.
 */
import { describe, it, expect, vi } from "vitest";
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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { ETradeEmailTradingService } from "../src/trading/email/agent";
import { ETradeVoiceTradingService } from "../src/trading/voice/agent";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { InMemoryIvHistoryStore } from "../src/trading/options/ivHistoryStore";
import type { Env, ETradeOptionChain, InboundEmailPayload } from "../src/types";

const SESSION = "stub_orm_pin_session";

/** Env with no Slack delivery credentials: postSlackMessage no-ops. */
const bareEnv = {
  ETRADE_ENVIRONMENT: "sandbox",
  EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
} as Env;

const voiceEnv = {
  APP_BASE_URL: "https://agent.openaimp.com",
  AI_SEARCH_ENDPOINT: "https://ai-search.internal",
  ORCHESTRATOR_AGENT: {} as any,
  ETRADE_ENVIRONMENT: "sandbox",
} as Env;

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(SESSION);
  return orm;
}

function chainFixture(symbol: string, spot: number): ETradeOptionChain {
  return {
    symbol,
    underlyingPrice: spot,
    quoteTime: Date.now(),
    selectedExpiry: { year: 2026, month: 11, day: 20 },
    pairs: [
      {
        call: {
          symbol, optionType: "CALL", strikePrice: spot,
          bid: 4.9, ask: 5.1, lastPrice: 5, volume: 800, openInterest: 2000,
          impliedVolatility: 0.3, delta: 0.52, gamma: 0.04, theta: -0.05, vega: 0.12, rho: 0.02,
        },
        put: {
          symbol, optionType: "PUT", strikePrice: spot,
          bid: 4.7, ask: 4.9, lastPrice: 4.8, volume: 700, openInterest: 1800,
          impliedVolatility: 0.32, delta: -0.48, gamma: 0.04, theta: -0.05, vega: 0.12, rho: -0.02,
        },
      },
    ],
  } as ETradeOptionChain;
}

describe("issue #781: stub-ORM elimination", () => {
  it("source pin: no stub-ORM fallback pattern anywhere in src/", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    // The stub signature is an exec that ignores its query and returns a
    // bare empty array. Legitimate adapters elsewhere construct a
    // DatabaseORM over an exec object — but theirs forward to real
    // storage and return actual rows ([...stmt]), never a bare [].
    // These patterns discriminate on exactly that. (Comment updated
    // by #2361: the two agent shims this note once named are retired —
    // research-agent's was dead code, screener-agent's is now the
    // standard direct construction over ctx.storage.sql. No pattern
    // or assertion changed.)
    const patterns = [
      /exec\s*:\s*\([^)]*\)\s*=>\s*(?:\{\s*return\s*)?\[\s*\]/,
      /exec\s*\([^)]*\)\s*\{\s*return\s*\[\s*\]\s*;?\s*\}/,
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          const text = readFileSync(full, "utf-8");
          if (patterns.some((p) => p.test(text))) {
            offenders.push(path.relative(srcRoot, full));
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it("requireOrm returns the injected ORM and throws a named MissingOrmError otherwise", async () => {
    // Dynamic import so this suite still loads against pre-change code,
    // where the helper does not exist yet (the test then fails as a test,
    // not as a module load error).
    const ormModule = (await import("../src/orm")) as any;
    expect(typeof ormModule.requireOrm).toBe("function");
    expect(typeof ormModule.MissingOrmError).toBe("function");
    const orm = makeOrm();
    expect(ormModule.requireOrm(orm, "SomeService.method")).toBe(orm);
    let caught: any;
    try {
      ormModule.requireOrm(undefined, "SomeService.method");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ormModule.MissingOrmError);
    expect(caught?.name).toBe("MissingOrmError");
    expect(caught?.message).toContain("SomeService.method");
    expect(caught?.message).toMatch(/DatabaseORM/);
  });

  it("slack: url_verification handshake still works without an ORM", async () => {
    const service = new ETradeSlackTradingService(bareEnv, undefined, SESSION);
    const result = await service.processSlackEvent({
      type: "url_verification",
      challenge: "challenge-token-123",
    });
    expect(result.handled).toBe(true);
    expect(result.challenge).toBe("challenge-token-123");
  });

  it("slack: event_callback without an ORM throws MissingOrmError instead of reading an empty ledger", async () => {
    const service = new ETradeSlackTradingService(bareEnv, undefined, SESSION);
    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        user: "U123",
        text: "cancel ord_whatever",
        channel: "C123",
        ts: "1727800000.000001",
      },
    };
    await expect(service.processSlackEvent(payload)).rejects.toThrowError(/DatabaseORM/);
    const ormModule = (await import("../src/orm")) as any;
    await expect(service.processSlackEvent(payload)).rejects.toBeInstanceOf(
      ormModule.MissingOrmError
    );
  });

  it("slack: with a real ORM wired, a cancel event reads and writes the actual trade ledger", async () => {
    const orm = makeOrm();
    orm.trades.create({
      id: "ord_pin_cancel_1",
      sessionId: SESSION,
      symbol: "AAPL",
      action: "BUY",
      orderType: "LIMIT",
      quantity: 5,
      price: 200,
      totalValue: 1000,
      status: "previewed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const service = new ETradeSlackTradingService(bareEnv, orm, SESSION);
    const result = await service.processSlackEvent({
      type: "event_callback",
      event: {
        type: "message",
        user: "U123",
        text: "cancel ord_pin_cancel_1",
        channel: "C123",
        ts: "1727800000.000002",
      },
    });
    expect(result.handled).toBe(true);
    expect(result.actionType).toBe("rejection");
    expect(orm.trades.findById("ord_pin_cancel_1")?.status).toBe("rejected");
  });

  it("email: processInboundEmail without an ORM throws MissingOrmError instead of fabricating answers from an empty ledger", async () => {
    const service = new ETradeEmailTradingService(bareEnv);
    const payload: InboundEmailPayload = {
      from: "human.trader@example.com",
      to: "trade@agent.openaimp.com",
      subject: "APPROVE ord_pin_1",
      text: "APPROVE ord_pin_1",
    };
    await expect(service.processInboundEmail(payload)).rejects.toThrowError(/DatabaseORM/);
    const ormModule = (await import("../src/orm")) as any;
    await expect(service.processInboundEmail(payload)).rejects.toBeInstanceOf(
      ormModule.MissingOrmError
    );
  });

  it("email: sendOutboundEmail remains ORM-free (the legitimate send-only mode)", async () => {
    let sentBody = "";
    const env = {
      ...bareEnv,
      EMAIL: {
        send: vi.fn(async (message: ReadableStream<Uint8Array>) => {
          sentBody = await new Response(message).text();
        }),
      },
    } as unknown as Env;
    const service = new ETradeEmailTradingService(env);
    const sent = await service.sendOutboundEmail(
      "analyst@example.com",
      "NLQ webhook response",
      "<p>Summary</p>",
      "Summary"
    );
    expect(sent).toBe(true);
    expect(sentBody).toContain("Summary");
  });

  it("voice: an NLQ turn without an ORM fails honestly, naming the missing DatabaseORM", async () => {
    const service = new ETradeVoiceTradingService(voiceEnv, undefined, SESSION);
    const result = await service.processVoiceTurn({
      transcript: "What is nvidia trading at?",
      sessionId: SESSION,
    });
    expect(result.success).toBe(false);
    expect(result.displayMarkdown).toMatch(/DatabaseORM/);
  });

  it("unified: execute(screen) without an ORM still succeeds — client-only flow, no stub substituted", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: chainFixture("NVDA", 130) });
    try {
      const service = new UnifiedOptionsService({ ETRADE_ENVIRONMENT: "sandbox" } as Env, "test-user");
      const result = await service.execute({
        action: "screen",
        symbol: "NVDA",
        channel: "ui",
      });
      expect(result.success).toBe(true);
      expect(result.action).toBe("screen");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("scheduled: collectDailyIvHistory without an ORM still records through the real data path", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: chainFixture("AAPL", 100) });
    try {
      const store = new InMemoryIvHistoryStore();
      const service = new ScheduledTasksService({} as Env, undefined, "trader1", undefined, store);
      const result = await service.collectDailyIvHistory({ symbols: ["AAPL"] });
      expect(result.success).toBe(true);
      expect(result.data?.recorded).toBe(1);
      expect(result.data?.failed).toBe(0);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
