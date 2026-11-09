/**
 * Issue #3888 — externalized trading limits.
 *
 * What these pins defend:
 *   1. Resolution order and provenance: ticker override → account setting →
 *      env → unset. A caller can always say where a value came from.
 *   2. Unset (and unparsable) is a refusal with `limit_not_configured`,
 *      never "unlimited". Zero is a real, deliberate limit.
 *   3. The validator reports the limit, its value, current usage and the
 *      requested amount — the facts a refusal answer must quote (#3889).
 *   4. A change is a recorded before/after, persisted to the caller's own
 *      settings, and audited by every surface that can make one.
 *   5. The route and the tool read the same snapshot the engines read.
 */
import { describe, it, expect, vi } from "vitest";
import {
  TRADING_LIMIT_KEYS,
  TRADING_LIMITS_SETTING_KEY,
  applyTradingLimitChange,
  describeTradingLimitRefusal,
  evaluateTradingLimit,
  evaluateTradingLimits,
  formatTradingLimitAmount,
  parseTradingLimitValue,
  resolveTradingLimits,
  tradingLimitEnvVar,
  tradingLimitTickerSettingKey,
} from "../src/trading";
import { handleBrokerLimitRoutes } from "../src/agents/routes/brokerLimits";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { resolveToolScope } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MockSqlStorage } from "./mock-sql";

function settingsReader(values: Record<string, string>) {
  return (key: string) => values[key] ?? null;
}

describe("#3888 — limit resolution and provenance", () => {
  it("reads the env default when nothing is stored, and says so", () => {
    const snapshot = resolveTradingLimits({
      symbol: "AAPL",
      env: { TRADING_LIMIT_MAX_RUNGS_PER_LADDER: "3" } as any,
      readSetting: settingsReader({}),
    });

    expect(snapshot.limits.maxRungsPerLadder).toEqual({
      key: "maxRungsPerLadder",
      value: 3,
      source: "env",
      readFrom: "TRADING_LIMIT_MAX_RUNGS_PER_LADDER",
    });
    expect(snapshot.symbol).toBe("AAPL");
  });

  it("prefers the account setting over the env default", () => {
    const snapshot = resolveTradingLimits({
      env: { TRADING_LIMIT_MAX_RUNGS_PER_LADDER: "3" } as any,
      readSetting: settingsReader({
        [TRADING_LIMITS_SETTING_KEY]: JSON.stringify({ maxRungsPerLadder: 5 }),
      }),
    });
    expect(snapshot.limits.maxRungsPerLadder.value).toBe(5);
    expect(snapshot.limits.maxRungsPerLadder.source).toBe("setting");
    expect(snapshot.limits.maxRungsPerLadder.readFrom).toBe(TRADING_LIMITS_SETTING_KEY);
  });

  it("prefers a per-ticker override over everything else", () => {
    const snapshot = resolveTradingLimits({
      symbol: "msft",
      env: { TRADING_LIMIT_MAX_RUNGS_PER_LADDER: "3" } as any,
      readSetting: settingsReader({
        [TRADING_LIMITS_SETTING_KEY]: JSON.stringify({ maxRungsPerLadder: 5 }),
        [tradingLimitTickerSettingKey("MSFT")]: JSON.stringify({ maxRungsPerLadder: 2 }),
      }),
    });
    expect(snapshot.limits.maxRungsPerLadder.value).toBe(2);
    expect(snapshot.limits.maxRungsPerLadder.source).toBe("ticker-override");
    expect(snapshot.limits.maxRungsPerLadder.readFrom).toBe("trading:limits:MSFT");
  });

  it("reports an unconfigured limit as unset, never as unlimited", () => {
    const snapshot = resolveTradingLimits({ readSetting: settingsReader({}) });
    for (const key of TRADING_LIMIT_KEYS) {
      expect(snapshot.limits[key].value).toBeNull();
      expect(snapshot.limits[key].source).toBe("unset");
    }
  });

  it("treats a blank, negative or non-numeric value as unset (a typo is not 'no limit')", () => {
    for (const bad of ["", "  ", "abc", "-5", "Infinity"]) {
      expect(parseTradingLimitValue(bad)).toBeNull();
    }
    const snapshot = resolveTradingLimits({
      env: { TRADING_LIMIT_MAX_DAILY_ORDERS: "not-a-number" } as any,
      readSetting: settingsReader({}),
    });
    expect(snapshot.limits.maxDailyOrders.source).toBe("unset");
  });

  it("accepts zero as a real limit", () => {
    expect(parseTradingLimitValue("0")).toBe(0);
    const snapshot = resolveTradingLimits({
      readSetting: settingsReader({
        [TRADING_LIMITS_SETTING_KEY]: JSON.stringify({ cancelMaxCount: 0 }),
      }),
    });
    expect(snapshot.limits.cancelMaxCount.value).toBe(0);
  });

  it("gives the session window a bounded default and says it is the default", () => {
    const snapshot = resolveTradingLimits({ readSetting: settingsReader({}) });
    expect(snapshot.sessionWindow).toMatchObject({
      startMinuteEt: 570,
      endMinuteEt: 960,
      extendedHours: false,
      source: "default",
    });
  });

  it("derives one env var per key, with no hand-written list to drift", () => {
    expect(tradingLimitEnvVar("maxNotionalPerTicker")).toBe("TRADING_LIMIT_MAX_NOTIONAL_PER_TICKER");
    expect(tradingLimitEnvVar("maxOpenOrdersTotal")).toBe("TRADING_LIMIT_MAX_OPEN_ORDERS_TOTAL");
    expect(tradingLimitEnvVar("cancelMaxCount")).toBe("TRADING_LIMIT_CANCEL_MAX_COUNT");
    for (const key of TRADING_LIMIT_KEYS) {
      expect(tradingLimitEnvVar(key)).toMatch(/^TRADING_LIMIT_[A-Z0-9_]+$/);
    }
  });
});

