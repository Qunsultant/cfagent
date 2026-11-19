// @vitest-environment node
/**
 * Issue #5767 — neutral create: propose + submit for approval, one call.
 *
 * Pins:
 *  - 5767C-P01 registered, mcp:trade, synchronous;
 *  - 5767C-P02 invalid input never reaches a door;
 *  - 5767C-P03 the tenant's broker is the default, an explicit one wins;
 *  - 5767C-P04 a proposal without an order id is reported, not approved;
 *  - 5767C-P05 success submits the approval run and says nothing is placed;
 *  - 5767C-P06 a door failure is named;
 *  - 5767C-P07 the command audits.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tenantBroker: "alpaca" as string | null,
  propose: vi.fn(),
  approval: vi.fn(),
}));

vi.mock("../src/services/tenantProviders", () => ({
  resolveTenantBroker: async () => h.tenantBroker ?? "alpaca",
  resolveTenantBrokerSelection: async () => h.tenantBroker,
}));

vi.mock("../src/agents/orchestrator/meshDoors", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    proposeStockTradeViaDoor: h.propose,
    startTradeApprovalViaDoor: h.approval,
  };
});

import { createOrderViaSelectedBroker } from "../src/services/brokerOrderCreate";
import { BrokerOrderCreateCommand } from "../src/mcps/openaimp/brokerOrderCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { SYNCHRONOUS_MCP_TOOLS } from "../src/config/asyncJobModes";

const base = {
  env: {} as never,
  userLogin: "alice",
  symbol: "NVDA",
  action: "BUY",
  quantity: 10,
};

beforeEach(() => {
  h.tenantBroker = "alpaca";
  h.propose.mockReset();
  h.approval.mockReset();
});

describe("5767C-P01 the tool is available and synchronous", () => {
  it("is registered, gated as a trade, and never queued", () => {
    const tool = McpToolFactory.getTool("broker_order_create");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("broker_order_create");
    expect(MCP_TOOL_SCOPES.broker_order_create).toBe("mcp:trade");
    expect(SYNCHRONOUS_MCP_TOOLS.has("broker_order_create")).toBe(true);
    expect((tool!.jsonSchema as any).required).toEqual(["symbol", "action", "quantity"]);
  });
});

describe("5767C-P02 invalid input never reaches a door", () => {
  it("refuses a missing login, symbol, action, quantity and price", async () => {
    for (const [patch, code] of [
      [{ userLogin: "" }, "identity_required"],
      [{ symbol: " " }, "invalid_symbol"],
      [{ action: "HOLD" }, "invalid_action"],
      [{ quantity: 0 }, "invalid_quantity"],
      [{ limitPrice: -1 }, "invalid_limitPrice"],
    ] as const) {
      const r = await createOrderViaSelectedBroker({ ...base, ...(patch as object) } as never);
      expect(r.code, JSON.stringify(patch)).toBe(code);
    }
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.approval).not.toHaveBeenCalled();
  });
});

describe("5767C-P03 the broker is resolved, never guessed", () => {
  it("defaults to the tenant's selected broker", async () => {
    h.tenantBroker = "tastytrade";
    h.propose.mockResolvedValue({ status: "pending_approval", proposal: { orderId: "draft-1" } });
    h.approval.mockResolvedValue({ workflowId: "wf-1", orderId: "draft-1", status: "awaiting_approval" });
    const r = await createOrderViaSelectedBroker(base);
    expect(r.success).toBe(true);
    expect(h.propose.mock.calls[0][2]).toMatchObject({ provider: "tastytrade" });
    expect(r.provider).toBe("tastytrade");
  });

  it("lets an explicit provider win", async () => {
    h.propose.mockResolvedValue({ status: "pending_approval", proposal: { orderId: "draft-2" } });
    h.approval.mockResolvedValue({ workflowId: "wf-2", orderId: "draft-2", status: "awaiting_approval" });
    await createOrderViaSelectedBroker({ ...base, provider: "alpaca" });
    expect(h.propose.mock.calls[0][2]).toMatchObject({ provider: "alpaca" });
  });
});

describe("5767C-P04 a proposal without an order id is reported, not approved", () => {
  it("names the door's status and submits nothing", async () => {
    h.propose.mockResolvedValue({ status: "rejected_by_risk", proposal: {}, note: "size above the cap" });
    const r = await createOrderViaSelectedBroker(base);
    expect(r.success).toBe(false);
    expect(r.code).toBe("proposal_refused");
    expect(r.message).toContain("size above the cap");
    expect(h.approval).not.toHaveBeenCalled();
  });
});

describe("5767C-P05 success submits the approval run and places nothing", () => {
  it("passes the order id to the approval door and says so", async () => {
    h.propose.mockResolvedValue({ status: "pending_approval", proposal: { orderId: "draft-3" } });
    h.approval.mockResolvedValue({ workflowId: "wf-3", orderId: "draft-3", status: "awaiting_approval" });
    const r = await createOrderViaSelectedBroker(base);
    expect(h.approval).toHaveBeenCalledTimes(1);
    expect(h.approval.mock.calls[0][2]).toMatchObject({ orderId: "draft-3" });
    expect(r.success).toBe(true);
    expect(r.message).toContain("NOTHING IS PLACED");
    expect(r.approval).toMatchObject({ workflowId: "wf-3", status: "awaiting_approval" });
  });
});

describe("5767C-P06 a door failure is named", () => {
  it("returns create_failed with the door's message", async () => {
    h.propose.mockRejectedValue(new Error("broker credentials are not configured"));
    const r = await createOrderViaSelectedBroker(base);
    expect(r.code).toBe("create_failed");
    expect(r.message).toContain("not configured");
  });
});

describe("5767C-P07 the command audits", () => {
  it("records the create attempt", async () => {
    h.propose.mockResolvedValue({ status: "pending_approval", proposal: { orderId: "draft-4" } });
    h.approval.mockResolvedValue({ workflowId: "wf-4", orderId: "draft-4", status: "awaiting_approval" });
    const audited: unknown[] = [];
    const command = new BrokerOrderCreateCommand();
    await command.execute(
      { symbol: "NVDA", action: "BUY", quantity: 1 },
      {
        env: {} as never,
        actingLogin: () => "alice",
        audit: (type: string, _c: string, payload: unknown) => audited.push({ type, payload }),
      } as never,
    );
    expect(audited).toHaveLength(1);
    expect((audited[0] as any).type).toBe("broker_order_create");
  });
});
