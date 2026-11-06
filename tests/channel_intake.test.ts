/**
 * Issue #1262 Phase 1 — channel identity (ChannelIntake → resolvePrincipal).
 *
 * Pins the frozen design (~/workspace/cfagent-channels/phase1-design.md):
 *  - Email principals come from the CHANNEL_EMAIL_PRINCIPALS config map;
 *    the trade tier additionally requires a DKIM or SPF pass parsed from
 *    the Authentication-Results header, else the message is downgraded
 *    to read tier with a stated reason.
 *  - Slack principals come from the per-user connect-code link store
 *    (team_id + user_id → login); unlinked users resolve to null and get
 *    an explicit refusal — never the shared instance identity.
 *  - Connect codes are short-lived (10 min) and single-use; the confirm
 *    step binds the code's Slack user to the SESSION's login only.
 *  - The `|| "email_trader" | "slack_trader" | "voice_trader"` fallback
 *    tails (the #1185 residual) are gone from src/.
 *  - Channel NLQ dispatch passes the resolved principal's login (never
 *    a sessionId as userLogin), approvals refuse below the trade tier,
 *    and channel-origin paid actions are refused at the channel seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ETradeRestClient } from "../src/trading/etrade/client";

/**
 * §7 adaptation (#2389): approvals now settle through the broker
 * client's placeOrder — the platform no longer settles locally. The
 * signed-link test below stubs that placement seam with a
 * broker-confirmed result; the channel enforcement under test is
 * exercised for real (restored by the file's restoreAllMocks).
 */
function stubBrokerPlacement() {
  return vi.spyOn(ETradeRestClient.prototype, "placeOrder").mockImplementation(async (params: any) => ({
    success: true,
    orderId: params.orderId,
    executionId: "et_order_intake",
    brokerOrderRef: "et_order_intake",
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
      signature: ["sig", "0xbrokerintake"].join("_"),
    },
    message: "E*TRADE Execution Confirmed: Broker Order ID et_order_intake",
    timestamp: new Date().toISOString(),
  }) as any);
}

// --- NLQ seam mock ---------------------------------------------------------
// The channel services import executeNaturalLanguageQuery + planNLQ from
// src/agents/nlq. Mocking the module lets these tests (a) capture the
// identity the services pass to NLQ and (b) drive the paid-action seam
// refusal with a canned plan — without running the real planner/executor.
const mockNlq = vi.hoisted(() => ({
  plan: { domain: "trading", operation: "read", tradingData: { action: "quote" }, terms: "", role: "any", since: null, limit: 25 } as any,
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

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  resolvePrincipal,
  parseEmailPrincipals,
  parseAuthenticationResults,
  createMemorySlackPrincipalLinkStore,
  confirmSlackLink,
  channelPlanRefusal,
  tierAtLeast,
  type ChannelPrincipal,
} from "../src/trading/channels/intake";
import { ETradeEmailTradingService } from "../src/trading/email/agent";
import { issueApprovalLink } from "../src/trading/channels/signedLinks";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import type { Env, InboundEmailPayload } from "../src/types";

const EMAIL_MAP = JSON.stringify({
  "boss@example.com": { login: "boss-login", tier: "trade" },
  "analyst@example.com": { login: "analyst-login", tier: "preview" },
  "reader@example.com": { login: "reader-login", tier: "read" },
});

const baseEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
    EMAIL_AGENT_ADDRESS: "trade@agent.openaimp.com",
    CHANNEL_EMAIL_PRINCIPALS: EMAIL_MAP,
    ...overrides,
  }) as Env;

