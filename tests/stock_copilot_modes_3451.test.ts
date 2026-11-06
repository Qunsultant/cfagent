/**
 * Issue #3451 — Stock Copilot conformance to the selectable trading
 * modes (PAPER or LIVE; one active broker, one active mode).
 *
 * The defect this slice fixes: the cycle took its Alpaca environment
 * from the screener execution context's ENVIRONMENT snapshot
 * (overrideEnv), so a PROD context refused every cycle with
 * stock_copilot_live_environment_refused even when the panel menu's
 * trading-mode selection was PAPER. Environment is not trading mode.
 *
 * Pins:
 * - The selection resolver reads the platform's OWN selection model:
 *   the active broker from the tenant provider settings (data layer,
 *   #3233) and the active mode from the per-login stored trade
 *   environment (#2482/#3382: stored `etrade:environment`; unset ⇒
 *   TEST/paper — live is an explicit act), mapped through the broker
 *   catalog (#3232). An unreadable broker store resolves to
 *   "unresolved" — fail closed, never a guessed mode.
 * - The cycle's behavior matrix, all fail-closed and named:
 *   unresolved ⇒ stock_copilot_mode_unresolved, zero platform calls;
 *   active broker ≠ alpaca ⇒ inactive (stock_copilot_inactive_broker),
 *   zero platform calls; guard disagreement between the selected mode
 *   and the platform resolver's base ⇒ stock_copilot_mode_mismatch,
 *   zero orders; paper ⇒ paper trades; live ⇒ live trades.
 * - The host regression: a PROD screener execution context with the
 *   menu selection on TEST/paper and Alpaca active builds the
 *   platform for TEST and the cycle trades — the context's
 *   environment no longer influences the copilot's mode at all.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  resolveCopilotTradingSelection,
  type CopilotSelectionResolution,
} from "../src/agents/copilotTradingMode";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotControlPort,
  createInMemoryStockCopilotPositionPort,
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import {
  runStockCopilotCycle,
  STOCK_COPILOT_INACTIVE_BROKER,
  STOCK_COPILOT_MODE_MISMATCH,
  STOCK_COPILOT_MODE_UNRESOLVED,
  type StockCopilotDeps,
} from "../src/services/stockCopilot";
import {
  declareStockCopilotTasks,
  STOCK_COPILOT_TASK_ID,
  type ScheduledTasksCopilotContext,
} from "../src/agents/orchestrator/scheduledTasksCopilot";
import { TradingPlatformRegistry } from "../src/trading/registry";

// ---------------------------------------------------------------------------
// Fakes (mirroring tests/stock_copilot_3391.test.ts)
// ---------------------------------------------------------------------------

interface FakePlatform {
  platform: any;
  placed: Array<Record<string, unknown>>;
  calls: { getPositions: number; getQuote: number; placeOrderRemote: number };
}

function createFakePlatform(opts?: { nav?: number }): FakePlatform {
  const placed: Array<Record<string, unknown>> = [];
  const calls = { getPositions: 0, getQuote: 0, placeOrderRemote: 0 };
  const platform = {
    platformId: "alpaca",
    name: "Alpaca (fake)",
    async getPositions() {
      calls.getPositions += 1;
      return {
        account: { netAccountValue: opts?.nav ?? 100_000, totalAccountValue: opts?.nav ?? 100_000 },
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
  return { platform, placed, calls };
}

/** A Wednesday inside market hours (15:00 UTC = 10:00 ET, EST). */
const MARKET_OPEN_NOW = () => new Date("2026-11-04T15:00:00Z");

/** Sawtooth series the mean-reversion family enters on (see #3391 tests). */
function sawtoothCloses(): number[] {
  const closes: number[] = [];
  for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
  closes.push(100, 98);
  return closes;
}

const PAPER_SELECTION: CopilotSelectionResolution = {
  resolved: true,
  selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
};
const LIVE_SELECTION: CopilotSelectionResolution = {
  resolved: true,
  selection: { brokerId: "alpaca", environment: "PROD", mode: "live" },
};
const ETRADE_SELECTION: CopilotSelectionResolution = {
  resolved: true,
  selection: { brokerId: "etrade", environment: "TEST", mode: "paper" },
};
const UNRESOLVED: CopilotSelectionResolution = { resolved: false };

