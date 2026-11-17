import { describe, it, expect } from "vitest";
import {
  resolveEffectiveAccountBinding,
  validateAccountBindingInput,
} from "../src/trading";
import {
  listAccountBindings,
  removeAccountBinding,
  resolveUserAccountBinding,
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

describe("Issue #5110 (Sub-issue 1 of #5094) — Account binding model & persistence", () => {
  it("validates { broker, mode, accountType, scope, accountId } cleanly", () => {
    const valid = validateAccountBindingInput({
      broker: "IBKR",
      mode: "live",
      accountType: "forex",
      scope: "autopilot",
      accountId: "U998877-FX",
      accountName: "IBKR FX Margin",
      updatedBy: "alice@example.com",
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.binding.broker).toBe("ibkr");
      expect(valid.binding.mode).toBe("live");
      expect(valid.binding.accountType).toBe("forex");
      expect(valid.binding.scope).toBe("autopilot");
      expect(valid.binding.accountId).toBe("U998877-FX");
    }

    expect(
      validateAccountBindingInput({
        broker: "unknown",
        mode: "paper",
        accountId: "A1",
      }).ok,
    ).toBe(false);

    expect(
      validateAccountBindingInput({
        broker: "alpaca",
        mode: "sandbox",
        accountId: "A1",
      }).ok,
    ).toBe(false);

    expect(
      validateAccountBindingInput({
        broker: "alpaca",
        mode: "paper",
        accountType: "invalid_type",
        accountId: "A1",
      }).ok,
    ).toBe(false);

    expect(
      validateAccountBindingInput({
        broker: "alpaca",
        mode: "paper",
        accountId: "   ",
      }).ok,
    ).toBe(false);
  });

  it("isolates bindings by broker, mode, and accountType with tenant-scope fallback only", () => {
    const stockTenant = validateAccountBindingInput({
      broker: "ibkr",
      mode: "live",
      accountType: "stock",
      scope: "tenant",
      accountId: "U100-STK",
    });
    const forexAutopilot = validateAccountBindingInput({
      broker: "ibkr",
      mode: "live",
      accountType: "forex",
      scope: "autopilot",
      accountId: "U200-FX",
    });
    expect(stockTenant.ok && forexAutopilot.ok).toBe(true);
    if (!stockTenant.ok || !forexAutopilot.ok) return;

    const bindings = [stockTenant.binding, forexAutopilot.binding];

    // Exact match for forex autopilot.
    const fxRes = resolveEffectiveAccountBinding(bindings, {
      broker: "ibkr",
      mode: "live",
      accountType: "forex",
      scope: "autopilot",
    });
    expect(fxRes.found).toBe(true);
    expect(fxRes.binding?.accountId).toBe("U200-FX");
    expect(fxRes.resolvedFromScope).toBe("autopilot");

    // Copilot scope for stock falls back to tenant stock binding on same broker+mode.
    const stkCopilot = resolveEffectiveAccountBinding(bindings, {
      broker: "ibkr",
      mode: "live",
      accountType: "stock",
      scope: "copilot",
    });
    expect(stkCopilot.found).toBe(true);
    expect(stkCopilot.binding?.accountId).toBe("U100-STK");
    expect(stkCopilot.resolvedFromScope).toBe("tenant");

    // Never crosses mode (paper vs live), broker (alpaca vs ibkr), or accountType (options vs stock).
    expect(
      resolveEffectiveAccountBinding(bindings, {
        broker: "ibkr",
        mode: "paper",
        accountType: "stock",
        scope: "tenant",
      }).found,
    ).toBe(false);
    expect(
      resolveEffectiveAccountBinding(bindings, {
        broker: "alpaca",
        mode: "live",
        accountType: "stock",
        scope: "tenant",
      }).found,
    ).toBe(false);
    expect(
      resolveEffectiveAccountBinding(bindings, {
        broker: "ibkr",
        mode: "live",
        accountType: "options",
        scope: "tenant",
      }).found,
    ).toBe(false);
  });

  it("persists, updates, resolves, and deletes bindings in SessionStore DO", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;

    const first = await upsertAccountBinding(env, "trader@example.com", {
      broker: "etrade",
      mode: "live",
      accountType: "stock",
      scope: "tenant",
      accountId: "ET-111",
      accountName: "Individual Brokerage",
    });
    expect(first.ok).toBe(true);

    const second = await upsertAccountBinding(env, "trader@example.com", {
      broker: "etrade",
      mode: "live",
      accountType: "options",
      scope: "schedule",
      accountId: "ET-222",
      accountName: "Options Account",
    });
    expect(second.ok).toBe(true);

    const all = await listAccountBindings(env, "trader@example.com");
    expect(all).toHaveLength(2);

    const resolved = await resolveUserAccountBinding(env, "trader@example.com", {
      broker: "etrade",
      mode: "live",
      accountType: "options",
      scope: "schedule",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.binding?.accountId).toBe("ET-222");

    const removed = await removeAccountBinding(env, "trader@example.com", {
      broker: "etrade",
      mode: "live",
      accountType: "options",
      scope: "schedule",
    });
    expect(removed).toBe(true);
    expect(await listAccountBindings(env, "trader@example.com")).toHaveLength(1);
  });
});
