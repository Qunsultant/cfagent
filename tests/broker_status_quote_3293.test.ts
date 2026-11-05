/**
 * Issue #3293: `/broker/status` and `/broker/quote` are neutral too.
 *
 * Defect: the hub read status and quotes from `/api/etrade/*`, so an Alpaca
 * tenant saw E*TRADE status — the last two reads with no neutral equivalent.
 *
 * Pinned here:
 *   1. The selected broker answers both, and the response names it.
 *   2. A failure is coded and names the broker (`BROKER_STATUS_FAILED`,
 *      `BROKER_QUOTE_FAILED`) — never a zero quote or an E*TRADE status.
 *   3. A missing symbol is `400`; a broker without a quote read is `501`
 *      naming it, and no platform is constructed for that refusal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

import { handleBrokerReadsRoutes, type BrokerReadsRouteContext } from "../src/agents/routes/brokerReads";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";

function ctx(): BrokerReadsRouteContext {
  return {
    env: { APP_ENV: "TEST", FEATURE_BROKER_PANEL_CONTRACT: "1" } as any,
    getOrm: () => undefined,
    readSettingRaw: (key: string) => (key === "etrade:environment" ? "TEST" : null),
  };
}

function get(path: string) {
  const url = new URL(`https://example.test/api${path}`);
  return { request: new Request(url.toString(), { method: "GET" }), url };
}

const platform = {
  getStatus: vi.fn(async () => ({
    broker: "alpaca",
    configured: true,
    protocol: "alpaca_rest_v2",
    mode: "paper_api",
    environment: "paper",
  })),
  getQuote: vi.fn(async (symbol: string) => ({ symbol, lastPrice: 187.5 })),
  getAccounts: vi.fn(async () => []),
  getPositions: vi.fn(async () => ({ account: {}, positions: [] })),
};

let getPlatform: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tenant.broker = "alpaca";
  vi.clearAllMocks();
  getPlatform = vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(() => platform as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/broker/status (#3293)", () => {
  it("reports the selected broker's own vocabulary", async () => {
    const { request, url } = get("/broker/status");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.environment).toBe("TEST");
    expect(body.status.protocol).toBe("alpaca_rest_v2");
    expect(body.status.mode).toBe("paper_api");
    expect(getPlatform.mock.calls[0][0]).toBe("alpaca");
  });

  it("codes a failed status read and names the broker", async () => {
    getPlatform.mockImplementation(() => ({ getStatus: async () => { throw new Error("upstream down"); } }) as any);
    const { request, url } = get("/broker/status");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(502);
    const body = await res!.json();
    expect(body.code).toBe("BROKER_STATUS_FAILED");
    expect(body.message).toContain("alpaca");
    expect(body.message).toContain("upstream down");
  });
});

describe("/broker/quote (#3293)", () => {
  it("quotes through the selected broker", async () => {
    const { request, url } = get("/broker/quote?symbol=aapl");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.symbol).toBe("AAPL");
    expect(body.quote.lastPrice).toBe(187.5);
    expect(platform.getQuote).toHaveBeenCalledWith("AAPL");
  });

  it("requires a symbol", async () => {
    const { request, url } = get("/broker/quote");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(400);
    expect((await res!.json()).message).toContain("symbol");
  });

  it("refuses a broker without a quote read, before constructing it", async () => {
    const original = BROKER_CATALOG.alpaca.supports.quote;
    try {
      (BROKER_CATALOG.alpaca.supports as { quote: boolean }).quote = false;
      const { request, url } = get("/broker/quote?symbol=AAPL");
      const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
      expect(res!.status).toBe(501);
      expect(await res!.json()).toMatchObject({ code: "provider_unsupported", broker: "alpaca" });
      expect(getPlatform).not.toHaveBeenCalled();
    } finally {
      (BROKER_CATALOG.alpaca.supports as { quote: boolean }).quote = original;
    }
  });

  it("codes a failed quote and never returns a zero price", async () => {
    getPlatform.mockImplementation(() => ({ getQuote: async () => { throw new Error("no such symbol"); } }) as any);
    const { request, url } = get("/broker/quote?symbol=NOPE");
    const res = await handleBrokerReadsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(502);
    const body = await res!.json();
    expect(body.code).toBe("BROKER_QUOTE_FAILED");
    expect(body).not.toHaveProperty("quote");
    expect(body.message).toContain("alpaca");
  });
});
