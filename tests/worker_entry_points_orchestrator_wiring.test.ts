/**
 * Issue #815 — worker entry points route through the orchestrator DO.
 *
 * #781 made the worker's two ORM-less entry points fail loud instead of
 * fabricating answers from a stub ORM:
 *  - the worker `email` export (inbound email trading), and
 *  - the voice WebSocket route (voice NLQ turns).
 * #815 restores both features honestly: each entry point forwards its
 * persistence-backed work to the owning user's OrchestratorAgent DO —
 * the same SEARCH_AGENT channel every /api route uses — where the
 * email/voice services run against the DO's real ORM. The DO-side
 * handlers already exist (POST /trading/email/inbound and
 * POST /trading/voice/turn in src/agents/routes/tradingIntegrations.ts);
 * these pins hold the worker-side wiring:
 *
 *  - An emailed APPROVE acts on the real pending preview: the full chain
 *    worker email export → SEARCH_AGENT forward → DO route → service
 *    transitions the seeded ledger row to "executed".
 *  - The forward is addressed to the worker's established owner
 *    instance — never an instance derived from the (caller-controlled)
 *    sender address. #1262 Phase 1 supersedes the identity half of the
 *    original pin: the forward no longer asserts an identity header;
 *    it carries the sender + Authentication-Results, and the DO route
 *    resolves the channel principal (sender map + DKIM/SPF gate). The
 *    APPROVE below therefore runs as a mapped trade-tier principal
 *    whose message passed DKIM.
 *  - A voice NLQ turn over the WebSocket reads real data via the
 *    per-turn DO forwarder (seeded store + screener fixtures).
 *  - If the orchestrator path is unavailable, both entry points keep
 *    failing loud — no ORM-less local fallback is reintroduced.
 *  - Source pins: no worker entry point constructs the email/voice
 *    services for persistence work without the orchestrator path.
 *
 * Red/green note: on post-#781 code the email export throws
 * MissingOrmError, the voice forwarder export does not exist, and the
 * source pins fail — the fail-loud pins below assert that before-state
 * contract is preserved when the DO path is absent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ETradeRestClient } from "../src/trading/etrade/client";

/**
 * §7 adaptation (#2389): approvals now settle through the broker
 * client's placeOrder — the platform no longer settles locally. The
 * two approval tests below stub that placement seam with a
 * broker-confirmed result; the worker-entry wiring under test is
 * exercised for real (restored by the file's restoreAllMocks).
 */
function stubBrokerPlacement() {
  return vi.spyOn(ETradeRestClient.prototype, "placeOrder").mockImplementation(async (params: any) => ({
    success: true,
    orderId: params.orderId,
    executionId: "et_order_wiring",
    brokerOrderRef: "et_order_wiring",
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
      signature: ["sig", "0xbrokerwiring"].join("_"),
    },
    message: "E*TRADE Execution Confirmed: Broker Order ID et_order_wiring",
    timestamp: new Date().toISOString(),
  }) as any);
}

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/api_chat_auth.test.ts); routeAgentRequest returns
// null so the worker's own dispatch runs.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { handleTradingIntegrationsRoutes } from "../src/agents/routes/tradingIntegrations";
import { issueApprovalLink } from "../src/trading/channels/signedLinks";
import {
  handleVoiceWebSocketConnection,
  createOrchestratorVoiceTurnForwarder,
} from "../src/trading/voice/agent";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import type { Env, AgentScheduleItem } from "../src/types";
import type { NLQSchedulingPort } from "../src/agents/nlq";

/** The worker's established owner instance for session-less entry points
 *  (the same instance name the scheduled() handler forwards to).
 *  Renamed default_trader -> shared_orchestrator by issue #2681; the
 *  test's premise (email forwards to the owner instance) is unchanged. */
