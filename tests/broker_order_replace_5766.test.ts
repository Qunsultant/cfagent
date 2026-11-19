// @vitest-environment node
/**
 * Issue #5766 — neutral broker order replace.
 *
 * Pins:
 *  - 5766-P01 registered, mcp:trade, synchronous;
 *  - 5766-P02 nobody anonymous, and an empty id sends nothing;
 *  - 5766-P03 an empty replace is refused, not forwarded;
 *  - 5766-P04 only the stated fields reach the broker (unstated terms keep
 *    their broker value);
 *  - 5766-P05 a broker that cannot replace refuses BY NAME and is never
 *    cancelled-and-re-placed;
 *  - 5766-P06 the command resolves the trade environment and audits.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  broker: "etrade" as string,
  supports: true,
  platform: { replaceOrderRemote: vi.fn() } as any,
  getPlatform: vi.fn(),
}));

vi.mock("../src/services/tenantProviders", () => ({
  resolveTenantBroker: async () => h.broker,
  resolveTenantBrokerSelection: async () => h.broker,
}));

vi.mock("../src/trading", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    brokerSupports: () => h.supports,
    TradingPlatformRegistry: { getPlatform: h.getPlatform },
  };
});

import { replaceOrderViaSelectedBroker } from "../src/services/brokerOrderReplace";
import { BrokerOrderReplaceCommand } from "../src/mcps/openaimp/brokerOrderCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { SYNCHRONOUS_MCP_TOOLS } from "../src/config/asyncJobModes";

const base = {
  env: {} as never,
  userLogin: "alice",
  orderId: "ord-1",
  limitPrice: 179,
};

beforeEach(() => {
  h.broker = "etrade";
  h.supports = true;
  h.getPlatform.mockReset();
  h.platform.replaceOrderRemote.mockReset();
  h.getPlatform.mockReturnValue(h.platform);
});

describe("5766-P01 the tool is available and synchronous", () => {
  it("is registered, gated as a trade, and never queued", () => {
    const tool = McpToolFactory.getTool("broker_order_replace");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("broker_order_replace");
    expect(MCP_TOOL_SCOPES.broker_order_replace).toBe("mcp:trade");
    expect(SYNCHRONOUS_MCP_TOOLS.has("broker_order_replace")).toBe(true);
    expect((tool!.jsonSchema as any).required).toEqual(["orderId"]);
  });
});

describe("5766-P02 control is never anonymous", () => {
  it("refuses a missing login without touching a broker", async () => {
    const result = await replaceOrderViaSelectedBroker({ ...base, userLogin: "" });
    expect(result.code).toBe("identity_required");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });

  it("refuses an empty order id", async () => {
    const result = await replaceOrderViaSelectedBroker({ ...base, orderId: " " });
    expect(result.code).toBe("invalid_order_id");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });
});

describe("5766-P03 an empty replace is refused, not forwarded", () => {
  it("names the required change set", async () => {
    const result = await replaceOrderViaSelectedBroker({
      env: {} as never,
      userLogin: "alice",
      orderId: "ord-1",
    });
    expect(result.code).toBe("no_change");
    expect(result.message).toContain("at least one change");
    expect(h.platform.replaceOrderRemote).not.toHaveBeenCalled();
  });

  it("refuses a non-positive term instead of sending it", async () => {
    const result = await replaceOrderViaSelectedBroker({ ...base, limitPrice: -1 });
    expect(result.code).toBe("invalid_limitPrice");
    expect(h.platform.replaceOrderRemote).not.toHaveBeenCalled();
  });
});

describe("5766-P04 only the stated fields reach the broker", () => {
  it("sends the stated price and omits everything else", async () => {
    h.platform.replaceOrderRemote.mockResolvedValue({ success: true, message: "ok" });
    const result = await replaceOrderViaSelectedBroker(base);
    expect(result.success).toBe(true);
    const sent = h.platform.replaceOrderRemote.mock.calls[0][0];
    expect(sent).toEqual({ orderId: "ord-1", limitPrice: 179 });
    expect("quantity" in sent).toBe(false);
  });
});

describe("5766-P05 an incapable broker refuses by name", () => {
  it("names the broker and never falls back to cancel-and-re-place", async () => {
    h.broker = "public";
    h.supports = false;
    const result = await replaceOrderViaSelectedBroker(base);
    expect(result.code).toBe("provider_unsupported");
    expect(result.broker).toBe("public");
    expect(result.message).toContain("not cancelled and re-placed");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });

  it("surfaces the broker's refusal without inventing success", async () => {
    h.platform.replaceOrderRemote.mockResolvedValue({ success: false, message: "already filled" });
    const result = await replaceOrderViaSelectedBroker(base);
    expect(result.success).toBe(false);
    expect(result.code).toBe("replace_refused");
    expect(result.message).toContain("already filled");
  });
});

describe("5766-P06 the command resolves the environment and audits", () => {
  it("passes the acting login and audits the outcome", async () => {
    h.platform.replaceOrderRemote.mockResolvedValue({ success: true, message: "ok" });
    const audited: unknown[] = [];
    const command = new BrokerOrderReplaceCommand();
    await command.execute(
      { orderId: "ord-1", quantity: 5 },
      {
        env: {} as never,
        actingLogin: () => "alice",
        readSettingRaw: () => null,
        audit: (type: string, _c: string, payload: unknown) => audited.push({ type, payload }),
      } as never,
    );
    expect(h.platform.replaceOrderRemote.mock.calls[0][0]).toEqual({
      orderId: "ord-1",
      quantity: 5,
    });
    expect(audited).toHaveLength(1);
    expect((audited[0] as any).type).toBe("broker_order_replace");
  });
});
