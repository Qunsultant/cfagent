/**
 * Issue #3398 — Stock Copilot 24-hour sessions, externalized and
 * user-decided (owner sharpening 2026-11-06: the capability must be
 * usable around the clock; what happens in each session is the
 * USER's choice via externalized settings, never a unilateral
 * system decision; a non-trading state is a named, visible state).
 *
 * Pins:
 * - The session model: pre-market / regular / after-hours / EXTO
 *   overnight windows in America/New_York, including the overnight
 *   session's midnight span and its Sunday–Thursday nights (no
 *   Friday-night or weekend session).
 * - Resolution precedence: the per-login stored setting wins, then
 *   the deployment env, then the truthful default (regular only —
 *   today's behavior until the user chooses otherwise). An explicit
 *   stored "none" is a user decision for no sessions, not a parse
 *   failure.
 * - The cycle gate: outside the enabled set the cycle is the named
 *   outside_enabled_sessions state, touches no platform, and
 *   records ONE transition record (not one per firing).
 * - Session-aware order shaping: market in regular hours; limit-only
 *   outside them, at the cycle's own reference price. A platform
 *   that cannot carry session terms refuses with the named
 *   stock_copilot_session_wire_unsupported reason — a
 *   regular-session order is never silently sent in its place.
 * - The status route reports the enabled set + current session and
 *   the named state; the control route persists the user's session
 *   choice through the settings store (fail-closed without a
 *   writer).
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import {
  runStockCopilotCycle,
  type StockCopilotDeps,
} from "../src/services/stockCopilot";
import { StockCopilotPositionStore } from "../src/services/stockCopilotStore";
import {
  copilotSessionAt,
  parseCopilotSessionList,
  resolveCopilotSessions,
  shapeCopilotSessionOrder,
  COPILOT_SESSION_SETTING_KEY,
  STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS,
  STOCK_COPILOT_SESSION_WIRE_UNSUPPORTED,
  type CopilotSessionId,
} from "../src/services/stockCopilotSessions";
import {
  handleStockCopilotRoutes,
  type StockCopilotRouteContext,
} from "../src/agents/routes/stockCopilot";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";

// ---------------------------------------------------------------------------
// Fakes (the #3391 shape, plus the session-terms capability seam)
// ---------------------------------------------------------------------------

interface FakePlatform {
  platform: any;
  placed: Array<Record<string, unknown>>;
  calls: { getPositions: number; getQuote: number; placeOrderRemote: number };
}

function createFakePlatform(opts?: { sessionOrders?: boolean }): FakePlatform {
  const placed: Array<Record<string, unknown>> = [];
  const calls = { getPositions: 0, getQuote: 0, placeOrderRemote: 0 };
  const platform: Record<string, unknown> = {
    platformId: "alpaca",
    name: "Alpaca (fake)",
    async getPositions() {
      calls.getPositions += 1;
      return {
        account: { netAccountValue: 100_000, totalAccountValue: 100_000 },
        positions: [],
      };
    },
    async getQuote(symbol: string) {
      calls.getQuote += 1;
      return { symbol, lastPrice: 500 };
    },
    async placeOrderRemote(params: Record<string, unknown>) {
      calls.placeOrderRemote += 1;
      placed.push(params);
      return {
        success: true,
        orderId: params.orderId,
        executionId: `alpaca-${placed.length}`,
        brokerOrderRef: `alpaca-${placed.length}`,
        status: "submitted",
        symbol: params.symbol,
        action: params.action,
        quantity: params.quantity,
        executionPrice: 0,
        totalSettled: 0,
        message: "submitted (fake)",
        timestamp: new Date().toISOString(),
      };
    },
  };
  if (opts?.sessionOrders) {
    platform.supportsSessionOrders = (_session: string) => true;
  }
  return { platform, placed, calls };
}

/** Sawtooth series whose latest bar is a mean-reversion entry signal
 *  (the #3391 fixture: dips to 98 recover to 101; final dip open). */
function sawtoothCloses(): number[] {
  const closes: number[] = [];
  for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
  closes.push(100, 98);
  return closes;
}

const ALL_SESSIONS: CopilotSessionId[] = [
  "pre_market",
  "regular",
  "after_hours",
  "exto",
];

