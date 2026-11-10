/**
 * Issue #147 (found during #140): the Slack signature verifier
 * `verifySlackSignature` fails closed, but its CALLERS made it
 * optional. The LIVE worker routes /slack/commands, /slack/events and
 * /slack/interactions in src/server.ts wrapped verification in
 * `if (env.SLACK_SIGNING_SECRET) { … }`, and SlackAgent.onRequest did
 * the same — additionally skipping verification whenever the caller
 * simply omitted the signature headers. With the secret unset (its
 * production state is unknowable from config — wrangler secrets are
 * not visible), ANY unauthenticated caller could:
 *
 * - POST a forged event with text "approve <orderId>" and execute a
 *   previewed order on E*TRADE under an attacker-chosen Slack user id
 *   (processSlackEvent → executeOrder / placeOrderRemote);
 * - POST a forged approve-button interaction and pass the HITL gate
 *   itself (processSlackInteraction, etrade_approve_order);
 * - run slash commands (/trade, /portfolio, /quote, /options, /snap)
 *   as the workspace agent identity;
 * - answer Slack's url_verification handshake for an arbitrary app.
 *
 * The fix makes verification MANDATORY at every ingress layer via the
 * shared `gateSlackRequest` (src/security/webhookSecurity.ts):
 * unconfigured → honest 503 naming SLACK_SIGNING_SECRET, before any
 * processing (the /nlq/webhook precedent from #140); configured +
 * missing/invalid signature → 401; configured + valid → processed
 * exactly as before. These tests drive the REAL worker fetch dispatch
 * and the REAL SlackAgent.onRequest, signing with genuine Slack-style
 * HMAC signatures computed under a test secret via the real verifier
 * scheme — never a stubbed verifier.
 *
 * Harnesses follow the repo patterns: module mocks from
 * tests/options_flow_provenance.test.ts (which also drives
 * src/server.ts), the MockSqlStorage agent harness from
 * tests/browser_and_slack_agents.test.ts, source pins from the other
 * #115-family honesty suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ETradeRestClient } from "../src/trading/etrade/client";

/**
 * §7 adaptation (#2389): approvals now settle through the broker
 * client's placeOrder — the platform no longer settles locally. The
 * one test in this file whose subject is the signature gate (with an
 * executed settle as its outcome) stubs that placement seam with a
 * broker-confirmed result; the gate itself is exercised for real.
 */
function stubBrokerPlacement() {
  return vi.spyOn(ETradeRestClient.prototype, "placeOrder").mockImplementation(async (params: any) => ({
    success: true,
    orderId: params.orderId,
    executionId: "et_order_gate",
    brokerOrderRef: "et_order_gate",
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
      signature: ["sig", "0xbrokergate"].join("_"),
    },
    message: "E*TRADE Execution Confirmed: Broker Order ID et_order_gate",
    timestamp: new Date().toISOString(),
  }) as any);
}

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/options_flow_provenance.test.ts); routeAgentRequest
// returns null so the worker's own route dispatch runs.
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
  // Issue #199: src/server.ts re-exports PaymentsAgent/ScheduledAgent,
  // which `extend Agent` when the module loads — the stub must be an
  // extendable class, otherwise `extends undefined` throws at import time.
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import { SlackAgent } from "../src/agents/slackAgent";
import {
  confirmSlackLink,
  slackPrincipalLinkStoreFromEnv,
} from "../src/trading/channels/intake";
import { makeFakeSessionStore } from "./fake-session-store";
import { gateSlackRequest } from "../src/security/webhookSecurity";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const SECRET = "unit-test-slack-signing-secret-147";
const nowTs = () => String(Math.floor(Date.now() / 1000));

/** Genuine Slack signature headers for `body` under `secret`. */
async function slackSigHeaders(secret: string, body: string, ts: string = nowTs()) {
  return {
    "x-slack-request-timestamp": ts,
    "x-slack-signature":
      "v0=" + (await computeHmacSha256Hex(secret, `v0:${ts}:${body}`)),
  };
}

// ===========================================================================
// The shared gate itself
// ===========================================================================

