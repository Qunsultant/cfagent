/**
 * Issue #3374 — options discovery history belongs to a broker, not just a user.
 *
 * What these tests defend:
 *   1. The catalogue declares `optionsDiscovery` per broker: E*TRADE true,
 *      Alpaca false. Discovery runs are produced by an engine wired to one
 *      broker's chains (`createDiscoveryService`), so another broker cannot
 *      claim the stream.
 *   2. Both discovery-run reads refuse a broker without the capability with a
 *      coded 501 naming the broker, BEFORE touching the store — never another
 *      broker's runs, never an empty list that reads as "you have none".
 *   3. E*TRADE is unchanged: same envelope, same user scoping, same store call.
 *   4. The panel refuses before its first request and says why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));
const discoveryStore = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

// The store is mocked so "was the store read?" is a direct question, not an
// inference from SQL side effects.
vi.mock("../src/data/createOptionsDiscoveryPorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/createOptionsDiscoveryPorts")>();
  return {
    ...actual,
    createOptionsDiscoveryPorts: () => ({ discoveryRuns: discoveryStore }),
  };
});

import {
  handleOptionsDiscoveryRunById,
  handleOptionsDiscoveryRunsList,
} from "../src/agents/routes/etradeOptionsRuns";
import { BROKER_CATALOG, brokerSupports } from "../src/trading/brokerCatalog";
import { discoveryRefusal } from "../src/client/options/DiscoveryRunsPanel";

const BASE = "https://example.test/api/etrade/options/discovery-runs";

function ctx() {
  return { env: {} as never };
}

function listRequest(userLogin = "user@example.com") {
  const url = new URL(`${BASE}?limit=25&offset=0`);
  return {
    request: new Request(url.toString(), { method: "GET", headers: { "x-user-login": userLogin } }),
    url,
  };
}

function byIdRequest(id = "run-1", userLogin = "user@example.com") {
  const url = new URL(`${BASE}/${id}`);
  return {
    request: new Request(url.toString(), { method: "GET", headers: { "x-user-login": userLogin } }),
    match: [`/etrade/options/discovery-runs/${id}`, id] as unknown as RegExpMatchArray,
  };
}

beforeEach(() => {
  tenant.broker = "alpaca";
  discoveryStore.list.mockReset();
  discoveryStore.get.mockReset();
});

describe("the discovery capability is declared (#3374)", () => {
  it("E*TRADE produces discovery runs; Alpaca does not", () => {
    expect(brokerSupports("etrade", "optionsDiscovery")).toBe(true);
    expect(brokerSupports("alpaca", "optionsDiscovery")).toBe(false);
  });

  it("states every operation for both brokers, so the declaration stays total", () => {
    expect(Object.keys(BROKER_CATALOG.alpaca.supports).sort()).toEqual(
      Object.keys(BROKER_CATALOG.etrade.supports).sort(),
    );
  });
});

describe("discovery-run reads refuse a broker that cannot produce them (#3374)", () => {
  it("the list answers a coded 501 naming the broker and never reads the store", async () => {
    const { request, url } = listRequest();
    const res = await handleOptionsDiscoveryRunsList(request, url, "session", {} as never, ctx());
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; broker: string; message: string; retryable: boolean };
    expect(body.code).toBe("provider_unsupported");
    expect(body.broker).toBe("alpaca");
    expect(body.message).toContain("alpaca");
    expect(body.retryable).toBe(false);
    expect(discoveryStore.list).not.toHaveBeenCalled();
  });

  it("the by-id read refuses the same way and never reads the store", async () => {
    const { request, match } = byIdRequest();
    const res = await handleOptionsDiscoveryRunById(request, "session", {} as never, match, ctx());
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; broker: string };
    expect(body.code).toBe("provider_unsupported");
    expect(body.broker).toBe("alpaca");
    expect(discoveryStore.get).not.toHaveBeenCalled();
  });
});

describe("E*TRADE behaviour is unchanged (#3374)", () => {
  it("the list answers the same envelope, scoped by the caller's login", async () => {
    tenant.broker = "etrade";
    discoveryStore.list.mockResolvedValue([{ id: "run-1" }]);
    const { request, url } = listRequest("etrade@example.com");
    const res = await handleOptionsDiscoveryRunsList(request, url, "session", {} as never, ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 1, runs: [{ id: "run-1" }] });
    expect(discoveryStore.list).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      userLogin: "etrade@example.com",
    });
  });

  it("the by-id read still serves the stored run", async () => {
    tenant.broker = "etrade";
    discoveryStore.get.mockResolvedValue({ id: "run-1", status: "completed" });
    const { request, match } = byIdRequest("run-1", "etrade@example.com");
    const res = await handleOptionsDiscoveryRunById(request, "session", {} as never, match, ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "run-1", status: "completed" });
    expect(discoveryStore.get).toHaveBeenCalledWith("run-1", { userLogin: "etrade@example.com" });
  });
});

describe("the panel names the gap instead of asking (#3374)", () => {
  it("refuses by name for Alpaca", () => {
    const refusal = discoveryRefusal("alpaca");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("alpaca");
    expect(refusal).toContain("no other broker's runs");
  });

  it("allows E*TRADE", () => {
    expect(discoveryRefusal("etrade")).toBeNull();
  });

  it("does not let the loader run when the broker cannot produce runs", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/client/options/DiscoveryRunsPanel.tsx", "utf8");
    const guardAt = source.indexOf("const refusal = discoveryRefusal()");
    const listCallAt = source.indexOf("await listDiscoveryRuns(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(listCallAt).toBeGreaterThan(guardAt);
    expect(source.slice(guardAt, listCallAt)).toContain("if (refusal) return;");
  });
});