/** Wed 2026-11-04 16:30 ET — after-hours. */
const AFTER_HOURS_NOW = () => new Date("2026-11-04T21:30:00Z");
/** Thu 2026-11-05 01:30 ET — EXTO overnight (Wednesday night's tail). */
const EXTO_NOW = () => new Date("2026-11-05T06:30:00Z");
/** Wed 2026-11-04 05:00 ET — pre-market. */
const PRE_MARKET_NOW = () => new Date("2026-11-04T10:00:00Z");
/** Sat 2026-11-07 10:00 ET — no session exists. */
const SATURDAY_NOW = () => new Date("2026-11-07T15:00:00Z");

function baseDeps(overrides: Partial<StockCopilotDeps>): StockCopilotDeps {
  return {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    positions: createInMemoryStockCopilotPositionPort(),
    userLogin: "owner",
    platform: createFakePlatform().platform,
    selection: {
      resolved: true,
      selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
    },
    loadBars: async () => sawtoothCloses(),
    now: AFTER_HOURS_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The session model
// ---------------------------------------------------------------------------

describe("copilotSessionAt — session windows (America/New_York)", () => {
  const cases: Array<[string, CopilotSessionId | null]> = [
    // Wednesday boundaries (EST, UTC-5).
    ["2026-11-04T08:59:00Z", "exto"], // 03:59 — Tuesday night's tail
    ["2026-11-04T09:00:00Z", "pre_market"], // 04:00
    ["2026-11-04T14:29:00Z", "pre_market"], // 09:29
    ["2026-11-04T14:30:00Z", "regular"], // 09:30
    ["2026-11-04T20:59:00Z", "regular"], // 15:59
    ["2026-11-04T21:00:00Z", "after_hours"], // 16:00
    ["2026-11-05T00:59:00Z", "after_hours"], // 19:59
    ["2026-11-05T01:00:00Z", "exto"], // 20:00 — overnight begins
    ["2026-11-05T06:30:00Z", "exto"], // Thu 01:30 — Wednesday night's tail
    // The overnight session runs Sunday–Thursday nights only.
    ["2026-11-07T02:00:00Z", null], // Fri 21:00 — no Friday-night session
    ["2026-11-07T15:00:00Z", null], // Saturday
    ["2026-11-08T15:00:00Z", null], // Sunday daytime
    ["2026-11-09T01:30:00Z", "exto"], // Sun 20:30 — the week's first session
    ["2026-11-09T08:59:00Z", "exto"], // Mon 03:59 — Sunday night's tail
    ["2026-11-06T13:30:00Z", "pre_market"], // Fri 08:30
    // DST: July is EDT (UTC-4) — the Intl path, not a fixed offset.
    ["2026-07-15T13:30:00Z", "regular"], // Wed 09:30 EDT
    ["2026-07-15T08:00:00Z", "pre_market"], // Wed 04:00 EDT
  ];
  for (const [iso, expected] of cases) {
    it(`${iso} is ${expected ?? "no session"}`, () => {
      expect(copilotSessionAt(new Date(iso))).toBe(expected);
    });
  }
});

describe("session setting — parse and resolve (AOP precedence)", () => {
  it("parses a comma list case-insensitively, in canonical order, dropping unknown tokens", () => {
    expect(parseCopilotSessionList("exto, REGULAR ,bogus")).toEqual([
      "regular",
      "exto",
    ]);
    expect(parseCopilotSessionList("after_hours")).toEqual(["after_hours"]);
  });

  it("distinguishes an explicit 'none' decision from no usable value", () => {
    expect(parseCopilotSessionList("none")).toEqual([]);
    expect(parseCopilotSessionList("")).toBeNull();
    expect(parseCopilotSessionList("bogus")).toBeNull();
    expect(parseCopilotSessionList(null)).toBeNull();
    expect(parseCopilotSessionList(undefined)).toBeNull();
  });

  it("defaults to all four sessions (#3541): 24/7 autonomous trading", () => {
    expect(resolveCopilotSessions({})).toEqual(ALL_SESSIONS);
    expect(resolveCopilotSessions({ env: {} })).toEqual(ALL_SESSIONS);
    expect(resolveCopilotSessions({ readSettingRaw: () => null, env: {} })).toEqual(
      ALL_SESSIONS,
    );
  });

  it("supports 'all' or '*' session aliases", () => {
    expect(parseCopilotSessionList("all")).toEqual(ALL_SESSIONS);
    expect(parseCopilotSessionList("*")).toEqual(ALL_SESSIONS);
  });

  it("supports STOCK_COPILOT_IGNORE_SESSIONS and STOCK_COPILOT_FORCE_ALL_SESSIONS", () => {
    expect(
      resolveCopilotSessions({
        env: { STOCK_COPILOT_IGNORE_SESSIONS: "true" },
        readSettingRaw: () => "none",
      }),
    ).toEqual(ALL_SESSIONS);
    expect(
      resolveCopilotSessions({
        env: { STOCK_COPILOT_FORCE_ALL_SESSIONS: "true" },
        readSettingRaw: () => "none",
      }),
    ).toEqual(ALL_SESSIONS);
  });

  it("env is the deployment default; the stored per-login setting wins over it", () => {
    const env = { STOCK_COPILOT_SESSIONS: "regular,exto" };
    expect(resolveCopilotSessions({ env })).toEqual(["regular", "exto"]);
    expect(
      resolveCopilotSessions({
        env,
        readSettingRaw: (key) => (key === COPILOT_SESSION_SETTING_KEY ? "pre_market" : null),
      }),
    ).toEqual(["pre_market"]);
  });

  it("an explicit stored 'none' is honored — the env does not override the user's decision", () => {
    expect(
      resolveCopilotSessions({
        env: { STOCK_COPILOT_SESSIONS: "regular,exto" },
        readSettingRaw: () => "none",
      }),
    ).toEqual([]);
  });

  it("an unusable stored value falls through to the env, then the default", () => {
    expect(
      resolveCopilotSessions({
        env: { STOCK_COPILOT_SESSIONS: "exto" },
        readSettingRaw: () => "garbage",
      }),
    ).toEqual(["exto"]);
  });

  it("the setting key is the copilot's own namespaced key", () => {
    expect(COPILOT_SESSION_SETTING_KEY).toBe("stock_copilot:sessions");
  });
});

describe("shapeCopilotSessionOrder — per-session order policy", () => {
  it("regular session: market orders, no session terms needed", () => {
    expect(shapeCopilotSessionOrder("regular", 98)).toEqual({
      orderType: "MARKET",
      requiresSessionTerms: false,
    });
  });

  it("pre-market, after-hours and EXTO are limit-only at the reference price", () => {
    for (const session of ["pre_market", "after_hours", "exto"] as const) {
      expect(shapeCopilotSessionOrder(session, 98)).toEqual({
        orderType: "LIMIT",
        limitPrice: 98,
        requiresSessionTerms: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The cycle gate
// ---------------------------------------------------------------------------

describe("stock copilot cycle — session gate", () => {
  it("outside every session (Saturday): named state, zero platform calls, one transition record", async () => {
    const fake = createFakePlatform();
    const activity = createInMemoryStockCopilotActivityPort();
    const deps = baseDeps({
      platform: fake.platform,
      activity,
      now: SATURDAY_NOW,
    });
    const first = await runStockCopilotCycle(deps);
    expect(first.status).toBe("outside_enabled_sessions");
    expect(first.session).toBeNull();
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);

    const second = await runStockCopilotCycle(deps);
    expect(second.status).toBe("outside_enabled_sessions");
    const records = activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "outside_sessions",
      detail: `${STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS}:none`,
      session: null,
    });
  });

  it("in a session the user has not enabled: named state naming the session, no record spam on repeat", async () => {
    const fake = createFakePlatform();
    const activity = createInMemoryStockCopilotActivityPort();
    const deps = baseDeps({
      platform: fake.platform,
      activity,
      now: PRE_MARKET_NOW,
      enabledSessions: ["regular"],
    });
    const result = await runStockCopilotCycle(deps);
    expect(result.status).toBe("outside_enabled_sessions");
    expect(result.session).toBe("pre_market");
    expect(result.enabledSessions).toEqual(["regular"]);
    expect(fake.calls.placeOrderRemote).toBe(0);
    await runStockCopilotCycle(deps);
    const records = activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "outside_sessions",
      detail: `${STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS}:pre_market`,
      session: "pre_market",
    });
  });

  it("an empty enabled set is the user's decision: every firing is the named outside state", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      baseDeps({ platform: fake.platform, enabledSessions: [] }),
    );
    expect(result.status).toBe("outside_enabled_sessions");
    expect(result.session).toBe("after_hours");
    expect(fake.calls.placeOrderRemote).toBe(0);
  });

  it("the env setting reaches the cycle when no host-resolved set is passed", async () => {
    const fake = createFakePlatform({ sessionOrders: true });
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          STOCK_COPILOT_SESSIONS: "regular,after_hours",
        } as any,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Session-aware order placement
// ---------------------------------------------------------------------------

describe("stock copilot cycle — session-aware orders", () => {
  it("after-hours entry on a session-capable platform: LIMIT at the reference price, session recorded on the position", async () => {
    const fake = createFakePlatform({ sessionOrders: true });
    const positions = createInMemoryStockCopilotPositionPort();
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        positions,
        enabledSessions: ALL_SESSIONS,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.session).toBe("after_hours");
    expect(result.entriesPlaced).toBe(1);
    expect(fake.placed).toHaveLength(1);
    expect(fake.placed[0]).toMatchObject({
      symbol: "TEST",
      action: "BUY",
      orderType: "LIMIT",
      limitPrice: 98,
    });
    const open = await new StockCopilotPositionStore(positions).listOpenPositions("owner");
    expect(open).toHaveLength(1);
    expect(open[0].entrySession).toBe("after_hours");
    expect(open[0].entryOrderType).toBe("LIMIT");
  });

  it("EXTO entry on a session-capable platform: LIMIT order in the overnight session", async () => {
    const fake = createFakePlatform({ sessionOrders: true });
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        enabledSessions: ALL_SESSIONS,
        now: EXTO_NOW,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.session).toBe("exto");
    expect(result.entriesPlaced).toBe(1);
    expect(fake.placed[0]).toMatchObject({ orderType: "LIMIT", limitPrice: 98 });
  });

  it("regular session entry is unchanged: MARKET order, no limit price", async () => {
    const fake = createFakePlatform({ sessionOrders: true });
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        enabledSessions: ALL_SESSIONS,
        now: () => new Date("2026-11-04T15:00:00Z"), // Wed 10:00 ET
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.entriesPlaced).toBe(1);
    expect(fake.placed[0]).toMatchObject({ orderType: "MARKET" });
    expect(fake.placed[0].limitPrice).toBeUndefined();
  });

  it("a platform that cannot carry session terms refuses by name — nothing is silently sent as a regular order", async () => {
    const fake = createFakePlatform(); // no supportsSessionOrders
    const activity = createInMemoryStockCopilotActivityPort();
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        activity,
        enabledSessions: ALL_SESSIONS,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(0);
    expect(fake.placed).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].reason).toBe(
      `${STOCK_COPILOT_SESSION_WIRE_UNSUPPORTED}: after_hours`,
    );
    const records = activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("no_trade");
    expect(records[0].detail).toContain(STOCK_COPILOT_SESSION_WIRE_UNSUPPORTED);
    expect(records[0].session).toBe("after_hours");
  });

  it("exit in an enabled after-hours session on a capable platform: LIMIT sell at the decision price", async () => {
    const fake = createFakePlatform({ sessionOrders: true });
    const positions = createInMemoryStockCopilotPositionPort();
    const store = new StockCopilotPositionStore(positions);
    await store.openPosition({
      userLogin: "owner",
      symbol: "TEST",
      strategy: "mean_reversion",
      quantity: 10,
      entryPrice: 98,
      stopPrice: 93.1,
      targetPrice: 107.8,
      brokerOrderRef: "alpaca-entry",
    });
    const closes = [...Array.from({ length: 15 }, () => 99), 101];
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        positions,
        enabledSessions: ALL_SESSIONS,
        universe: [],
        loadBars: async () => closes,
      }),
    );
    expect(result.exitsPlaced).toBe(1);
    expect(fake.placed).toHaveLength(1);
    expect(fake.placed[0]).toMatchObject({
      symbol: "TEST",
      action: "SELL",
      orderType: "LIMIT",
      limitPrice: 101,
    });
  });

  it("exit in an enabled session on an incapable platform: named error, position stays open", async () => {
    const fake = createFakePlatform(); // no supportsSessionOrders
    const positions = createInMemoryStockCopilotPositionPort();
    const store = new StockCopilotPositionStore(positions);
    await store.openPosition({
      userLogin: "owner",
      symbol: "TEST",
      strategy: "mean_reversion",
      quantity: 10,
      entryPrice: 98,
      stopPrice: 93.1,
      targetPrice: 107.8,
      brokerOrderRef: "alpaca-entry",
    });
    const closes = [...Array.from({ length: 15 }, () => 99), 101];
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        positions,
        enabledSessions: ALL_SESSIONS,
        universe: [],
        loadBars: async () => closes,
      }),
    );
    expect(result.exitsPlaced).toBe(0);
    expect(fake.placed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      symbol: "TEST",
      stage: "exit_order",
      message: `${STOCK_COPILOT_SESSION_WIRE_UNSUPPORTED}: after_hours`,
    });
    const open = await store.listOpenPositions("owner");
    expect(open).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Status + control routes: the session set is visible and user-writable