describe("resolvePrincipal — email (CHANNEL_EMAIL_PRINCIPALS)", () => {
  const intake = (from: string, authProof?: { dkimPass?: boolean; spfPass?: boolean }) => ({
    channel: "email" as const,
    channelUserId: from,
    text: "quote NVDA",
    ...(authProof ? { authProof } : {}),
  });

  it("resolves a mapped trade-tier sender when DKIM passes", async () => {
    const p = await resolvePrincipal(baseEnv(), intake("boss@example.com", { dkimPass: true }));
    expect(p).not.toBeNull();
    expect(p!.userLogin).toBe("boss-login");
    expect(p!.tier).toBe("trade");
    expect(p!.authorizerDid).toBe("did:user:email:boss@example.com");
    expect(p!.notice).toBeUndefined();
  });

  it("resolves a mapped trade-tier sender when only SPF passes", async () => {
    const p = await resolvePrincipal(baseEnv(), intake("boss@example.com", { spfPass: true }));
    expect(p!.tier).toBe("trade");
  });

  it("matches the sender address case-insensitively", async () => {
    const p = await resolvePrincipal(baseEnv(), intake("Boss@Example.COM", { dkimPass: true }));
    expect(p!.userLogin).toBe("boss-login");
  });

  it("downgrades a trade-tier mapping to read when DKIM/SPF do not pass, with a stated reason", async () => {
    const p = await resolvePrincipal(baseEnv(), intake("boss@example.com", { dkimPass: false, spfPass: false }));
    expect(p).not.toBeNull();
    expect(p!.tier).toBe("read");
    expect(p!.userLogin).toBe("boss-login");
    expect(p!.notice).toMatch(/DKIM\/SPF/i);
  });

  it("downgrades a trade-tier mapping to read when authentication results are absent", async () => {
    const p = await resolvePrincipal(baseEnv(), intake("boss@example.com"));
    expect(p!.tier).toBe("read");
    expect(p!.notice).toMatch(/DKIM\/SPF/i);
  });

  it("does not downgrade preview/read mappings (the gate is trade-tier only)", async () => {
    const preview = await resolvePrincipal(baseEnv(), intake("analyst@example.com"));
    expect(preview!.tier).toBe("preview");
    const read = await resolvePrincipal(baseEnv(), intake("reader@example.com"));
    expect(read!.tier).toBe("read");
  });

  it("returns null for an unmapped sender", async () => {
    const p = await resolvePrincipal(baseEnv(), intake("stranger@evil.example", { dkimPass: true, spfPass: true }));
    expect(p).toBeNull();
  });

  it("returns null when CHANNEL_EMAIL_PRINCIPALS is not configured", async () => {
    const env = baseEnv();
    delete (env as any).CHANNEL_EMAIL_PRINCIPALS;
    const p = await resolvePrincipal(env, intake("boss@example.com", { dkimPass: true }));
    expect(p).toBeNull();
  });

  it("treats malformed CHANNEL_EMAIL_PRINCIPALS JSON as an empty map and logs loudly (never throws)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = baseEnv({ CHANNEL_EMAIL_PRINCIPALS: "{not json" });
    const p = await resolvePrincipal(env, intake("boss@example.com", { dkimPass: true }));
    expect(p).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("parseEmailPrincipals tolerates malformed entries (skips bad rows, keeps good ones)", () => {
    const map = parseEmailPrincipals(
      baseEnv({
        CHANNEL_EMAIL_PRINCIPALS: JSON.stringify({
          "good@example.com": { login: "good-login", tier: "read" },
          "bad@example.com": { login: "x" },
          "also-bad@example.com": { tier: "trade" },
          "weird@example.com": { login: "w", tier: "superuser" },
        }),
      })
    );
    expect(Object.keys(map)).toEqual(["good@example.com"]);
  });
});

describe("parseAuthenticationResults", () => {
  it("extracts dkim/spf pass results", () => {
    expect(
      parseAuthenticationResults("mx.example; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com")
    ).toEqual({ dkimPass: true, spfPass: true });
  });

  it("treats fail/none/absent as not passed", () => {
    expect(parseAuthenticationResults("mx.example; dkim=fail; spf=fail")).toEqual({ dkimPass: false, spfPass: false });
    expect(parseAuthenticationResults("mx.example; dkim=none")).toEqual({ dkimPass: false, spfPass: false });
    expect(parseAuthenticationResults(undefined)).toEqual({ dkimPass: false, spfPass: false });
    expect(parseAuthenticationResults("")).toEqual({ dkimPass: false, spfPass: false });
  });
});

describe("resolvePrincipal — slack (connect-code link store)", () => {
  it("resolves a linked slack user to the bound login and tier", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    await store.putLink("T111", "U222", { login: "gh-user", tier: "trade", linkedAt: "2026-10-24T00:00:00.000Z" });
    const p = await resolvePrincipal(
      baseEnv(),
      { channel: "slack", channelUserId: "U222", channelScopeId: "T111", text: "quote NVDA" },
      { slackLinks: store }
    );
    expect(p).toEqual({
      userLogin: "gh-user",
      authorizerDid: "did:user:slack:U222",
      tier: "trade",
    });
  });

  it("returns null for an unlinked slack user (no default read tier in v1)", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    const p = await resolvePrincipal(
      baseEnv(),
      { channel: "slack", channelUserId: "U999", channelScopeId: "T111", text: "quote NVDA" },
      { slackLinks: store }
    );
    expect(p).toBeNull();
  });

  it("does not resolve a link from a different workspace", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    await store.putLink("T111", "U222", { login: "gh-user", tier: "trade", linkedAt: "2026-10-24T00:00:00.000Z" });
    const p = await resolvePrincipal(
      baseEnv(),
      { channel: "slack", channelUserId: "U222", channelScopeId: "TOTHER", text: "quote NVDA" },
      { slackLinks: store }
    );
    expect(p).toBeNull();
  });
});