describe("gateSlackRequest (#147)", () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "gate_challenge" });
  const makeReq = async (headers: Record<string, string> = {}) =>
    new Request("https://agent.test/slack/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });

  it("unconfigured: 503 naming the missing configuration", async () => {
    const gate = await gateSlackRequest(await makeReq(), undefined);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response.status).toBe(503);
      const json = (await gate.response.json()) as any;
      expect(json.error).toContain("SLACK_SIGNING_SECRET is not configured");
    }
  });

  it("empty-string secret counts as unconfigured", async () => {
    const gate = await gateSlackRequest(await makeReq(), "");
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(503);
  });

  it("configured + valid signature: ok with the raw body", async () => {
    const gate = await gateSlackRequest(await makeReq(await slackSigHeaders(SECRET, body)), SECRET);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.rawBody).toBe(body);
  });

  it("configured + invalid signature: 401", async () => {
    const headers = await slackSigHeaders("a-different-secret", body);
    const gate = await gateSlackRequest(await makeReq(headers), SECRET);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response.status).toBe(401);
      expect(await gate.response.text()).toBe("Invalid Slack signature");
    }
  });

  it("configured + missing signature headers: 401", async () => {
    const gate = await gateSlackRequest(await makeReq(), SECRET);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });

  it("configured + stale timestamp (validly signed): 401 replay protection", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const headers = await slackSigHeaders(SECRET, body, staleTs);
    const gate = await gateSlackRequest(await makeReq(headers), SECRET);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });
});

// ===========================================================================
// Worker routes (src/server.ts): the LIVE ingress
// ===========================================================================

