/**
 * Issue #2482 — one E*TRADE environment source of truth, system-wide.
 *
 * Pins the posted design: the persisted per-login selection (DO
 * settings key `etrade:environment`) is the only authority, defaulting
 * to TEST (paper, #3857 — live is an explicit stored selection); the
 * switch persists and the GET reads it back; headers are
 * never an input to resolution, so a stale client key cannot split
 * surfaces again. Token presence is never consulted here by design
 * (#2442 owns the token seam) — single-token and dual-token cases
 * both reduce to selection ?? TEST.
 */

import { describe, expect, it } from "vitest";
import {
  BROKER_ENVIRONMENT_SETTING_KEY,
  isBrokerEnvironment,
  resolveBrokerEnvironment,
  resolveBrokerEnvironmentFromSettings,
} from "../src/agents/routes/brokerEnvironment";
import {
  handleBrokerEnvironmentGet,
  handleEnvironmentSwitch,
} from "../src/agents/routes/brokerEnvironment";

function stubCtx(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    store,
    ctx: {
      readSettingRaw: (key: string) => store.get(key) ?? null,
      writeSetting: (key: string, value: string) => {
        store.set(key, value);
      },
      env: {},
    },
  };
}

function apiPost(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("broker environment resolver (#2482)", () => {
  it("defaults to TEST (paper) when unset, null, garbage, or wrong case", () => {
    expect(resolveBrokerEnvironment(undefined)).toBe("TEST");
    expect(resolveBrokerEnvironment(null)).toBe("TEST");
    expect(resolveBrokerEnvironment("")).toBe("TEST");
    expect(resolveBrokerEnvironment("BOGUS")).toBe("TEST");
    expect(resolveBrokerEnvironment("test")).toBe("TEST");
    expect(resolveBrokerEnvironment("prod")).toBe("TEST");
  });

  it("returns the stored selection verbatim when it is TEST or PROD", () => {
    expect(resolveBrokerEnvironment("TEST")).toBe("TEST");
    expect(resolveBrokerEnvironment("PROD")).toBe("PROD");
  });

  it("reads the selection from the settings store, never from a header", () => {
    // The resolver signature takes only a settings reader plus the
    // worker env: there is no parameter a stale x-environment header
    // could arrive through.
    const read = (key: string) => (key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : null);
    expect(resolveBrokerEnvironmentFromSettings(read, {})).toBe("TEST");
    expect(resolveBrokerEnvironmentFromSettings(() => null, {})).toBe("TEST");
    expect(isBrokerEnvironment("TEST")).toBe(true);
    expect(isBrokerEnvironment("PROD")).toBe(true);
    expect(isBrokerEnvironment("SANDBOX")).toBe(false);
  });

  it("unset selection falls back to the paper default (#3857), not the deployment environment", () => {
    // The default mode is paper (TEST) on every deployment; live is
    // an explicit stored selection. A TEST deployment resolves TEST
    // as before; a PROD deployment no longer defaults to PROD.
    expect(resolveBrokerEnvironmentFromSettings(() => null, {})).toBe("TEST");
    expect(resolveBrokerEnvironmentFromSettings(() => null, { APP_ENV: "TEST" })).toBe("TEST");
    expect(resolveBrokerEnvironmentFromSettings(() => null, { ETRADE_ENVIRONMENT: "sandbox" })).toBe("TEST");
    // A stored selection beats the deployment default either way.
    expect(
      resolveBrokerEnvironmentFromSettings(
        (key) => (key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : null),
        {},
      ),
    ).toBe("TEST");
    expect(
      resolveBrokerEnvironmentFromSettings(
        (key) => (key === BROKER_ENVIRONMENT_SETTING_KEY ? "PROD" : null),
        { APP_ENV: "TEST" },
      ),
    ).toBe("PROD");
  });

  it("single-token and dual-token cases reduce to selection ?? TEST", () => {
    // No token input exists on the resolver, so the number of stored
    // tokens cannot change the outcome: stored TEST wins over any
    // token set, and unset means TEST regardless of tokens held.
    expect(resolveBrokerEnvironment("TEST")).toBe("TEST");
    expect(resolveBrokerEnvironment(undefined)).toBe("TEST");
  });
});

describe("environment switch persistence (#2482)", () => {
  it("POST persists the selection and echoes it; GET reads it back", async () => {
    const { store, ctx } = stubCtx();
    const res = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "TEST" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, environment: "TEST" });
    expect(store.get(BROKER_ENVIRONMENT_SETTING_KEY)).toBe("TEST");

    const get = handleBrokerEnvironmentGet(ctx);
    expect(await get.json()).toEqual({ environment: "TEST" });

    // A second switch overwrites, it does not append a second source.
    await handleEnvironmentSwitch(apiPost("/api/broker/etrade/environment", { environment: "PROD" }), ctx);
    expect(store.get(BROKER_ENVIRONMENT_SETTING_KEY)).toBe("PROD");
    expect(store.size).toBe(1);
  });

  it("GET with no selection returns the paper default", () => {
    const { ctx } = stubCtx();
    return handleBrokerEnvironmentGet(ctx)
      .json()
      .then((body: any) => expect(body).toEqual({ environment: "TEST" }));
  });

  it("GET applies the deployment default in a TEST deployment", async () => {
    const ctx = {
      readSettingRaw: () => null,
      writeSetting: () => {},
      env: { APP_ENV: "TEST" },
    };
    const body: any = await handleBrokerEnvironmentGet(ctx).json();
    expect(body).toEqual({ environment: "TEST" });
  });

  it("invalid POST 400s and leaves the stored selection untouched", async () => {
    const { store, ctx } = stubCtx({ [BROKER_ENVIRONMENT_SETTING_KEY]: "TEST" });
    const res = await handleEnvironmentSwitch(
      apiPost("/api/broker/etrade/environment", { environment: "BOGUS" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(store.get(BROKER_ENVIRONMENT_SETTING_KEY)).toBe("TEST");
  });

  it("POST without a settings writer fails closed instead of silent success", async () => {
    const res = await handleEnvironmentSwitch(
      apiPost("/api/environment/switch", { environment: "TEST" }),
      { readSettingRaw: () => null, env: {} },
    );
    expect(res.status).toBe(500);
  });

  it("lowercase input normalizes to the canonical value before persisting", async () => {
    const { store, ctx } = stubCtx();
    const res = await handleEnvironmentSwitch(apiPost("/api/environment/switch", { environment: "test" }), ctx);
    expect(await res.json()).toEqual({ success: true, environment: "TEST" });
    expect(store.get(BROKER_ENVIRONMENT_SETTING_KEY)).toBe("TEST");
  });
});
