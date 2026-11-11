// @vitest-environment node
/**
 * Issue #4064 — options delivery suppression: the options deliver
 * stage (the manual entry's deliver fn) consults the ONE suppressor
 * module (src/workflows/screenDeliverySuppression.ts) with an
 * injected store, claiming (runId, destination) pairs in the
 * screener's key space, so a re-run/replay of a delivered options
 * report never re-sends to the same destination. The contract:
 *  - the manual deliver claims (runId, "slack") before the Slack
 *    send (bridge scheduling or direct A2A) and (runId,
 *    "email:<recipient>") before the email send, through the one
 *    key function; a held claim records already_delivered and the
 *    sender is never called again;
 *  - a failed send releases its claim, so the pair retries on the
 *    next run; a bridge-scheduling failure releases too;
 *  - a pair that cannot be attempted (deferred, Slack disabled,
 *    no email recipient) never claims;
 *  - the goal leg's deliver defers to the goal run: it sends
 *    nothing and claims nothing;
 *  - wiring: the manual route injects a suppressor backed by the
 *    durable mas_delivery_claims table in the route DO's SQLite,
 *    so a claim survives a second suppressor built over the
 *    same store.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createManualOptionsScreenDelivery } from "../src/workflows/manualOptionsScreen";
import { createGoalOptionsLegDelivery } from "../src/workflows/goalOptionsLeg";
import {
  createDeliverySuppressor,
  deliveryDestinationFor,
  deliverySuppressionKey,
  type DeliverySuppressionStore,
  type DeliverySuppressor,
} from "../src/workflows/screenDeliverySuppression";
import { createSqlDeliverySuppressionStore } from "../src/data/deliveryClaimsStore";
import { executeOptionsScreen } from "../src/agents/routes/etradeOptionsScreen";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

vi.mock("../src/services/gatedSlackDelivery", () => ({
  deliverGatedSlack: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("../src/services/optionsRunEmail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/optionsRunEmail")>();
  return {
    ...actual,
    sendOptionsRunEmail: vi.fn(async () => ({
      sent: true,
      via: "local" as const,
    })),
  };
});

import { deliverGatedSlack } from "../src/services/gatedSlackDelivery";
import { sendOptionsRunEmail } from "../src/services/optionsRunEmail";

const mockSlack = vi.mocked(deliverGatedSlack);
const mockEmail = vi.mocked(sendOptionsRunEmail);

const RUN_ID = "options_scanner:manual:2026-11-11T10:00:00.000Z";
const EMAIL_TO = "Ops@Example.com";

/** A recording DeliverySuppressionStore: the claim keys are the assertion (#3943 idiom). */
class RecordingSuppressionStore implements DeliverySuppressionStore {
  readonly claimed = new Map<string, true>();
  has(key: string): boolean {
    return this.claimed.has(key);
  }
  add(key: string): void {
    this.claimed.set(key, true);
  }
  delete(key: string): void {
    this.claimed.delete(key);
  }
  keys(): string[] {
    return [...this.claimed.keys()].sort();
  }
}

