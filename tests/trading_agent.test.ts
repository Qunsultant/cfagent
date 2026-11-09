/**
 * Issue #291 T1 — TradingAgent shell: config, service registry, and the
 * three doors (tools / A2A / RPC) over one execution path.
 *
 * The pluggability proof lives here: a FAKE provider platform is
 * registered at runtime and the stock-screening service executes against
 * it without the agent or service naming any broker — the same path a
 * future real provider (e.g. Public.com) onboards through.
 */
import { describe, it, expect, vi } from "vitest";
import {
  getTradingAgentConfig,
  TRADING_AGENT_CONFIG_BASELINE,
} from "../src/config/tradingAgentConfig";
import { MockSqlStorage } from "./mock-sql";
// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
// Issue #1954: TradingAgent extends PortThink, so this file's
// module graph now reaches bare @cloudflare/think via thinkAdapter.
// Under node vitest that specifier resolves to the test-only stub
// (harness #2003, tracker #1951), so this file runs under node
// with real assertions; no local stub/mock of thinkAdapter is
// added here. The real Think turn still cannot run under node
// vitest (spike verdict) and is covered by the workerd proof +
// think-port-mapping tests, not here.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import {
  TRADING_SERVICE_REGISTRY,
  buildTradingTools,
  dispatchTradingA2A,
  executeTradingService,
  extractA2AOperation,
  liveTradingServices,
  resolveTradingPlatform,
} from "../src/agents/trading-agent";
import {
  TradingPlatformRegistry,
  type ITradingPlatform,
} from "../src/trading";
import { AGENT_CARDS } from "../src/a2a/agent-cards";
import { OPERATION_CATALOG } from "../src/orchestrate";
import type { Env } from "../src/types";

const env = { SERVICE_USER_LOGIN: "svc-trader" } as Env;

const CANNED_SCREEN = {
  totalScanned: 3,
  totalScreened: 1,
  matchedCount: 1,
  filterApplied: {},
  filterSummary: "fake screen",
  stocks: [{ symbol: "FAKE" }],
  scannedAt: "2026-10-22T00:00:00.000Z",
};

function fakePlatform(withScreening: boolean): ITradingPlatform {
  const platform: any = {
    platformId: "fake291",
    name: "Fake Provider (test)",
    getStatus: async () => ({}),
    getQuote: async () => ({}),
    getAccounts: async () => [],
    getPositions: async () => ({ account: {}, positions: [] }),
    previewOrder: async () => ({}),
    executeOrder: () => ({}),
  };
  if (withScreening) {
    platform.screenMarkets = async (filter: unknown) => ({
      ...CANNED_SCREEN,
      filterApplied: filter ?? {},
    });
  }
  return platform as ITradingPlatform;
}

TradingPlatformRegistry.register("fake291" as any, () => fakePlatform(true));
TradingPlatformRegistry.register("noscreen291" as any, () => fakePlatform(false));

const fakeConfig = {
  enabledProviders: ["fake291", "noscreen291", "ghost291"],
  defaultProvider: "fake291",
  enabledServices: [...TRADING_AGENT_CONFIG_BASELINE.enabledServices],
};

describe("TradingAgent config (#291)", () => {
  it("baseline: etrade + alpaca enabled, alpaca default, all services on", () => {
    const config = getTradingAgentConfig({});
    expect(config.enabledProviders).toEqual(["etrade", "alpaca"]);
    expect(config.defaultProvider).toBe("alpaca");
    expect(config.enabledServices).toContain("stock_screening");
    expect(config.enabledServices).toContain("options_trading");
  });

  it("env overrides parse lists and drop unknown service ids", () => {
    const config = getTradingAgentConfig({
      TRADING_AGENT_PROVIDERS: "etrade, Public ",
      TRADING_AGENT_DEFAULT_PROVIDER: "public",
      TRADING_AGENT_SERVICES: "stock_screening,bogus_service",
    });
    expect(config.enabledProviders).toEqual(["etrade", "public"]);
    expect(config.defaultProvider).toBe("public");
    expect(config.enabledServices).toEqual(["stock_screening"]);
  });

  it("empty overrides fall back to baseline rather than disabling everything", () => {
    const config = getTradingAgentConfig({
      TRADING_AGENT_PROVIDERS: " , ",
      TRADING_AGENT_SERVICES: "",
    });
    expect(config.enabledProviders).toEqual(["etrade", "alpaca"]);
    expect(config.enabledServices.length).toBeGreaterThan(0);
  });
});

