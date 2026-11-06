/**
 * Issue #3429 — a channel desk must never route a non-E*TRADE tenant's order
 * to E*TRADE.
 *
 * What these tests defend:
 *   1. Every path that constructs an E*TRADE-shaped channel service refuses a
 *      tenant whose selected broker is not E*TRADE, with a coded body naming
 *      the selection. Nothing is previewed and no order is routed.
 *   2. The refusal happens before any service is built — the stub context has
 *      no ORM, so a handler that got past the gate would throw instead of
 *      answering with the code.
 *   3. An E*TRADE tenant is not refused: the gate returns null and the
 *      existing handler runs, so nothing changes for the broker the desks
 *      actually execute at.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ broker: "etrade" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return {
    ...actual,
    resolveTenantBroker: async () => state.broker,
  };
});

import {
  CHANNEL_BROKER_UNAVAILABLE,
  CHANNEL_DESK_PATHS,
  channelBrokerRefusal,
  handleTradingIntegrationsRoutes,
  isChannelDeskPath,
} from "../src/agents/routes/tradingIntegrations";

/** Deliberately too thin to run a channel service: a request past the gate throws. */
const STUB_CTX = {
  env: {},
  getOrm: () => {
    throw new Error("the gate did not run: no ORM is available in this stub");
  },
  audit: () => {},
  agentCtx: {},
  nlqSchedulingPort: () => ({}),
  getStorageSql: () => {
    throw new Error("the gate did not run: no storage is available in this stub");
  },
} as never;

function requestFor(path: string): Request {
  return new Request(`https://example.test${path}`, {
    method: path.endsWith("/voice/greeting") ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: path.endsWith("/voice/greeting") ? undefined : "{}",
  });
}

beforeEach(() => {
  state.broker = "etrade";
});

describe("channel desk broker gate (#3429)", () => {
  it("recognises exactly the paths that build an E*TRADE channel service", () => {
    for (const path of CHANNEL_DESK_PATHS) {
      expect(isChannelDeskPath(`/api/agents/session-1${path}`), path).toBe(true);
    }
    expect(isChannelDeskPath("/api/broker/order/execute")).toBe(false);
    expect(isChannelDeskPath("/trading/reports/email")).toBe(false);
  });

  it("names the selected broker in the coded refusal", () => {
    const response = channelBrokerRefusal("alpaca");
    expect(response.status).toBe(501);
    return response.json().then((body) => {
      expect(body.code).toBe(CHANNEL_BROKER_UNAVAILABLE);
      expect(body.broker).toBe("alpaca");
      expect(body.message).toContain("Alpaca");
      expect(body.message).toContain("/api/broker/order/execute");
      expect(body.retryable).toBe(false);
    });
  });

  it("refuses every channel path for an Alpaca tenant, before any service is built", async () => {
    state.broker = "alpaca";
    for (const path of CHANNEL_DESK_PATHS) {
      const response = await handleTradingIntegrationsRoutes(
        requestFor(path),
        new URL(`https://example.test${path}`),
        path,
        "session-1",
        STUB_CTX,
      );
      expect(response, path).not.toBeNull();
      expect(response!.status, path).toBe(501);
      const body = (await response!.json()) as Record<string, unknown>;
      expect(body.code, path).toBe(CHANNEL_BROKER_UNAVAILABLE);
      expect(body.message, path).toContain("Nothing was previewed");
    }
  });

  it("does not refuse an E*TRADE tenant", async () => {
    state.broker = "etrade";
    // Past the gate the stub is unusable, so a throw is the expected outcome:
    // what matters is that the response is not the refusal.
    let refused = false;
    try {
      const response = await handleTradingIntegrationsRoutes(
        requestFor("/trading/email/inbound"),
        new URL("https://example.test/trading/email/inbound"),
        "/trading/email/inbound",
        "session-1",
        STUB_CTX,
      );
      if (response && response.status === 501) {
        const body = (await response.json()) as Record<string, unknown>;
        refused = body.code === CHANNEL_BROKER_UNAVAILABLE;
      }
    } catch {
      refused = false;
    }
    expect(refused).toBe(false);
  });
});
