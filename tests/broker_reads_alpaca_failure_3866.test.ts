/**
 * Issue #3866 — one base URL, one failure vocabulary.
 *
 * Live symptom: the Alpaca portfolio panel failed four reads while
 * `/api/trading/alpaca/account` and a real bracket placement succeeded on the
 * same session. The platform client consumed `ALPACA_PAPER_URL` verbatim and
 * appended `/v2/…`, so a configured value carrying a trailing slash or a `/v2`
 * suffix called `…/v2/v2/account`; the status read meanwhile advertised a
 * hardcoded host, so nothing looked wrong.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveTenantBroker = vi.fn();
vi.mock("../src/services/tenantProviders", () => ({
  resolveTenantBroker: (...args: unknown[]) => resolveTenantBroker(...args),
}));

import { normalizeAlpacaBaseUrl, withAlpacaCredentials } from "../src/trading/alpaca/credentials";
import { resolveAlpacaTradingBase } from "../src/trading/alpaca/platform";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import { handleBrokerReadsRoutes } from "../src/agents/routes/brokerReads";
import type { Env } from "../src/types";

const PAPER = "https://paper-api.alpaca.markets";

describe("normalizeAlpacaBaseUrl (#3866)", () => {
  it("strips a trailing slash", () => {
    expect(normalizeAlpacaBaseUrl("https://paper-api.alpaca.markets/")).toBe(PAPER);
  });

  it("strips an API prefix the client appends itself", () => {
    expect(normalizeAlpacaBaseUrl("https://paper-api.alpaca.markets/v2")).toBe(PAPER);
    expect(normalizeAlpacaBaseUrl("https://paper-api.alpaca.markets/v2/")).toBe(PAPER);
    expect(normalizeAlpacaBaseUrl("  https://api.alpaca.markets/v2/  ")).toBe("https://api.alpaca.markets");
  });

  it("falls back to the paper host for absent or non-URL values", () => {
    expect(normalizeAlpacaBaseUrl(undefined)).toBe(PAPER);
    expect(normalizeAlpacaBaseUrl("")).toBe(PAPER);
    expect(normalizeAlpacaBaseUrl("paper-api.alpaca.markets")).toBe(PAPER);
    expect(normalizeAlpacaBaseUrl("not a url")).toBe(PAPER);
  });

  it("leaves a clean host untouched", () => {
    expect(normalizeAlpacaBaseUrl(PAPER)).toBe(PAPER);
  });
});

describe("the mapped deployment URL is normalized (#3866)", () => {
  it("maps ALPACA_PAPER_URL onto a single-segment base", () => {
    const mapped = withAlpacaCredentials({
      ALPACA_PAPER_API_KEY: "k",
      ALPACA_PAPER_SECRET_KEY: "s",
      ALPACA_PAPER_URL: "https://paper-api.alpaca.markets/v2/",
    } as unknown as Env);
    expect(mapped.ALPACA_BASE_URL).toBe(PAPER);
  });
});

describe("resolveAlpacaTradingBase reports what the client calls (#3866)", () => {
  it("keeps the configured paper host instead of a hardcoded one", () => {
    const resolved = resolveAlpacaTradingBase(
      { ALPACA_BASE_URL: "https://paper-api.alpaca.markets/v2" } as unknown as Env,
      "TEST",
    );
    expect(resolved).toEqual({ baseUrl: PAPER, isLive: false, source: "selection" });
  });

  it("never sends a live selection to a paper host", () => {
    const resolved = resolveAlpacaTradingBase(
      { ALPACA_BASE_URL: "https://paper-api.alpaca.markets" } as unknown as Env,
      "PROD",
    );
    expect(resolved).toEqual({ baseUrl: "https://api.alpaca.markets", isLive: true, source: "selection" });
  });
});

describe("the trading client builds one /v2 segment (#3866)", () => {
  it("does not double the API prefix", () => {
    const provider = new AlpacaMarketDataProvider({
      ALPACA_PAPER_API_KEY: "k",
      ALPACA_PAPER_SECRET_KEY: "s",
      ALPACA_BASE_URL: "https://paper-api.alpaca.markets/v2",
    } as unknown as Env);
    expect(provider.getTradingUrl()).toBe(PAPER);
  });
});

describe("order history classifies the real status (#3866)", () => {
  beforeEach(() => {
    resolveTenantBroker.mockReset();
    resolveTenantBroker.mockResolvedValue("alpaca");
  });

  const env = {
    ALPACA_PAPER_API_KEY: "k",
    ALPACA_PAPER_SECRET_KEY: "s",
    ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
  } as unknown as Env;

  // The route takes the path WITHOUT the query string; the query travels on the
  // URL. Passing both together made every history/activity assertion see `null`.
  const call = async (pathAndQuery: string) => {
    const [pathname, query = ""] = pathAndQuery.split("?");
    const href = `https://example.com/api${pathname}${query ? `?${query}` : ""}`;
    return (await handleBrokerReadsRoutes(
      new Request(href, { headers: { "x-user-login": "owner@openaimp.com" } }),
      new URL(href),
      `/api${pathname}`,
      "session",
      { env, getOrm: () => undefined, readSettingRaw: () => null },
    )) as Response | null;
  };

  it("a rejected accounts read is coded, named, and never a bare 500", async () => {
    vi.spyOn(AlpacaMarketDataProvider.prototype, "getAccount").mockResolvedValue({
      success: false,
      httpStatus: 404,
      message: "not found",
    });

    const response = await call("/broker/accounts");
    expect(response?.status).toBe(502);
    const body = await response!.json();
    expect(body.code).toBe("BROKER_ACCOUNTS_FAILED");
    expect(body.broker).toBe("alpaca");
    expect(body.message).toContain("could not read accounts");
    expect(body.message.endsWith("..")).toBe(false);
  });

  it("a failed orders read says rejected, not 'could not reach', and carries no doubled stop", async () => {
    vi.spyOn(AlpacaMarketDataProvider.prototype, "getOrders").mockResolvedValue({
      success: false,
      httpStatus: 403,
      message: "forbidden",
    });

    const response = await call("/broker/orders/history?status=all");
    expect(response?.status).toBe(502);
    const body = await response!.json();
    expect(body.code).toBe("BROKER_ORDER_HISTORY_FAILED");
    expect(body.message).toContain("rejected the broker credentials");
    expect(body.message).not.toContain("Could not reach Alpaca");
    expect(body.message.endsWith("..")).toBe(false);
  });

  it("a transport failure still says it could not reach Alpaca", async () => {
    vi.spyOn(AlpacaMarketDataProvider.prototype, "getOrders").mockResolvedValue({
      success: false,
      message: "Network error",
    });

    const response = await call("/broker/orders/history?status=all");
    const body = await response!.json();
    expect(body.message).toContain("Could not reach Alpaca");
  });
});