describe("TradingAgent surfaces stay in sync (#291 anti-drift)", () => {
  it("A2A card, operation catalog, and live registry agree on operations", () => {
    const card = AGENT_CARDS.find((c) => c.name === "trading");
    expect(card).toBeDefined();
    const catalog = OPERATION_CATALOG.find((e) => e.agent === "trading");
    expect(catalog).toBeDefined();
    expect(catalog!.binding).toBe("TRADING_AGENT");
    const liveOps = liveTradingServices(TRADING_AGENT_CONFIG_BASELINE).map(
      (s) => s.a2aOperation,
    );
    expect(card!.operations).toEqual(liveOps);
    expect(catalog!.operations).toEqual(liveOps);
  });

  it("tools are generated from the registry and honor the service toggles", () => {
    const tools = buildTradingTools(env, TRADING_AGENT_CONFIG_BASELINE);
    expect(Object.keys(tools)).toEqual(
      liveTradingServices(TRADING_AGENT_CONFIG_BASELINE).map((s) => s.toolName),
    );
    const narrowed = buildTradingTools(env, {
      ...TRADING_AGENT_CONFIG_BASELINE,
      enabledServices: ["not_a_service"],
    });
    expect(Object.keys(narrowed)).toEqual([]);
  });
});

describe("TradingAgent execution path (#291)", () => {
  it("stock screening executes against a fake provider — no broker named", async () => {
    const result: any = await executeTradingService(env, fakeConfig as any, { userLogin: "alice",
      serviceId: "stock_screening",
      input: { provider: "fake291", filter: { minPrice: 10 } },
    });
    expect(result.matchedCount).toBe(1);
    expect(result.filterApplied).toEqual({ minPrice: 10 });
  });

  it("the default provider is used when none is named", async () => {
    const result: any = await executeTradingService(env, fakeConfig as any, { userLogin: "alice",
      serviceId: "stock_screening",
      input: {},
    });
    expect(result.filterSummary).toBe("fake screen");
  });

  it("a provider that is not enabled is refused before resolution", async () => {
    await expect(
      executeTradingService(env, TRADING_AGENT_CONFIG_BASELINE, { userLogin: "alice",
        serviceId: "stock_screening",
        input: { provider: "fake291" },
      }),
    ).rejects.toThrow(/not enabled/);
  });

  it("an enabled but unregistered provider fails honestly", () => {
    expect(() => resolveTradingPlatform(env, fakeConfig as any, "ghost291", "alice")).toThrow(
      /no platform is registered/,
    );
  });

  it("a provider without screening support fails honestly", async () => {
    await expect(
      executeTradingService(env, fakeConfig as any, { userLogin: "alice",
        serviceId: "stock_screening",
        input: { provider: "noscreen291" },
      }),
    ).rejects.toThrow(/does not support stock screening/);
  });

  it("a disabled service is refused on the execution path", async () => {
    await expect(
      executeTradingService(
        env,
        { ...fakeConfig, enabledServices: ["options_screening"] } as any,
        { userLogin: "alice", serviceId: "stock_screening", input: {} },
      ),
    ).rejects.toThrow(/disabled by configuration/);
  });
});

describe("TradingAgent A2A door (#291)", () => {
  it("extracts the operation from the JSON-RPC data-part envelope", () => {
    const extracted = extractA2AOperation({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          parts: [
            { kind: "data", data: { operation: "trading.screen_stocks", provider: "fake291" } },
          ],
        },
      },
    });
    expect(extracted).toEqual({
      operation: "trading.screen_stocks",
      args: { provider: "fake291" },
    });
  });

  it("dispatches a structured operation to the service", async () => {
    const result = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.screen_stocks",
      provider: "fake291",
    }, "alice");
    expect(result.ok).toBe(true);
    expect(result.service).toBe("stock_screening");
    expect((result.result as any).matchedCount).toBe(1);
  });

  it("unknown operations and missing operations return errors, never throw", async () => {
    const unknown = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.nope",
    }, "alice");
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown operation/);
    const empty = await dispatchTradingA2A(env, fakeConfig as any, { hello: 1 }, "alice");
    expect(empty.ok).toBe(false);
  });

  it("the registry registers the screening services + stock trading (T1/T2/T3)", () => {
    expect(TRADING_SERVICE_REGISTRY.map((s) => s.id)).toEqual([
      "stock_screening",
      "options_screening",
      "stock_trading",
      "options_trading",
    ]);
  });

  it("every registered service declares a cfpay access class", () => {
    for (const service of TRADING_SERVICE_REGISTRY) {
      expect(["read", "write", "action"]).toContain(service.access);
    }
    expect(TRADING_SERVICE_REGISTRY[0].access).toBe("read");
  });
});

