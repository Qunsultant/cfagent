import { describe, it, expect } from "vitest";
import {
  accountBindingAuditFields,
  resolveValidatedExecutionAccountContext,
  upsertAccountBinding,
} from "../src/services/accountBindings";
import type { Env } from "../src/types";

/**
 * Issue #5100 (F3 of #5094) — the validated-resolution wrapper.
 *
 * `resolveExecutionAccountContext` (F1) has two holes the B1 plan
 * flagged: `source: "explicit"` returns a body-supplied accountId
 * verbatim with no validation, and `source: "unset"` still proceeds.
 * The F3 wrapper closes both: explicit ids are validated against the
 * broker's enumerated accounts (never trusted verbatim) and an
 * unbound resolution is a coded refusal, never an unset context.
 * Mirrors the #5112 file's in-memory DO-namespace stub.
 */
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

/** The broker's enumerated accounts for the Alpaca paper tenant. */
const ALPACA_ACCOUNTS = [
  { accountId: "PA-900", accountType: "stock", broker: "alpaca", accountName: "Alpaca Paper" },
  { accountId: "PA-901", accountType: "stock", broker: "alpaca", owned: false },
  { accountId: "PA-CASH", accountType: "cash", broker: "alpaca" },
  { accountId: "ET-123", accountType: "stock", broker: "etrade" },
];

async function seedBindings(env: Env) {
  await upsertAccountBinding(env, "trader@example.com", {
    broker: "alpaca",
    mode: "paper",
    accountType: "stock",
    scope: "tenant",
    accountId: "PA-900",
  });
  await upsertAccountBinding(env, "trader@example.com", {
    broker: "ibkr",
    mode: "live",
    accountType: "forex",
    scope: "autopilot",
    accountId: "U777-FX",
    accountName: "IBKR FX",
  });
}

describe("Issue #5100 (F3 of #5094) — validated execution-account resolution", () => {
  it("resolves an explicit accountId that matches an enumerated account", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      explicitAccountId: "PA-900",
      availableAccounts: ALPACA_ACCOUNTS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.context.source).toBe("explicit");
    expect(res.context.accountId).toBe("PA-900");
    expect(res.context.tuple).toEqual({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "PA-900",
    });
  });

  it("refuses an explicit accountId that is not among the enumerated accounts (404)", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      explicitAccountId: "PA-NOPE",
      availableAccounts: ALPACA_ACCOUNTS,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_UNKNOWN");
    expect(res.status).toBe(404);
  });

  it("refuses an explicit unowned account (403)", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      explicitAccountId: "PA-901",
      availableAccounts: ALPACA_ACCOUNTS,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_UNOWNED");
    expect(res.status).toBe(403);
  });

  it("refuses an explicit account whose asset class cannot serve the request (400)", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "options",
      scope: "copilot",
      explicitAccountId: "PA-CASH",
      availableAccounts: ALPACA_ACCOUNTS,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_ASSET_TYPE_MISMATCH");
    expect(res.status).toBe(400);
  });

  it("refuses an explicit account that belongs to another broker (409)", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      explicitAccountId: "ET-123",
      availableAccounts: ALPACA_ACCOUNTS,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_BROKER_MISMATCH");
    expect(res.status).toBe(409);
  });

  it("refuses when unbound instead of returning an unset context", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    // No bindings seeded for this login: nothing to resolve from.
    const res = await resolveValidatedExecutionAccountContext(env, "nobody@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(res.status).toBe(404);
  });

  it("resolves from the stored binding, honoring the per-scope resolution", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "schedule",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.context.source).toBe("binding");
    expect(res.context.accountId).toBe("PA-900");
    expect(res.context.resolvedFromScope).toBe("tenant");
  });

  it("never trusts a well-formed body-supplied id that is not enumerated", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    // Well-formed, registry-shaped, but absent from the broker's list.
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      explicitAccountId: "PA-902",
      availableAccounts: ALPACA_ACCOUNTS,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_UNKNOWN");
  });

  it("fails closed when an explicit id cannot be validated (no enumeration)", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "copilot",
      explicitAccountId: "PA-900",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
  });

  it("emits the full six audit fields on a wrapper-resolved context", async () => {
    const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
    await seedBindings(env);
    const res = await resolveValidatedExecutionAccountContext(env, "trader@example.com", {
      broker: "ibkr",
      mode: "live",
      accountType: "forex",
      scope: "autopilot",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(accountBindingAuditFields(res.context)).toEqual({
      broker: "ibkr",
      mode: "live",
      accountType: "forex",
      accountId: "U777-FX",
      bindingScope: "autopilot",
      bindingSource: "binding",
    });
  });
});