describe("worker /slack/* routes — mandatory gate (#147)", () => {
  interface ForwardedCall {
    id: string;
    pathname: string;
    body: string;
  }

  function makeServerEnv(secret?: string) {
    const forwarded: ForwardedCall[] = [];
    const env: any = {
      // Issue #3937: the forwarded Slack paths reach the E*TRADE desk, so
      // the test tenant selects etrade explicitly — the platform default
      // is alpaca now.
      BROKER_ID: "etrade",
      ORCHESTRATOR_AGENT: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          fetch: async (req: Request) => {
            forwarded.push({
              id,
              pathname: new URL(req.url).pathname,
              body: await req.text(),
            });
            return Response.json({ forwarded: true });
          },
        }),
      },
    };
    if (secret !== undefined) env.SLACK_SIGNING_SECRET = secret;
    return { env, forwarded };
  }

  const post = (path: string, body: string, headers: Record<string, string> = {}, contentType = "application/json") =>
    new Request(`https://agent.test${path}`, {
      method: "POST",
      headers: { "Content-Type": contentType, ...headers },
      body,
    });

  // ---- Slash commands -----------------------------------------------------

  const commandBody = "command=%2Fquote&text=NVDA&team_id=T147&user_id=U147&channel_id=C147";

  it("commands: unconfigured → 503 naming the config, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv();
    const res = await worker.fetch(post("/slack/commands", commandBody, {}, "application/x-www-form-urlencoded"), env);
    expect(res.status).toBe(503);
    const json = (await res.json()) as any;
    expect(json.error).toContain("SLACK_SIGNING_SECRET is not configured");
    expect(forwarded).toHaveLength(0);
  });

  it("commands alias /slack/slash: unconfigured → 503, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv();
    const res = await worker.fetch(post("/slack/slash", commandBody, {}, "application/x-www-form-urlencoded"), env);
    expect(res.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  it("commands: configured + valid signature → forwarded to the agent unchanged", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const headers = await slackSigHeaders(SECRET, commandBody);
    const res = await worker.fetch(
      post("/slack/commands", commandBody, headers, "application/x-www-form-urlencoded"),
      env
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/slack/command");
    expect(forwarded[0].id).toBe("slack_T147");
    expect(forwarded[0].body).toBe(commandBody);
  });

  it("commands: configured + invalid signature → 401, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const headers = await slackSigHeaders("wrong-secret", commandBody);
    const res = await worker.fetch(
      post("/slack/commands", commandBody, headers, "application/x-www-form-urlencoded"),
      env
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid Slack signature");
    expect(forwarded).toHaveLength(0);
  });

  it("commands: configured + missing signature headers → 401, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const res = await worker.fetch(post("/slack/commands", commandBody, {}, "application/x-www-form-urlencoded"), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  // ---- Events -------------------------------------------------------------

  const challengeBody = JSON.stringify({ type: "url_verification", challenge: "challenge_147" });
  const eventBody = JSON.stringify({
    type: "event_callback",
    team_id: "T147",
    event: { type: "app_mention", user: "U147", text: "<@U_BOT> approve ord_147", channel: "C147" },
  });

  it("events: unconfigured → 503 and the url_verification challenge is NOT answered", async () => {
    const { env, forwarded } = makeServerEnv();
    const res = await worker.fetch(post("/slack/events", challengeBody), env);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("SLACK_SIGNING_SECRET is not configured");
    expect(text).not.toContain("challenge_147");
    expect(forwarded).toHaveLength(0);
  });

  it("events alias /slack: unconfigured → 503, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv();
    const res = await worker.fetch(post("/slack", eventBody), env);
    expect(res.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  it("events: configured + valid signature → url_verification challenge answered by the route", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const headers = await slackSigHeaders(SECRET, challengeBody);
    const res = await worker.fetch(post("/slack/events", challengeBody, headers), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.challenge).toBe("challenge_147");
    expect(forwarded).toHaveLength(0);
  });

  it("events: configured + valid signature → event forwarded to the agent", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const headers = await slackSigHeaders(SECRET, eventBody);
    const res = await worker.fetch(post("/slack/events", eventBody, headers), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/slack/event");
    expect(forwarded[0].id).toBe("slack_T147");
    expect(forwarded[0].body).toBe(eventBody);
  });

  it("events: configured + invalid signature → 401, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const headers = await slackSigHeaders("wrong-secret", eventBody);
    const res = await worker.fetch(post("/slack/events", eventBody, headers), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("events: configured + missing signature headers → 401, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const res = await worker.fetch(post("/slack/events", eventBody), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  // ---- Interactions ---------------------------------------------------------

  const interactionPayload = {
    type: "block_actions",
    team: { id: "T147" },
    user: { id: "U147" },
    channel: { id: "C147" },
    actions: [{ action_id: "etrade_approve_order", value: "ord_147" }],
  };
  const interactionBody = `payload=${encodeURIComponent(JSON.stringify(interactionPayload))}`;

  it("interactions: unconfigured → 503 naming the config, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv();
    const res = await worker.fetch(
      post("/slack/interactions", interactionBody, {}, "application/x-www-form-urlencoded"),
      env
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as any;
    expect(json.error).toContain("SLACK_SIGNING_SECRET is not configured");
    expect(forwarded).toHaveLength(0);
  });

  it("interactions: configured + valid signature → forwarded to the agent", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const headers = await slackSigHeaders(SECRET, interactionBody);
    const res = await worker.fetch(
      post("/slack/interactions", interactionBody, headers, "application/x-www-form-urlencoded"),
      env
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/slack/interaction");
    expect(forwarded[0].id).toBe("slack_T147");
    expect(JSON.parse(forwarded[0].body)).toEqual(interactionPayload);
  });

  it("interactions: configured + invalid signature → 401, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const headers = await slackSigHeaders("wrong-secret", interactionBody);
    const res = await worker.fetch(
      post("/slack/interactions", interactionBody, headers, "application/x-www-form-urlencoded"),
      env
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("interactions: configured + missing signature headers → 401, agent never invoked", async () => {
    const { env, forwarded } = makeServerEnv(SECRET);
    const res = await worker.fetch(
      post("/slack/interactions", interactionBody, {}, "application/x-www-form-urlencoded"),
      env
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });
});

// ===========================================================================
// SlackAgent.onRequest — the same gate at the agent layer (defense in depth)
// ===========================================================================

describe("SlackAgent.onRequest — mandatory gate (#147)", () => {
  const agentTeam = "T147AGENT";
  let sql: MockSqlStorage;
  let orm: DatabaseORM;

  const baseEnv = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
    // Issue #3937: the Slack desk is an E*TRADE service, so the test
    // tenant selects etrade explicitly — the platform default is alpaca now.
    BROKER_ID: "etrade",
    SLACK_BOT_TOKEN: "xoxb-test-bot-token-147",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T00/B00/X00",
  };
  const configuredEnv = { ...baseEnv, SLACK_SIGNING_SECRET: SECRET } as unknown as Env;
  const unconfiguredEnv = { ...baseEnv } as unknown as Env;

  // Issue #1262 Phase 2: onRequest resolves the caller's principal
  // from the Phase 1 link store, so "valid signature → processed"
  // tests must link the test user first (the gate is what these
  // tests prove; the link state is just the principal precondition).
  // The link is driven through the real issue + confirm flow over
  // the repo's fake SessionStore (#604 helper).
  const linkedConfiguredEnv = async (userId: string): Promise<Env> => {
    const env = { ...configuredEnv, SESSION_STORE: makeFakeSessionStore().namespace } as unknown as Env;
    const store = slackPrincipalLinkStoreFromEnv(env);
    const { code } = await store.issueLinkCode(agentTeam, userId);
    const confirmed = await confirmSlackLink(env, code, `trader-${userId.toLowerCase()}`);
    expect(confirmed.ok).toBe(true);
    return env;
  };

  const createMockCtx = () => ({
    id: { toString: () => agentTeam },
    storage: { sql },
    waitUntil: vi.fn(),
  });

  function seedPreviewedTrade(id: string) {
    orm.trades.create({
      id,
      sessionId: `slack_${agentTeam}`,
      symbol: "MSFT",
      action: "BUY",
      orderType: "LIMIT",
      quantity: 10,
      price: 430.0,
      totalValue: 4300.0,
      status: "previewed",
      proposerDid: "did:agent:openaimp:trading",
      proofSignature: "sig_147",
    });
  }

  const approveEventBody = (orderId: string) =>
    JSON.stringify({
      type: "event_callback",
      team_id: agentTeam,
      event: {
        type: "app_mention",
        user: "U_ATTACKER",
        text: `<@U_BOT> approve ${orderId}`,
        channel: "C_TRADING_ROOM",
        ts: "1728364800.000100",
      },
    });

  const approveInteractionBody = (orderId: string) =>
    `payload=${encodeURIComponent(
      JSON.stringify({
        type: "block_actions",
        team: { id: agentTeam },
        user: { id: "U_ATTACKER" },
        channel: { id: "C_TRADING_ROOM" },
        actions: [{ action_id: "approve_trade", value: orderId }],
      })
    )}`;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(`slack_${agentTeam}`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
      json: async () => ({ ok: true }),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unconfigured: events url_verification → 503, challenge NOT answered", async () => {
    const agent = new SlackAgent(createMockCtx() as any, unconfiguredEnv);
    const body = JSON.stringify({ type: "url_verification", challenge: "agent_challenge_147" });
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
    );
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("SLACK_SIGNING_SECRET is not configured");
    expect(text).not.toContain("agent_challenge_147");
  });

  it("unconfigured: forged 'approve' event → 503 and the order is NOT executed", async () => {
    seedPreviewedTrade("ord_147_unconf_event");
    const agent = new SlackAgent(createMockCtx() as any, unconfiguredEnv);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: approveEventBody("ord_147_unconf_event"),
      })
    );
    expect(res.status).toBe(503);
    expect(orm.trades.findById("ord_147_unconf_event")?.status).toBe("previewed");
  });

  it("unconfigured: slash command → 503, handler never invoked", async () => {
    const agent = new SlackAgent(createMockCtx() as any, unconfiguredEnv);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/commands", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "command=%2Fhelp&team_id=T147AGENT&user_id=U_ATTACKER",
      })
    );
    expect(res.status).toBe(503);
  });

  it("unconfigured: forged approve interaction → 503 and the order is NOT executed", async () => {
    seedPreviewedTrade("ord_147_unconf_ix");
    const agent = new SlackAgent(createMockCtx() as any, unconfiguredEnv);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: approveInteractionBody("ord_147_unconf_ix"),
      })
    );
    expect(res.status).toBe(503);
    expect(orm.trades.findById("ord_147_unconf_ix")?.status).toBe("previewed");
  });

  it("configured + valid signature: url_verification challenge answered", async () => {
    const agent = new SlackAgent(createMockCtx() as any, configuredEnv);
    const body = JSON.stringify({ type: "url_verification", challenge: "agent_challenge_ok" });
    const headers = await slackSigHeaders(SECRET, body);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.challenge).toBe("agent_challenge_ok");
  });

  it("configured + valid signature: 'approve' event is processed and executes the order", async () => {
    stubBrokerPlacement();
    seedPreviewedTrade("ord_147_ok_event");
    const agent = new SlackAgent(createMockCtx() as any, await linkedConfiguredEnv("U_ATTACKER"));
    const body = approveEventBody("ord_147_ok_event");
    const headers = await slackSigHeaders(SECRET, body);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.handled).toBe(true);
    expect(json.actionType).toBe("approval");
    expect(orm.trades.findById("ord_147_ok_event")?.status).toBe("executed");
  });

  it("configured + invalid signature: 'approve' event → 401 and the order is NOT executed", async () => {
    seedPreviewedTrade("ord_147_bad_sig");
    const agent = new SlackAgent(createMockCtx() as any, configuredEnv);
    const body = approveEventBody("ord_147_bad_sig");
    const headers = await slackSigHeaders("wrong-secret", body);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      })
    );
    expect(res.status).toBe(401);
    expect(orm.trades.findById("ord_147_bad_sig")?.status).toBe("previewed");
  });

  it("configured + missing signature headers: 'approve' event → 401 and the order is NOT executed", async () => {
    seedPreviewedTrade("ord_147_no_sig");
    const agent = new SlackAgent(createMockCtx() as any, configuredEnv);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: approveEventBody("ord_147_no_sig"),
      })
    );
    expect(res.status).toBe(401);
    expect(orm.trades.findById("ord_147_no_sig")?.status).toBe("previewed");
  });

  it("configured + valid signature: slash command is processed", async () => {
    const agent = new SlackAgent(createMockCtx() as any, await linkedConfiguredEnv("U147"));
    const body = "command=%2Fhelp&team_id=T147AGENT&user_id=U147";
    const headers = await slackSigHeaders(SECRET, body);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/commands", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body,
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.text).toContain("E*TRADE Slack Trading Agent Commands");
  });

  it("configured + invalid signature: slash command → 401", async () => {
    const agent = new SlackAgent(createMockCtx() as any, configuredEnv);
    const body = "command=%2Fhelp&team_id=T147AGENT&user_id=U147";
    const headers = await slackSigHeaders("wrong-secret", body);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/commands", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body,
      })
    );
    expect(res.status).toBe(401);
  });

  it("configured + valid signature: interaction is processed", async () => {
    const agent = new SlackAgent(createMockCtx() as any, await linkedConfiguredEnv("U147"));
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        type: "block_actions",
        team: { id: agentTeam },
        user: { id: "U147" },
        channel: { id: "C147" },
        actions: [{ action_id: "some_unknown_action", value: "ord_none" }],
      })
    )}`;
    const headers = await slackSigHeaders(SECRET, body);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body,
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.message).toContain("Unknown action_id");
  });

  it("configured + missing signature headers: interaction → 401", async () => {
    const agent = new SlackAgent(createMockCtx() as any, configuredEnv);
    const res = await agent.onRequest(
      new Request("https://agent.internal/slack/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: approveInteractionBody("ord_147_ix_no_sig"),
      })
    );
    expect(res.status).toBe(401);
  });

  it("health check is not a Slack ingress and stays up when unconfigured", async () => {
    const agent = new SlackAgent(createMockCtx() as any, unconfiguredEnv);
    const res = await agent.onRequest(new Request("https://agent.internal/slack/health", { method: "GET" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.agent).toBe("SlackAgent");
    expect(json.status).toBe("active");
  });
});

// ===========================================================================
// Source pins: the optional-verification wrappers cannot come back
// ===========================================================================

describe("source pins (#147)", () => {
  it("the server entry applies the mandatory gate on all three Slack routes", () => {
    // Slice 6 of Qunsultant/cfagent#2902 (2026-11-05): the Slack routes
    // moved from src/server.ts to src/server/routes/messaging.ts; the
    // entry surface is server.ts + routes/*.ts, so the pin reads both
    // files.
    const server = src("server.ts") + src("server/routes/messaging.ts");
    expect(server).not.toContain("if (env.SLACK_SIGNING_SECRET)");
    expect(server.match(/gateSlackRequest\(request, env\.SLACK_SIGNING_SECRET\)/g)).toHaveLength(3);
  });

  it("slackAgent.ts gates its ingress paths and drops the optional check", () => {
    const agent = src("agents/slackAgent.ts");
    expect(agent).not.toContain("Verify Slack signature if secret is configured");
    expect(agent).toContain("gateSlackRequest(request.clone(), this.env.SLACK_SIGNING_SECRET)");
  });

  it("the gate names the missing configuration in webhookSecurity.ts", () => {
    const security = src("security/webhookSecurity.ts");
    expect(security).toContain("SLACK_SIGNING_SECRET is not configured");
    expect(security).toContain("gateSlackRequest");
  });
});