// ---------------------------------------------------------------------------

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

async function alpacaCommercial(): Promise<InMemoryCommercialAdapter> {
  const commercial = new InMemoryCommercialAdapter();
  await commercial.setTenantProviders(resolveIaaaTenant({}), {
    dataProviderId: "etrade",
    brokerId: "alpaca",
  });
  return commercial;
}

async function makeRouteCtx(overrides: Partial<StockCopilotRouteContext> = {}) {
  const sql = new SqliteTestStorage();
  const written: Array<[string, string]> = [];
  const ctx: StockCopilotRouteContext = {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as StockCopilotRouteContext["env"],
    sql: sql as never,
    getScreenerExecutionContext: async () => ({
      userLogin: "owner",
      environment: "TEST" as const,
    }),
    readSettingRaw: (key: string) =>
      key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : null,
    writeSetting: (key: string, value: string) => {
      written.push([key, value]);
    },
    commercial: await alpacaCommercial(),
    audit: vi.fn(),
    ...overrides,
  };
  return { ctx, written };
}

function routeReq(method: string, path: string, body?: unknown): Request {
  return new Request(`https://agent.openaimp.com${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callRoute(
  ctx: StockCopilotRouteContext,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  return handleStockCopilotRoutes(request, url, url.pathname, "sess", ctx);
}

describe("stock copilot routes — sessions surface", () => {
  it("status reports the enabled set and current session; the named state follows them", async () => {
    const { ctx } = await makeRouteCtx();
    const res = await callRoute(ctx, routeReq("GET", "/api/stock-copilot/status"));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.enabledSessions).toEqual(ALL_SESSIONS);
    expect(
      body.currentSession === null ||
        ALL_SESSIONS.includes(body.currentSession),
    ).toBe(true);
    const expectLive =
      body.currentSession !== null &&
      body.enabledSessions.includes(body.currentSession);
    expect(body.status).toBe(expectLive ? "live" : "outside_enabled_sessions");
  });

  it("status reflects the stored per-login session setting", async () => {
    const { ctx } = await makeRouteCtx({
      readSettingRaw: (key: string) =>
        key === COPILOT_SESSION_SETTING_KEY
          ? "regular,exto"
          : key === BROKER_ENVIRONMENT_SETTING_KEY
            ? "TEST"
            : null,
    });
    const res = await callRoute(ctx, routeReq("GET", "/api/stock-copilot/status"));
    const body = (await res!.json()) as any;
    expect(body.enabledSessions).toEqual(["regular", "exto"]);
  });

  it("control writes the user's session choice through the settings store, canonically ordered, and audits it", async () => {
    const { ctx, written } = await makeRouteCtx();
    const res = await callRoute(
      ctx,
      routeReq("POST", "/api/stock-copilot/control", {
        sessions: ["exto", "regular"],
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body).toMatchObject({ ok: true, sessions: ["regular", "exto"] });
    expect(written).toEqual([[COPILOT_SESSION_SETTING_KEY, "regular,exto"]]);
    expect(ctx.audit).toHaveBeenCalledWith(
      "stock_copilot.control",
      "orchestrator",
      expect.objectContaining({ sessions: ["regular", "exto"] }),
    );
  });

  it("control with an empty session set writes the explicit 'none' decision", async () => {
    const { ctx, written } = await makeRouteCtx();
    const res = await callRoute(
      ctx,
      routeReq("POST", "/api/stock-copilot/control", { sessions: [] }),
    );
    expect(res?.status).toBe(200);
    expect(written).toEqual([[COPILOT_SESSION_SETTING_KEY, "none"]]);
  });

  it("control rejects an unknown session id with a 400 and writes nothing", async () => {
    const { ctx, written } = await makeRouteCtx();
    const res = await callRoute(
      ctx,
      routeReq("POST", "/api/stock-copilot/control", { sessions: ["brunch"] }),
    );
    expect(res?.status).toBe(400);
    expect(written).toEqual([]);
  });

  it("control fails closed (500) when the host provides no settings writer", async () => {
    const { ctx } = await makeRouteCtx({ writeSetting: undefined });
    const res = await callRoute(
      ctx,
      routeReq("POST", "/api/stock-copilot/control", { sessions: ["regular"] }),
    );
    expect(res?.status).toBe(500);
  });

  it("control still accepts the pause write on its own (the #3422 contract)", async () => {
    const { ctx, written } = await makeRouteCtx();
    const res = await callRoute(
      ctx,
      routeReq("POST", "/api/stock-copilot/control", { paused: true }),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body).toMatchObject({ ok: true, paused: true });
    expect(written).toEqual([]);
  });
});
