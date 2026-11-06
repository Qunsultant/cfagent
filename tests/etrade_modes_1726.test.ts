/**
 * #1726 (parent #1717, slice (f)): E*TRADE MCP vs REST unification.
 *
 * RED pins first: the MCP execute path must adopt the REST HITL gate
 * (403 did:agent: / 404 draft-exists / 400 previewed-status, with the
 * REST messages and status codes carried on the thrown error), remote
 * placement when broker keys are present, payload-hash audit, and a
 * best-effort Slack transaction snap — and each divergent pair keeps
 * BOTH paths behind one scoped config switch (run > session > user >
 * global env > built-in surface legacy; invalid fails closed +
 * `etrade.config_error` audit). The gate itself is NEVER switchable.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { ETradeService } from "../src/services/etrade";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { ETradeBrowserService } from "../src/services/browserAgent";
import { DynamicMarketScreener } from "../src/trading/screener";
import { handleEtradeBrokerRoutes } from "../src/agents/routes/etradeBroker";
import {
  resolveEtradeScanMode,
  resolveEtradeQuoteMode,
  resolveEtradePreviewMode,
  resolveEtradePositionsMode,
  resolveEtradeStatusMode,
  resolveEtradeDiscoveryMode,
  levelsForEtradeSwitch,
  etradeConfigErrorEvent,
} from "../src/config/etradeModes";
import type { Env } from "../src/types";

const mockEnv: Env = {
  APP_BASE_URL: "https://agent.openaimp.com",
  AI_SEARCH_ENDPOINT: "https://ai-search.internal",
  ORCHESTRATOR_AGENT: {} as any,
  ETRADE_ENVIRONMENT: "sandbox",
} as any;

function setup() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("1726-test-session");
  const auditMock = vi.fn();
  const mcpContext: any = {
    env: mockEnv,
    orm,
    sessionId: "trader_session_001",
    audit: auditMock,
  };
  return { orm, auditMock, mcpContext };
}

async function previewDraft(mcpContext: any, symbol = "PLTR") {
  const previewCmd = McpToolFactory.getTool("etrade_preview_order");
  return previewCmd.execute({ symbol, orderAction: "BUY", quantity: 10 }, mcpContext);
}

/**
 * §7 adaptation (#2389): approval now settles through the broker
 * client's placeOrder — the platform no longer settles locally. Tests
 * in this file whose subject is the execute GATE (not the broker)
 * stub that placement seam to return a broker-confirmed result, the
 * same level the "remote placement" test below stubs for
 * placeOrderRemote.
 */
function stubBrokerPlacement() {
  return vi.spyOn(ETradeRestClient.prototype, "placeOrder").mockImplementation(async (params: any) => ({
    success: true,
    orderId: params.orderId,
    executionId: "et_order_1726",
    brokerOrderRef: "et_order_1726",
    authorizerDid: params.userLogin,
    status: "executed",
    symbol: params.symbol,
    action: params.action,
    quantity: params.quantity,
    executionPrice: 10,
    totalSettled: 10 * params.quantity,
    didAttestation: {
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: params.userLogin,
      signature: ["sig", "0xbroker1726"].join("_"),
    },
    message: "E*TRADE Execution Confirmed: Broker Order ID et_order_1726",
    timestamp: new Date().toISOString(),
  }) as any);
}

