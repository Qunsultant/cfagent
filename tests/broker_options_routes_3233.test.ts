/**
 * Issue #3233 (program #3216) slice 2: broker-neutral options reads.
 *
 * What these tests defend — the three ways an options surface can lie:
 *   1. It serves E*TRADE data while Alpaca is selected (silent fallback).
 *   2. It returns an empty list for a capability the broker does not have,
 *      so the user sees "no contracts" instead of "Alpaca cannot do this".
 *   3. It ignores the persisted trading environment and reports one the
 *      user never selected.
 *
 * The legacy `/etrade/options/*` module is untouched by this slice (its
 * route inventory is byte-pinned by #995), so these tests pin the additive
 * `/broker/options/*` surface only.
 *
 * Harness follows tests/broker_orders_3089.test.ts: the handler is called
 * directly with a fake route context. The tenant broker is mocked at its
 * single source (`resolveTenantBroker`), and the platform is a spy on the
 * registry so the test can assert *which* broker served the call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

import {
  handleBrokerOptionsRoutes,
  type BrokerOptionsRouteContext,
} from "../src/agents/routes/brokerOptions";
import { TradingPlatformRegistry } from "../src/trading/registry";

const BASE = "https://example.test/api";

function ctx(settings: Record<string, string> = {}): BrokerOptionsRouteContext {
  return {
    env: { APP_ENV: "TEST" } as any,
    getOrm: () => undefined,
    readSettingRaw: (key: string) => settings[key] ?? null,
  };
}

function req(path: string, method = "GET", body?: unknown): { request: Request; url: URL } {
  const url = new URL(`${BASE}${path}`);
  const request =
    body === undefined
      ? new Request(url.toString(), { method })
      : new Request(url.toString(), {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
  return { request, url };
}

/** A platform that answers both options reads, recording how it was called. */
function optionsPlatform(overrides: Record<string, unknown> = {}) {
  return {
    getOptionChains: vi.fn(async () => [{ symbol: "AAPL260116C00200000", strike: 200 }]),
    getOptionExpireDates: vi.fn(async () => ["2026-01-16", "2026-02-20"]),
    ...overrides,
  };
}

let platform: ReturnType<typeof optionsPlatform>;
let getPlatform: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tenant.broker = "alpaca";
  platform = optionsPlatform();
  getPlatform = vi
    .spyOn(TradingPlatformRegistry, "getPlatform")
    .mockImplementation(() => platform as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the neutral surface does not capture other routes (#3233)", () => {
  it("returns null for a path it does not own", async () => {
    const { request, url } = req("/etrade/options/chains?symbol=AAPL");
    expect(await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx())).toBeNull();
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("ignores methods it does not serve", async () => {
    const { request, url } = req("/broker/options/chains", "DELETE");
    expect(await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx())).toBeNull();
  });

  it("requires a symbol instead of defaulting to one", async () => {
    const { request, url } = req("/broker/options/chains");
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(400);
    expect((await res!.json()).code).toBe("invalid_request");
    expect(getPlatform).not.toHaveBeenCalled();
  });
});

describe("the selected broker serves the read (#3233)", () => {
  it("serves expiry dates from the selected broker, naming it", async () => {
    const { request, url } = req("/broker/options/expire-dates?symbol=aapl");
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({
      broker: "alpaca",
      environment: "TEST",
      symbol: "AAPL",
      dates: ["2026-01-16", "2026-02-20"],
    });
    expect(platform.getOptionExpireDates).toHaveBeenCalledWith("AAPL", undefined);
    // The registry was asked for the selected broker — never for E*TRADE.
    expect(getPlatform.mock.calls[0][0]).toBe("alpaca");
  });

  it("passes an expiry type through when given", async () => {
    const { request, url } = req("/broker/options/expire-dates?symbol=AAPL&expiryType=weekly");
    await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(platform.getOptionExpireDates).toHaveBeenCalledWith("AAPL", "weekly");
  });

  it("parses chain parameters as numbers and normalises the chain type", async () => {
    const { request, url } = req(
      "/broker/options/chains?symbol=AAPL&expiryYear=2026&expiryMonth=1&expiryDay=16&strikePrice=200&noOfStrikes=5&chainType=put",
    );
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(await res!.json()).toMatchObject({ broker: "alpaca", symbol: "AAPL" });
    expect(platform.getOptionChains).toHaveBeenCalledWith({
      symbol: "AAPL",
      expiryYear: 2026,
      expiryMonth: 1,
      expiryDay: 16,
      strikePrice: 200,
      noOfStrikes: 5,
      chainType: "PUT",
    });
  });

  it("prefers a POST body over the query string", async () => {
    const { request, url } = req("/broker/options/chains?symbol=MSFT&P", "POST", {
      symbol: "AAPL",
      chainType: "CALL",
    });
    await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(platform.getOptionChains).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "AAPL", chainType: "CALL" }),
    );
  });

  it("drops an unrecognised chain type rather than inventing one", async () => {
    const { request, url } = req("/broker/options/chains?symbol=AAPL&chainType=sideways");
    await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(platform.getOptionChains).toHaveBeenCalledWith(
      expect.objectContaining({ chainType: undefined }),
    );
  });

  it("reports the persisted trading environment, not a default", async () => {
    tenant.broker = "etrade";
    const { request, url } = req("/broker/options/expire-dates?symbol=AAPL");
    const res = await handleBrokerOptionsRoutes(
      request,
      url,
      url.pathname,
      "sid",
      ctx({ "etrade:environment": "PROD" }),
    );
    expect(await res!.json()).toMatchObject({ broker: "etrade", environment: "PROD" });
  });
});

describe("a broker that cannot answer says so (#3233)", () => {
  it("answers 501 provider_unsupported naming the broker when chains are missing", async () => {
    platform = optionsPlatform({ getOptionChains: undefined }) as any;
    const { request, url } = req("/broker/options/chains?symbol=AAPL");
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(501);
    const body = await res!.json();
    expect(body).toMatchObject({ code: "provider_unsupported", broker: "alpaca", retryable: false });
    expect(body.message).toContain("alpaca");
    expect(body.message).toContain("Option chains");
  });

  it("answers 501 provider_unsupported when expiry dates are missing", async () => {
    platform = optionsPlatform({ getOptionExpireDates: undefined }) as any;
    const { request, url } = req("/broker/options/expire-dates?symbol=AAPL");
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(501);
    expect(await res!.json()).toMatchObject({ code: "provider_unsupported", broker: "alpaca" });
  });

  it("never substitutes another broker's data for an unsupported read", async () => {
    platform = optionsPlatform({ getOptionChains: undefined }) as any;
    const { request, url } = req("/broker/options/chains?symbol=AAPL");
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    const body = await res!.json();
    expect(body).not.toHaveProperty("chain");
    expect(body.message).toContain("no other broker's data");
    expect(getPlatform.mock.calls.every((c) => c[0] === "alpaca")).toBe(true);
  });

  it("states explicit absence instead of an empty success", async () => {
    platform = optionsPlatform({ getOptionChains: vi.fn(async () => null) }) as any;
    const { request, url } = req("/broker/options/chains?symbol=AAPL");
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.chain).toBeNull();
    expect(body.message).toContain("no quotable contracts");
    expect(body.chain).not.toEqual([]);
  });
});