describe("TradingAgent A2A outcome + instance unification (#291 A1/A2)", () => {
  it("outcomes always carry a text part next to the data part", async () => {
    const { tradingA2AOutcome, a2aReplyFromOutcome } = await import(
      "../src/agents/trading-agent"
    );
    const ok = tradingA2AOutcome({
      ok: true,
      operation: "trading.screen_stocks",
      service: "stock_screening",
      result: { matchedCount: 2 },
    });
    expect(ok.text).toMatch(/trading\.screen_stocks completed/);
    const reply = a2aReplyFromOutcome(ok);
    expect(reply.text).toBe(ok.text);
    expect((reply.data as any).result.matchedCount).toBe(2);
    const bad = tradingA2AOutcome({
      ok: false,
      operation: "trading.screen_stocks",
      error: "boom",
    });
    expect(bad.text).toMatch(/failed: boom/);
    expect(a2aReplyFromOutcome(null).text).toBe("");
    expect(a2aReplyFromOutcome({}).text).toBe("");
  });

  it("one instance name per user across every door", async () => {
    const { tradingAgentName } = await import("../src/agents/trading-agent");
    // The A2A dispatcher resolves idFromName("trading") from the URL —
    // the SERVICE identity's instance must be exactly that name (issue
    // #1185: the bare name keys off the configured service login, and
    // only that login).
    expect(tradingAgentName("svc-trader", "svc-trader")).toBe("trading");
    expect(tradingAgentName("alice", "svc-trader")).toBe("trading:alice");
    expect(tradingAgentName("svc-trader")).toBe("trading:svc-trader");
  });

  it("the edge dispatcher parses the body, calls handleA2A(body, origin), and shapes text+data parts", async () => {    const { handleA2A } = await import("../src/a2a/index");
    const seen: unknown[] = [];
    const fakeEnv = {
      A2A_API_TOKEN: "test-token",
      TRADING_AGENT: {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          handleA2A: async (body: unknown, origin: string) => {
            seen.push([id.name, body, origin]);
            return {
              text: "trading.screen_stocks completed (stock_screening).",
              data: { ok: true, operation: "trading.screen_stocks", result: { matchedCount: 1 } },
            };
          },
        }),
      },
    };
    const request = new Request("https://agent.example/a2a/trading", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "message/send",
        params: {
          message: {
            parts: [{ kind: "data", data: { operation: "trading.screen_stocks" } }],
          },
        },
      }),
    });
    const response = await handleA2A(request, fakeEnv);
    expect(response.status).toBe(200);
    const wire: any = await response.json();
    expect(wire.id).toBe("req-1");
    const parts = wire.result.artifacts[0].parts;
    expect(parts[0]).toEqual({
      kind: "text",
      text: "trading.screen_stocks completed (stock_screening).",
    });
    expect(parts[1].kind).toBe("data");
    expect(parts[1].data.ok).toBe(true);
    // The stub received the parsed body + origin, not the raw Request.
    expect(seen[0][0]).toBe("trading");
    expect((seen[0][1] as any).method).toBe("message/send");
    expect(seen[0][2]).toBe("https://agent.example");
  });
});

