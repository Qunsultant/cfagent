/**
 * Issue #3374 → superseded by #3388 — discovery reads, from refusal to scope.
 *
 * #3374 refused discovery reads for a broker with no engine and pinned that
 * refusal. #3388 composed the engine on the selected broker's chains and flipped
 * the declaration for both brokers, so these pins now assert the opposite:
 * Alpaca reads its OWN runs, scoped by the resolved broker, and the panel no
 * longer refuses it.
 *
 * What these tests defend:
 *   1. Both brokers declare the capability.
 *   2. Both reads pass the resolved broker to the store (so a run cannot leak
 *      across brokers) and answer the stored runs rather than a refusal.
 *   3. The panel's refusal helper is null for both real brokers — it survives
 *      only as the guard for a future broker that declares the capability false.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));
const discoveryStore = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

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
import { brokerSupports } from "../src/trading/brokerCatalog";
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

describe("both brokers produce discovery runs (#3388)", () => {
  it("declares the capability for E*TRADE and Alpaca", () => {
    expect(brokerSupports("etrade", "optionsDiscovery")).toBe(true);
    expect(brokerSupports("alpaca", "optionsDiscovery")).toBe(true);
  });
});

describe("reads are scoped to the selected broker, not refused (#3388)", () => {
  it("an Alpaca list answers the store's runs, asking for alpaca only", async () => {
    discoveryStore.list.mockResolvedValue([{ id: "run-alpaca" }]);
    const { request, url } = listRequest();
    const res = await handleOptionsDiscoveryRunsList(request, url, "session", {} as never, ctx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      count: 1,
      runs: [{ id: "run-alpaca" }],
    });
    expect(discoveryStore.list).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      userLogin: "user@example.com",
      broker: "alpaca",
    });
  });

  it("an Alpaca by-id read is scoped too", async () => {
    discoveryStore.get.mockResolvedValue({ id: "run-1", status: "completed" });
    const { request, match } = byIdRequest();
    const res = await handleOptionsDiscoveryRunById(request, "session", {} as never, match, ctx());

    expect(res.status).toBe(200);
    expect(discoveryStore.get).toHaveBeenCalledWith("run-1", {
      userLogin: "user@example.com",
      broker: "alpaca",
    });
  });

  it("still answers a missing run as 404, not as another broker's", async () => {
    discoveryStore.get.mockResolvedValue(null);
    const { request, match } = byIdRequest("gone");
    const res = await handleOptionsDiscoveryRunById(request, "session", {} as never, match, ctx());
    expect(res.status).toBe(404);
  });
});

describe("the panel no longer refuses either real broker (#3388)", () => {
  it("allows Alpaca", () => {
    expect(discoveryRefusal("alpaca")).toBeNull();
  });

  it("allows E*TRADE", () => {
    expect(discoveryRefusal("etrade")).toBeNull();
  });

  it("still refuses an unknown broker by name", () => {
    const refusal = discoveryRefusal("interactive-brokers");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("interactive-brokers");
  });
});