const OWNER_INSTANCE = "shared_orchestrator";
const VOICE_LOGIN = "voice-user-815";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** In-memory NLQSchedulingPort (pattern: tests/voice_trading.test.ts). */
class FakeSchedulingPort implements NLQSchedulingPort {
  items: AgentScheduleItem[] = [];
  private seq = 0;
  async schedule(when: Date | string | number, callback: string, payload?: unknown): Promise<AgentScheduleItem> {
    const nowSec = Math.floor(Date.now() / 1000);
    const item: AgentScheduleItem = {
      id: `port-id-${++this.seq}`,
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
      id: `port-id-${++this.seq}`,
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

/** Lightweight mock WebSocket (pattern: tests/voice_trading.test.ts). */
class MockDuplexWebSocket {
  listeners: Record<string, ((event: any) => void)[]> = {};
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  addEventListener(event: string, cb: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = true;
    this.closeCode = code;
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

interface ForwardedCall {
  id: string;
  pathname: string;
  userLogin: string | null;
  body: any;
}

/**
 * A SEARCH_AGENT namespace stub whose stub fetch delegates to the REAL
 * orchestrator trading-integrations route handler, backed by the seeded
 * ORM — the test double for the DO itself. This is what makes the pins
 * integration-level: the worker wiring, the forward, the DO route, the
 * service, and the ledger are all the production code paths.
 */
function makeOrchestratorNamespace(orm: DatabaseORM, env: Env, forwarded: ForwardedCall[]) {
  return {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const body = await req.clone().json().catch(() => null);
        forwarded.push({ id, pathname: url.pathname, userLogin: req.headers.get("x-user-login"), body });
        const response = await handleTradingIntegrationsRoutes(req, url, url.pathname, "do_test_session", {
          env,
          getOrm: () => orm,
          audit: () => {},
          agentCtx: {} as any,
          nlqSchedulingPort: () => new FakeSchedulingPort(),
          // Issue #1262 Phase 4: the route builds the channel NLQ
          // dep set from DO storage SQL for every channel service.
          getStorageSql: () => ({ exec: () => [] }) as any,
        });
        return response ?? Response.json({ error: "route not found" }, { status: 404 });
      },
    }),
  };
}

function makeOrm(session: string): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(session);
  return orm;
}

function seedPreviewedTrade(orm: DatabaseORM, session: string, id: string) {
  orm.trades.create({
    id,
    sessionId: session,
    symbol: "AAPL",
    action: "BUY",
    orderType: "MARKET",
    quantity: 5,
    price: 225.5,
    totalValue: 1127.5,
    status: "previewed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function rawEmailMessage(from: string, subject: string, text: string, authResults?: string) {
  const mime = [
    `From: ${from}`,
    "To: trade@agent.openaimp.com",
    `Subject: ${subject}`,
    ...(authResults ? [`Authentication-Results: ${authResults}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "",
  ].join("\r\n");
  return {
    from,
    to: "trade@agent.openaimp.com",
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(mime));
        controller.close();
      },
    }),
    headers: new Headers(),
  };
}

// ---------------------------------------------------------------------------
// Email entry point
// ---------------------------------------------------------------------------

describe("issue #815: worker email export routes through the orchestrator DO", () => {
  it("an emailed signed-link approval acts on the real pending preview in the orchestrator's ledger", async () => {
    stubBrokerPlacement();
    const orm = makeOrm(OWNER_INSTANCE);
    seedPreviewedTrade(orm, OWNER_INSTANCE, "ord_815_email_1");

    const forwarded: ForwardedCall[] = [];
    const sentMail: string[] = [];
    const env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
      // #1262 Phase 1: the sender is a mapped trade-tier principal.
      CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
        "human.trader@example.com": { login: "owner-login", tier: "trade" },
      }),
      // #1262 Phase 5: the approval travels as a signed link, so the
      // env carries the link secret the issuance + verification read.
      CHANNEL_APPROVAL_LINK_SECRET: "test-link-secret-1262",
      SERVICE_USER_LOGIN: OWNER_INSTANCE,
      EMAIL: {
        send: vi.fn(async (message: ReadableStream<Uint8Array>) => {
          sentMail.push(await new Response(message).text());
        }),
      },
    } as unknown as Env;
    (env as any).SEARCH_AGENT = makeOrchestratorNamespace(orm, env, forwarded);

    // Phase 5: a bare APPROVE no longer executes — the approval reply
    // quotes the signed link issued for this draft (the preview email
    // carries it; here it is issued directly for the seeded draft).
    const issued = await issueApprovalLink(env as Env, {
      orderId: "ord_815_email_1",
      login: "owner-login",
      address: "human.trader@example.com",
      baseUrl: "https://agent.openaimp.com",
    });
    expect(issued).not.toBeNull();
    const message = rawEmailMessage(
      "human.trader@example.com",
      "Re: HITL Action Required: Preview BUY 5 AAPL [ord_815_email_1]",
      `APPROVE ord_815_email_1\n${issued!.url}`,
      // #1262 Phase 1: the trade tier requires a DKIM (or SPF) pass on
      // this exact message.
      "mx.openaimp.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com"
    );
    await (worker as any).email(message, env, {});

    // The persistence work travelled the SEARCH_AGENT channel to the
    // DO-side inbound-email route, addressed to the worker's established
    // owner instance — the instance is NOT derived from the
    // caller-controlled sender address. #1262 Phase 1: the forward
    // asserts NO identity header; it carries the sender and the
    // Authentication-Results, and the DO route resolves the principal.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/email/inbound");
    expect(forwarded[0].id).toBe(OWNER_INSTANCE);
    expect(forwarded[0].userLogin).toBeNull();
    expect(forwarded[0].body.from).toBe("human.trader@example.com");
    expect(forwarded[0].body.text).toContain("APPROVE ord_815_email_1");
    expect(forwarded[0].body.authenticationResults).toContain("dkim=pass");

    // The approval transitioned the ACTUAL seeded row.
    expect(orm.trades.findById("ord_815_email_1")?.status).toBe("executed");

    // The reply was dispatched from the worker (send-only path).
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toContain("E*TRADE Order Executed");
  });

  it("keeps failing loud when the orchestrator binding is unavailable — no ORM-less fallback", async () => {
    const orm = makeOrm(OWNER_INSTANCE);
    seedPreviewedTrade(orm, OWNER_INSTANCE, "ord_815_email_2");

    const env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
      // No SEARCH_AGENT binding at all.
    } as unknown as Env;

    const message = rawEmailMessage("human.trader@example.com", "Approval", "APPROVE ord_815_email_2");
    await expect((worker as any).email(message, env, {})).rejects.toThrow(/SEARCH_AGENT/);

    // Nothing fabricated an answer and the row is untouched.
    expect(orm.trades.findById("ord_815_email_2")?.status).toBe("previewed");
  });

  it("keeps failing loud when the orchestrator rejects the forward", async () => {
    const orm = makeOrm(OWNER_INSTANCE);
    seedPreviewedTrade(orm, OWNER_INSTANCE, "ord_815_email_3");

    const env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
      SERVICE_USER_LOGIN: OWNER_INSTANCE,
      SEARCH_AGENT: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => Response.json({ error: "do unavailable" }, { status: 503 }) }),
      },
    } as unknown as Env;

    const message = rawEmailMessage("human.trader@example.com", "Approval", "APPROVE ord_815_email_3");
    await expect((worker as any).email(message, env, {})).rejects.toThrow(/503|orchestrator/i);
    expect(orm.trades.findById("ord_815_email_3")?.status).toBe("previewed");
  });
});

// ---------------------------------------------------------------------------
// Voice entry point
// ---------------------------------------------------------------------------

describe("issue #815: voice WebSocket turns route through the orchestrator DO", () => {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    DynamicMarketScreener.setTestListingsFixture(null);
  });

  it("a voice NLQ turn reads real data through the per-turn orchestrator forward", async () => {
    const orm = makeOrm(VOICE_LOGIN);
    const forwarded: ForwardedCall[] = [];
    const env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
    } as unknown as Env;
    (env as any).SEARCH_AGENT = makeOrchestratorNamespace(orm, env, forwarded);

    const ws = new MockDuplexWebSocket();
    const forwardTurn = createOrchestratorVoiceTurnForwarder(env, VOICE_LOGIN);
    await handleVoiceWebSocketConnection(ws as any, env, undefined, VOICE_LOGIN, forwardTurn);

    await ws.emitClientMessage({ type: "turn", transcript: "What is nvidia trading at?" });

    const messages = ws.getParsedMessages();
    const turn = messages.find((m) => m.type === "assistant_turn");
    expect(turn).toBeDefined();
    expect(turn.actionType).toBe("quote");
    expect(turn.marketQuote?.symbol).toBe("NVDA");
    expect(turn.spokenText).toContain("NVIDIA Corporation");

    // The turn travelled to the session user's own orchestrator instance
    // with the worker-set identity header.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/voice/turn");
    expect(forwarded[0].id).toBe(VOICE_LOGIN);
    expect(forwarded[0].userLogin).toBe(VOICE_LOGIN);
  });

  it("a voice approval turn transitions the seeded preview in the orchestrator's ledger", async () => {
    stubBrokerPlacement();
    const orm = makeOrm(VOICE_LOGIN);
    seedPreviewedTrade(orm, VOICE_LOGIN, "ord_815_voice_1");
    const forwarded: ForwardedCall[] = [];
    const env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
    } as unknown as Env;
    (env as any).SEARCH_AGENT = makeOrchestratorNamespace(orm, env, forwarded);

    const ws = new MockDuplexWebSocket();
    const forwardTurn = createOrchestratorVoiceTurnForwarder(env, VOICE_LOGIN);
    await handleVoiceWebSocketConnection(ws as any, env, undefined, VOICE_LOGIN, forwardTurn);

    await ws.emitClientMessage({ type: "turn", transcript: "Confirm execution of order ord_815_voice_1" });

    const messages = ws.getParsedMessages();
    const turn = messages.find((m) => m.type === "assistant_turn");
    expect(turn).toBeDefined();
    expect(turn.actionType).toBe("approval");
    expect(turn.orderStatus).toBe("executed");
    expect(orm.trades.findById("ord_815_voice_1")?.status).toBe("executed");
  });

  it("without an ORM or a forwarder, a voice NLQ turn still fails honestly (no stub fallback)", async () => {
    const env = {
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      SEARCH_AGENT: {} as any,
    } as unknown as Env;

    const ws = new MockDuplexWebSocket();
    await handleVoiceWebSocketConnection(ws as any, env, undefined, VOICE_LOGIN);

    await ws.emitClientMessage({ type: "turn", transcript: "What is nvidia trading at?" });

    const messages = ws.getParsedMessages();
    const turn = messages.find((m) => m.type === "assistant_turn");
    expect(turn).toBeDefined();
    expect(turn.displayMarkdown).toMatch(/DatabaseORM/);
  });
});

// ---------------------------------------------------------------------------
// Source pins
// ---------------------------------------------------------------------------

describe("issue #815: source pins — no ORM-less persistence at worker entry points", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const readSrc = (rel: string) => readFileSync(path.join(srcRoot, rel), "utf-8");

  it("server.ts wires the voice route with the orchestrator turn forwarder", () => {
    const server = readSrc("server.ts");
    expect(server).toContain("createOrchestratorVoiceTurnForwarder(env, userLogin)");
    expect(server).not.toMatch(/handleVoiceWebSocketConnection\(serverWs, env, undefined, userLogin\)/);
  });

  it("the worker email handler forwards inbound mail to the orchestrator route instead of processing it ORM-less", () => {
    const emailAgent = readSrc("trading/email/agent.ts");
    expect(emailAgent).toContain("/trading/email/inbound");
    expect(emailAgent).toContain("SEARCH_AGENT");
    // processInboundEmail is DEFINED in this module (the DO-side service
    // method) but never INVOKED here — invocation happens inside the
    // orchestrator via POST /trading/email/inbound.
    expect(emailAgent).not.toMatch(/\.\s*processInboundEmail\s*\(/);
  });
});
