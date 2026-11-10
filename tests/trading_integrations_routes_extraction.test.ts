/**
 * Issue #359-10: characterization for the trading-integrations route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/tradingIntegrations.ts — the matching order in
 * routeRequest is load-bearing, so the module must handle the (path, method)
 * pairs in the same sequence as the original inline blocks; (b) the
 * delegation call site in orchestrator.ts — one call site, between the
 * E*TRADE broker delegation and the broker-activity delegation; and (c) the
 * extracted entry point's behavior with a mock context: owned paths return a
 * Response (audit events fire, services dispatch), non-matching paths return
 * null (the orchestrator keeps routing).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks — those move when their domain is extracted. Here BOTH neighbors
 * are already-extracted delegations (handleEtradeBrokerRoutes from slice 09
 * #359-09, handleEtradeBrokerActivityRoutes from slice #359-09), so the
 * anchors are stable. The still-inline E*TRADE options block (slice #359-11)
 * sits below the lower anchor and does not reference this domain, so its
 * future extraction needs no swap here. Watchlists (#375) and alpaca (#376)
 * come after the options block — no neighborhood interaction.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleTradingIntegrationsRoutes,
  type TradingIntegrationsRouteContext,
} from "../src/agents/routes/tradingIntegrations";
import {
  ETradeEmailTradingService,
  ETradeSlackTradingService,
  ETradeVoiceTradingService,
} from "../src/trading";
// BrowserAgent pulls in the agents SDK (cloudflare: protocol), which
// cannot load under plain node ESM — the same reason the other
// extraction suites never import agent classes directly. Mock the agent
// module (vi.mock is hoisted, so the real module never loads); the route
// module's own `../browserAgent` specifier resolves to the same file and
// gets the mock. (Issue #1262 Phase 2: the route no longer constructs
// SlackAgent at all — commands go through ETradeSlackTradingService —
// so no SlackAgent mock is needed here.)
vi.mock("../src/agents/browserAgent", () => ({
  BrowserAgent: class MockBrowserAgent {
    constructor(..._args: unknown[]) {}
    async sendTransactionSnapToSlack(
      _tx: unknown,
      _opts: { webhookUrl?: string; channel?: string; caption?: string }
    ): Promise<unknown> {
      return { posted: true };
    }
  },
}));
import { BrowserAgent } from "../src/agents/browserAgent";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (
  overrides: Partial<TradingIntegrationsRouteContext> = {}
): TradingIntegrationsRouteContext =>
  ({
    // Issue #3937: the desks are E*TRADE services, so the test tenant
    // selects etrade explicitly — the platform default is alpaca now.
    env: { BROKER_ID: "etrade" } as any,
    getOrm: () => ({}) as any,
    audit: vi.fn(),
    agentCtx: {} as any,
    nlqSchedulingPort: () => ({}) as any,
    // Issue #1262 Phase 4: the route builds the channel NLQ dep set
    // from DO storage SQL for every channel service construction.
    getStorageSql: () => ({ exec: () => [] }) as any,
    ...overrides,
  }) as TradingIntegrationsRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

const ROUTE_MARKERS = [
  'path.endsWith("/trading/email/inbound")',
  'path.endsWith("/trading/slack/event")',
  'path.endsWith("/trading/slack/interaction")',
  'path.endsWith("/trading/slack/command")',
  'path.endsWith("/trading/browser/transaction-snap")',
  'path.endsWith("/browser/transaction-snap")',
  'path.endsWith("/trading/voice/turn")',
  'path.endsWith("/trading/voice/greeting")',
];

describe("trading-integrations route inventory (extraction #373)", () => {
  it("the route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/tradingIntegrations.ts");
    let last = -1;
    for (const marker of ROUTE_MARKERS) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
    // One handler, with the slice-08 null-fallthrough guard.
    expect(moduleSrc).toContain("export async function handleTradingIntegrationsRoutes");
    expect(moduleSrc).toContain("return null;");
  });

  it("the original inline blocks are gone from orchestrator.ts; one delegation stands at the original position", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    // No leftover inline conditions for these paths.
    for (const cond of ROUTE_MARKERS) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The extracted module is the sole owner of these blocks now.
    const moduleSrc = src("agents/routes/tradingIntegrations.ts");
    expect(moduleSrc).toContain("// Omnichannel Trading Channel: Inbound Email Trading Agent");
    expect(moduleSrc).toContain("// Omnichannel Trading Channel: Voice Trading Welcome Greeting");
    // Single call site.
    const calls = [...dispatchSrc.matchAll(/handleTradingIntegrationsRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });

  it("the delegation sits between the broker delegation and the broker-activity delegation", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const myIdx = dispatchSrc.indexOf("handleTradingIntegrationsRoutes(request, url, path, sessionId,");
    // Upper bound: the slice-09 (#359-09) broker delegation call. The
    // requestedEnv binding stays inline below it, but the landmark anchors
    // on the delegation call per the #405 rule.
    const brokerIdx = dispatchSrc.indexOf("handleEtradeBrokerRoutes(request, url, path, sessionId,");
    expect(brokerIdx).toBeGreaterThan(-1);
    expect(myIdx, "integrations delegation must follow the broker delegation").toBeGreaterThan(brokerIdx);
    // Lower bound: the slice-09 broker-activity delegation call (the trading
    // channels block's own banner comment moved into this module, so anchoring
    // on the banner would break; the delegation call is stable).
    const activityIdx = dispatchSrc.indexOf("handleEtradeBrokerActivityRoutes(request, url, path, sessionId,");
    expect(activityIdx).toBeGreaterThan(-1);
    expect(myIdx, "integrations delegation must precede the broker-activity delegation").toBeLessThan(activityIdx);
  });

  it("trading access stays behind the src/trading/index.ts boundary (#290)", () => {
    const moduleSrc = src("agents/routes/tradingIntegrations.ts");
    // From src/agents/routes/, the boundary is "../../trading".
    expect(moduleSrc).toContain('from "../../trading"');
    // No direct imports of trading internals (only "../../trading" and types).
    const tradingImports = [...moduleSrc.matchAll(/from\s+"(\.\.\/\.\.\/trading[^"]*)"/g)].map((m) => m[1]);
    expect(tradingImports.length).toBeGreaterThan(0);
    for (const imp of tradingImports) {
      expect(imp, `trading import must go through the boundary: ${imp}`).toBe("../../trading");
    }
    // The boundary still re-exports these three services (the #290 owner).
    expect(moduleSrc).toMatch(/ETradeEmailTradingService[\s\S]*ETradeSlackTradingService[\s\S]*ETradeVoiceTradingService/);
  });
});

describe("handleTradingIntegrationsRoutes behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(
      await handleTradingIntegrationsRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)
    ).toBeNull();
    expect(
      await handleTradingIntegrationsRoutes(req("POST", "/api/etrade/options/chains"), urlOf("/api/etrade/options/chains"), "/api/etrade/options/chains", "s", ctx)
    ).toBeNull();
    // Wrong method on an owned path is not owned by this handler.
    expect(
      await handleTradingIntegrationsRoutes(req("GET", "/api/trading/email/inbound"), urlOf("/api/trading/email/inbound"), "/api/trading/email/inbound", "s", ctx)
    ).toBeNull();
  });

  it("a non-E*TRADE tenant gets the coded desk refusal, never the service (#3937)", async () => {
    // Issue #3937: the platform default is alpaca, so a tenant with no
    // stored selection is refused by name on the E*TRADE desks — the
    // service is never constructed and nothing is previewed or routed.
    const ctx = baseCtx({ env: { BROKER_ID: "alpaca" } as any });
    const res = await handleTradingIntegrationsRoutes(
      req("POST", "/api/trading/email/inbound", { subject: "quote AAPL" }),
      urlOf("/api/trading/email/inbound"),
      "/api/trading/email/inbound",
      "sess-1",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(501);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("BROKER_CHANNEL_UNAVAILABLE");
    expect(body.broker).toBe("alpaca");
  });

  it("POST /trading/email/inbound dispatches the email service and audits (contract preserved)", async () => {
    const processInboundEmail = vi
      .spyOn(ETradeEmailTradingService.prototype, "processInboundEmail")
      .mockResolvedValue({ actionType: "quote", from: "user@example.com", orderId: "ord_1" } as any);
    const audit = vi.fn();
    const ctx = baseCtx({ audit });
    const res = await handleTradingIntegrationsRoutes(
      req("POST", "/api/trading/email/inbound", { subject: "quote AAPL" }),
      urlOf("/api/trading/email/inbound"),
      "/api/trading/email/inbound",
      "sess-1",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(processInboundEmail).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      "trading.email_processed",
      "trading",
      { actionType: "quote", from: "user@example.com", orderId: "ord_1" }
    );
    const body = (await res!.json()) as any;
    expect(body.actionType).toBe("quote");
  });

  it("POST /trading/slack/event dispatches the slack event handler and audits", async () => {
    const processSlackEvent = vi
      .spyOn(ETradeSlackTradingService.prototype, "processSlackEvent")
      .mockResolvedValue({ actionType: "message", handled: true } as any);
    const audit = vi.fn();
    const ctx = baseCtx({ audit });
    const res = await handleTradingIntegrationsRoutes(
      req("POST", "/api/trading/slack/event", { type: "message" }),
      urlOf("/api/trading/slack/event"),
      "/api/trading/slack/event",
      "sess-2",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(processSlackEvent).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith("trading.slack_event", "trading", { actionType: "message", handled: true });
  });

  it("POST /trading/slack/interaction dispatches the interaction handler and audits", async () => {
    const processSlackInteraction = vi
      .spyOn(ETradeSlackTradingService.prototype, "processSlackInteraction")
      .mockResolvedValue({ actionId: "approve_btn", orderId: "ord_9", status: "approved" } as any);
    const audit = vi.fn();
    const ctx = baseCtx({ audit });
    const res = await handleTradingIntegrationsRoutes(
      req("POST", "/api/trading/slack/interaction", { payload: "{}" }),
      urlOf("/api/trading/slack/interaction"),
      "/api/trading/slack/interaction",
      "sess-3",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(processSlackInteraction).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith("trading.slack_interaction", "trading", {
      actionId: "approve_btn",
      orderId: "ord_9",
      status: "approved",
    });
  });

  it("POST /trading/slack/command delegates to the single slack service with form data (Phase 2 dedup)", async () => {
    const processSlackCommand = vi
      .spyOn(ETradeSlackTradingService.prototype, "processSlackCommand")
      .mockResolvedValue(new Response("ok"));
    const ctx = baseCtx();
    const form = new FormData();
    form.set("text", "/quote AAPL");
    const request = new Request("https://agent.internal/api/trading/slack/command", { method: "POST", body: form });
    const res = await handleTradingIntegrationsRoutes(
      request,
      urlOf("/api/trading/slack/command"),
      "/api/trading/slack/command",
      "sess-4",
      ctx
    );
    expect(res).not.toBeNull();
    expect(processSlackCommand).toHaveBeenCalledTimes(1);
    const formData = processSlackCommand.mock.calls[0][0] as FormData;
    expect(formData.get("text")).toBe("/quote AAPL");
  });

  it("POST /trading/browser/transaction-snap (and /browser/transaction-snap) dispatch the browser agent", async () => {
    const sendSnap = vi
      .spyOn(BrowserAgent.prototype, "sendTransactionSnapToSlack")
      .mockResolvedValue({ posted: true } as any);
    const ctx = baseCtx({ env: { SLACK_WEBHOOK_URL: "https://hooks.slack.test/x" } as any });
    for (const path of ["/api/trading/browser/transaction-snap", "/api/browser/transaction-snap"]) {
      const res = await handleTradingIntegrationsRoutes(
        req("POST", path, { transaction: { id: "tx1" }, channel: "#trades" }),
        urlOf(path),
        path,
        "sess-5",
        ctx
      );
      expect(res, `expected a Response for ${path}`).not.toBeNull();
      expect(res!.status).toBe(200);
    }
    expect(sendSnap).toHaveBeenCalledTimes(2);
    // The env webhook URL is used when the body has none.
    expect(sendSnap.mock.calls[0][1].webhookUrl).toBe("https://hooks.slack.test/x");
  });

  it("POST /trading/voice/turn dispatches the voice service and audits", async () => {
    const processVoiceTurn = vi
      .spyOn(ETradeVoiceTradingService.prototype, "processVoiceTurn")
      .mockResolvedValue({ actionType: "quote", orderId: "ord_2", success: true } as any);
    const audit = vi.fn();
    const ctx = baseCtx({ audit });
    const res = await handleTradingIntegrationsRoutes(
      req("POST", "/api/trading/voice/turn", { transcript: "quote AAPL" }),
      urlOf("/api/trading/voice/turn"),
      "/api/trading/voice/turn",
      "sess-6",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(processVoiceTurn).toHaveBeenCalledTimes(1);
    const args = processVoiceTurn.mock.calls[0][0] as any;
    expect(args.userLogin).toBe("sess-6");
    expect(audit).toHaveBeenCalledWith("trading.voice_turn", "trading", {
      actionType: "quote",
      orderId: "ord_2",
      success: true,
    });
  });

  it("GET /trading/voice/greeting returns the welcome greeting", async () => {
    const getWelcomeGreeting = vi
      .spyOn(ETradeVoiceTradingService.prototype, "getWelcomeGreeting")
      .mockReturnValue({ greeting: "hello trader" } as any);
    const ctx = baseCtx();
    const res = await handleTradingIntegrationsRoutes(
      req("GET", "/api/trading/voice/greeting"),
      urlOf("/api/trading/voice/greeting"),
      "/api/trading/voice/greeting",
      "sess-7",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(getWelcomeGreeting).toHaveBeenCalledTimes(1);
    const body = (await res!.json()) as any;
    expect(body.greeting).toBe("hello trader");
  });

  it("POST /trading/email/approve-link dispatches the signed-link execution and audits (Phase 5)", async () => {
    const executeSignedApprovalLink = vi
      .spyOn(ETradeEmailTradingService.prototype, "executeSignedApprovalLink")
      .mockResolvedValue({ success: true, orderId: "ord_link_1", status: "executed", message: "ok", execId: "et_1" } as any);
    const audit = vi.fn();
    const ctx = baseCtx({ audit });
    const res = await handleTradingIntegrationsRoutes(
      req("POST", "/api/trading/email/approve-link", { token: "tok.abc" }),
      urlOf("/api/trading/email/approve-link"),
      "/api/trading/email/approve-link",
      "sess-link",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(executeSignedApprovalLink).toHaveBeenCalledTimes(1);
    expect(executeSignedApprovalLink.mock.calls[0][0]).toBe("tok.abc");
    expect(audit).toHaveBeenCalledWith("trading.email_approve_link", "trading", {
      orderId: "ord_link_1",
      status: "executed",
    });
    const body = (await res!.json()) as any;
    expect(body.success).toBe(true);
  });

  it("service failures keep the original 500 contract", async () => {
    vi.spyOn(ETradeEmailTradingService.prototype, "processInboundEmail").mockRejectedValue(
      new Error("boom")
    );
    const ctx = baseCtx();
    const res = await handleTradingIntegrationsRoutes(
      req("POST", "/api/trading/email/inbound", {}),
      urlOf("/api/trading/email/inbound"),
      "/api/trading/email/inbound",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    expect(((await res!.json()) as any).error).toBe("boom");
  });
});
