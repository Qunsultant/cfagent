import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

// Same thinkAdapter mock idiom as tests/browser_and_slack_agents.test.ts:
// the real adapter graph is workerd-only; the class behavior under test
// (onRequest ingress, sessionKey) does not touch the base beyond ctx/env.
vi.mock("../src/actors/thinkAdapter", () => {
  return {
    PortThink: class MockPortThink {
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
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import {
  confirmSlackLink,
  slackPrincipalLinkStoreFromEnv,
} from "../src/trading/channels/intake";
import { makeFakeSessionStore } from "./fake-session-store";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { DatabaseORM } from "../src/orm";
import { resetRateLimits } from "../src/security/rateLimiter";
import { MockSqlStorage } from "./mock-sql";
import { AGENT_DIDS } from "../src/agents/did";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { MESH_CHANNELS, getChannel } from "../src/agents/registry";
import type { Env } from "../src/types";

/**
 * Issue #2412 (Agent Mesh S13, G10): channel completeness.
 *
 * Pins, in four groups:
 *  1. The S1 registry's channel records are complete (six channels —
 *     the survey's nine reconciled as 6 channels + MCP/A2A doors +
 *     cron trigger) and carry identity / gate / parity / adapter,
 *     drift-pinned against the code they describe.
 *  2. Slack ingress is ONE implementation: SlackAgent.onRequest
 *     delegates to the shared channel handler
 *     (src/agents/routes/tradingIntegrations.ts) the production
 *     server.ts forwards also terminate in — a signed event is
 *     processed by the single service, a forged one is refused at
 *     the gate before any service work.
 *  3. Duplicate Slack event deliveries are deduped on event_id in
 *     the shared handler: the second delivery is acked without
 *     reprocessing.
 *  4. Identity dispositions: sessionKey fails closed (the
 *     slack_agent_master fallback is retired); the NLQ webhook's
 *     fallback login is a named service identity; and SlackAgent's
 *     recovery evidence — a draft executed by one incarnation is
 *     honored by a fresh incarnation over the same store (a second
 *     approval cannot re-execute).
 */

const root = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

function stubBrokerPlacement() {
  return vi.spyOn(ETradeRestClient.prototype, "placeOrder").mockImplementation(async (params: any) => ({
    success: true,
    orderId: params.orderId,
    executionId: "et_order_slack_s13",
    brokerOrderRef: "et_order_slack_s13",
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
      signature: ["sig", "0xbrokerslack13"].join("_"),
    },
    message: "E*TRADE Execution Confirmed: Broker Order ID et_order_slack_s13",
    timestamp: new Date().toISOString(),
  }) as any);
}

describe("Agent Mesh S13 (#2412) — channel registry completeness", () => {
  it("records six channels, each with ingress, identity, gate, parity and a named adapter", () => {
    expect(MESH_CHANNELS.map((c) => c.id).sort()).toEqual(
      ["email", "nlq-webhook", "slack", "voice", "web-chat", "webhook"].sort(),
    );
    for (const channel of MESH_CHANNELS) {
      expect(channel.ingress.length, channel.id).toBeGreaterThan(0);
      expect(channel.terminatesAt.length, channel.id).toBeGreaterThan(0);
      expect(channel.identity.length, channel.id).toBeGreaterThan(0);
      expect(channel.gate.length, channel.id).toBeGreaterThan(0);
      expect(channel.parity.length, channel.id).toBeGreaterThan(0);
      expect(channel.adapter.length, channel.id).toBeGreaterThan(0);
      // The adapter record leads with the module that implements the
      // ingress; that module must exist.
      const adapterFile = channel.adapter.split(/\s/)[0];
      expect(existsSync(resolve(root, adapterFile)), `${channel.id} adapter ${adapterFile}`).toBe(true);
    }
  });

  it("Slack's posture is converged (no longer MIXED) and its adapter is the shared channel handler", () => {
    const slack = getChannel("slack")!;
    expect(slack.posture).not.toBe("MIXED");
    expect(slack.adapter).toContain("src/agents/routes/tradingIntegrations.ts");
    expect(slack.identity).toContain("link");
    expect(slack.gate).toContain("gateSlackRequest");
  });

  it("the production Slack host is unchanged: the server entry still forwards to the per-team orchestrator instance", () => {
    // Slice 6 of Qunsultant/cfagent#2902 (2026-11-05): the Slack routes
    // moved from src/server.ts to src/server/routes/messaging.ts; the
    // entry surface is server.ts + routes/*.ts, so the pin reads both
    // files.
    const server = read("src/server.ts") + read("src/server/routes/messaging.ts");
    // #1779: the per-team forward now rides the ActorGateway; the
    // pin tracks the gateway spelling, the instance still per-team.
    expect(server).toContain("actorGateway.dispatch(env.ORCHESTRATOR_AGENT, `slack_${teamId}`");
    expect(server).toContain('"/trading/slack/command"');
    expect(server).toContain('"/trading/slack/event"');
    expect(server).toContain('"/trading/slack/interaction"');
  });

  it("SlackAgent's ingress delegates to the shared handler — no parallel per-path service construction remains", () => {
    const agent = read("src/agents/slackAgent.ts");
    expect(agent).toContain("handleTradingIntegrationsRoutes");
    expect(agent).not.toContain("processSlackCommand(");
    expect(agent).not.toContain("processSlackEvent(");
    expect(agent).not.toContain("processSlackInteraction(");
  });

  it("the NLQ webhook channel is recorded with its HMAC gate and named service identity", () => {
    const nlq = getChannel("nlq-webhook")!;
    expect(nlq.gate).toContain("HMAC");
    expect(nlq.identity).toContain("service identity");
    // Slice 6 of Qunsultant/cfagent#2902 (2026-11-05): the NLQ webhook
    // handler moved from src/server.ts to src/server/routes/messaging.ts;
    // the entry surface is server.ts + routes/*.ts, so the pin reads
    // both files.
    const server = read("src/server.ts") + read("src/server/routes/messaging.ts");
    expect(server).toContain('NLQ_WEBHOOK_SERVICE_LOGIN = "nlq_webhook"');
    expect(server).toContain("`nlq_webhook_${body.userId}`");
  });
});

describe("Agent Mesh S13 (#2412) — converged Slack ingress through SlackAgent", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const teamId = "T0123456789";

  const baseEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
    // Issue #3937: the Slack desk is an E*TRADE service, so the test
    // tenant selects etrade explicitly — the platform default is alpaca now.
    BROKER_ID: "etrade",
    SLACK_SIGNING_SECRET: ["unit", "test", "slack", "signing", "secret"].join("-"),
    SLACK_BOT_TOKEN: ["xoxb", "unit", "test"].join("-"),
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T00/B00/X00",
  } as Env;

  const createMockCtx = (idString = teamId) => ({
    id: { toString: () => idString },
    storage: { sql },
    waitUntil: vi.fn(),
  });

  const linkedEnvFor = async (userId: string, team = teamId): Promise<Env> => {
    const env = { ...baseEnv, SESSION_STORE: makeFakeSessionStore().namespace } as unknown as Env;
    const store = slackPrincipalLinkStoreFromEnv(env);
    const { code } = await store.issueLinkCode(team, userId);
    const confirmed = await confirmSlackLink(env, code, `trader-${userId.toLowerCase()}`);
    expect(confirmed.ok).toBe(true);
    return env;
  };

  const slackSignedPost = async (url: string, body: string, secret = baseEnv.SLACK_SIGNING_SECRET as string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + (await computeHmacSha256Hex(secret, `v0:${ts}:${body}`));
    return new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": signature,
      },
      body,
    });
  };

  const seedPreviewedDraft = (id: string) => {
    orm.trades.create({
      id,
      sessionId: `slack_${teamId}`,
      symbol: "MSFT",
      action: "BUY",
      orderType: "LIMIT",
      quantity: 10,
      price: 430.0,
      totalValue: 4300.0,
      status: "previewed",
      proposerDid: AGENT_DIDS.TRADING,
      proofSignature: "sig_s13",
    });
  };

  const approveEventBody = (orderId: string, eventId?: string) =>
    JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      ...(eventId ? { event_id: eventId } : {}),
      event: {
        type: "app_mention",
        user: "U_HUMAN_APPROVER",
        text: `<@U_BOT> approve ${orderId}`,
        channel: "C_TRADING_ROOM",
        ts: "1728364800.000100",
      },
    });

  beforeEach(() => {
    resetRateLimits();
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(`slack_${teamId}`);
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

  it("a signed production-shaped event reaches the shared handler and executes the approval", async () => {
    stubBrokerPlacement();
    seedPreviewedDraft("ord_s13_approve_1");
    const agent = new SlackAgent(createMockCtx() as any, await linkedEnvFor("U_HUMAN_APPROVER"));

    const res = await agent.onRequest(
      await slackSignedPost("https://agent.internal/slack/events", approveEventBody("ord_s13_approve_1")),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.handled).toBe(true);
    expect(json.actionType).toBe("approval");
    expect(orm.trades.findById("ord_s13_approve_1")?.status).toBe("executed");
  });

  it("a forged signature is refused at the gate before any service work", async () => {
    const processEvent = vi.spyOn(ETradeSlackTradingService.prototype, "processSlackEvent");
    const agent = new SlackAgent(createMockCtx() as any, await linkedEnvFor("U_HUMAN_APPROVER"));

    const res = await agent.onRequest(
      await slackSignedPost(
        "https://agent.internal/slack/events",
        approveEventBody("ord_s13_never"),
        "the-wrong-secret",
      ),
    );
    expect(res.status).toBe(401);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("a duplicate event delivery (same event_id) is acked without reprocessing", async () => {
    const placement = stubBrokerPlacement();
    const processEvent = vi.spyOn(ETradeSlackTradingService.prototype, "processSlackEvent");
    seedPreviewedDraft("ord_s13_dup_1");
    const agent = new SlackAgent(createMockCtx() as any, await linkedEnvFor("U_HUMAN_APPROVER"));
    const body = approveEventBody("ord_s13_dup_1", "EvS13DUP0001");

    const first = await agent.onRequest(await slackSignedPost("https://agent.internal/slack/events", body));
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).actionType).toBe("approval");
    expect(orm.trades.findById("ord_s13_dup_1")?.status).toBe("executed");

    const second = await agent.onRequest(await slackSignedPost("https://agent.internal/slack/events", body));
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as any;
    expect(secondJson.actionType).toBe("duplicate");
    // The service ran exactly once; the broker placement ran exactly once.
    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(placement).toHaveBeenCalledTimes(1);
  });

  it("sessionKey fails closed when the instance id is absent — no synthetic master fallback", () => {
    const agent = new SlackAgent({ storage: { sql }, waitUntil: vi.fn() } as any, baseEnv);
    expect(() => agent.sessionKey()).toThrow();
    expect(read("src/agents/slackAgent.ts")).not.toContain("slack_agent_master");
  });

  it("recovery: a fresh incarnation over the same store honors the executed draft — a second approval cannot re-execute", async () => {
    const placement = stubBrokerPlacement();
    seedPreviewedDraft("ord_s13_recovery_1");
    const env = await linkedEnvFor("U_HUMAN_APPROVER");

    // Incarnation A executes the approval.
    const incarnationA = new SlackAgent(createMockCtx() as any, env);
    const resA = await incarnationA.onRequest(
      await slackSignedPost(
        "https://agent.internal/slack/events",
        approveEventBody("ord_s13_recovery_1", "EvS13REC_A"),
      ),
    );
    expect(resA.status).toBe(200);
    expect(orm.trades.findById("ord_s13_recovery_1")?.status).toBe("executed");
    expect(placement).toHaveBeenCalledTimes(1);

    // Incarnation B is a NEW agent object over the SAME durable store
    // (instance replacement). A fresh delivery (new event_id) asking
    // to approve the same draft must read A's recorded outcome from
    // the ledger and refuse to execute again.
    const incarnationB = new SlackAgent(createMockCtx() as any, env);
    const resB = await incarnationB.onRequest(
      await slackSignedPost(
        "https://agent.internal/slack/events",
        approveEventBody("ord_s13_recovery_1", "EvS13REC_B"),
      ),
    );
    expect(resB.status).toBe(200);
    const jsonB = (await resB.json()) as any;
    // The shared engine's state machine answers the second approval
    // with the already-executed refusal (actionType "rejection",
    // "Execution skipped") — B honored A's recorded outcome.
    expect(jsonB.actionType).toBe("rejection");
    expect(orm.trades.findById("ord_s13_recovery_1")?.status).toBe("executed");
    expect(placement).toHaveBeenCalledTimes(1);
  });
});
