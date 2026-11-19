// @vitest-environment node
/**
 * Issue #5767 — neutral broker order preview.
 *
 * Pins:
 *  - 5767-P01 registered, mcp:trade, synchronous;
 *  - 5767-P02 invalid input is refused before any broker call;
 *  - 5767-P03 an unsupported broker / time-in-force is named, not guessed;
 *  - 5767-P04 options need legs and equity must not carry them;
 *  - 5767-P05 a valid preview calls the broker and says nothing was placed;
 *  - 5767-P06 an unconfigured broker returns its connect-flow code;
 *  - 5767-P07 the command audits.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  platform: { previewOrder: vi.fn() } as any,
  getPlatform: vi.fn(),
  tenantBroker: "alpaca" as string,
}));

vi.mock("../src/services/tenantProviders", () => ({
  resolveTenantBroker: async () => h.tenantBroker,
  resolveTenantBrokerSelection: async () => h.tenantBroker,
}));

vi.mock("../src/trading", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    TradingPlatformRegistry: { getPlatform: h.getPlatform },
  };
});

import { previewOrderViaSelectedBroker } from "../src/services/brokerOrderPreview";
import { BrokerOrderPreviewCommand } from "../src/mcps/openaimp/brokerOrderCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { SYNCHRONOUS_MCP_TOOLS } from "../src/config/asyncJobModes";

const base = {
  env: {} as never,
  userLogin: "alice",
  sessionId: "sess-1",
  symbol: "NVDA",
  orderAction: "BUY",
  quantity: 10,
  orderType: "LIMIT",
  limitPrice: 135,
};

beforeEach(() => {
  h.platform.previewOrder.mockReset();
  h.getPlatform.mockReset();
  h.getPlatform.mockReturnValue(h.platform);
  h.tenantBroker = "alpaca";
});

describe("5767-P01 the tool is available and synchronous", () => {
  it("is registered, gated as a trade, and never queued", () => {
    const tool = McpToolFactory.getTool("broker_order_preview");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("broker_order_preview");
    expect(MCP_TOOL_SCOPES.broker_order_preview).toBe("mcp:trade");
    expect(SYNCHRONOUS_MCP_TOOLS.has("broker_order_preview")).toBe(true);
    expect((tool!.jsonSchema as any).required).toEqual([
      "symbol",
      "orderAction",
      "quantity",
      "orderType",
    ]);
  });
});

describe("5767-P02 invalid input never reaches a broker", () => {
  it("refuses a missing login", async () => {
    const r = await previewOrderViaSelectedBroker({ ...base, userLogin: "" });
    expect(r.code).toBe("identity_required");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });

  it("refuses a missing symbol, a bad action, a bad type and a bad quantity", async () => {
    for (const [patch, code] of [
      [{ symbol: " " }, "invalid_symbol"],
      [{ orderAction: "HOLD" }, "invalid_order_action"],
      [{ orderType: "MARKET_IF_TOUCHED" }, "invalid_order_type"],
      [{ quantity: 0 }, "invalid_quantity"],
      [{ quantity: 1.5 }, "invalid_quantity"],
      [{ limitPrice: -3 }, "invalid_limitPrice"],
    ] as const) {
      const r = await previewOrderViaSelectedBroker({ ...base, ...(patch as object) } as never);
      expect(r.code, JSON.stringify(patch)).toBe(code);
    }
    expect(h.getPlatform).not.toHaveBeenCalled();
  });
});

describe("5767-P03 broker and time-in-force are validated, never guessed", () => {
  it("names an unsupported broker", async () => {
    const r = await previewOrderViaSelectedBroker({ ...base, broker: "notabroker" });
    expect(r.code).toBe("unsupported_broker");
    expect(r.message).toContain("Routed brokers");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });

  it("names an unsupported time-in-force", async () => {
    const r = await previewOrderViaSelectedBroker({ ...base, timeInForce: "FOREVER" });
    expect(r.code).toBe("invalid_time_in_force");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });
});

describe("5767-P04 asset class and legs must agree", () => {
  it("refuses options without legs", async () => {
    const r = await previewOrderViaSelectedBroker({ ...base, assetClass: "options" });
    expect(r.code).toBe("invalid_option_legs");
  });

  it("refuses equity carrying option legs", async () => {
    const r = await previewOrderViaSelectedBroker({
      ...base,
      assetClass: "equity",
      optionLegs: [{ securityType: "OPTN" }],
    });
    expect(r.code).toBe("invalid_option_legs");
  });
});

describe("5767-P05 a valid preview calls the broker and places nothing", () => {
  it("passes the described terms and returns the broker's draft", async () => {
    h.platform.previewOrder.mockResolvedValue({ orderId: "preview-1", estimatedTotal: 1350 });
    const r = await previewOrderViaSelectedBroker(base);
    expect(r.success).toBe(true);
    expect(r.broker).toBe("alpaca");
    expect(r.message).toContain("nothing was placed");
    expect(h.platform.previewOrder.mock.calls[0][0]).toMatchObject({
      symbol: "NVDA",
      orderAction: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 135,
      assetClass: "equity",
      sessionId: "sess-1",
    });
    expect(r.draft).toEqual({ orderId: "preview-1", estimatedTotal: 1350 });
  });
});

describe("5767-P06 an unconfigured broker returns its connect-flow code", () => {
  it("names the broker instead of a generic failure", async () => {
    h.platform.previewOrder.mockRejectedValue(new Error("Alpaca credentials are not configured"));
    const r = await previewOrderViaSelectedBroker(base);
    expect(r.success).toBe(false);
    expect(r.code).toBe("FAILURE_BROKER_UNAVAILABLE");
    expect(r.message).toContain("Connect");
  });
});

describe("5767-P07 the command audits", () => {
  it("records the preview attempt", async () => {
    h.platform.previewOrder.mockResolvedValue({ orderId: "preview-2" });
    const audited: unknown[] = [];
    const command = new BrokerOrderPreviewCommand();
    const r = await command.execute(
      { symbol: "NVDA", orderAction: "BUY", quantity: 1, orderType: "MARKET" },
      {
        env: {} as never,
        sessionId: "sess-1",
        actingLogin: () => "alice",
        audit: (type: string, _c: string, payload: unknown) => audited.push({ type, payload }),
      } as never,
    );
    expect(r.success).toBe(true);
    expect(audited).toHaveLength(1);
    expect((audited[0] as any).type).toBe("broker_order_preview");
  });
});
