import { describe, it, expect, vi } from "vitest";
import { readTenantBrokerSelection } from "../src/services/providerConnections";
import { handleBrokerGateRoutes } from "../src/agents/routes/brokerGate";

/**
 * Issue #3460 slice 3 — gates fail-closed.
 *
 * 1. The broker gate: a store failure now returns a named 503 instead
 *    of failing open to E*TRADE. Unconfigured still passes through
 *    (the /etrade/ surface serves until the S7 menu makes selection
 *    explicit); a non-E*TRADE broker still gets the 409.
 * 2. The manual screen entry (`resolveEngineClient`) reads the broker
 *    through the same presence-aware seam — its refusal test lives in
 *    tests/fail_closed_fallbacks_3460.test.ts, updated in this slice.
 */

const adapter = { current: null as any };

vi.mock("../src/data/createCommercialPorts", () => ({
  createCommercialAdapter: () => adapter.current,
}));

function gateRequest(path: string): [Request, URL, string] {
  const url = new URL(`https://example.com${path}`);
  return [new Request(url.toString()), url, path];
}

describe("readTenantBrokerSelection — the presence-aware broker read", () => {
  it("reports store_unavailable when no commercial store is bound", async () => {
    const read = await readTenantBrokerSelection({}, null);
    expect(read.status).toBe("store_unavailable");
  });

  it("reports store_unavailable when the store read throws", async () => {
    const throwing = {
      getTenantBrokerSelection: async () => {
        throw new Error("D1 down");
      },
    };
    const read = await readTenantBrokerSelection({}, throwing as never);
    expect(read.status).toBe("store_unavailable");
  });

  it("reports unconfigured when the tenant has no stored selection", async () => {
    const empty = { getTenantBrokerSelection: async () => null };
    const read = await readTenantBrokerSelection({}, empty as never);
    expect(read.status).toBe("unconfigured");
  });

  it("reports unconfigured when the stored id is not a registered broker", async () => {
    const bogus = { getTenantBrokerSelection: async () => "bogus-broker" };
    const read = await readTenantBrokerSelection({}, bogus as never);
    expect(read.status).toBe("unconfigured");
  });

  it("returns the stored broker when one is configured", async () => {
    const stored = { getTenantBrokerSelection: async () => "alpaca" };
    const read = await readTenantBrokerSelection({}, stored as never);
    expect(read).toEqual({ status: "ok", brokerId: "alpaca" });
  });
});

describe("handleBrokerGateRoutes — store failure is a named 503", () => {
  it("returns 503 when no tenant store is bound", async () => {
    adapter.current = null;
    const [request, url, path] = gateRequest("/etrade/quotes");
    const response = await handleBrokerGateRoutes(request, url, path, "s1", {
      env: {} as never,
    });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    const body = await response!.json();
    expect(body.code).toBe("FAILURE_BROKER_STORE_UNAVAILABLE");
  });

  it("returns 503 when the store read throws", async () => {
    adapter.current = {
      getTenantBrokerSelection: async () => {
        throw new Error("D1 down");
      },
    };
    const [request, url, path] = gateRequest("/etrade/quotes");
    const response = await handleBrokerGateRoutes(request, url, path, "s1", {
      env: {} as never,
    });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    const body = await response!.json();
    expect(body.code).toBe("FAILURE_BROKER_STORE_UNAVAILABLE");
  });

  it("passes through when the tenant has no stored selection (S7 retires this default)", async () => {
    adapter.current = { getTenantBrokerSelection: async () => null };
    const [request, url, path] = gateRequest("/etrade/quotes");
    const response = await handleBrokerGateRoutes(request, url, path, "s1", {
      env: {} as never,
    });
    expect(response).toBeNull();
  });

  it("still returns 409 for a configured non-E*TRADE broker", async () => {
    adapter.current = { getTenantBrokerSelection: async () => "alpaca" };
    const [request, url, path] = gateRequest("/etrade/quotes");
    const response = await handleBrokerGateRoutes(request, url, path, "s1", {
      env: {} as never,
    });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(409);
    const body = await response!.json();
    expect(body.code).toBe("FAILURE_BROKER_UNAVAILABLE");
  });

  it("ignores non-gated paths", async () => {
    adapter.current = null;
    const [request, url, path] = gateRequest("/broker/options/screen");
    const response = await handleBrokerGateRoutes(request, url, path, "s1", {
      env: {} as never,
    });
    expect(response).toBeNull();
  });
});