describe("TradingAgent stable error tokens + dispatch logging (#291 A3/A6)", () => {
  it("each classified failure carries its stable token on the A2A surface", async () => {
    const missing = await dispatchTradingA2A(env, fakeConfig as any, { hello: 1 }, "alice");
    expect(missing.code).toBe("missing_operation");
    const unknown = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.nope",
    }, "alice");
    expect(unknown.code).toBe("unknown_operation");
    const notEnabled = await dispatchTradingA2A(env, TRADING_AGENT_CONFIG_BASELINE, {
      operation: "trading.screen_stocks",
      provider: "fake291",
    }, "alice");
    expect(notEnabled.code).toBe("provider_not_enabled");
    const unsupported = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.screen_stocks",
      provider: "noscreen291",
    }, "alice");
    expect(unsupported.code).toBe("provider_unsupported");
    const disabled = await dispatchTradingA2A(
      env,
      { ...fakeConfig, enabledServices: ["options_screening"] } as any,
      { operation: "trading.screen_stocks", provider: "fake291" },
    "alice");
    expect(disabled.code).toBe("service_disabled");
    const invalid = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.screen_stocks",
      provider: "fake291",
      filter: { minPrice: "not-a-number" },
    }, "alice");
    expect(invalid.code).toBe("invalid_input");
    // Every dispatch result carries the correlation id.
    for (const r of [missing, unknown, notEnabled, unsupported, disabled, invalid]) {
      expect(typeof r.correlationId).toBe("string");
      expect(r.correlationId!.length).toBeGreaterThan(0);
    }
  });

  it("the execution path throws typed errors with the same tokens", async () => {
    const { TradingServiceError } = await import("../src/agents/trading-agent");
    const err: any = await executeTradingService(env, fakeConfig as any, { userLogin: "alice",
      serviceId: "nope",
      input: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TradingServiceError);
    expect(err.code).toBe("unknown_service");
  });

  it("unclassified failures ship internal_error and never leak exception text", async () => {
    const { TRADING_SERVICE_REGISTRY } = await import("../src/agents/trading-agent");
    TRADING_SERVICE_REGISTRY.push({
      id: "exploding",
      toolName: "explode",
      a2aOperation: "trading.explode",
      access: "read",
      description: "test double",
      inputSchema: (await import("zod")).z.object({}).passthrough(),
      execute: async () => {
        throw new Error("secret internals: db password hunter2");
      },
    } as any);
    try {
      const result = await dispatchTradingA2A(
        env,
        { ...fakeConfig, enabledServices: [...fakeConfig.enabledServices, "exploding"] } as any,
        { operation: "trading.explode" },
      "alice");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("internal_error");
      expect(result.error).not.toMatch(/hunter2|secret internals/);
    } finally {
      TRADING_SERVICE_REGISTRY.pop();
    }
  });

  it("executions emit one structured dispatch log line", async () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await executeTradingService(env, fakeConfig as any, { userLogin: "alice",
        serviceId: "stock_screening",
        input: { provider: "fake291" },
        door: "rpc",
        traceId: "trace-test-1",
      });
    } finally {
      console.info = original;
    }
    // Issue #3515 S3: the dispatch log goes through the S2 structured
    // logger — one bare JSON event line via console.info, no
    // "[TradingAgent] " prefix. Parse the JSON lines and assert on
    // the event's fields.
    const entry = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find((e) => e.type === "tradingAgent.dispatch" && e.fields?.correlationId === "trace-test-1");
    expect(entry).toBeDefined();
    expect(entry.fields.ok).toBe(true);
    expect(entry.fields.service).toBe("stock_screening");
    expect(entry.fields.access).toBe("read");
  });
});

describe("A2A edge auth (#291 A5)", () => {
  function makeRequest(token?: string): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    return new Request("https://agent.example/a2a/trading", {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "trading.screen_stocks" }),
    });
  }
  const stubEnv = (extra: Record<string, unknown>) => ({
    ...extra,
    TRADING_AGENT: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        handleA2A: async () => ({ text: "ok", data: { ok: true } }),
      }),
    },
  });

  it("fails closed with 503 when no A2A token is configured", async () => {
    const { handleA2A } = await import("../src/a2a/index");
    const res = await handleA2A(makeRequest("anything"), stubEnv({}));
    expect(res.status).toBe(503);
  });

  it("rejects missing and wrong tokens with 401 before agent resolution", async () => {
    const { handleA2A } = await import("../src/a2a/index");
    const env = stubEnv({ A2A_API_TOKEN: "s3cret" });
    expect((await handleA2A(makeRequest(undefined), env)).status).toBe(401);
    expect((await handleA2A(makeRequest("wr0ng"), env)).status).toBe(401);
    // Even for an unknown agent — auth precedes routing disclosure.
    const unknownAgent = new Request("https://agent.example/a2a/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await handleA2A(unknownAgent, env)).status).toBe(401);
  });

  it("dispatches with the correct token; discovery stays public", async () => {
    const { handleA2A } = await import("../src/a2a/index");
    const env = stubEnv({ A2A_API_TOKEN: "s3cret" });
    const res = await handleA2A(makeRequest("s3cret"), env);
    expect(res.status).toBe(200);
    const cardRes = await handleA2A(
      new Request("https://agent.example/a2a/trading/agent-card.json"),
      stubEnv({}),
    );
    expect(cardRes.status).toBe(200);
    const card: any = await cardRes.json();
    expect(card.name).toBe("trading");
  });
});