describe("slack connect codes (issue / consume / confirm)", () => {
  it("issues a code that confirms exactly once, binding the slack user to the session login at trade tier", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    const { code, expiresAt } = await store.issueLinkCode("T111", "U222");
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

    const confirmed = await confirmSlackLink(baseEnv(), code, "session-login", { slackLinks: store });
    expect(confirmed.ok).toBe(true);

    const p = await resolvePrincipal(
      baseEnv(),
      { channel: "slack", channelUserId: "U222", channelScopeId: "T111", text: "x" },
      { slackLinks: store }
    );
    expect(p!.userLogin).toBe("session-login");
    expect(p!.tier).toBe("trade");

    // Single-use: a second confirm with the same code fails.
    const again = await confirmSlackLink(baseEnv(), code, "other-login", { slackLinks: store });
    expect(again.ok).toBe(false);
  });

  it("accepts the code without the display dash and case-insensitively", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    const { code } = await store.issueLinkCode("T111", "U222");
    const confirmed = await confirmSlackLink(baseEnv(), code.replace("-", "").toLowerCase(), "session-login", {
      slackLinks: store,
    });
    expect(confirmed.ok).toBe(true);
  });

  it("rejects an expired code", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    const t0 = Date.now();
    const { code } = await store.issueLinkCode("T111", "U222", t0);
    const consumed = await store.consumeLinkCode(code, t0 + 10 * 60 * 1000 + 1);
    expect(consumed).toBeNull();
  });

  it("rejects an unknown code", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    expect(await store.consumeLinkCode("ZZZZ-9999")).toBeNull();
    const confirmed = await confirmSlackLink(baseEnv(), "ZZZZ-9999", "session-login", { slackLinks: store });
    expect(confirmed.ok).toBe(false);
  });
});

describe("resolvePrincipal — voice (session principal, contract adoption only)", () => {
  it("resolves the session login at trade tier with the voice DID", async () => {
    const p = await resolvePrincipal(baseEnv(), { channel: "voice", channelUserId: "voice-user", text: "" });
    expect(p).toEqual({ userLogin: "voice-user", authorizerDid: "did:user:voice:voice-user", tier: "trade" });
  });
});

describe("tierAtLeast ordering", () => {
  it("orders read < preview < trade", () => {
    expect(tierAtLeast("read", "read")).toBe(true);
    expect(tierAtLeast("read", "preview")).toBe(false);
    expect(tierAtLeast("preview", "read")).toBe(true);
    expect(tierAtLeast("preview", "trade")).toBe(false);
    expect(tierAtLeast("trade", "preview")).toBe(true);
    expect(tierAtLeast("trade", "trade")).toBe(true);
  });
});