describe("#1726 switch resolution (run > session > user > env > built-in)", () => {
  it("resolves run first, then session, user, env, built-in", () => {
    const scoped = { session: { scan: "screened" }, user: { scan: "listings" } };
    expect(resolveEtradeScanMode(levelsForEtradeSwitch(scoped, "scan", "listings", "screened"), "listings").mode).toBe("listings");
    expect(resolveEtradeScanMode(levelsForEtradeSwitch(scoped, "scan", undefined, "screened"), "listings").mode).toBe("screened");
    expect(resolveEtradeScanMode(levelsForEtradeSwitch({ session: {}, user: { scan: "screened" } }, "scan", undefined, "listings"), "listings").mode).toBe("screened");
    expect(resolveEtradeScanMode(levelsForEtradeSwitch(undefined, "scan", undefined, "screened"), "listings").mode).toBe("screened");
    expect(resolveEtradeScanMode(levelsForEtradeSwitch(undefined, "scan", undefined, undefined), "listings").mode).toBe("listings");
  });

  it("fails closed to the built-in legacy on an invalid value, without falling through", () => {
    const resolved = resolveEtradeQuoteMode(levelsForEtradeSwitch(undefined, "quote", "bogus", "rest"), "mcp");
    expect(resolved.mode).toBe("mcp");
    expect(resolved.invalid).toBe(true);
    expect(resolved.level).toBe("run");
    expect(etradeConfigErrorEvent()).toBe("etrade.config_error");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(resolveEtradePreviewMode(levelsForEtradeSwitch(undefined, "preview", "  BROKER ", undefined), "local").mode).toBe("broker");
    expect(resolveEtradePositionsMode(levelsForEtradeSwitch(undefined, "positions", undefined, "REST"), "mcp").mode).toBe("rest");
    expect(resolveEtradeStatusMode(levelsForEtradeSwitch(undefined, "status", undefined, undefined), "mcp").mode).toBe("mcp");
    expect(resolveEtradeDiscoveryMode(levelsForEtradeSwitch(undefined, "discovery", undefined, undefined), "mcp").mode).toBe("mcp");
  });
});

describe("#1726 E04 MCP execute adopts the REST HITL gate", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    DynamicMarketScreener.setTestListingsFixture(null);
  });

  it("rejects a did:agent: caller with the REST 403 message and status", async () => {
    const execCmd = McpToolFactory.getTool("etrade_execute_order");
    const agentCtx = { ...ctx.mcpContext, sessionId: "did:agent:openaimp:trading" };
    const err = await execCmd.execute({ orderId: "ord_missing", decision: "approved" }, agentCtx).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("HITL Enforcement: Autonomous trade execution is strictly prohibited");
    expect(err.status).toBe(403);
  });

  it("rejects an unknown draft with the REST 404 message and status", async () => {
    const execCmd = McpToolFactory.getTool("etrade_execute_order");
    const err = await execCmd.execute({ orderId: "ord_nope123", decision: "approved" }, ctx.mcpContext).catch((e: any) => e);
    expect(err.message).toContain("Order draft 'ord_nope123' not found");
    expect(err.status).toBe(404);
  });

  it("rejects re-execution of an executed draft with the REST 400 previewed message and status", async () => {
    const placeSpy = stubBrokerPlacement();
    try {
      const draft = await previewDraft(ctx.mcpContext);
      const execCmd = McpToolFactory.getTool("etrade_execute_order");
      await execCmd.execute({ orderId: draft.orderId, decision: "approved" }, ctx.mcpContext);
      const err = await execCmd.execute({ orderId: draft.orderId, decision: "approved" }, ctx.mcpContext).catch((e: any) => e);
      expect(err.message).toContain("Only 'previewed' drafts may be executed");
      expect(err.status).toBe(400);
    } finally {
      placeSpy.mockRestore();
    }
  });

  it("rejects a rejected decision on an unknown draft with 404 (gate runs before rejection)", async () => {
    const execCmd = McpToolFactory.getTool("etrade_execute_order");
    const err = await execCmd.execute({ orderId: "ord_nope123", decision: "rejected" }, ctx.mcpContext).catch((e: any) => e);
    expect(err.status).toBe(404);
  });

  it("approved execution audits a payload hash and keeps the legacy result shape", async () => {
    const placeSpy = stubBrokerPlacement();
    try {
      const draft = await previewDraft(ctx.mcpContext);
      const execCmd = McpToolFactory.getTool("etrade_execute_order");
      const executed = await execCmd.execute({ orderId: draft.orderId, decision: "approved" }, ctx.mcpContext);
      expect(executed.success).toBe(true);
      expect(executed.status).toBe("executed");
      const audit = ctx.auditMock.mock.calls.find((c: any[]) => c[0] === "etrade.order_executed");
      expect(audit).toBeDefined();
      expect(typeof audit[2].payloadHash).toBe("string");
      expect(audit[2].payloadHash.length).toBeGreaterThan(0);
    } finally {
      placeSpy.mockRestore();
    }
  });

  it("rejection marks the draft rejected and audits order_rejected", async () => {
    const draft = await previewDraft(ctx.mcpContext);
    const execCmd = McpToolFactory.getTool("etrade_execute_order");
    const result = await execCmd.execute({ orderId: draft.orderId, decision: "rejected" }, ctx.mcpContext);
    expect(result.status).toBe("rejected");
    expect(ctx.orm.trades?.findById(draft.orderId)?.status).toBe("rejected");
    expect(ctx.auditMock).toHaveBeenCalledWith("etrade.order_rejected", "trading", expect.any(Object));
  });

  it("uses remote placement when broker keys are present, and sends a Slack snap", async () => {
    const draft = await previewDraft(ctx.mcpContext);
    const remoteSpy = vi.spyOn(ETradeService.prototype, "placeOrderRemote").mockResolvedValue({
      success: true, status: "executed", executionId: "remote-1", orderId: draft.orderId,
    } as any);
    const snapSpy = vi.spyOn(ETradeBrowserService.prototype, "sendTransactionSnapToSlack").mockResolvedValue(undefined as any);
    try {
      const keyedCtx = { ...ctx.mcpContext, env: { ...mockEnv, ETRADE_CONSUMER_KEY: "key", ETRADE_MCP_SERVER_URL: undefined, ET_API_KEY: undefined } };
      const execCmd = McpToolFactory.getTool("etrade_execute_order");
      const executed = await execCmd.execute({ orderId: draft.orderId, decision: "approved" }, keyedCtx);
      expect(remoteSpy).toHaveBeenCalled();
      expect(executed.executionId).toBe("remote-1");
      expect(ctx.orm.trades?.findById(draft.orderId)?.status).toBe("executed");
      expect(snapSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "EXECUTED", humanApproved: true }));
    } finally {
      remoteSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });
});