describe("TradingAgent options screening service (#291 T2)", () => {
  it("is registered read-only and generated onto the tool surface", () => {
    const svc = TRADING_SERVICE_REGISTRY.find((s) => s.id === "options_screening");
    expect(svc).toBeDefined();
    expect(svc!.toolName).toBe("screen_options");
    expect(svc!.a2aOperation).toBe("trading.screen_options");
    expect(svc!.access).toBe("read");
    const tools = buildTradingTools(env, TRADING_AGENT_CONFIG_BASELINE);
    expect(Object.keys(tools)).toContain("screen_options");
  });

  it("gates non-E*TRADE providers with provider_unsupported (pipeline is E*TRADE-backed today)", async () => {
    const result = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.screen_options",
      provider: "fake291",
      symbols: ["AAPL"],
    }, "alice");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("provider_unsupported");
  });

  it("honors the enable/disable config like every service", async () => {
    const result = await dispatchTradingA2A(
      env,
      { ...fakeConfig, enabledServices: ["stock_screening"] } as any,
      { operation: "trading.screen_options", provider: "fake291" },
    "alice");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("service_disabled");
  });

  it("reaches the unified pipeline for the etrade provider (no gate error)", async () => {
    TradingPlatformRegistry.register(
      "etrade",
      () => ({ platformId: "etrade" }) as any,
    );
    try {
      const result = await dispatchTradingA2A(
        env,
        { enabledProviders: ["etrade"], defaultProvider: "etrade", enabledServices: ["options_screening"] } as any,
        { operation: "trading.screen_options", symbols: ["AAPL"], limit: 5 },
      "alice");
      // The gate passed: the failure mode must NOT be the provider gate.
      // (With an empty test env the pipeline itself answers or fails
      // downstream — either way the service was actually invoked.)
      expect(result.code).not.toBe("provider_unsupported");
      expect(result.code).not.toBe("provider_not_enabled");
      expect(result.code).not.toBe("provider_not_registered");
      expect(result.service).toBe("options_screening");
    } finally {
      const { ETradeTradingPlatform } = await import("../src/trading/etrade/platform");
      TradingPlatformRegistry.register(
        "etrade",
        (e: any, orm: any, userLogin: any) => new ETradeTradingPlatform(e, orm, userLogin),
      );
    }
  });
});

describe("TradingAgent stock trading + approval door (#291 T3)", () => {
  const orderCalls: { previews: any[]; executions: any[] } = { previews: [], executions: [] };
  TradingPlatformRegistry.register("faketrade291" as any, () => ({
    platformId: "faketrade291",
    name: "Fake Trade 291",
    getStatus: async () => ({}),
    getQuote: async () => ({}),
    getAccounts: async () => [],
    getPositions: async () => ({ account: {}, positions: [] }),
    previewOrder: async (params: any) => {
      orderCalls.previews.push(params);
      return { id: "draft-291", ...params, estimatedCost: 100 };
    },
    executeOrder: async (orderId: string, authorizerDid: string, decision: string) => {
      orderCalls.executions.push({ orderId, authorizerDid, decision });
      return { orderId, status: decision === "approved" ? "placed" : "cancelled", authorizerDid };
    },
  }) as any);
  const tradeConfig = {
    enabledProviders: ["faketrade291"],
    defaultProvider: "faketrade291",
    enabledServices: ["stock_trading"],
  };

  it("the service is action-class and previews only — it never places", async () => {
    orderCalls.previews.length = 0;
    orderCalls.executions.length = 0;
    const svc = TRADING_SERVICE_REGISTRY.find((s) => s.id === "stock_trading");
    expect(svc!.access).toBe("action");
    const result: any = await dispatchTradingA2A(env, tradeConfig as any, {
      operation: "trading.trade_stock",
      provider: "faketrade291",
      symbol: "aapl",
      action: "BUY",
      quantity: 3,
      orderType: "LIMIT",
      limitPrice: 150,
    }, "alice");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("pending_approval");
    expect(result.result.proposal.id).toBe("draft-291");
    expect(orderCalls.previews).toHaveLength(1);
    expect(orderCalls.previews[0].assetClass).toBe("equity");
    // The critical safety property: no execution happened on any surface.
    expect(orderCalls.executions).toHaveLength(0);
  });

  it("the approval door executes with an explicit authorizer, and refuses without one", async () => {
    const { TradingAgent } = await import("../src/agents/trading-agent");
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = env;
    agent.config = () => tradeConfig;
    // Issue #2178 (Q7 S2): the door audits through the agent ORM —
    // main's #2375 ctx below supplies the real one (MockSqlStorage).
    // #2375: the door settle threads the instance ORM (the draft
    // store), so the prototype agent needs a ctx like a real
    // instance's. The fake platform ignores the ORM it is handed.
    agent.ctx = {
      id: { toString: () => "trading:test" },
      storage: { sql: new MockSqlStorage() },
    };
    orderCalls.executions.length = 0;

    const placed: any = await agent.executeApprovedOrder({
      provider: "faketrade291",
      orderId: "draft-291",
      authorizerDid: "did:web:venus",
      decision: "approved",
    });
    expect(placed.status).toBe("placed");
    expect(orderCalls.executions).toEqual([
      { orderId: "draft-291", authorizerDid: "did:web:venus", decision: "approved" },
    ]);

    const anon: any = await agent
      .executeApprovedOrder({ provider: "faketrade291", orderId: "draft-291", decision: "approved" })
      .catch((e: any) => e);
    expect(anon.code).toBe("invalid_input");
    expect(orderCalls.executions).toHaveLength(1);

    const rejected: any = await agent.executeApprovedOrder({
      provider: "faketrade291",
      orderId: "draft-291",
      authorizerDid: "did:web:venus",
      decision: "rejected",
    });
    expect(rejected.status).toBe("cancelled");
  });

  it("the approval door is not a registry service (no tool/A2A surface reaches it)", () => {
    const surfaces = TRADING_SERVICE_REGISTRY.map((s) => s.id);
    expect(surfaces).not.toContain("execute_approved_order");
    expect(
      TRADING_SERVICE_REGISTRY.every((s) => s.a2aOperation !== "trading.execute_approved_order"),
    ).toBe(true);
  });
});

