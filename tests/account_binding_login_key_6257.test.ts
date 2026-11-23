// Issue #6257 — Settings-written account bindings are keyed by the Orchestrator
// DO instance id, invisible to login-keyed readers (schedule creation fails
// FAILURE_ACCOUNT_BINDING_MISSING). The fix re-points the HTTP binding route at
// the verified login (x-user-login) and migrates DO-id-keyed entries to the
// login key, so already-saved bindings keep working with no manual re-save.
import { describe, it, expect } from "vitest";
import { routeRequest, type RouteRequestDeps } from "../src/agents/orchestrator/routeRequest";
import { handleAccountBindingRoutes } from "../src/agents/routes/accountBindings";
import {
  getBrokerAssetAccountRegistry,
  listAccountBindings,
  migrateAccountBindingsToLogin,
  resolveUserAccountBinding,
  updateBrokerAssetAccountRegistry,
  upsertAccountBinding,
} from "../src/services/accountBindings";
import type { Env } from "../src/types";

const LOGIN = "openaimp";
const DO_ID = "0123456789abcdef".repeat(4); // 64-hex, stands in for the DO instance id
const ACCOUNT_ID = "913e836a-1d2d-4956-8f28-2ac262a272bd";

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

function makeEnv() {
  return { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
}

async function seedBinding(env: Env, identity: string, scope: "tenant" | "schedule", accountId = ACCOUNT_ID) {
  const res = await upsertAccountBinding(env, identity, {
    broker: "alpaca",
    mode: "paper",
    accountType: "stock",
    scope,
    accountId,
  });
  expect(res.ok).toBe(true);
  return res;
}

function makeRouteDeps(env: Env) {
  return {
    env,
    ctx: { waitUntil: () => {}, storage: { sql: {} } },
    sessionKey: () => DO_ID,
    ensureTables: () => ({}),
    notifySettingsChanged: () => {},
    dataProviderPorts: async () => ({ config: null, captures: null }),
  } as unknown as RouteRequestDeps;
}

describe("Issue #6257 — account bindings keyed by login, not DO id", () => {
  it("migrates DO-id-keyed bindings to the login key (service)", async () => {
    const env = makeEnv();
    await seedBinding(env, DO_ID, "tenant");
    await seedBinding(env, DO_ID, "schedule");

    const first = await migrateAccountBindingsToLogin(env, DO_ID, LOGIN);
    expect(first.migratedBindings).toBe(2);

    const loginBindings = await listAccountBindings(env, LOGIN);
    expect(loginBindings.map((b) => b.scope).sort()).toEqual(["schedule", "tenant"]);
    expect(loginBindings.every((b) => b.accountId === ACCOUNT_ID)).toBe(true);

    // The legacy entries are copied, not deleted.
    expect((await listAccountBindings(env, DO_ID)).length).toBe(2);

    // Idempotent: a second run migrates nothing.
    const second = await migrateAccountBindingsToLogin(env, DO_ID, LOGIN);
    expect(second.migratedBindings).toBe(0);
    expect((await listAccountBindings(env, LOGIN)).length).toBe(2);
  });

  it("login-keyed entries win on slot conflict", async () => {
    const env = makeEnv();
    await seedBinding(env, LOGIN, "tenant", "other-account-id");
    await seedBinding(env, DO_ID, "tenant", ACCOUNT_ID);
    await seedBinding(env, DO_ID, "schedule", ACCOUNT_ID);

    const res = await migrateAccountBindingsToLogin(env, DO_ID, LOGIN);
    expect(res.migratedBindings).toBe(1);

    const loginBindings = await listAccountBindings(env, LOGIN);
    const tenant = loginBindings.find((b) => b.scope === "tenant");
    expect(tenant?.accountId).toBe("other-account-id");
    expect(loginBindings.find((b) => b.scope === "schedule")?.accountId).toBe(ACCOUNT_ID);
  });

  it("migrates a stored registry patch to the login key", async () => {
    const env = makeEnv();
    const patchRes = await updateBrokerAssetAccountRegistry(env, DO_ID, {
      addAssetType: "commodities",
      addAccountType: "sep_ira",
      upsertBroker: {
        id: "global_fx",
        label: "Global FX & Commodities",
        enabled: true,
        modes: ["paper", "live"],
        assetTypes: ["commodities"],
      },
    });
    expect(patchRes.ok).toBe(true);

    // Before migration the login key sees only defaults.
    const beforeRegistry = await getBrokerAssetAccountRegistry(env, LOGIN);
    expect(beforeRegistry.assetTypes).not.toContain("commodities");

    const res = await migrateAccountBindingsToLogin(env, DO_ID, LOGIN);
    expect(res.migratedRegistry).toBe(true);

    const registry = await getBrokerAssetAccountRegistry(env, LOGIN);
    expect(registry.assetTypes).toContain("commodities");
    expect(registry.accountTypes).toContain("sep_ira");
    expect(registry.brokers.some((b) => b.id === "global_fx")).toBe(true);
  });

  it("migration is a no-op for identical or blank identities", async () => {
    const env = makeEnv();
    await seedBinding(env, DO_ID, "tenant");
    expect((await migrateAccountBindingsToLogin(env, DO_ID, DO_ID)).migratedBindings).toBe(0);
    expect((await migrateAccountBindingsToLogin(env, "", LOGIN)).migratedBindings).toBe(0);
    expect((await migrateAccountBindingsToLogin(env, DO_ID, "")).migratedBindings).toBe(0);
    expect((await listAccountBindings(env, LOGIN)).length).toBe(0);
  });

  it("route GET migrates legacy bindings and the login-keyed resolver finds them", async () => {
    const env = makeEnv();
    await seedBinding(env, DO_ID, "tenant");
    await seedBinding(env, DO_ID, "schedule");

    // Before the fix this is the production failure: the schedule-creation
    // check reads an empty login-keyed list.
    const before = await resolveUserAccountBinding(env, LOGIN, {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "schedule",
    });
    expect(before.found).toBe(false);

    const res = await handleAccountBindingRoutes(
      new Request("https://example.com/broker/account-binding", { method: "GET" }),
      new URL("https://example.com/broker/account-binding"),
      "/broker/account-binding",
      LOGIN,
      { env, legacySessionId: DO_ID },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { bindings: Array<{ scope: string }> };
    expect(body.bindings.map((b) => b.scope).sort()).toEqual(["schedule", "tenant"]);

    // The migration persisted: the schedule-creation check now finds it.
    const after = await resolveUserAccountBinding(env, LOGIN, {
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      scope: "schedule",
    });
    expect(after.found).toBe(true);
    expect(after.binding?.accountId).toBe(ACCOUNT_ID);
  });

  it("route PUT writes under the login key, not the legacy key", async () => {
    const env = makeEnv();
    const res = await handleAccountBindingRoutes(
      new Request("https://example.com/broker/account-binding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          broker: "alpaca",
          mode: "paper",
          accountType: "stock",
          scope: "tenant",
          accountId: ACCOUNT_ID,
        }),
      }),
      new URL("https://example.com/broker/account-binding"),
      "/broker/account-binding",
      LOGIN,
      { env, legacySessionId: DO_ID },
    );
    expect(res?.status).toBe(200);
    expect((await listAccountBindings(env, LOGIN)).length).toBe(1);
    expect((await listAccountBindings(env, DO_ID)).length).toBe(0);
  });

  it("routeRequest passes the verified login to the binding route (wiring)", async () => {
    const env = makeEnv();
    await seedBinding(env, DO_ID, "tenant");
    await seedBinding(env, DO_ID, "schedule");

    const deps = makeRouteDeps(env);

    const res = await routeRequest(
      deps,
      new Request("https://example.com/broker/account-binding", {
        method: "GET",
        headers: { "x-user-login": "OpenAIMP" },
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { bindings: Array<{ scope: string }> };
    expect(body.bindings.map((b) => b.scope).sort()).toEqual(["schedule", "tenant"]);

    // And the migration persisted under the login key.
    expect((await listAccountBindings(env, LOGIN)).length).toBe(2);
  });

  it("routeRequest falls back to the DO id when no verified login header is present", async () => {
    const env = makeEnv();
    await seedBinding(env, DO_ID, "tenant");

    const deps = makeRouteDeps(env);

    const res = await routeRequest(
      deps,
      new Request("https://example.com/broker/account-binding", { method: "GET" }),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { bindings: Array<{ scope: string }> };
    expect(body.bindings.map((b) => b.scope)).toEqual(["tenant"]);

    // Nothing migrated: the login key stays empty.
    expect((await listAccountBindings(env, LOGIN)).length).toBe(0);
  });
});
