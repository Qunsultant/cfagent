import { describe, it, expect } from "vitest";
import {
  accountBindingAuditFields,
  resolveExecutionAccountContext,
  upsertAccountBinding,
} from "../src/services/accountBindings";
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

describe("Issue #5112 (Sub-issue 3 of #5094) — Execution account binding & audit fields", () => {
  it("resolves per-scope bindings for autopilot, copilot, and schedule and emits full audit fields", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;

    await upsertAccountBinding(env, "trader@example.com", {
      broker: "ibkr",
      mode: "live",
      accountType: "forex",
      scope: "autopilot",
      accountId: "U777-FX",
      accountName: "IBKR FX",
    });
    await upsertAccountBinding(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "tenant",
      accountId: "PA-900",
    });

    const fxAutopilot = await resolveExecutionAccountContext(env, "trader@example.com", {
      broker: "ibkr",
      mode: "live",
      accountType: "forex",
      scope: "autopilot",
    });
    expect(fxAutopilot?.accountId).toBe("U777-FX");
    expect(fxAutopilot?.source).toBe("binding");
    expect(accountBindingAuditFields(fxAutopilot)).toEqual({
      broker: "ibkr",
      mode: "live",
      accountType: "forex",
      accountId: "U777-FX",
      bindingScope: "autopilot",
      bindingSource: "binding",
    });

    // Schedule scope for Alpaca paper stock falls back to tenant binding PA-900.
    const stkSchedule = await resolveExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "schedule",
    });
    expect(stkSchedule?.accountId).toBe("PA-900");
    expect(stkSchedule?.resolvedFromScope).toBe("tenant");
    expect(accountBindingAuditFields(stkSchedule)).toMatchObject({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "PA-900",
      bindingScope: "schedule",
      bindingSource: "binding",
    });

    // Explicit accountId overrides stored binding.
    const explicit = await resolveExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      explicitAccountId: "PA-OVERRIDE",
    });
    expect(explicit?.accountId).toBe("PA-OVERRIDE");
    expect(explicit?.source).toBe("explicit");
  });
});