describe("TradingAgent options trading service (#291 T4)", () => {
  const orderCalls: { previews: any[]; executions: any[] } = { previews: [], executions: [] };
  TradingPlatformRegistry.register("fakeopt291" as any, () => ({
    platformId: "fakeopt291",
    name: "Fake Options 291",
    getStatus: async () => ({}),
    getQuote: async () => ({}),
    getAccounts: async () => [],
    getPositions: async () => ({ account: {}, positions: [] }),
    previewOrder: async (params: any) => {
      orderCalls.previews.push(params);
      return { id: "opt-draft-291", ...params, estimatedCost: 250 };
    },
    executeOrder: async (orderId: string, authorizerDid: string, decision: string) => {
      orderCalls.executions.push({ orderId, authorizerDid, decision });
      return { orderId, status: decision === "approved" ? "placed" : "cancelled", authorizerDid };
    },
  }) as any);
  const optConfig = {
    enabledProviders: ["fakeopt291"],
    defaultProvider: "fakeopt291",
    enabledServices: ["options_trading"],
  };
  const spread = {
    operation: "trading.trade_options",
    provider: "fakeopt291",
    symbol: "AAPL",
    action: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    strategyNetDebit: 2.5,
    optionLegs: [
      { underlyingSymbol: "AAPL", securityType: "OPTN", side: "BUY", quantity: 1, optionType: "CALL", strike: 150, expirationDate: "2027-01-15" },
      { underlyingSymbol: "AAPL", securityType: "OPTN", side: "SELL", quantity: 1, optionType: "CALL", strike: 160, expirationDate: "2027-01-15" },
    ],
  };

  it("is action-class, previews the spread, and never places", async () => {
    orderCalls.previews.length = 0;
    orderCalls.executions.length = 0;
    const svc = TRADING_SERVICE_REGISTRY.find((s) => s.id === "options_trading");
    expect(svc!.access).toBe("action");
    expect(svc!.toolName).toBe("trade_options");
    const result: any = await dispatchTradingA2A(env, optConfig as any, spread, "alice");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("pending_approval");
    expect(result.result.proposal.id).toBe("opt-draft-291");
    expect(orderCalls.previews).toHaveLength(1);
    expect(orderCalls.previews[0].assetClass).toBe("options");
    expect(orderCalls.previews[0].optionLegs).toHaveLength(2);
    expect(orderCalls.previews[0].strategyNetDebit).toBe(2.5);
    expect(orderCalls.executions).toHaveLength(0);
  });

  it("rejects a leg-less options order as invalid_input at the schema layer", async () => {
    const { optionLegs: _drop, ...legless } = spread;
    const result = await dispatchTradingA2A(env, optConfig as any, legless, "alice");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
  });

  it("the shared approval door places the options draft by id", async () => {
    const { TradingAgent } = await import("../src/agents/trading-agent");
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = env;
    agent.config = () => optConfig;
    // #2375: see the stock approval-door test — the settle threads
    // the instance ORM now.
    agent.ctx = {
      id: { toString: () => "trading:test" },
      storage: { sql: new MockSqlStorage() },
    };
    const placed: any = await agent.executeApprovedOrder({
      provider: "fakeopt291",
      orderId: "opt-draft-291",
      authorizerDid: "did:web:venus",
      decision: "approved",
    });
    expect(placed.status).toBe("placed");
    expect(orderCalls.executions.at(-1)).toEqual({
      orderId: "opt-draft-291",
      authorizerDid: "did:web:venus",
      decision: "approved",
    });
  });
});