describe("channelPlanRefusal (paid actions + tier gates at the channel seam)", () => {
  const principal = (tier: ChannelPrincipal["tier"]): ChannelPrincipal => ({
    userLogin: "someone",
    authorizerDid: "did:user:email:someone@example.com",
    tier,
  });

  it("refuses channel-origin paid_scan / paid_research for every tier in v1", () => {
    const paidScan = { domain: "agentic_payments", agenticPaymentsData: { action: "paid_scan" } };
    const paidResearch = { domain: "agentic_payments", agenticPaymentsData: { action: "paid_research" } };
    expect(channelPlanRefusal(paidScan, principal("trade"))).toMatch(/paid/i);
    expect(channelPlanRefusal(paidResearch, principal("trade"))).toMatch(/paid/i);
  });

  it("does not refuse non-paid agentic_payments actions (wallet status is read-only)", () => {
    const wallet = { domain: "agentic_payments", agenticPaymentsData: { action: "wallet_status" } };
    expect(channelPlanRefusal(wallet, principal("read"))).toBeNull();
  });

  it("refuses trade previews below the preview tier and direct execution below the trade tier", () => {
    const preview = { domain: "trading", tradingData: { action: "preview_order" } };
    const execute = { domain: "trading", tradingData: { action: "execute_order" } };
    expect(channelPlanRefusal(preview, principal("read"))).not.toBeNull();
    expect(channelPlanRefusal(preview, principal("preview"))).toBeNull();
    expect(channelPlanRefusal(execute, principal("preview"))).not.toBeNull();
    expect(channelPlanRefusal(execute, principal("trade"))).toBeNull();
  });

  it("allows read-tier quotes/screens", () => {
    expect(channelPlanRefusal({ domain: "trading", tradingData: { action: "quote" } }, principal("read"))).toBeNull();
    expect(channelPlanRefusal({ domain: "trading", tradingData: { action: "screen" } }, principal("read"))).toBeNull();
  });
});