function modeDeps(overrides: Partial<StockCopilotDeps>): StockCopilotDeps {
  return {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    positions: createInMemoryStockCopilotPositionPort(),
    activity: createInMemoryStockCopilotActivityPort(),
    control: createInMemoryStockCopilotControlPort(),
    userLogin: "owner",
    platform: createFakePlatform().platform,
    selection: PAPER_SELECTION,
    loadBars: async () => sawtoothCloses(),
    now: MARKET_OPEN_NOW,
    universe: ["TEST"],
    strategies: ["mean_reversion"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The selection resolver — the platform's own selection model
// ---------------------------------------------------------------------------

async function commercialWithBroker(brokerId: string): Promise<InMemoryCommercialAdapter> {
  const commercial = new InMemoryCommercialAdapter();
  await commercial.setTenantProviders(resolveIaaaTenant({}), {
    dataProviderId: "etrade",
    brokerId,
  });
  return commercial;
}

const readerWith =
  (stored: string | null) =>
  (key: string): string | null =>
    key === BROKER_ENVIRONMENT_SETTING_KEY ? stored : null;

describe("copilot trading-mode selection resolver (#3451)", () => {
  it("alpaca active + stored PROD ⇒ the LIVE selection", async () => {
    const res = await resolveCopilotTradingSelection({
      env: {},
      readSettingRaw: readerWith("PROD"),
      commercial: await commercialWithBroker("alpaca"),
    });
    expect(res).toEqual({
      resolved: true,
      selection: { brokerId: "alpaca", environment: "PROD", mode: "live" },
    });
  });

  it("alpaca active + stored TEST ⇒ the PAPER selection", async () => {
    const res = await resolveCopilotTradingSelection({
      env: {},
      readSettingRaw: readerWith("TEST"),
      commercial: await commercialWithBroker("alpaca"),
    });
    expect(res).toEqual({
      resolved: true,
      selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
    });
  });

  it("no stored setting ⇒ TEST/paper (the #3382 trade default — live is an explicit act)", async () => {
    const res = await resolveCopilotTradingSelection({
      env: {},
      readSettingRaw: readerWith(null),
      commercial: await commercialWithBroker("alpaca"),
    });
    expect(res).toEqual({
      resolved: true,
      selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
    });
  });

  it("no tenant row ⇒ the tenant default broker resolves (etrade); the mode still follows the setting", async () => {
    const res = await resolveCopilotTradingSelection({
      env: {},
      readSettingRaw: readerWith("PROD"),
      commercial: new InMemoryCommercialAdapter(),
    });
    expect(res).toEqual({
      resolved: true,
      selection: { brokerId: "etrade", environment: "PROD", mode: "live" },
    });
  });

  it("broker store unbound (null) ⇒ unresolved — fail closed, never a guessed mode", async () => {
    const res = await resolveCopilotTradingSelection({
      env: {},
      readSettingRaw: readerWith("TEST"),
      commercial: null,
    });
    expect(res).toEqual({ resolved: false });
  });

  it("broker store throws ⇒ unresolved — fail closed", async () => {
    const broken = {
      getTenantProviders: async () => {
        throw new Error("d1 unavailable");
      },
    } as never;
    const res = await resolveCopilotTradingSelection({
      env: {},
      readSettingRaw: readerWith("TEST"),
      commercial: broken,
    });
    expect(res).toEqual({ resolved: false });
  });
});

// ---------------------------------------------------------------------------
// The cycle's behavior matrix
// ---------------------------------------------------------------------------

describe("stock copilot cycle — mode matrix (#3451)", () => {
  it("REGRESSION: paper selection ⇒ the cycle evaluates and trades paper (no refusal)", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      modeDeps({ platform: fake.platform, selection: PAPER_SELECTION }),
    );
    expect(result.status).toBe("ok");
    expect(result.refusal).toBeUndefined();
    expect(result.entriesPlaced).toBe(1);
    expect(fake.placed).toHaveLength(1);
    expect(fake.placed[0]).toMatchObject({ action: "BUY", symbol: "TEST" });
  });

  it("live selection + live-resolved env ⇒ the cycle evaluates and trades live", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      modeDeps({
        platform: fake.platform,
        selection: LIVE_SELECTION,
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          ALPACA_BASE_URL: "https://api.alpaca.markets",
        } as any,
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(1);
    expect(fake.calls.placeOrderRemote).toBe(1);
  });

  it("live selection + paper pin ⇒ guard disagreement refuses, zero platform calls, refused record", async () => {
    const fake = createFakePlatform();
    const activity = createInMemoryStockCopilotActivityPort();
    const result = await runStockCopilotCycle(
      modeDeps({
        platform: fake.platform,
        selection: LIVE_SELECTION,
        activity,
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          ALPACA_TRADING_TYPE: "paper",
        } as any,
      }),
    );
    expect(result.status).toBe("refused_mode_mismatch");
    expect(result.refusal).toBe(STOCK_COPILOT_MODE_MISMATCH);
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
    const records = activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "refused", detail: STOCK_COPILOT_MODE_MISMATCH });
  });

  it("paper selection + live pin ⇒ guard disagreement refuses, zero platform calls", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      modeDeps({
        platform: fake.platform,
        selection: PAPER_SELECTION,
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          ALPACA_TRADING_TYPE: "live",
        } as any,
      }),
    );
    expect(result.status).toBe("refused_mode_mismatch");
    expect(result.refusal).toBe(STOCK_COPILOT_MODE_MISMATCH);
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
  });

  it("paper selection + a live base URL in env ⇒ the selection outranks base-URL inference (#3272) and the cycle trades paper", async () => {
    // The platform resolver's precedence is pin → selection →
    // inference: with a selection in hand, ALPACA_BASE_URL never
    // decides the mode (it only did under the old wiring, when the
    // cycle passed the screener environment or nothing at all).
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      modeDeps({
        platform: fake.platform,
        selection: PAPER_SELECTION,
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          ALPACA_BASE_URL: "https://api.alpaca.markets",
        } as any,
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(1);
  });

  it("unresolved selection ⇒ stock_copilot_mode_unresolved, zero platform calls, refused record", async () => {
    const fake = createFakePlatform();
    const activity = createInMemoryStockCopilotActivityPort();
    const result = await runStockCopilotCycle(
      modeDeps({ platform: fake.platform, selection: UNRESOLVED, activity }),
    );
    expect(result.status).toBe("mode_unresolved");
    expect(result.refusal).toBe(STOCK_COPILOT_MODE_UNRESOLVED);
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
    expect(fake.calls.getQuote).toBe(0);
    const records = activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "refused", detail: STOCK_COPILOT_MODE_UNRESOLVED });
  });

  it("active broker ≠ alpaca ⇒ inactive, zero platform calls, inactive record naming the state", async () => {
    const fake = createFakePlatform();
    const activity = createInMemoryStockCopilotActivityPort();
    const result = await runStockCopilotCycle(
      modeDeps({ platform: fake.platform, selection: ETRADE_SELECTION, activity }),
    );
    expect(result.status).toBe("inactive_broker");
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
    expect(fake.calls.getQuote).toBe(0);
    const records = activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "inactive", detail: STOCK_COPILOT_INACTIVE_BROKER });
  });

  it("flag OFF still wins over every selection gate: disabled, zero calls, no record", async () => {
    const fake = createFakePlatform();
    const activity = createInMemoryStockCopilotActivityPort();
    const result = await runStockCopilotCycle(
      modeDeps({
        platform: fake.platform,
        selection: UNRESOLVED,
        activity,
        env: {} as any,
      }),
    );
    expect(result.status).toBe("disabled");
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(activity.listActivity("owner", 10)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The host regression — the screener context's environment is not a mode
// ---------------------------------------------------------------------------

vi.mock("../src/services/marketDataResearch", () => ({
  MarketDataResearchService: class {
    async getHistoricalBars(): Promise<Array<{ close: number }>> {
      return sawtoothCloses().map((close) => ({ close }));
    }
  },
}));

/** Minimal SqlStorage shim over node:sqlite (same shape as #2528's harness). */
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

describe("stock copilot host — mode conformance (#3451)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function runDeclaredCycle(opts: {
    storedEnvironment: string | null;
    commercial: InMemoryCommercialAdapter | null;
    fake: FakePlatform;
  }) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T15:00:00Z")); // Wed, market open
    const sql = new SqliteTestStorage();
    // The class's ensureTables owns DDL in production; the harness
    // ensures the copilot families over the same handle here.
    createStockCopilotPositionPort(sql as never).ensureSchema();
    createStockCopilotActivityPort(sql as never).ensureSchema();
    createStockCopilotControlPort(sql as never).ensureSchema();
    const getPlatformSpy = vi
      .spyOn(TradingPlatformRegistry, "getPlatform")
      .mockReturnValue(opts.fake.platform as never);
    const audit = vi.fn();
    const ctx: ScheduledTasksCopilotContext = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as ScheduledTasksCopilotContext["env"],
      agentCtx: { storage: { sql } } as never,
      // THE DEFECT STATE: the screener execution context says PROD.
      getScreenerExecutionContext: async () => ({
        userLogin: "owner",
        environment: "PROD" as const,
      }),
      getOrm: () => undefined,
      audit,
      readSettingRaw: readerWith(opts.storedEnvironment),
      commercial: opts.commercial,
    };
    const tasks = await declareStockCopilotTasks(ctx);
    const task = tasks[STOCK_COPILOT_TASK_ID];
    expect(task).toBeDefined();
    await task.handler({ taskId: STOCK_COPILOT_TASK_ID } as never);
    const cycleAudits = audit.mock.calls.filter((c) => c[0] === "stock_copilot.cycle");
    expect(cycleAudits).toHaveLength(1);
    return { payload: cycleAudits[0][2] as Record<string, unknown>, getPlatformSpy };
  }

  it("REGRESSION: PROD context + menu paper (TEST) + alpaca ⇒ platform built for TEST, cycle trades, nothing refused", async () => {
    const fake = createFakePlatform();
    const { payload, getPlatformSpy } = await runDeclaredCycle({
      storedEnvironment: "TEST",
      commercial: await commercialWithBroker("alpaca"),
      fake,
    });
    // The platform override is the SELECTED environment (TEST), never
    // the screener context's PROD snapshot.
    expect(getPlatformSpy).toHaveBeenCalledWith(
      "alpaca",
      expect.anything(),
      undefined,
      "owner",
      "TEST",
    );
    expect(payload.status).toBe("ok");
    expect(Number(payload.entriesPlaced)).toBeGreaterThanOrEqual(1);
    expect(fake.calls.placeOrderRemote).toBeGreaterThanOrEqual(1);
  });

  it("PROD context + menu live (PROD) + alpaca ⇒ platform built for PROD and the cycle runs live", async () => {
    const fake = createFakePlatform();
    const { payload, getPlatformSpy } = await runDeclaredCycle({
      storedEnvironment: "PROD",
      commercial: await commercialWithBroker("alpaca"),
      fake,
    });
    expect(getPlatformSpy).toHaveBeenCalledWith(
      "alpaca",
      expect.anything(),
      undefined,
      "owner",
      "PROD",
    );
    expect(payload.status).toBe("ok");
    expect(fake.calls.placeOrderRemote).toBeGreaterThanOrEqual(1);
  });

  it("etrade active ⇒ the audit reports inactive_broker and the platform is never called", async () => {
    const fake = createFakePlatform();
    const { payload } = await runDeclaredCycle({
      storedEnvironment: "TEST",
      commercial: await commercialWithBroker("etrade"),
      fake,
    });
    expect(payload.status).toBe("inactive_broker");
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
  });

  it("broker store unbound ⇒ the audit reports mode_unresolved and the platform is never called", async () => {
    const fake = createFakePlatform();
    const { payload } = await runDeclaredCycle({
      storedEnvironment: "TEST",
      commercial: null,
      fake,
    });
    expect(payload.status).toBe("mode_unresolved");
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
  });
});