describe("TradingAgent read surface (#291 T5a)", () => {
  const factoryLogins: string[] = [];
  TradingPlatformRegistry.register("fakeread291" as any, (_env: any, _orm: any, userLogin?: string) => {
    factoryLogins.push(userLogin ?? "");
    return {
      platformId: "fakeread291",
      name: "Fake Read 291",
      getStatus: async () => ({ connected: true, marker: "status" }),
      getQuote: async (symbol: string) => ({ symbol, lastPrice: 42 }),
      getAccounts: async () => [{ accountIdKey: "acc-1" }],
      getPositions: async (accountKey?: string) => ({ account: { accountIdKey: accountKey ?? "acc-1" }, positions: [{ symbol: "AAPL" }] }),
      getOptionChains: async (params: any) => ({ symbol: params.symbol, underlyingPrice: 150, marker: "chain" }),
      getOptionExpireDates: async (symbol: string) => [{ year: 2027, month: 1, day: 15, symbol }],
      getQuoteDetailed: async (symbol: string) => ({ quote: { symbol, lastPrice: 150 }, error: null }),
      previewOrder: async () => ({}),
      executeOrder: async () => ({}),
    };
  }) as any;
  const readConfig = {
    enabledProviders: ["fakeread291"],
    defaultProvider: "fakeread291",
    enabledServices: ["stock_screening"],
  };

  async function agentNamed(name: string): Promise<any> {
    const { TradingAgent } = await import("../src/agents/trading-agent");
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = env;
    agent.name = name;
    agent.config = () => readConfig;
    return agent;
  }

  it("serves the four platform reads through the registry", async () => {
    const agent = await agentNamed("trading");
    expect(await agent.getStatus()).toEqual({ connected: true, marker: "status" });
    expect(await agent.getQuote("aapl")).toEqual({ symbol: "aapl", lastPrice: 42 });
    expect(await agent.getAccounts()).toEqual([{ accountIdKey: "acc-1" }]);
    const positions: any = await agent.getPositions("acc-9");
    expect(positions.account.accountIdKey).toBe("acc-9");
    expect(positions.positions).toEqual([{ symbol: "AAPL" }]);
  });

  it("derives the platform user from the instance name", async () => {
    factoryLogins.length = 0;
    const alice = await agentNamed("trading:alice");
    await alice.getStatus();
    const root = await agentNamed("trading");
    await root.getStatus();
    // Issue #1185: the bare instance's platform user is the configured
    // service identity (SERVICE_USER_LOGIN in the shared test env).
    expect(factoryLogins).toEqual(["alice", "svc-trader"]);
  });

  it("tradingAgentUserLogin inverts tradingAgentName", async () => {
    const { tradingAgentUserLogin, tradingAgentName } = await import("../src/agents/trading-agent");
    expect(tradingAgentUserLogin(tradingAgentName("svc-trader", "svc-trader"), "svc-trader")).toBe("svc-trader");
    expect(tradingAgentUserLogin(tradingAgentName("bob", "svc-trader"), "svc-trader")).toBe("bob");
    expect(tradingAgentUserLogin("trading", "svc-trader")).toBe("svc-trader");
    // No service identity configured: the bare name encodes no login.
    expect(tradingAgentUserLogin("trading")).toBeNull();
  });

  it("options data reads pass through, and platforms without them get provider_unsupported (#291 T5b)", async () => {
    const agent = await agentNamed("trading");
    expect(await agent.getOptionChains({ symbol: "AAPL", chainType: "CALLPUT" })).toEqual({
      symbol: "AAPL",
      underlyingPrice: 150,
      marker: "chain",
    });
    expect(await agent.getOptionExpireDates("AAPL")).toEqual([
      { year: 2027, month: 1, day: 15, symbol: "AAPL" },
    ]);
    // fake291 (the screening fake) has no options data plane.
    const { TradingAgent } = await import("../src/agents/trading-agent");
    const plain: any = Object.create(TradingAgent.prototype);
    plain.env = env;
    plain.name = "trading";
    plain.config = () => fakeConfig;
    const err: any = await plain.getOptionChains({ symbol: "AAPL" }).catch((e: any) => e);
    expect(err.code).toBe("provider_unsupported");
  });

  it("detailed quote reads carry the error with the result (#291 Q1)", async () => {
    const agent = await agentNamed("trading");
    expect(await agent.getQuoteDetailed("AAPL")).toEqual({
      quote: { symbol: "AAPL", lastPrice: 150 },
      error: null,
    });
    const { TradingAgent } = await import("../src/agents/trading-agent");
    const plain: any = Object.create(TradingAgent.prototype);
    plain.env = env;
    plain.name = "trading";
    plain.config = () => fakeConfig;
    const err: any = await plain.getQuoteDetailed("AAPL").catch((e: any) => e);
    expect(err.code).toBe("provider_unsupported");
  });
});