describe("pins: synthetic channel identity fallbacks are gone from src/", () => {
  it("no email_trader / slack_trader / voice_trader literal remains in src/", () => {
    const SRC = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (/email_trader|slack_trader|voice_trader/.test(text)) {
            offenders.push(path.relative(SRC, full));
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Service-level enforcement (stubbed ledger via MockSqlStorage ORM)
// ===========================================================================

describe("channel service enforcement (#1262 Phase 1)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const sessionId = "channel_intake_test_session";

  const seedPreviewedTrade = (id: string) => {
    orm.trades.create({
      id,
      sessionId,
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
  };

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    mockNlq.executeCalls.length = 0;
    mockNlq.planCalls.length = 0;
    mockNlq.plan = { domain: "trading", operation: "read", tradingData: { action: "quote" }, terms: "", role: "any", since: null, limit: 25 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("email: an unmapped sender (null principal) gets an explicit refusal and NLQ never runs", async () => {
    const service = new ETradeEmailTradingService(baseEnv(), orm, sessionId, null);
    const payload: InboundEmailPayload = {
      from: "stranger@evil.example",
      to: "trade@agent.openaimp.com",
      subject: "Quote NVDA",
      text: "What is the price of NVDA?",
    };
    const result = await service.processInboundEmail(payload);
    expect(result.success).toBe(false);
    expect(result.actionType).toBe("refusal");
    expect(result.responseText).toMatch(/not (mapped|linked|recognized)/i);
    expect(mockNlq.executeCalls).toHaveLength(0);
  });

  it("email: approval refuses below the trade tier and the draft stays previewed", async () => {
    seedPreviewedTrade("ord_read_tier_approve");
    const principal: ChannelPrincipal = {
      userLogin: "reader-login",
      authorizerDid: "did:user:email:reader@example.com",
      tier: "read",
    };
    const service = new ETradeEmailTradingService(baseEnv(), orm, sessionId, principal);
    const result = await service.processInboundEmail({
      from: "reader@example.com",
      to: "trade@agent.openaimp.com",
      subject: "Re: Preview",
      text: "APPROVE ord_read_tier_approve",
    });
    expect(result.success).toBe(false);
    expect(result.actionType).toBe("approval");
    expect(result.responseText).toMatch(/trade/i);
    expect(orm.trades.findById("ord_read_tier_approve")?.status).toBe("previewed");
  });

  it("email: a trade-tier principal approves via a signed link; a bare APPROVE is refused (Phase 5)", async () => {
    stubBrokerPlacement();
    seedPreviewedTrade("ord_trade_tier_approve");
    const principal: ChannelPrincipal = {
      userLogin: "boss-login",
      authorizerDid: "did:user:email:boss@example.com",
      tier: "trade",
    };
    const env = baseEnv({ CHANNEL_APPROVAL_LINK_SECRET: "test-link-secret-1262" });
    const service = new ETradeEmailTradingService(env, orm, sessionId, principal);
    // Bare APPROVE no longer executes, even for a trade-tier principal.
    const refused = await service.processInboundEmail({
      from: "boss@example.com",
      to: "trade@agent.openaimp.com",
      subject: "Re: Preview",
      text: "APPROVE ord_trade_tier_approve",
    });
    expect(refused.success).toBe(false);
    expect(refused.actionType).toBe("approval");
    expect(refused.responseText).toMatch(/signed link/i);
    expect(orm.trades.findById("ord_trade_tier_approve")?.status).toBe("previewed");
    // The same approval with a valid signed link executes.
    const issued = await issueApprovalLink(env, {
      orderId: "ord_trade_tier_approve",
      login: "boss-login",
      address: "boss@example.com",
      baseUrl: "https://agent.openaimp.com",
    });
    expect(issued).not.toBeNull();
    const result = await service.processInboundEmail({
      from: "boss@example.com",
      to: "trade@agent.openaimp.com",
      subject: "Re: Preview",
      text: `APPROVE ord_trade_tier_approve\n${issued!.url}`,
    });
    expect(result.success).toBe(true);
    expect(result.actionType).toBe("approval");
    expect(orm.trades.findById("ord_trade_tier_approve")?.status).toBe("executed");
  });

  it("email: NLQ dispatch passes the resolved principal login + DID, never the sessionId", async () => {
    const principal: ChannelPrincipal = {
      userLogin: "analyst-login",
      authorizerDid: "did:user:email:analyst@example.com",
      tier: "preview",
    };
    const service = new ETradeEmailTradingService(baseEnv(), orm, sessionId, principal);
    const result = await service.processInboundEmail({
      from: "analyst@example.com",
      to: "trade@agent.openaimp.com",
      subject: "Quote NVDA",
      text: "Latest quote for NVDA please",
    });
    expect(result.success).toBe(true);
    expect(mockNlq.executeCalls).toHaveLength(1);
    const [, sessionArg, , , userLoginArg, userDidArg] = mockNlq.executeCalls[0];
    expect(sessionArg).toBe(sessionId); // session scope unchanged
    expect(userLoginArg).toBe("analyst-login");
    expect(userLoginArg).not.toBe(sessionId);
    expect(userDidArg).toBe("did:user:email:analyst@example.com");
  });

  it("email: a channel-origin paid action is refused at the seam and never executes", async () => {
    mockNlq.plan = { domain: "agentic_payments", operation: "create", agenticPaymentsData: { action: "paid_scan" }, terms: "", role: "any", since: null, limit: 10 };
    const principal: ChannelPrincipal = {
      userLogin: "boss-login",
      authorizerDid: "did:user:email:boss@example.com",
      tier: "trade",
    };
    const service = new ETradeEmailTradingService(baseEnv(), orm, sessionId, principal);
    const result = await service.processInboundEmail({
      from: "boss@example.com",
      to: "trade@agent.openaimp.com",
      subject: "Paid options screen",
      text: "Run a paid options screen for NVDA",
    });
    expect(result.success).toBe(false);
    expect(result.actionType).toBe("refusal");
    expect(result.responseText).toMatch(/paid/i);
    expect(mockNlq.executeCalls).toHaveLength(0);
  });

  it("slack: an unlinked user (null principal) gets an explicit refusal reply, NLQ never runs", async () => {
    const service = new ETradeSlackTradingService(baseEnv(), orm, sessionId, null);
    const result = await service.processSlackEvent({
      type: "event_callback",
      team_id: "T111",
      event: { type: "app_mention", user: "U999", text: "<@UBOT> quote AAPL", channel: "C123", ts: "1727800000.000100" },
    });
    expect(result.handled).toBe(true);
    expect(result.actionType).toBe("refusal");
    expect(result.response?.text).toMatch(/link/i);
    expect(mockNlq.executeCalls).toHaveLength(0);
  });

  it("slack: 'link' DM issues a connect code for an unlinked user, and confirming it enables resolution", async () => {
    const store = createMemorySlackPrincipalLinkStore();
    const service = new ETradeSlackTradingService(baseEnv(), orm, sessionId, null, store);
    const result = await service.processSlackEvent({
      type: "event_callback",
      team_id: "T111",
      event: { type: "message", channel_type: "im", user: "U222", text: "link", channel: "D123", ts: "1727800000.000200" },
    });
    expect(result.handled).toBe(true);
    expect(result.actionType).toBe("link");
    const codeMatch = (result.response?.text || "").match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(codeMatch).not.toBeNull();

    const confirmed = await confirmSlackLink(baseEnv(), codeMatch![0], "session-login", { slackLinks: store });
    expect(confirmed.ok).toBe(true);
    const p = await resolvePrincipal(
      baseEnv(),
      { channel: "slack", channelUserId: "U222", channelScopeId: "T111", text: "x" },
      { slackLinks: store }
    );
    expect(p!.userLogin).toBe("session-login");
    expect(p!.tier).toBe("trade");
  });

  it("slack: text approval refuses below the trade tier and the draft stays previewed", async () => {
    seedPreviewedTrade("ord_slack_preview_tier");
    const principal: ChannelPrincipal = {
      userLogin: "analyst-login",
      authorizerDid: "did:user:slack:U222",
      tier: "preview",
    };
    const service = new ETradeSlackTradingService(baseEnv(), orm, sessionId, principal);
    const result = await service.processSlackEvent({
      type: "event_callback",
      team_id: "T111",
      event: { type: "app_mention", user: "U222", text: "<@UBOT> approve ord_slack_preview_tier", channel: "C123", ts: "1727800000.000300" },
    });
    expect(result.handled).toBe(true);
    expect(result.actionType).toBe("refusal");
    expect(orm.trades.findById("ord_slack_preview_tier")?.status).toBe("previewed");
  });

  it("slack: button approval (interaction) refuses below the trade tier", async () => {
    seedPreviewedTrade("ord_slack_button_tier");
    const principal: ChannelPrincipal = {
      userLogin: "reader-login",
      authorizerDid: "did:user:slack:U333",
      tier: "read",
    };
    const service = new ETradeSlackTradingService(baseEnv(), orm, sessionId, principal);
    const result = await service.processSlackInteraction({
      type: "block_actions",
      user: { id: "U333" },
      team: { id: "T111" },
      channel: { id: "C123" },
      actions: [{ action_id: "etrade_approve_order", value: "ord_slack_button_tier" }],
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/trade/i);
    expect(orm.trades.findById("ord_slack_button_tier")?.status).toBe("previewed");
  });

  it("slack: an unlinked user's button approval is refused outright", async () => {
    seedPreviewedTrade("ord_slack_button_unlinked");
    const service = new ETradeSlackTradingService(baseEnv(), orm, sessionId, null);
    const result = await service.processSlackInteraction({
      type: "block_actions",
      user: { id: "U999" },
      team: { id: "T111" },
      channel: { id: "C123" },
      actions: [{ action_id: "etrade_approve_order", value: "ord_slack_button_unlinked" }],
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/link/i);
    expect(orm.trades.findById("ord_slack_button_unlinked")?.status).toBe("previewed");
  });

  it("slack: NLQ dispatch passes the resolved principal login + DID, never the sessionId", async () => {
    const principal: ChannelPrincipal = {
      userLogin: "gh-user",
      authorizerDid: "did:user:slack:U222",
      tier: "trade",
    };
    const service = new ETradeSlackTradingService(baseEnv(), orm, sessionId, principal);
    const result = await service.processSlackEvent({
      type: "event_callback",
      team_id: "T111",
      event: { type: "app_mention", user: "U222", text: "<@UBOT> quote AAPL", channel: "C123", ts: "1727800000.000400" },
    });
    expect(result.handled).toBe(true);
    expect(mockNlq.executeCalls).toHaveLength(1);
    const [, sessionArg, , , userLoginArg, userDidArg] = mockNlq.executeCalls[0];
    expect(sessionArg).toBe(sessionId);
    expect(userLoginArg).toBe("gh-user");
    expect(userDidArg).toBe("did:user:slack:U222");
  });
});