describe("#3888 — the validator matrix", () => {
  const limits = resolveTradingLimits({
    readSetting: settingsReader({
      [TRADING_LIMITS_SETTING_KEY]: JSON.stringify({
        maxNotionalPerTicker: 5000,
        maxOpenOrdersPerTicker: 3,
        cancelMaxCount: 10,
      }),
    }),
  });

  it("allows a request inside the limit", () => {
    expect(evaluateTradingLimit(limits, { key: "maxOpenOrdersPerTicker", requested: 1, used: 1 })).toEqual({
      allowed: true,
    });
  });

  it("allows the exact boundary (used + requested === limit)", () => {
    expect(evaluateTradingLimit(limits, { key: "maxOpenOrdersPerTicker", requested: 1, used: 2 }).allowed).toBe(true);
    expect(evaluateTradingLimit(limits, { key: "maxNotionalPerTicker", requested: 1000, used: 4000 }).allowed).toBe(true);
  });

  it("refuses past the limit with the limit, value, usage and request", () => {
    const verdict = evaluateTradingLimit(limits, { key: "maxNotionalPerTicker", requested: 1200, used: 4980 });
    expect(verdict).toMatchObject({
      allowed: false,
      code: "limit_exceeded",
      limit: "maxNotionalPerTicker",
      limitValue: 5000,
      used: 4980,
      requested: 1200,
    });
    expect(verdict.message).toContain("$5,000");
  });

  it("refuses an unset limit, naming the setting and env var to set", () => {
    const verdict = evaluateTradingLimit(limits, { key: "maxRungsPerLadder", requested: 1 });
    expect(verdict.code).toBe("limit_not_configured");
    expect(verdict.message).toContain("trading:limits");
    expect(verdict.message).toContain("TRADING_LIMIT_MAX_RUNGS_PER_LADDER");
  });

  it("refuses a non-numeric request instead of coercing it to zero", () => {
    const verdict = evaluateTradingLimit(limits, { key: "maxOpenOrdersPerTicker", requested: Number.NaN });
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toContain("not a usable number");
  });

  it("reports the first refusal of a batch", () => {
    const verdict = evaluateTradingLimits(limits, [
      { key: "maxOpenOrdersPerTicker", requested: 1 },
      { key: "maxRungsPerLadder", requested: 6 },
      { key: "cancelMaxCount", requested: 99 },
    ]);
    expect(verdict.limit).toBe("maxRungsPerLadder");
  });

  it("formats a refusal in the shape #3889 quotes back", () => {
    const verdict = evaluateTradingLimit(limits, { key: "maxNotionalPerTicker", requested: 1200, used: 4980 });
    expect(describeTradingLimitRefusal(verdict, "budget_exhausted")).toBe(
      "budget_exhausted (maxNotionalPerTicker @ $5,000; used $4,980; requested $1,200)",
    );
    expect(describeTradingLimitRefusal(evaluateTradingLimit(limits, { key: "maxDailyOrders", requested: 1 }))).toBe(
      "limit_not_configured (maxDailyOrders unset; requested 1)",
    );
  });

  it("formats money keys in dollars and count keys as counts", () => {
    expect(formatTradingLimitAmount("maxDailyNotional", 2500)).toBe("$2,500");
    expect(formatTradingLimitAmount("maxDailyOrders", 25)).toBe("25");
    expect(formatTradingLimitAmount("maxDailyOrders", null)).toBe("not configured");
  });
});

