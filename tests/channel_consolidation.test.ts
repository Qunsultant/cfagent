/**
 * Issue #1262 Phases 2–5 consolidation tests.
 *
 * - Phase 2 (Slack dedup): SlackAgent.onRequest delegates commands and
 *   interactions to the single ETradeSlackTradingService, and the
 *   retired SlackAgent.handleSlashCommand / handleInteraction methods
 *   are gone (source pin).
 * - Phase 4 (NLQ parity, closes #880): channel NLQ calls thread the
 *   web-chat dep set (scan/profile stores, scheduling port, discovery
 *   runners) and pass untrustedContent: true unconditionally — for
 *   email, Slack, and voice alike. Voice additionally gates on the
 *   peek (paid actions refused) and falls back to its constructor
 *   scheduling port when the dep set carries none.
 *
 * NLQ is mocked at the module boundary (same pattern as
 * tests/channel_intake.test.ts); the dep stubs below are distinctive
 * objects so the tests assert pass-through by identity, not shape.
 * Social-approval principal gating lives with the handler tests in
 * tests/social_approval_actions.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";

const mockNlq = vi.hoisted(() => ({
  plan: {
    domain: "trading",
    operation: "read",
    tradingData: { action: "quote" },
    terms: "",
    role: "any",
    since: null,
    limit: 25,
  } as any,
  executeCalls: [] as any[][],
  planCalls: [] as any[][],
  result: {
    domain: "trading",
    targetTable: "trades",
    count: 1,
    status: "ok",
    summary: "Quote for NVDA",
    rows: [
      {
        symbol: "NVDA",
        company: "NVIDIA Corporation",
        lastPrice: "$131.88",
        change: "+1.24%",
        bidAsk: "131.80 / 131.90",
        volume: "12.3M",
        range52Week: "75.61 - 140.76",
        peRatio: "54.2",
        marketCap: "$3.24T",
      },
    ],
    executedAt: "2026-10-24T00:00:00.000Z",
  } as any,
}));

vi.mock("../src/agents/nlq", () => ({
  executeNaturalLanguageQuery: vi.fn(async (...args: any[]) => {
    mockNlq.executeCalls.push(args);
    return { plan: mockNlq.plan, result: mockNlq.result };
  }),
  planNLQ: vi.fn(async (...args: any[]) => {
    mockNlq.planCalls.push(args);
    return mockNlq.plan;
  }),
}));

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

import { SlackAgent } from "../src/agents/slackAgent";
import { ETradeEmailTradingService } from "../src/trading/email/agent";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { ETradeVoiceTradingService } from "../src/trading/voice/agent";
import {
  confirmSlackLink,
  slackPrincipalLinkStoreFromEnv,
  type ChannelPrincipal,
} from "../src/trading/channels/intake";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

const SECRET = "test-consolidation-signing-secret";
const TEAM = "T1262";
const SESSION = "consolidation_test_session";

const baseEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
    // Issue #3937: the Slack desk is an E*TRADE service, so the test
    // tenant selects etrade explicitly — the platform default is alpaca now.
    BROKER_ID: "etrade",
    EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: "xoxb-test-1262",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T00/B00/X00",
    ...overrides,
  }) as Env;

const tradePrincipal: ChannelPrincipal = {
  userLogin: "trader-login",
  authorizerDid: "did:user:slack:U1",
  tier: "trade",
};

describe("Phase 2 — Slack dedup: one handler path", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(`slack_${TEAM}`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
      json: async () => ({ ok: true }),
    } as any);
  });

  const linkedEnv = async (userId: string): Promise<Env> => {
    const env = baseEnv({ SESSION_STORE: makeFakeSessionStore().namespace } as any);
    const store = slackPrincipalLinkStoreFromEnv(env);
    const { code } = await store.issueLinkCode(TEAM, userId);
    const confirmed = await confirmSlackLink(env, code, `trader-${userId.toLowerCase()}`);
    expect(confirmed.ok).toBe(true);
    return env;
  };

  const signedPost = async (url: string, body: string, contentType: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + (await computeHmacSha256Hex(SECRET, `v0:${ts}:${body}`));
    return new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "x-slack-request-timestamp": ts,
        "x-slack-signature": signature,
      },
      body,
    });
  };

  const mockCtx = () => ({
    id: { toString: () => TEAM },
    storage: { sql },
    waitUntil: vi.fn(),
  });

  it("onRequest commands delegate to ETradeSlackTradingService.processSlackCommand", async () => {
    const processSlackCommand = vi
      .spyOn(ETradeSlackTradingService.prototype, "processSlackCommand")
      .mockResolvedValue(new Response("ok"));
    const agent = new SlackAgent(mockCtx() as any, await linkedEnv("U1"));
    const body = "command=%2Fhelp&text=&team_id=T1262&user_id=U1&channel_id=C1";
    const res = await agent.onRequest(
      await signedPost("https://agent.internal/slack/commands", body, "application/x-www-form-urlencoded")
    );
    expect(res.status).toBe(200);
    expect(processSlackCommand).toHaveBeenCalledTimes(1);
    expect((processSlackCommand.mock.calls[0][0] as FormData).get("command")).toBe("/help");
  });

  it("onRequest interactions delegate to ETradeSlackTradingService.processSlackInteraction", async () => {
    const processSlackInteraction = vi
      .spyOn(ETradeSlackTradingService.prototype, "processSlackInteraction")
      .mockResolvedValue({ actionId: "x", status: "ok" } as any);
    const agent = new SlackAgent(mockCtx() as any, await linkedEnv("U1"));
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        type: "block_actions",
        team: { id: TEAM },
        user: { id: "U1" },
        channel: { id: "C1" },
        actions: [{ action_id: "some_unknown_action", value: "ord_none" }],
      })
    )}`;
    const res = await agent.onRequest(
      await signedPost("https://agent.internal/slack/interactions", body, "application/x-www-form-urlencoded")
    );
    expect(res.status).toBe(200);
    expect(processSlackInteraction).toHaveBeenCalledTimes(1);
  });

  it("the retired SlackAgent handlers are gone (source pin)", () => {
    const src = readFileSync("src/agents/slackAgent.ts", "utf8");
    expect(src).not.toContain("async handleSlashCommand");
    expect(src).not.toContain("async handleInteraction");
    // The shell keeps the SDK surface: export, health, gate, delegations.
    expect(src).toContain("export class SlackAgent");
    expect(src).toContain("sendPreTradeApprovalTicket");
    expect(src).toContain("dispatchTransactionSnap");
  });
});

describe("Phase 4 — NLQ parity + untrustedContent (#880)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;

  beforeEach(() => {
    mockNlq.executeCalls.length = 0;
    mockNlq.planCalls.length = 0;
    mockNlq.plan = {
      domain: "trading",
      operation: "read",
      tradingData: { action: "quote" },
      terms: "",
      role: "any",
      since: null,
      limit: 25,
    } as any;
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(SESSION);
  });

  const deps = () => ({
    scanRunStore: { marker: "scan" } as any,
    profileStore: { marker: "profile" } as any,
    schedulingPort: { marker: "sched" } as any,
    discoveryRunner: { marker: "discovery" } as any,
    fitDiscoveryRunner: { marker: "fit" } as any,
  });

  it("email NLQ threads the dep set and forces untrustedContent", async () => {
    const d = deps();
    const service = new ETradeEmailTradingService(baseEnv(), orm, SESSION, {
      userLogin: "analyst-login",
      authorizerDid: "did:user:email:analyst@example.com",
      tier: "preview",
    }, d);
    const result = await service.processInboundEmail({
      from: "analyst@example.com",
      to: "trade@agent.openaimp.com",
      subject: "Quote NVDA",
      text: "Latest quote for NVDA please",
    });
    expect(result.success).toBe(true);
    expect(mockNlq.executeCalls).toHaveLength(1);
    const options = mockNlq.executeCalls[0][6];
    expect(options.untrustedContent).toBe(true);
    expect(options.scanRunStore).toBe(d.scanRunStore);
    expect(options.profileStore).toBe(d.profileStore);
    expect(options.schedulingPort).toBe(d.schedulingPort);
    expect(options.discoveryRunner).toBe(d.discoveryRunner);
    expect(options.fitDiscoveryRunner).toBe(d.fitDiscoveryRunner);
  });

  it("Slack event NLQ peeks untrusted, then executes with the dep set", async () => {
    const d = deps();
    const service = new ETradeSlackTradingService(baseEnv(), orm, SESSION, tradePrincipal, undefined, d);
    const result = await service.processSlackEvent({
      type: "event_callback",
      team_id: TEAM,
      event: { type: "message", user: "U1", text: "quote NVDA", channel: "C1" },
    });
    expect(result.handled).toBe(true);
    expect(mockNlq.planCalls).toHaveLength(1);
    expect(mockNlq.planCalls[0][2]).toEqual({ untrustedContent: true });
    expect(mockNlq.executeCalls).toHaveLength(1);
    const options = mockNlq.executeCalls[0][6];
    expect(options.untrustedContent).toBe(true);
    expect(options.scanRunStore).toBe(d.scanRunStore);
    expect(options.discoveryRunner).toBe(d.discoveryRunner);
  });

  it("voice NLQ threads the dep set and forces untrustedContent", async () => {
    const d = deps();
    const service = new ETradeVoiceTradingService(
      baseEnv(),
      orm,
      "voice-login",
      { marker: "ctor-sched" } as any,
      tradePrincipal,
      d
    );
    const result = await service.processVoiceTurn({ transcript: "quote NVDA" });
    expect(result.success).toBe(true);
    expect(mockNlq.executeCalls).toHaveLength(1);
    const options = mockNlq.executeCalls[0][6];
    expect(options.untrustedContent).toBe(true);
    expect(options.scanRunStore).toBe(d.scanRunStore);
    expect(options.schedulingPort).toBe(d.schedulingPort);
  });

  it("voice NLQ falls back to the constructor scheduling port when the dep set has none", async () => {
    const ctorPort = { marker: "ctor-sched" } as any;
    const d = deps();
    delete (d as any).schedulingPort;
    const service = new ETradeVoiceTradingService(baseEnv(), orm, "voice-login", ctorPort, tradePrincipal, d);
    await service.processVoiceTurn({ transcript: "quote NVDA" });
    expect(mockNlq.executeCalls).toHaveLength(1);
    expect(mockNlq.executeCalls[0][6].schedulingPort).toBe(ctorPort);
  });

  it("voice peek gate refuses a channel-origin paid action before any execution", async () => {
    mockNlq.plan = {
      domain: "agentic_payments",
      operation: "create",
      agenticPaymentsData: { action: "paid_scan" },
      terms: "",
      role: "any",
      since: null,
      limit: 10,
    } as any;
    const service = new ETradeVoiceTradingService(baseEnv(), orm, "voice-login", undefined, tradePrincipal, deps());
    const result = await service.processVoiceTurn({ transcript: "quote NVDA" });
    expect(result.success).toBe(false);
    expect(result.spokenText).toMatch(/paid/i);
    expect(mockNlq.executeCalls).toHaveLength(0);
  });
});