describe("#1726 divergent pairs behind switches (MCP surface)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    DynamicMarketScreener.setTestListingsFixture(null);
  });

  it("scan screened mode in MCP fails loud (ScreenerAgent is not bound in MCP context)", async () => {
    const cmd = McpToolFactory.getTool("etrade_market_scan");
    const err = await cmd.execute({ mode: "screened" }, ctx.mcpContext).catch((e: any) => e);
    expect(err.message).toMatch(/screened.*not available in MCP context/i);
  });

  it("scan listings mode keeps the legacy listings engine and audit", async () => {
    DynamicMarketScreener.setTestListingsFixture([{
      symbol: "LIVE", companyName: "Live Corp", exchange: "nasdaq",
      lastPrice: 50, change: 1, changePercent: 2, marketCap: 1_000_000_000,
    }]);
    try {
      const cmd = McpToolFactory.getTool("etrade_market_scan");
      const res = await cmd.execute({ mode: "listings", limit: 5 }, ctx.mcpContext);
      expect(res.stocks.length).toBeGreaterThanOrEqual(1);
      expect(ctx.auditMock).toHaveBeenCalledWith("etrade.market_scanned", "trading", expect.any(Object));
    } finally {
      DynamicMarketScreener.setTestListingsFixture(null);
    }
  });

  it("quote rest mode defaults a missing symbol to NVDA and skips the MCP audit", async () => {
    const cmd = McpToolFactory.getTool("etrade_get_quote");
    const quote = await cmd.execute({ mode: "rest" }, ctx.mcpContext);
    expect(quote.symbol).toBe("NVDA");
    expect(ctx.auditMock).not.toHaveBeenCalledWith("etrade.quote_fetched", "trading", expect.any(Object));
  });

  it("quote mcp mode keeps the legacy audit", async () => {
    const cmd = McpToolFactory.getTool("etrade_get_quote");
    const quote = await cmd.execute({ symbol: "AAPL", mode: "mcp" }, ctx.mcpContext);
    expect(quote.symbol).toBe("AAPL");
    expect(ctx.auditMock).toHaveBeenCalledWith("etrade.quote_fetched", "trading", expect.any(Object));
  });

  it("quote rest mode honors a TEST/PROD environment override (PROD takes the live path, which refuses without live creds)", async () => {
    const cmd = McpToolFactory.getTool("etrade_get_quote");
    // Sandbox (no env override) returns a quote; PROD flips isLive on,
    // and the live path refuses without live credentials — the refusal
    // itself proves the override was honored (the sandbox path would
    // have returned a quote, as the mcp-mode test above does).
    // #1726 fix: which pre-existing refusal string is reached depends on
    // environment credentials, NOT on the code under test. CI's test-shard
    // job injects ET_API_KEY/ET_API_SECRET into the test process env
    // (ci.yml), and resolveEnvironmentConfig (src/config/environment.ts)
    // falls back to process.env, so in CI fetchQuoteDetailed
    // (src/trading/etrade/client.ts:183-203) passes its consumer-credentials
    // check and reaches the token check ("OAuth access token is missing");
    // without consumer credentials it stops at the credentials check
    // ("not configured for live quote"). Both are pre-existing REST
    // contract strings, untouched by this slice, and both mean "refused
    // without live creds" with no quote returned — so the test accepts
    // either. Intent unchanged: a refusal, not a quote.
    const err = await cmd.execute({ symbol: "AAPL", mode: "rest", environment: "PROD" }, ctx.mcpContext).catch((e: any) => e);
    expect(err.message).toMatch(/not configured for live quote|OAuth access token is missing/);
  });

  it("an invalid switch value fails closed to the legacy path and audits etrade.config_error", async () => {
    const cmd = McpToolFactory.getTool("etrade_get_quote");
    const quote = await cmd.execute({ symbol: "AAPL", mode: "bogus" }, ctx.mcpContext);
    expect(quote.symbol).toBe("AAPL");
    expect(ctx.auditMock).toHaveBeenCalledWith("etrade.quote_fetched", "trading", expect.any(Object));
    expect(ctx.auditMock).toHaveBeenCalledWith("etrade.config_error", "trading", expect.objectContaining({ switch: "ETRADE_QUOTE_MODE" }));
  });

  it("positions rest mode returns the spread REST envelope, not the reshaped MCP envelope", async () => {
    const cmd = McpToolFactory.getTool("etrade_get_positions");
    const res = await cmd.execute({ mode: "rest" }, ctx.mcpContext);
    expect(res.account).toBeDefined();
    expect(Array.isArray(res.positions)).toBe(true);
    expect(res).not.toHaveProperty("totalPortfolioValue");
    expect(res).not.toHaveProperty("positionsCount");
  });

  it("positions mcp mode keeps the legacy reshaped envelope", async () => {
    const cmd = McpToolFactory.getTool("etrade_get_positions");
    const res = await cmd.execute({ mode: "mcp" }, ctx.mcpContext);
    expect(res.totalPortfolioValue).toBeDefined();
    expect(res.positionsCount).toBeDefined();
    expect(res.asOf).toBeDefined();
  });

  it("discovery rest mode in sandbox surfaces the credential failure as 502 (REST parity: empty + upstream error)", async () => {
    // No broker session in this env: the client returns [] with a
    // recorded error, so the REST shape is a 502 naming the cause —
    // exactly what GET /etrade/accounts returns for the same state.
    // #1726 fix: which pre-existing credential-refusal string is reached
    // depends on environment credentials, as in the quote test above.
    // Without consumer credentials, fetchAccounts
    // (src/trading/etrade/client.ts:1406-1407) stops at "not configured
    // for account"; with CI-injected ET_API_KEY/ET_API_SECRET it passes
    // that check and generateOAuthHeader (client.ts:131) records the
    // pre-existing "OAuth Token Missing: No active session" message,
    // which the discovery command surfaces as the 502 (see
    // src/mcps/openaimp/etradeCommands.ts, etrade_account_discovery). Both are
    // pre-existing contract strings, untouched by this slice. The 502
    // assertion above is unchanged — intent unchanged: credential
    // failure surfaced as 502.
    const cmd = McpToolFactory.getTool("etrade_account_discovery");
    const err = await cmd.execute({ mode: "rest" }, ctx.mcpContext).catch((e: any) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/not configured for account|OAuth Token Missing/);
  });

  it("discovery rest mode returns {count, accounts} without asOf when accounts exist", async () => {
    const accountsSpy = vi.spyOn(ETradeService.prototype, "fetchAccountsRemote").mockResolvedValue([{ accountId: "a1" } as any]);
    try {
      const cmd = McpToolFactory.getTool("etrade_account_discovery");
      const res = await cmd.execute({ mode: "rest" }, ctx.mcpContext);
      expect(res).toHaveProperty("count", 1);
      expect(res).toHaveProperty("accounts");
      expect(res).not.toHaveProperty("asOf");
    } finally {
      accountsSpy.mockRestore();
    }
  });

  it("discovery rest mode surfaces an empty list with an upstream error as a 502 error", async () => {
    const accountsSpy = vi.spyOn(ETradeService.prototype, "fetchAccountsRemote").mockResolvedValue([]);
    const errSpy = vi.spyOn(ETradeService.prototype, "getLastError").mockReturnValue("OAuth expired");
    try {
      const cmd = McpToolFactory.getTool("etrade_account_discovery");
      const err = await cmd.execute({ mode: "rest" }, ctx.mcpContext).catch((e: any) => e);
      expect(err.status).toBe(502);
      expect(err.message).toContain("OAuth expired");
    } finally {
      accountsSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("status rest mode threads the requested environment (PROD override changes the reported environment)", async () => {
    const cmd = McpToolFactory.getTool("etrade_auth_status");
    const mcpStatus = await cmd.execute({ mode: "mcp" }, ctx.mcpContext);
    expect(mcpStatus.environment).toBe("sandbox");
    const restStatus = await cmd.execute({ mode: "rest", environment: "PROD" }, ctx.mcpContext);
    expect(restStatus.environment).toBe("live");
  });

  it("preview local mode rejects option legs loudly instead of dropping them silently", async () => {
    const cmd = McpToolFactory.getTool("etrade_preview_order");
    const err = await cmd.execute({
      symbol: "SPY", orderAction: "BUY", quantity: 1, orderType: "LIMIT", limitPrice: 5,
      optionLegs: [{ securityType: "OPTN", symbol: "SPY", quantity: 1 }],
    }, ctx.mcpContext).catch((e: any) => e);
    expect(err.message).toMatch(/option legs/);
    expect(err.message).toMatch(/Local preview mode/);
  });

  it("preview broker mode returns a broker draft and audits its payload hash", async () => {
    const cmd = McpToolFactory.getTool("etrade_preview_order");
    const preview = await cmd.execute({ symbol: "AMD", orderAction: "BUY", quantity: 20, mode: "broker" }, ctx.mcpContext);
    expect(preview.orderId).toMatch(/^ord_/);
    expect(preview.status).toBe("previewed");
    const audit = ctx.auditMock.mock.calls.find((c: any[]) => c[0] === "etrade.order_previewed");
    expect(audit).toBeDefined();
    expect(typeof audit[2].payloadHash).toBe("string");
  });
});

describe("#1726 REST screen listings branch", () => {
  it("POST /etrade/screen with mode=listings runs the listings engine, not the screened pipeline", async () => {
    DynamicMarketScreener.setTestListingsFixture([{
      symbol: "LIVE", companyName: "Live Corp", exchange: "nasdaq",
      lastPrice: 50, change: 1, changePercent: 2, marketCap: 1_000_000_000,
    }]);
    try {
      const sql = new MockSqlStorage();
      const orm = new DatabaseORM(sql);
      orm.initializeSchema("1726-rest-screen");
      const audit = vi.fn();
      const routeCtx: any = {
        env: mockEnv,
        getOrm: () => orm,
        audit,
        getScreenerAgent: () => { throw new Error("screened pipeline must not run in listings mode"); },
        readSettingRaw: () => null,
      };
      const req = new Request("https://agent.test/api/etrade/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "test-user" },
        body: JSON.stringify({ mode: "listings", exchange: "NASDAQ", limit: 5 }),
      });
      const res = await handleEtradeBrokerRoutes(req, new URL(req.url), "/api/etrade/screen", "s", routeCtx);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const body: any = await res!.json();
      expect(Array.isArray(body.stocks)).toBe(true);
      expect(audit).toHaveBeenCalledWith("etrade.market_scanned", "trading", expect.any(Object));
    } finally {
      DynamicMarketScreener.setTestListingsFixture(null);
    }
  });
});
