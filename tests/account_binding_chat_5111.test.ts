import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { BrokerAccountBindingCommand } from "../src/mcps/openaimp/accountBindingCommands";
import { maskAccountId } from "../src/config/accountBindings";
import type { BrokerAccountRecordLike } from "../src/trading/accountBindings";
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

// Issue #5101 (F4 of #5094): the broker's enumerated accounts, injected
// so no live broker credentials are needed. The tool must validate a
// `set` against exactly these — never against a model-supplied id.
const ENUMERATED_ACCOUNTS: BrokerAccountRecordLike[] = [
  { accountId: "PA-123", accountKey: "PA-123", accountDesc: "Alpaca Stock", accountName: "Alpaca Stock", accountType: "stock", broker: "alpaca" },
  { accountId: "PA-456", accountKey: "PA-456", accountDesc: "Alpaca Options", accountName: "Alpaca Options", accountType: "margin", broker: "alpaca" },
  { accountId: "PA-777", accountKey: "PA-777", accountDesc: "Shared Name", accountName: "Shared Name", accountType: "stock", broker: "alpaca" },
  { accountId: "PA-778", accountKey: "PA-778", accountDesc: "Shared Name", accountName: "Shared Name", accountType: "stock", broker: "alpaca" },
];

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

  it("exposes every action in the model-visible schema (issue #5101: jsonSchema matches zodSchema)", () => {
    const cmd = McpToolFactory.getTool("broker_account_binding") as unknown as { jsonSchema: { properties: { action: { enum: string[] } } } };
    expect(cmd.jsonSchema.properties.action.enum).toEqual(
      expect.arrayContaining(["list", "get", "set", "clear", "validate", "migrate", "registry_get", "registry_update"]),
    );
  });

  it("supports set, list, get, and clear through chat for multiple account types", async () => {
    const cmd = new BrokerAccountBindingCommand({
      listAccounts: async () => ENUMERATED_ACCOUNTS,
    });
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const ctx = { sessionId: "trader@example.com", env } as any;

    // Set a paper Alpaca stock binding for tenant by id. The stored
    // name is the enumerated account's own name, and the result carries
    // only the masked id — never the full id.
    const setStk = await cmd.execute(
      {
        action: "set",
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        scope: "tenant",
        accountId: "PA-123",
        accountName: "Custom Name",
      },
      ctx,
    );
    expect(setStk).toMatchObject({
      ok: true,
      action: "set",
      binding: { broker: "alpaca", mode: "paper", accountType: "stock", scope: "tenant" },
    });
    expect((setStk as any).binding.accountId).toBe(maskAccountId("PA-123"));
    expect((setStk as any).binding.maskedAccountId).toBe(maskAccountId("PA-123"));
    expect((setStk as any).binding.accountName).toBe("Alpaca Stock");
    expect(JSON.stringify(setStk)).not.toContain("PA-123");

    // Set an Alpaca options binding for autopilot by label (no id held).
    const setOpt = await cmd.execute(
      {
        action: "set",
        broker: "alpaca",
        mode: "paper",
        accountType: "options",
        scope: "autopilot",
        accountName: "Alpaca Options",
      },
      ctx,
    );
    expect(setOpt).toMatchObject({ ok: true, action: "set" });
    expect((setOpt as any).binding.accountId).toBe(maskAccountId("PA-456"));
    expect(JSON.stringify(setOpt)).not.toContain("PA-456");

    // List filtered by accountType=options — masked only.
    const listed = (await cmd.execute({ action: "list", accountType: "options" }, ctx)) as any;
    expect(listed.bindings).toHaveLength(1);
    expect(listed.bindings[0].accountId).toBe(maskAccountId("PA-456"));
    expect(JSON.stringify(listed)).not.toContain("PA-456");

    // Get copilot stock binding falls back to tenant stock binding.
    const got = (await cmd.execute(
      { action: "get", broker: "alpaca", mode: "paper", accountType: "stock", scope: "copilot" },
      ctx,
    )) as any;
    expect(got.found).toBe(true);
    expect(got.binding.accountId).toBe(maskAccountId("PA-123"));
    expect(got.resolvedFromScope).toBe("tenant");
    expect(JSON.stringify(got)).not.toContain("PA-123");

    // Clear Alpaca options autopilot binding.
    const cleared = (await cmd.execute(
      { action: "clear", broker: "alpaca", mode: "paper", accountType: "options", scope: "autopilot" },
      ctx,
    )) as any;
    expect(cleared).toEqual({ ok: true, action: "clear", removed: true });
  });

  it("refuses a set for an unknown id, an unknown label, and an ambiguous label (issue #5101)", async () => {
    const cmd = new BrokerAccountBindingCommand({
      listAccounts: async () => ENUMERATED_ACCOUNTS,
    });
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const ctx = { sessionId: "trader@example.com", env } as any;

    const unknownId = (await cmd.execute(
      { action: "set", broker: "alpaca", mode: "paper", accountType: "stock", scope: "tenant", accountId: "NOPE-999" },
      ctx,
    )) as any;
    expect(unknownId.ok).toBe(false);
    expect(unknownId.code).toBe("FAILURE_ACCOUNT_UNKNOWN");
    expect(JSON.stringify(unknownId)).not.toContain("NOPE-999");

    const unknownLabel = (await cmd.execute(
      { action: "set", broker: "alpaca", mode: "paper", accountType: "stock", scope: "tenant", accountName: "No Such Account" },
      ctx,
    )) as any;
    expect(unknownLabel.ok).toBe(false);
    expect(unknownLabel.code).toBe("FAILURE_ACCOUNT_UNKNOWN");

    const ambiguous = (await cmd.execute(
      { action: "set", broker: "alpaca", mode: "paper", accountType: "stock", scope: "tenant", accountName: "Shared Name" },
      ctx,
    )) as any;
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.code).toBe("FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS");
    expect(ambiguous.candidateNames).toEqual(["Shared Name"]);
  });

  it("fails a set closed when the broker's accounts cannot be enumerated (issue #5101)", async () => {
    // No injected enumerator: the live platform read has no credentials
    // in this test env, so the enumeration — and the set — must refuse
    // with FAILURE_ACCOUNT_BINDING_MISSING, never upsert unvalidated.
    const cmd = new BrokerAccountBindingCommand();
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const ctx = { sessionId: "trader@example.com", env } as any;

    const res = (await cmd.execute(
      { action: "set", broker: "alpaca", mode: "paper", accountType: "stock", scope: "tenant", accountId: "PA-123" },
      ctx,
    )) as any;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
  });

  it("refuses a set for a broker without an account list, by name (issue #5101)", async () => {
    const cmd = new BrokerAccountBindingCommand({
      listAccounts: async () => ENUMERATED_ACCOUNTS,
    });
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    const ctx = { sessionId: "trader@example.com", env } as any;

    const res = (await cmd.execute(
      { action: "set", broker: "ibkr", mode: "live", accountType: "forex", scope: "autopilot", accountId: "U888-FX" },
      ctx,
    )) as any;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(res.error).toContain("ibkr");
  });
});
