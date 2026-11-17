import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { BrokerAccountBindingCommand } from "../src/mcps/openaimp/accountBindingCommands";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import type { Env } from "../src/types";

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

describe("Issue #5111 (Sub-issue 2 of #5094) — Chat & Copilot account binding tool", () => {
  it("registers broker_account_binding in McpToolFactory and exposes its tool definition", () => {
    const cmd = McpToolFactory.getTool("broker_account_binding");
    expect(cmd).toBeDefined();
    expect(cmd?.description).toContain("account binding");

    const defs = McpToolFactory.getToolDefinitions();
    const bindingTool = defs.find((t) => t.name === "broker_account_binding");
    expect(bindingTool).toBeDefined();
    expect(bindingTool?.description).toContain("account binding");
  });

  it("supports set, list, get, and clear through chat for multiple account types", async () => {
    const cmd = new BrokerAccountBindingCommand();
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const ctx = { sessionId: "trader@example.com", env } as any;

    // Set a live IBKR forex binding for autopilot
    const setFx = await cmd.execute(
      {
        action: "set",
        broker: "ibkr",
        mode: "live",
        accountType: "forex",
        scope: "autopilot",
        accountId: "U888-FX",
        accountName: "IBKR Forex",
      },
      ctx,
    );
    expect(setFx).toMatchObject({
      ok: true,
      action: "set",
      binding: { broker: "ibkr", mode: "live", accountType: "forex", scope: "autopilot", accountId: "U888-FX" },
    });

    // Set a paper Alpaca stock binding for tenant
    const setStk = await cmd.execute(
      {
        action: "set",
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        scope: "tenant",
        accountId: "PA-123",
      },
      ctx,
    );
    expect(setStk).toMatchObject({ ok: true, action: "set" });

    // List filtered by accountType=forex
    const listed = (await cmd.execute({ action: "list", accountType: "forex" }, ctx)) as any;
    expect(listed.bindings).toHaveLength(1);
    expect(listed.bindings[0].accountId).toBe("U888-FX");

    // Get copilot stock binding falls back to tenant stock binding
    const got = (await cmd.execute(
      { action: "get", broker: "alpaca", mode: "paper", accountType: "stock", scope: "copilot" },
      ctx,
    )) as any;
    expect(got.found).toBe(true);
    expect(got.binding.accountId).toBe("PA-123");
    expect(got.resolvedFromScope).toBe("tenant");

    // Clear IBKR forex autopilot binding
    const cleared = (await cmd.execute(
      { action: "clear", broker: "ibkr", mode: "live", accountType: "forex", scope: "autopilot" },
      ctx,
    )) as any;
    expect(cleared).toEqual({ ok: true, action: "clear", removed: true });
  });
});