describe("TradingAgent Think turn path (#1954)", () => {
  // Object.create instances: no constructor runs, so no Think
  // lifecycle exists here. What IS under test: the class's own
  // port hooks and its turn delegation seam. The real Think turn
  // (lifecycle boot, one-shot override, hook order, model call)
  // cannot run under node vitest (tracker #1951 spike verdict) and
  // is foundation-owned — covered by the workerd proof and the
  // think-port-mapping tests, not re-proven here.
  async function hookAgent(): Promise<any> {
    const { TradingAgent } = await import("../src/agents/trading-agent");
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = env;
    agent.config = () => ({ enabledProviders: [], defaultProvider: "none", enabledServices: [] });
    agent.getModel = () => "mock-model";
    agent.getSystemPrompt = () => "mock system prompt";
    agent.getTools = () => ({ mock_tool: { description: "mock" } });
    return agent;
  }

  // No prototype-base test here: the real base is pinned by source
  // in tests/agent-conformance.test.ts (PortThink #1954).

  it("beforeTurn supplies the class's own system prompt, tools, and model", async () => {
    const agent = await hookAgent();
    // Hooks live in the portHooks object, never as class methods
    // (PortThink owns those names with Think's signatures — #1954).
    const hooks = agent.tradingTurnHooks();
    const config: any = await hooks.beforeTurn({
      system: "",
      messages: [],
      tools: {},
      model: null,
      continuation: false,
    });
    expect(config.instructions).toBe("mock system prompt");
    expect(config.model).toBe("mock-model");
    expect(config.tools).toEqual({ mock_tool: { description: "mock" } });
  });

  it("onChatResponse resolves with no side effect, and onChatError is a synchronous string", async () => {
    const agent = await hookAgent();
    const hooks = agent.tradingTurnHooks();
    await expect(hooks.onChatResponse({ status: "completed", requestId: "r1" })).resolves.toBeUndefined();
    const fromError = hooks.onChatError(new Error("boom"));
    expect(typeof fromError).toBe("string");
    expect(fromError).toBe("boom");
    expect(fromError instanceof Promise).toBe(false);
    expect(hooks.onChatError("raw failure")).toBe("raw failure");
  });

  it("getThinkActorPort wires portHooks and memoizes the port", async () => {
    const agent = await hookAgent();
    agent.ctx = {
      storage: {
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
        sql: { exec: () => [] },
      },
    };
    expect(agent.portHooks).toBeUndefined();
    const first = agent.getThinkActorPort();
    expect(agent.portHooks).toBeDefined();
    expect(agent.getThinkActorPort()).toBe(first);
    // The wired hooks delegate to the class's own methods.
    const config: any = await agent.portHooks.beforeTurn({
      system: "",
      messages: [],
      tools: {},
      model: null,
      continuation: false,
    });
    expect(config.instructions).toBe("mock system prompt");
    expect(typeof agent.portHooks.onChatError(new Error("x"))).toBe("string");
    await expect(agent.portHooks.onChatResponse({ status: "completed" })).resolves.toBeUndefined();
  });

  it("runThinkTurn delegates the input unchanged to the port turn and returns its result", async () => {
    const agent = await hookAgent();
    agent.ctx = {
      storage: {
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
        sql: { exec: () => [] },
      },
    };
    const port: any = agent.getThinkActorPort();
    const runTurn = vi.spyOn(port.turn, "runTurn").mockResolvedValue({ status: "completed", requestId: "r1" });
    const stringResult: any = await agent.runThinkTurn("hello");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith("hello");
    expect(stringResult.status).toBe("completed");
    // A configOverride input passes through untouched: the class
    // never reshapes turns — the adapter owns the skipped path.
    runTurn.mockClear();
    const overrideResult: any = await agent.runThinkTurn({ configOverride: { instructions: "x" } });
    expect(runTurn).toHaveBeenCalledWith({ configOverride: { instructions: "x" } });
    expect(overrideResult.status).toBe("completed");
  });
});