/** The node:sqlite DO-storage double (tests/deliver_suppression_3943.test.ts idiom). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function makeReport() {
  return {
    totalUnderlyingsScanned: 1,
    totalContractsEvaluated: 2,
    matchedCount: 1,
    filterSummary: "AAPL test",
  };
}

function makeDeliverCtx(overrides: {
  scheduleScreenerFollowups?: (
    outcome: unknown,
    userLogin: string,
  ) => Promise<void>;
  env?: Record<string, unknown>;
} = {}) {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql as never);
  const ctx = {
    env: (overrides.env ?? {}) as never,
    getOrm: () => orm,
    ensureTables: () => sql,
    getScreenerAgent: () => ({
      getPdfByKey: async () => null,
      getOptionsXlsxByKey: async () => null,
      getOptionsCsvByKey: async () => null,
      generateAndStoreOptionsXlsx: async () => ({
        key: "x",
        fileName: "x.xlsx",
      }),
      generateAndStoreOptionsCsv: async () => ({
        key: "c",
        fileName: "c.csv",
      }),
    }),
    ...(overrides.scheduleScreenerFollowups
      ? { scheduleScreenerFollowups: overrides.scheduleScreenerFollowups }
      : {}),
  } as never;
  return { ctx, sql };
}

function makeDeliverFn(input: {
  ctx: never;
  suppressor?: DeliverySuppressor;
  screenPushToSlack?: boolean;
  screenEmailTo?: string;
  deferDelivery?: boolean;
}) {
  return createManualOptionsScreenDelivery({
    ctx: input.ctx,
    screenFilter: { underlyingSymbols: ["AAPL"] },
    screenPushToSlack: input.screenPushToSlack,
    screenEmailTo: input.screenEmailTo,
    deferDelivery: input.deferDelivery,
    ...(input.suppressor ? { suppressor: input.suppressor } : {}),
  }).deliver;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("options delivery suppression (#4064)", () => {
  it("a second deliver with the same run id does not re-send Slack (direct A2A)", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: true,
    });
    const first = (await deliver({
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    })) as Record<string, unknown>;
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(first["slackState"]).toBe("sent");
    expect(store.keys()).toEqual([
      deliverySuppressionKey(RUN_ID, deliveryDestinationFor("slack")),
    ]);

    const second = (await deliver({
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    })) as Record<string, unknown>;
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(second["slackState"]).toBe("already_delivered");
    expect(second["deliveryState"]).toBe("delivered");
  });

  it("a second deliver with the same run id does not re-send email, and a different recipient is a different destination", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: false,
      screenEmailTo: EMAIL_TO,
    });
    const input = {
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    };
    const first = (await deliver(input)) as Record<string, unknown>;
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(first["emailState"]).toBe("sent");
    // Email destinations are lowercased by the one key function.
    expect(store.keys()).toEqual([
      deliverySuppressionKey(
        RUN_ID,
        deliveryDestinationFor("email", "ops@example.com"),
      ),
    ]);

    const second = (await deliver(input)) as Record<string, unknown>;
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(second["emailState"]).toBe("already_delivered");

    // A different recipient is a different delivery, not a duplicate.
    const other = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: false,
      screenEmailTo: "other@example.com",
    });
    await other(input);
    expect(mockEmail).toHaveBeenCalledTimes(2);
  });

  it("a failed direct Slack send releases its claim — the pair retries on the next deliver", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: true,
    });
    const input = {
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    };
    mockSlack.mockResolvedValueOnce({ ok: false, error: "slack down" });
    const first = (await deliver(input)) as Record<string, unknown>;
    expect(first["slackState"]).toBe("failed");
    expect(suppressor.wasClaimed(RUN_ID, "slack")).toBe(false);

    const second = (await deliver(input)) as Record<string, unknown>;
    expect(mockSlack).toHaveBeenCalledTimes(2);
    expect(second["slackState"]).toBe("sent");
    expect(suppressor.wasClaimed(RUN_ID, "slack")).toBe(true);
  });

  it("a throwing direct Slack send releases its claim — the pair retries", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: true,
    });
    const input = {
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    };
    mockSlack.mockRejectedValueOnce(new Error("slack transport threw"));
    const first = (await deliver(input)) as Record<string, unknown>;
    // The direct path warns and never throws: the run is not failed by a Slack error.
    expect(first["slackState"]).toBeUndefined();
    expect(suppressor.wasClaimed(RUN_ID, "slack")).toBe(false);

    await deliver(input);
    expect(mockSlack).toHaveBeenCalledTimes(2);
  });

  it("a failed email send releases its claim — the pair retries on the next deliver", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: false,
      screenEmailTo: EMAIL_TO,
    });
    const input = {
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    };
    mockEmail.mockResolvedValueOnce({ sent: false, via: "none" as const });
    const first = (await deliver(input)) as Record<string, unknown>;
    expect(first["emailState"]).toBe("failed");
    expect(
      suppressor.wasClaimed(RUN_ID, deliveryDestinationFor("email", EMAIL_TO)),
    ).toBe(false);

    const second = (await deliver(input)) as Record<string, unknown>;
    expect(mockEmail).toHaveBeenCalledTimes(2);
    expect(second["emailState"]).toBe("sent");
  });

  it("the bridge path claims once: a second deliver does not schedule a duplicate follow-up chain", async () => {
    const scheduled: unknown[] = [];
    const { ctx } = makeDeliverCtx({
      scheduleScreenerFollowups: async (outcome) => {
        scheduled.push(outcome);
      },
    });
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: true,
    });
    const input = {
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    };
    await deliver(input);
    expect(scheduled).toHaveLength(1);
    expect(store.keys()).toEqual([
      deliverySuppressionKey(RUN_ID, deliveryDestinationFor("slack")),
    ]);

    const second = (await deliver(input)) as Record<string, unknown>;
    expect(scheduled).toHaveLength(1);
    expect(second["slackState"]).toBe("already_delivered");
  });

  it("a bridge-scheduling failure releases its claim — the retry schedules", async () => {
    let calls = 0;
    const { ctx } = makeDeliverCtx({
      scheduleScreenerFollowups: async () => {
        calls += 1;
        if (calls === 1) throw new Error("follow-up scheduling failed");
      },
    });
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: true,
    });
    const input = {
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    };
    // A scheduling failure fails the stage (today's behaviour) — but the
    // claim is released, so the retry may schedule.
    await expect(deliver(input)).rejects.toThrow("follow-up scheduling failed");
    expect(suppressor.wasClaimed(RUN_ID, "slack")).toBe(false);

    await deliver(input);
    expect(calls).toBe(2);
    expect(suppressor.wasClaimed(RUN_ID, "slack")).toBe(true);
  });

  it("a deferred deliver claims nothing and sends nothing", async () => {
    const scheduled: unknown[] = [];
    const { ctx } = makeDeliverCtx({
      scheduleScreenerFollowups: async (outcome) => {
        scheduled.push(outcome);
      },
    });
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: true,
      screenEmailTo: EMAIL_TO,
      deferDelivery: true,
    });
    const result = (await deliver({
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    })) as Record<string, unknown>;
    expect(scheduled).toHaveLength(0);
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockEmail).not.toHaveBeenCalled();
    expect(store.keys()).toEqual([]);
    expect(result["slackState"]).toBeUndefined();
    expect(result["emailState"]).toBeUndefined();
  });

  it("Slack disabled claims nothing for Slack (and the email leg is unaffected)", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: false,
      screenEmailTo: EMAIL_TO,
    });
    await deliver({
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    });
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(store.keys()).toEqual([
      deliverySuppressionKey(
        RUN_ID,
        deliveryDestinationFor("email", "ops@example.com"),
      ),
    ]);
  });

  it("no email recipient claims nothing for email", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: false,
    });
    await deliver({
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    });
    expect(mockEmail).not.toHaveBeenCalled();
    expect(store.keys()).toEqual([]);
  });

  it("a different run id is a different delivery — it sends", async () => {
    const { ctx } = makeDeliverCtx();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const deliver = makeDeliverFn({
      ctx,
      suppressor,
      screenPushToSlack: true,
    });
    const input = (runId: string) => ({
      runId,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    });
    await deliver(input(RUN_ID));
    await deliver(
      input("options_scanner:manual:2026-11-11T10:01:00.000Z"),
    );
    expect(mockSlack).toHaveBeenCalledTimes(2);
  });

  it("claims survive a second suppressor over the same durable store", async () => {
    const sql = new SqliteTestStorage();
    const first = createDeliverySuppressor(
      createSqlDeliverySuppressionStore(() => sql as never),
    );
    const { ctx } = makeDeliverCtx();
    const deliverFirst = makeDeliverFn({
      ctx,
      suppressor: first,
      screenPushToSlack: true,
    });
    await deliverFirst({
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    });
    expect(mockSlack).toHaveBeenCalledTimes(1);

    // A fresh suppressor over the same table (a new process /
    // instance after an eviction) sees the first run's claim.
    const second = createDeliverySuppressor(
      createSqlDeliverySuppressionStore(() => sql as never),
    );
    expect(second.wasClaimed(RUN_ID, "slack")).toBe(true);
    const deliverSecond = makeDeliverFn({
      ctx,
      suppressor: second,
      screenPushToSlack: true,
    });
    const result = (await deliverSecond({
      runId: RUN_ID,
      userLogin: "owner@example.com",
      request: {} as never,
      report: makeReport(),
    })) as Record<string, unknown>;
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(result["slackState"]).toBe("already_delivered");
    const rows = sql.exec("SELECT key FROM mas_delivery_claims") as {
      key: string;
    }[];
    expect(rows.map((r) => r.key)).toEqual([
      deliverySuppressionKey(RUN_ID, "slack"),
    ]);
  });

  it("the goal leg's deliver defers to the goal run: it sends nothing and claims nothing", async () => {
    const { deliver } = createGoalOptionsLegDelivery({
      goalRunId: "goal-screen:task-1",
    });
    const result = (await deliver({
      runId: "goal-screen:task-1:options",
      userLogin: "owner@example.com",
      request: {} as never,
      report: { matchedCount: 1 },
    })) as Record<string, unknown>;
    expect(result["deliveryState"]).toBe("deferred-to-goal-run");
    expect(result["goalRunId"]).toBe("goal-screen:task-1");
    expect(result["terminal"]).toBe("completed");
    // The leg takes no suppressor and performs no send — the
    // goal run's delivery is the delivery. Calling it again
    // returns the same handoff, never a second send.
    const again = (await deliver({
      runId: "goal-screen:task-1:options",
      userLogin: "owner@example.com",
      request: {} as never,
      report: { matchedCount: 1 },
    })) as Record<string, unknown>;
    expect(again["deliveryState"]).toBe("deferred-to-goal-run");
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockEmail).not.toHaveBeenCalled();
  });
});

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: {
      year: expiry.year,
      month: expiry.month,
      day: expiry.day,
    },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

describe("manual route wiring (#4064)", () => {
  it("the manual route injects a durable suppressor: a delivering run leaves a mas_delivery_claims row", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as never);
    const storage = memoryStorage();
    const fakeAgent = {
      generateAndStoreOptionsXlsx: async () => ({
        key: "xlsx-key-1",
        fileName: "options.xlsx",
      }),
      generateAndStoreOptionsCsv: async () => ({
        key: "csv-key-1",
        fileName: "options.csv",
      }),
      getPdfByKey: async () => null,
      getOptionsXlsxByKey: async () => ({
        bytes: new Uint8Array([1]),
        fileName: "options.xlsx",
      }),
      getOptionsCsvByKey: async () => ({
        bytes: new Uint8Array([1]),
        fileName: "options.csv",
      }),
    };
    const ctx = {
      env: {},
      getOrm: () => orm,
      agentCtx: { storage: { ...storage, sql } },
      ensureTables: () => sql,
      getScreenerAgent: () => fakeAgent,
      requestedEnv: undefined,
    } as never;

    const res = await executeOptionsScreen({
      ctx,
      userLogin: "owner@example.com",
      screener,
      screenFilter: { underlyingSymbols: ["AAPL"] },
      screenPushToSlack: true,
      screenSlackChannel: undefined,
      screenUniverseLabel: undefined,
      screenEmailTo: undefined,
      deferDelivery: false,
    });
    expect(res.status).toBe(200);
    // The direct A2A Slack send went out once (mocked) and the
    // route-injected durable suppressor claimed the pair.
    expect(mockSlack).toHaveBeenCalledTimes(1);
    const claims = Array.from(
      sql.exec("SELECT key FROM mas_delivery_claims"),
    ) as { key: string }[];
    expect(claims).toHaveLength(1);
    expect(claims[0].key).toMatch(/^options_scanner:manual:.*::slack$/);
  });

  it("the manual route with Slack disabled and no email claims nothing", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as never);
    const storage = memoryStorage();
    const fakeAgent = {
      generateAndStoreOptionsXlsx: async () => ({
        key: "xlsx-key-1",
        fileName: "options.xlsx",
      }),
      generateAndStoreOptionsCsv: async () => ({
        key: "csv-key-1",
        fileName: "options.csv",
      }),
      getPdfByKey: async () => null,
      getOptionsXlsxByKey: async () => ({
        bytes: new Uint8Array([1]),
        fileName: "options.xlsx",
      }),
      getOptionsCsvByKey: async () => ({
        bytes: new Uint8Array([1]),
        fileName: "options.csv",
      }),
    };
    const ctx = {
      env: {},
      getOrm: () => orm,
      agentCtx: { storage: { ...storage, sql } },
      ensureTables: () => sql,
      getScreenerAgent: () => fakeAgent,
      requestedEnv: undefined,
    } as never;

    const res = await executeOptionsScreen({
      ctx,
      userLogin: "owner@example.com",
      screener,
      screenFilter: { underlyingSymbols: ["AAPL"] },
      screenPushToSlack: false,
      screenSlackChannel: undefined,
      screenUniverseLabel: undefined,
      screenEmailTo: undefined,
      deferDelivery: false,
    });
    expect(res.status).toBe(200);
    expect(mockSlack).not.toHaveBeenCalled();
    const claims = Array.from(
      sql.exec("SELECT key FROM mas_delivery_claims"),
    ) as { key: string }[];
    expect(claims).toHaveLength(0);
  });
});