describe("#3888 — a limit change is persisted, recorded and explainable", () => {
  function store() {
    const values: Record<string, string> = {};
    return {
      values,
      readSetting: (key: string) => values[key] ?? null,
      writeSetting: (key: string, value: string) => {
        values[key] = value;
      },
    };
  }

  it("writes the account setting and reports before/after", () => {
    const s = store();
    s.values[TRADING_LIMITS_SETTING_KEY] = JSON.stringify({ maxRungsPerLadder: 3 });
    const result = applyTradingLimitChange({
      key: "maxRungsPerLadder",
      value: 6,
      readSetting: s.readSetting,
      writeSetting: s.writeSetting,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toMatchObject({
      key: "maxRungsPerLadder",
      symbol: null,
      before: 3,
      after: 6,
      settingKey: TRADING_LIMITS_SETTING_KEY,
    });
    expect(resolveTradingLimits({ readSetting: s.readSetting }).limits.maxRungsPerLadder.value).toBe(6);
  });

  it("writes a per-ticker change into the ticker's own key", () => {
    const s = store();
    const result = applyTradingLimitChange({
      key: "maxNotionalPerTicker",
      value: 2500,
      symbol: "aapl",
      readSetting: s.readSetting,
      writeSetting: s.writeSetting,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change.settingKey).toBe("trading:limits:AAPL");
    const limits = resolveTradingLimits({ symbol: "AAPL", readSetting: s.readSetting });
    expect(limits.limits.maxNotionalPerTicker).toMatchObject({ value: 2500, source: "ticker-override" });
    // Another ticker is unaffected: the override is scoped, not global.
    expect(resolveTradingLimits({ symbol: "MSFT", readSetting: s.readSetting }).limits.maxNotionalPerTicker.value).toBeNull();
  });

  it("removes a value when given null, which makes the operation refuse", () => {
    const s = store();
    s.values[TRADING_LIMITS_SETTING_KEY] = JSON.stringify({ cancelMaxCount: 4 });
    const result = applyTradingLimitChange({
      key: "cancelMaxCount",
      value: null,
      readSetting: s.readSetting,
      writeSetting: s.writeSetting,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change.after).toBeNull();
    expect(resolveTradingLimits({ readSetting: s.readSetting }).limits.cancelMaxCount.source).toBe("unset");
  });

  it("refuses an unknown key with the accepted set", () => {
    const result = applyTradingLimitChange({ key: "maxBananas", value: 1, writeSetting: () => {} });
    expect(result).toMatchObject({ ok: false, code: "unknown_limit_key" });
    if (result.ok) return;
    expect(result.message).toContain("maxRungsPerLadder");
  });

  it("refuses an invalid value and changes nothing", () => {
    const s = store();
    s.values[TRADING_LIMITS_SETTING_KEY] = JSON.stringify({ maxRungsPerLadder: 3 });
    const result = applyTradingLimitChange({
      key: "maxRungsPerLadder",
      value: -1,
      readSetting: s.readSetting,
      writeSetting: s.writeSetting,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_limit_value" });
    expect(JSON.parse(s.values[TRADING_LIMITS_SETTING_KEY]).maxRungsPerLadder).toBe(3);
  });

  it("refuses to pretend it changed anything without a settings writer", () => {
    const result = applyTradingLimitChange({ key: "maxRungsPerLadder", value: 3 });
    expect(result).toMatchObject({ ok: false, code: "limit_write_unavailable" });
  });
});

describe("#3888 — the read surface", () => {
  function routeContext(values: Record<string, string>) {
    const audits: Array<{ type: string; payload: any }> = [];
    return {
      audits,
      ctx: {
        env: { TRADING_LIMIT_MAX_DAILY_ORDERS: "25" } as any,
        readSettingRaw: (key: string) => values[key] ?? null,
        writeSetting: (key: string, value: string) => {
          values[key] = value;
        },
        audit: (type: string, _agent: any, payload: any) => {
          audits.push({ type, payload });
        },
      },
    };
  }

  it("returns the effective values with provenance for a symbol", async () => {
    const { ctx } = routeContext({ "trading:limits:AAPL": JSON.stringify({ maxRungsPerLadder: 2 }) });
    const response = await handleBrokerLimitRoutes(
      new Request("https://x/api/broker/limits?symbol=AAPL"),
      new URL("https://x/api/broker/limits?symbol=AAPL"),
      "/api/broker/limits",
      ctx,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as any;
    expect(body.brokerLimits.symbol).toBe("AAPL");
    expect(body.brokerLimits.limits.maxRungsPerLadder).toMatchObject({ value: 2, source: "ticker-override" });
    expect(body.brokerLimits.limits.maxDailyOrders).toMatchObject({ value: 25, source: "env" });
    expect(body.brokerLimits.limits.maxOpenOrdersTotal.source).toBe("unset");
  });

  it("persists a POST and audits who changed what, from what to what", async () => {
    const values: Record<string, string> = {};
    const { ctx, audits } = routeContext(values);
    const request = new Request("https://x/api/broker/limits", {
      method: "POST",
      headers: { "x-user-login": "analyst@example.com", "content-type": "application/json" },
      body: JSON.stringify({ key: "maxRungsPerLadder", value: 4 }),
    });
    const response = await handleBrokerLimitRoutes(
      request,
      new URL("https://x/api/broker/limits"),
      "/api/broker/limits",
      ctx,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as any;
    expect(body.change).toMatchObject({ key: "maxRungsPerLadder", before: null, after: 4 });
    expect(audits).toHaveLength(1);
    expect(audits[0].type).toBe("trading.limit_changed");
    expect(audits[0].payload).toMatchObject({
      key: "maxRungsPerLadder",
      before: null,
      after: 4,
      changedBy: "analyst@example.com",
    });
  });

  it("refuses an unknown key with 400 and the accepted set", async () => {
    const { ctx } = routeContext({});
    const request = new Request("https://x/api/broker/limits", {
      method: "POST",
      body: JSON.stringify({ key: "maxBananas", value: 1 }),
    });
    const response = await handleBrokerLimitRoutes(
      request,
      new URL("https://x/api/broker/limits"),
      "/api/broker/limits",
      ctx,
    );
    expect(response?.status).toBe(400);
    const body = (await response!.json()) as any;
    expect(body.code).toBe("unknown_limit_key");
    expect(body.accepted).toContain("cancelMaxCount");
  });

  it("leaves other paths alone", async () => {
    const { ctx } = routeContext({});
    const response = await handleBrokerLimitRoutes(
      new Request("https://x/api/broker/orders"),
      new URL("https://x/api/broker/orders"),
      "/api/broker/orders",
      ctx,
    );
    expect(response).toBeNull();
  });
});

describe("#3888 — the trading_limits tool", () => {
  it("is registered on the trade scope", () => {
    expect(McpToolFactory.getTool("trading_limits")).toBeDefined();
    expect(resolveToolScope("trading_limits")).toBe("mcp:trade");
  });

  it("resolves the caller's own settings and audits the read", async () => {
    const sql = new MockSqlStorage();
    const audits: Array<{ type: string; payload: any }> = [];
    const tool = McpToolFactory.getTool("trading_limits")!;
    const result = (await tool.execute(
      { symbol: "AAPL" },
      {
        env: { TRADING_LIMIT_CANCEL_MAX_COUNT: "12" } as any,
        orm: { getSql: () => sql } as any,
        sessionId: "s1",
        audit: (type: string, _agent: any, payload: any) => {
          audits.push({ type, payload });
        },
      } as any,
    )) as any;

    expect(result.ok).toBe(true);
    expect(result.brokerLimits.limits.cancelMaxCount).toMatchObject({ value: 12, source: "env" });
    expect(result.brokerLimits.limits.maxRungsPerLadder.source).toBe("unset");
    expect(audits.some((entry) => entry.type === "trading.limits_read")).toBe(true);
  });

  it("applies a change through the tool and audits it", async () => {
    const sql = new MockSqlStorage();
    const audits: Array<{ type: string; payload: any }> = [];
    const tool = McpToolFactory.getTool("trading_limits")!;
    const result = (await tool.execute(
      { symbol: "MSFT", apply: { key: "maxRungsPerLadder", value: 2 } },
      {
        env: {} as any,
        orm: { getSql: () => sql } as any,
        sessionId: "s1",
        audit: (type: string, _agent: any, payload: any) => {
          audits.push({ type, payload });
        },
      } as any,
    )) as any;

    expect(result.ok).toBe(true);
    expect(result.change).toMatchObject({ key: "maxRungsPerLadder", after: 2, symbol: "MSFT" });
    expect(result.brokerLimits.limits.maxRungsPerLadder).toMatchObject({ value: 2, source: "ticker-override" });
    expect(audits.some((entry) => entry.type === "trading.limit_changed")).toBe(true);
  });

  it("refuses a change when the session has no settings store", async () => {
    const tool = McpToolFactory.getTool("trading_limits")!;
    const result = (await tool.execute(
      { apply: { key: "maxRungsPerLadder", value: 2 } },
      { env: {} as any, orm: {} as any, sessionId: "s1" } as any,
    )) as any;
    expect(result).toMatchObject({ ok: false, code: "limit_write_unavailable" });
  });
});

describe("#3888 — the limits module is the only source", () => {
  it("the route delegates to it instead of resolving values inline", () => {
    const route = require("node:fs").readFileSync("src/agents/routes/brokerLimits.ts", "utf8") as string;
    expect(route).toContain("resolveTradingLimits");
    expect(route).toContain("applyTradingLimitChange");
    expect(route).not.toMatch(/maxNotionalPerTicker\s*=/);
  });

  it("the tool delegates to it too", () => {
    const tool = require("node:fs").readFileSync("src/mcps/openaimp/tradingLimitCommands.ts", "utf8") as string;
    expect(tool).toContain("resolveTradingLimits");
    expect(tool).toContain("applyTradingLimitChange");
  });

  it("no engine keeps a literal budget of its own", () => {
    // The ladder's tiers cap is a parameter today; the configured rung limit
    // is what a caller reads from this module (#3887 wires it).
    const limits = resolveTradingLimits({ readSetting: settingsReader({}) });
    expect(limits.limits.maxRungsPerLadder.value).toBeNull();
  });
});
