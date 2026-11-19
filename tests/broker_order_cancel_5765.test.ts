// @vitest-environment node
/**
 * Issue #5765 — neutral broker order cancel.
 *
 * Pins:
 *  - 5765-P01 the tool is registered, on mcp:trade, and synchronous;
 *  - 5765-P02 control is never anonymous, and an empty id sends nothing;
 *  - 5765-P03 a broker without the orderCancel capability refuses BY NAME
 *    and no platform is even constructed (never another broker's cancel);
 *  - 5765-P04 a capable broker's own adapter performs the cancel;
 *  - 5765-P05 Alpaca runs the shared cancellation engine, not a second one.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  broker: "etrade" as string,
  supports: true,
  platform: { cancelOrderRemote: vi.fn() } as any,
  getPlatform: vi.fn(),
  engine: vi.fn(),
  record: vi.fn(),
  markDraft: vi.fn(),
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

vi.mock("../src/services/orderCancellation", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createCancelBrokerPort: () => ({}) as never,
    cancelSingleOrder: h.engine,
    recordCancelOutcome: h.record,
    markDraftRowCancelledIfPresent: h.markDraft,
  };
});

import { cancelOrderViaSelectedBroker } from "../src/services/brokerOrderCancel";
import { BrokerOrderCancelCommand } from "../src/mcps/openaimp/brokerOrderCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { SYNCHRONOUS_MCP_TOOLS } from "../src/config/asyncJobModes";

const base = {
  env: {} as never,
  userLogin: "alice",
  orderId: "ord-1",
};

beforeEach(() => {
  h.broker = "etrade";
  h.supports = true;
  h.getPlatform.mockReset();
  h.platform.cancelOrderRemote.mockReset();
  h.engine.mockReset();
  h.record.mockReset();
  h.markDraft.mockReset();
  h.getPlatform.mockReturnValue(h.platform);
});

describe("5765-P01 the tool is available and synchronous", () => {
  it("is registered, gated as a trade, and never queued", () => {
    const tool = McpToolFactory.getTool("broker_order_cancel");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("broker_order_cancel");
    expect(MCP_TOOL_SCOPES.broker_order_cancel).toBe("mcp:trade");
    expect(SYNCHRONOUS_MCP_TOOLS.has("broker_order_cancel")).toBe(true);
    expect((tool!.jsonSchema as any).required).toEqual(["orderId"]);
  });
});

describe("5765-P02 control is never anonymous", () => {
  it("refuses a missing login without touching a broker", async () => {
    const result = await cancelOrderViaSelectedBroker({ ...base, userLogin: "" });
    expect(result.success).toBe(false);
    expect(result.code).toBe("identity_required");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });

  it("refuses an empty order id without asking any broker", async () => {
    const result = await cancelOrderViaSelectedBroker({ ...base, orderId: "  " });
    expect(result.code).toBe("invalid_order_id");
    expect(h.getPlatform).not.toHaveBeenCalled();
  });
});

describe("5765-P03 an incapable broker refuses by name", () => {
  it("names the broker and constructs no platform", async () => {
    h.broker = "public";
    h.supports = false;
    const result = await cancelOrderViaSelectedBroker(base);
    expect(result.success).toBe(false);
    expect(result.code).toBe("provider_unsupported");
    expect(result.broker).toBe("public");
    expect(result.message).toContain("public");
    expect(h.getPlatform).not.toHaveBeenCalled();
    expect(h.platform.cancelOrderRemote).not.toHaveBeenCalled();
  });
});

describe("5765-P04 a capable broker's adapter performs the cancel", () => {
  it("calls that broker's cancelOrderRemote with the id", async () => {
    h.platform.cancelOrderRemote.mockResolvedValue({
      success: true,
      message: "Order ord-1 cancelled",
    });
    const result = await cancelOrderViaSelectedBroker(base);
    expect(h.getPlatform).toHaveBeenCalledTimes(1);
    expect(h.platform.cancelOrderRemote).toHaveBeenCalledWith("ord-1");
    expect(result).toMatchObject({ success: true, broker: "etrade", orderId: "ord-1" });
  });

  it("surfaces the broker's refusal without inventing success", async () => {
    h.platform.cancelOrderRemote.mockResolvedValue({ success: false, message: "already filled" });
    const result = await cancelOrderViaSelectedBroker(base);
    expect(result.success).toBe(false);
    expect(result.code).toBe("cancel_refused");
    expect(result.message).toContain("already filled");
  });
});

describe("5765-P05 Alpaca runs the shared cancellation engine", () => {
  it("routes alpaca through cancelSingleOrder, not the platform adapter", async () => {
    h.broker = "alpaca";
    h.engine.mockResolvedValue({
      success: true,
      message: "Cancelled order ord-1",
      target: { orderId: "ord-1" },
    });
    const result = await cancelOrderViaSelectedBroker({ ...base, reason: "manual" });
    expect(h.engine).toHaveBeenCalledTimes(1);
    expect(h.engine.mock.calls[0][1]).toMatchObject({ orderId: "ord-1", reason: "manual" });
    expect(h.platform.cancelOrderRemote).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, broker: "alpaca", orderId: "ord-1" });
  });
});

describe("5765-P06 the command audits and returns the receipt", () => {
  it("passes the acting login and audits the outcome", async () => {
    h.getPlatform.mockReturnValue({
      cancelOrderRemote: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    });
    const audited: unknown[] = [];
    const command = new BrokerOrderCancelCommand();
    const result = await command.execute(
      { orderId: "ord-1" },
      {
        env: {} as never,
        actingLogin: () => "alice",
        audit: (type: string, _c: string, payload: unknown) => audited.push({ type, payload }),
      } as never,
    );
    expect(result.success).toBe(true);
    expect(audited).toHaveLength(1);
    expect((audited[0] as any).type).toBe("broker_order_cancel");
  });
});
