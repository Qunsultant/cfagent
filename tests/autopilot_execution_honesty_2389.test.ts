/**
 * Issue #2389 — execution honesty for the autopilot feed.
 *
 * The Autopilot Control Center renders persisted mas_trades records.
 * Three writer paths used to stamp `executed` with no broker evidence:
 * the E*TRADE platform's draft executeOrder (invented an et_ref_
 * reference on approval), the E*TRADE client's non-live fall-through
 * (invented an et_sim_ execution), and the Alpaca platform's
 * executeOrder (a hardcoded NVDA result). The feed mappers compounded
 * it by hardcoding source "live" and synthesizing a signature for
 * unsigned records.
 *
 * This file has two halves:
 *  - Characterization: behaviour that was already honest and must not
 *    change (rejection path, HITL gates, the #1393 terms invariant,
 *    the client's broker-confirmed executions, the approval engine's
 *    placeOrderRemote fallback).
 *  - Honesty pins: the post-#2389 contract. Each of these FAILS
 *    against the unmodified tree (pristine-control Red) and passes
 *    once no path can present an execution without broker evidence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { approvePreviewedOrder } from "../src/trading/channels/approval";
import {
  mapAuditLogToAutonomousAction,
  mapTradeRecordToAutonomousAction,
} from "../src/client/components/AutopilotControlCenter";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { executeNLQQuery, executeNLQQueryAsync } from "../src/agents/nlq";
import type { Env } from "../src/types";

const HUMAN_DID = "did:user:github:boss";
const ACCOUNT_KEY_ERROR = "No active E*TRADE account key found. Please connect your brokerage account.";
// Mock credential fragments (assembled so no secret-shaped literal
// ever appears in this file).
const MOCK_CKEY = ["mock", "ckey"].join("_");
const MOCK_CSECRET = ["mock", "csecret"].join("_");
const MOCK_TOKEN = ["mock", "token"].join("_");
const MOCK_TSECRET = ["mock", "tsecret"].join("_");

/** Normalize a sync-throw or async result into a promise. */
function settle<T>(fn: () => T): Promise<T> {
  return (async () => fn())();
}

function makeOrm(sessionId: string): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(sessionId);
  return orm;
}

function seedPreviewedTrade(orm: DatabaseORM, overrides: Record<string, unknown> = {}): string {
  const id = (overrides.id as string) || "ord_2389_seed";
  orm.trades.create({
    id,
    sessionId: "sess_2389",
    symbol: "NVDA",
    action: "BUY",
    orderType: "MARKET",
    quantity: 10,
    price: 128,
    totalValue: 1280,
    status: "previewed",
    orderRef: undefined,
    proposerDid: "did:agent:openaimp:trading",
    authorizerDid: HUMAN_DID,
    proofSignature: ["sig", "0xseed"].join("_"),
    previewNotes: "E*TRADE Order Preview: BUY 10 NVDA. NO SHARES HAVE BEEN BOUGHT.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any);
  return id;
}

/** In-memory SESSION_STORE stand-in (same shape as the BAC preview test). */
function makeSessionStore() {
  const tokenStore = new Map<string, string>();
  return {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (request: Request) => {
        const payload = (await request.json()) as { op: string; ns: string; key: string; value?: string };
        const key = `${payload.ns}:${payload.key}`;
        if (payload.op === "get") return Response.json({ value: tokenStore.get(key) ?? null });
        if (payload.op === "put") {
          tokenStore.set(key, payload.value ?? "");
          return Response.json({ ok: true });
        }
        if (payload.op === "delete") {
          tokenStore.delete(key);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "Unsupported operation" }, { status: 400 });
      },
    }),
  };
}

const SANDBOX_NO_KEYS_ENV: Env = {
  ETRADE_ENVIRONMENT: "sandbox",
} as Env;

// ===========================================================================
// Characterization — honest behaviour that predates #2389 and must not move
// ===========================================================================
describe("#2389 characterization — behaviour that must not change", () => {
  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
  });
  afterEach(() => {
    __resetTokenCache();
    vi.restoreAllMocks();
  });

  it("platform: a rejected decision still rejects the draft and moves no funds", async () => {
    const orm = makeOrm("sess_2389");
    const id = seedPreviewedTrade(orm);
    const platform = new ETradeTradingPlatform(SANDBOX_NO_KEYS_ENV, orm, "boss");
    const result = await settle(() => platform.executeOrder(id, HUMAN_DID, "rejected"));
    expect(result.success).toBe(false);
    expect(result.status).toBe("rejected");
    expect(result.executionId).toBe("");
    expect(orm.trades.findById(id)?.status).toBe("rejected");
  });

  it("platform: an agent DID authorizer is still refused (HITL gate)", async () => {
    const orm = makeOrm("sess_2389");
    const id = seedPreviewedTrade(orm);
    const platform = new ETradeTradingPlatform(SANDBOX_NO_KEYS_ENV, orm, "boss");
    await expect(settle(() => platform.executeOrder(id, "did:agent:openaimp:trading", "approved"))).rejects.toThrow(
      /HITL Enforcement/
    );
    expect(orm.trades.findById(id)?.status).toBe("previewed");
  });

  it("platform: the #1393 frozen-terms invariant still refuses an edited draft before any execution", async () => {
    const orm = makeOrm("sess_2389");
    const id = seedPreviewedTrade(orm);
    const platform = new ETradeTradingPlatform(SANDBOX_NO_KEYS_ENV, orm, "boss");
    await expect(
      settle(() =>
        platform.executeOrder(id, HUMAN_DID, "approved", {
          symbol: "NVDA",
          action: "BUY",
          quantity: 99,
          price: 128,
          totalValue: 1280,
        } as any)
      )
    ).rejects.toThrow(/terms changed/i);
    expect(orm.trades.findById(id)?.status).toBe("previewed");
  });

  it("client: a native PlaceOrderResponse order id still yields a broker-confirmed execution", async () => {
    const env: Env = {
      ETRADE_CONSUMER_KEY: MOCK_CKEY,
      ETRADE_CONSUMER_SECRET: MOCK_CSECRET,
      ETRADE_OAUTH_TOKEN: MOCK_TOKEN,
      ETRADE_OAUTH_TOKEN_SECRET: MOCK_TSECRET,
      ETRADE_ACCOUNT_ID_KEY: "acct_83921048",
      ETRADE_ENVIRONMENT: "sandbox",
    } as Env;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/orders/place")) {
        return new Response(
          JSON.stringify({ PlaceOrderResponse: { OrderIds: [{ orderId: 445566 }] } }),
          { status: 200 }
        );
      }
      return new Response("Not Found", { status: 404 });
    });
    const client = new ETradeRestClient(env, "boss");
    const res = await client.placeOrder({
      orderId: "ord_2389_native",
      symbol: "NVDA",
      action: "BUY",
      quantity: 10,
      orderType: "MARKET",
      userLogin: HUMAN_DID,
    });
    expect(res.success).toBe(true);
    expect(res.status).toBe("executed");
    expect(res.brokerOrderRef).toBe("et_order_445566");
  });

  it("client: a live environment without broker keys already failed honestly (and still does)", async () => {
    const env: Env = { ETRADE_ENVIRONMENT: "production" } as Env;
    const client = new ETradeRestClient(env, "boss");
    const res = await client.placeOrder({
      orderId: "ord_2389_live",
      symbol: "NVDA",
      action: "BUY",
      quantity: 1,
      userLogin: HUMAN_DID,
    });
    expect(res.success).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.executionId).toBe("");
    expect(res.didAttestation?.signature).toBe("");
  });

  it("approval engine: when executeOrder throws, the placeOrderRemote fallback still writes the broker outcome", async () => {
    const store = new Map<string, any>([
      ["ord_2389_fb", { id: "ord_2389_fb", symbol: "NVDA", action: "BUY", quantity: 1, price: 10, orderType: "MARKET", totalValue: 10, status: "previewed" }],
    ]);
    const trades = {
      findById: (id: string) => store.get(id) ?? null,
      findMany: () => [],
      update: (id: string, patch: Record<string, unknown>) => {
        store.set(id, { ...store.get(id), ...patch });
      },
    };
    const outcome = await approvePreviewedOrder({
      trades: trades as any,
      executor: {
        executeOrder: () => {
          throw new Error("draft gate blew up");
        },
        placeOrderRemote: async () => ({
          success: true,
          status: "executed",
          executionId: "et_order_777",
          brokerOrderRef: "et_order_777",
          message: "E*TRADE Execution Confirmed: Broker Order ID et_order_777",
        }),
      } as any,
      authorizerDid: HUMAN_DID,
      userLogin: "boss",
      orderId: "ord_2389_fb",
      timestamp: new Date().toISOString(),
    });
    expect(outcome.kind).toBe("executed");
    expect(store.get("ord_2389_fb")?.status).toBe("executed");
    expect(store.get("ord_2389_fb")?.orderRef).toBe("et_order_777");
  });

  it("feed mapper: a broker-referenced executed trade renders live with its real signature", () => {
    const mapped = mapTradeRecordToAutonomousAction({
      id: "tr_2389_live",
      sessionId: "sess_2389",
      symbol: "AAPL",
      action: "BUY",
      orderType: "LIMIT",
      quantity: 5,
      price: 230.5,
      totalValue: 1152.5,
      status: "executed",
      orderRef: "et_order_445566",
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: HUMAN_DID,
      proofSignature: ["sig", "ed25519", "realproof"].join("_"),
      previewNotes: "preview ok",
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:00:05.000Z",
    } as any);
    expect(mapped.status).toBe("executed");
    expect(mapped.source).toBe("live");
    expect(mapped.didAttestation.signature).toBe("sig_ed25519_realproof");
  });
});

// ===========================================================================
// Honesty pins — each FAILS against the unmodified tree
// ===========================================================================
describe("#2389 honesty pins — no execution without broker evidence", () => {
  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
  });
  afterEach(() => {
    __resetTokenCache();
    vi.restoreAllMocks();
  });

  it("SCENARIO: preview failed for a missing account key; approval cannot produce an EXECUTED record or feed row", async () => {
    const orm = makeOrm("sess_2389");
    const env: Env = {
      ETRADE_CONSUMER_KEY: MOCK_CKEY,
      ETRADE_CONSUMER_SECRET: MOCK_CSECRET,
      ETRADE_OAUTH_TOKEN: MOCK_TOKEN,
      ETRADE_OAUTH_TOKEN_SECRET: MOCK_TSECRET,
      ETRADE_ENVIRONMENT: "sandbox",
      SESSION_STORE: makeSessionStore() as any,
    } as Env;
    await storeAccessTokens(env, "boss", MOCK_TOKEN, MOCK_TSECRET, "TEST");

    // A broker client whose preview fails exactly as reported (no
    // account key) and whose placement is blocked for the same reason
    // — the real client's behaviour when no account can be resolved.
    const placeOrder = vi.fn(async (params: any) => ({
      success: false,
      orderId: params.orderId,
      executionId: "",
      brokerOrderRef: "",
      authorizerDid: HUMAN_DID,
      status: "failed" as const,
      symbol: params.symbol,
      action: params.action,
      quantity: params.quantity,
      executionPrice: 0,
      totalSettled: 0,
      didAttestation: { proposerDid: "did:agent:openaimp:trading", authorizerDid: HUMAN_DID, signature: "" },
      message: `E*TRADE Execution Blocked: ${ACCOUNT_KEY_ERROR}`,
      timestamp: new Date().toISOString(),
    }));
    const stubClient = {
      fetchQuote: async () => null,
      previewOrder: async () => null,
      getLastError: () => ACCOUNT_KEY_ERROR,
      placeOrder,
    };
    const platform = new ETradeTradingPlatform(env, orm, "boss", undefined, stubClient as any);

    const draft = await platform.previewOrder({
      sessionId: "boss",
      symbol: "NVDA",
      action: "BUY",
      quantity: 10,
      orderType: "MARKET",
    });
    // The draft carries the failed preview's own words — the reported
    // row's exact starting state.
    expect(draft.status).toBe("previewed");
    expect(orm.trades.findById(draft.orderId)?.previewNotes).toContain("No active E*TRADE account key found");

    const result = await settle(() => platform.executeOrder(draft.orderId, HUMAN_DID, "approved"));

    // Placement was actually attempted through the broker path…
    expect(placeOrder).toHaveBeenCalledTimes(1);
    // …and its honest failure is the outcome: no execution is claimed,
    // no reference is invented, and the record was not stamped.
    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.brokerOrderRef).toBe("");
    const record = orm.trades.findById(draft.orderId);
    expect(record?.status).toBe("previewed");
    expect(record?.orderRef ?? "").not.toMatch(/^et_ref_/);
    const row = mapTradeRecordToAutonomousAction(record as any);
    expect(row.status).not.toBe("executed");
  });

  it("platform: approval executes ONLY on a broker-confirmed client result, persisting the broker's reference", async () => {
    const orm = makeOrm("sess_2389");
    const id = seedPreviewedTrade(orm);
    const placeOrder = vi.fn(async (params: any) => ({
      success: true,
      orderId: params.orderId,
      executionId: "et_order_987",
      brokerOrderRef: "et_order_987",
      authorizerDid: HUMAN_DID,
      status: "executed" as const,
      symbol: params.symbol,
      action: params.action,
      quantity: params.quantity,
      executionPrice: 128,
      totalSettled: 1280,
      didAttestation: { proposerDid: "did:agent:openaimp:trading", authorizerDid: HUMAN_DID, signature: ["sig", "0xbroker"].join("_") },
      message: "E*TRADE Execution Confirmed: Broker Order ID et_order_987",
      timestamp: new Date().toISOString(),
    }));
    const stubClient = { fetchQuote: async () => null, previewOrder: async () => null, getLastError: () => undefined, placeOrder };
    const platform = new ETradeTradingPlatform(SANDBOX_NO_KEYS_ENV, orm, "boss", undefined, stubClient as any);

    const result = await settle(() => platform.executeOrder(id, HUMAN_DID, "approved"));
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.status).toBe("executed");
    expect(result.brokerOrderRef).toBe("et_order_987");
    const record = orm.trades.findById(id);
    expect(record?.status).toBe("executed");
    expect(record?.orderRef).toBe("et_order_987");
  });

  it("service: preview + approval in an environment with no broker keys fails honestly end-to-end", async () => {
    const orm = makeOrm("sess_2389");
    const service = new ETradeService(orm, SANDBOX_NO_KEYS_ENV, "boss");
    const draft = service.previewOrder({
      sessionId: "sess_2389",
      symbol: "NVDA",
      orderAction: "BUY",
      quantity: 10,
      orderType: "MARKET",
    });
    const result = await settle(() => service.executeOrder(draft.orderId, HUMAN_DID, "approved"));
    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.executionId).toBe("");
    expect(orm.trades.findById(draft.orderId)?.status).toBe("previewed");
  });

  it("client: the non-live fall-through no longer fabricates a simulated execution", async () => {
    const client = new ETradeRestClient(SANDBOX_NO_KEYS_ENV, "boss");
    const res = await client.placeOrder({
      orderId: "ord_2389_sim",
      symbol: "NVDA",
      action: "BUY",
      quantity: 1,
      userLogin: HUMAN_DID,
    });
    expect(res.success).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.executionId).toBe("");
    expect(res.brokerOrderRef).toBe("");
    expect(res.didAttestation?.signature).toBe("");
    expect(res.message).not.toContain("Simulation Executed");
  });

  it("alpaca: approval returns an honest not-executed failure with no invented terms or references", async () => {
    const orm = makeOrm("sess_2389");
    const id = seedPreviewedTrade(orm, { id: "alp_ord_2389" });
    const alpaca = new AlpacaTradingPlatform(SANDBOX_NO_KEYS_ENV, orm, "boss");
    const res = await alpaca.executeOrder(id, HUMAN_DID, "approved");
    expect(res.success).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.executionId).toBe("");
    expect(res.brokerOrderRef).toBe("");
    expect(res.executionPrice).toBe(0);
    expect(res.totalSettled).toBe(0);
    expect(res.message).toMatch(/not (been )?executed|not wired|no .*placement|credentials are not configured|not been placed/i);
    // The stored draft was not stamped executed either.
    expect(orm.trades.findById(id)?.status).toBe("previewed");
  });

  it("alpaca: rejection still rejects, with no fabricated references", async () => {
    const orm = makeOrm("sess_2389");
    const id = seedPreviewedTrade(orm, { id: "alp_ord_2389_r" });
    const alpaca = new AlpacaTradingPlatform(SANDBOX_NO_KEYS_ENV, orm, "boss");
    const res = await alpaca.executeOrder(id, HUMAN_DID, "rejected");
    expect(res.success).toBe(false);
    expect(res.status).toBe("rejected");
    expect(res.executionId).toBe("");
    expect(res.brokerOrderRef).toBe("");
    expect(orm.trades.findById(id)?.status).toBe("rejected");
  });

  it("approval engine: an async (Promise-returning) executor result is honoured, not misread as failure", async () => {
    const store = new Map<string, any>([
      ["ord_2389_async", { id: "ord_2389_async", symbol: "NVDA", action: "BUY", quantity: 1, price: 10, orderType: "MARKET", totalValue: 10, status: "previewed" }],
    ]);
    const trades = {
      findById: (id: string) => store.get(id) ?? null,
      findMany: () => [],
      update: vi.fn(),
    };
    const placeOrderRemote = vi.fn(async () => ({ success: false, status: "failed", message: "should not be called" }));
    const outcome = await approvePreviewedOrder({
      trades: trades as any,
      executor: {
        executeOrder: async () => ({
          success: true,
          status: "executed",
          executionId: "et_order_31337",
          brokerOrderRef: "et_order_31337",
          message: "E*TRADE Execution Confirmed: Broker Order ID et_order_31337",
        }),
        placeOrderRemote,
      } as any,
      authorizerDid: HUMAN_DID,
      userLogin: "boss",
      orderId: "ord_2389_async",
      timestamp: new Date().toISOString(),
    });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") expect(outcome.execId).toBe("et_order_31337");
    expect(placeOrderRemote).not.toHaveBeenCalled();
  });

  it("approval engine: an async executor failure surfaces its real message", async () => {
    const store = new Map<string, any>([
      ["ord_2389_asyncf", { id: "ord_2389_asyncf", symbol: "NVDA", action: "BUY", quantity: 1, price: 10, orderType: "MARKET", totalValue: 10, status: "previewed" }],
    ]);
    const trades = {
      findById: (id: string) => store.get(id) ?? null,
      findMany: () => [],
      update: vi.fn(),
    };
    const outcome = await approvePreviewedOrder({
      trades: trades as any,
      executor: {
        executeOrder: async () => ({
          success: false,
          status: "failed",
          executionId: "",
          brokerOrderRef: "",
          message: "E*TRADE Execution Blocked: account not connected",
        }),
        placeOrderRemote: vi.fn(async () => ({ success: false, status: "failed", message: "should not be called" })),
      } as any,
      authorizerDid: HUMAN_DID,
      userLogin: "boss",
      orderId: "ord_2389_asyncf",
      timestamp: new Date().toISOString(),
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toContain("account not connected");
  });

  it("NLQ (async production path): approving a draft with no broker keys reports NOT executed and stamps nothing", async () => {
    const orm = makeOrm("sess_2389");
    const service = new ETradeService(orm, SANDBOX_NO_KEYS_ENV, "boss");
    const draft = service.previewOrder({
      sessionId: "sess_2389",
      symbol: "NVDA",
      orderAction: "BUY",
      quantity: 10,
      orderType: "MARKET",
    });
    const plan = {
      domain: "trading",
      operation: "update",
      tradingData: { action: "approve_order", symbol: draft.orderId },
    } as any;
    const result = await executeNLQQueryAsync(orm, "sess_2389", plan, SANDBOX_NO_KEYS_ENV, "boss", HUMAN_DID);
    expect(result.summary).not.toMatch(/APPROVED & EXECUTED/);
    expect((result.rows[0] as any)?.status).not.toBe("EXECUTED");
    expect(orm.trades.findById(draft.orderId)?.status).toBe("previewed");
  });

  it("NLQ (legacy sync path): an approval is never reported as executed by a path that cannot place orders", () => {
    const orm = makeOrm("sess_2389");
    const service = new ETradeService(orm, SANDBOX_NO_KEYS_ENV, "boss");
    const draft = service.previewOrder({
      sessionId: "sess_2389",
      symbol: "NVDA",
      orderAction: "BUY",
      quantity: 10,
      orderType: "MARKET",
    });
    const plan = {
      domain: "trading",
      operation: "update",
      tradingData: { action: "approve_order", symbol: draft.orderId },
    } as any;
    const result = executeNLQQuery(orm, "sess_2389", plan, SANDBOX_NO_KEYS_ENV, HUMAN_DID);
    expect(result.summary).not.toMatch(/APPROVED & EXECUTED/);
    expect((result.rows[0] as any)?.status).not.toBe("EXECUTED");
    expect(orm.trades.findById(draft.orderId)?.status).toBe("previewed");
  });

  it("feed mapper: fabricated references render as simulated, unreferenced rows render no provenance badge", () => {
    const base = {
      id: "tr_2389_hist",
      sessionId: "sess_2389",
      symbol: "NVDA",
      action: "BUY",
      orderType: "MARKET",
      quantity: 10,
      price: 128,
      totalValue: 1280,
      status: "executed",
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: HUMAN_DID,
      proofSignature: ["sig", "0xabc"].join("_"),
      previewNotes: "",
      createdAt: "2026-10-29T12:10:44.000Z",
      updatedAt: "2026-10-29T12:10:44.000Z",
    } as any;
    expect(mapTradeRecordToAutonomousAction({ ...base, orderRef: "et_ref_deadbeef" }).source).toBe("simulated");
    expect(mapTradeRecordToAutonomousAction({ ...base, orderRef: "et_sim_deadbeef" }).source).toBe("simulated");
    expect(mapTradeRecordToAutonomousAction({ ...base, orderRef: "alp_ref_deadbeef" }).source).toBe("simulated");
    expect(mapTradeRecordToAutonomousAction({ ...base, orderRef: undefined }).source).toBeUndefined();
  });

  it("feed mapper: an unsigned trade record renders unsigned — no synthesized signature", () => {
    const mapped = mapTradeRecordToAutonomousAction({
      id: "tr_2389_unsigned",
      sessionId: "sess_2389",
      symbol: "NVDA",
      action: "BUY",
      orderType: "MARKET",
      quantity: 1,
      price: 10,
      totalValue: 10,
      status: "previewed",
      proposerDid: "did:agent:openaimp:trading",
      proofSignature: "",
      previewNotes: "",
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:00:00.000Z",
    } as any);
    expect(mapped.didAttestation.signature).toBe("");
  });

  it("feed mapper (audit events): provenance derives from the recorded execution reference", () => {
    const baseEvent = {
      id: "evt_2389",
      type: "etrade.order_executed",
      agent: "trading",
      created_at: "2026-10-29T12:00:00.000Z",
    };
    const sim = mapAuditLogToAutonomousAction({
      ...baseEvent,
      payload: { symbol: "NVDA", status: "executed", executionId: "et_sim_zz" },
    } as any);
    expect(sim.source).toBe("simulated");
    const unknown = mapAuditLogToAutonomousAction({
      ...baseEvent,
      payload: { symbol: "NVDA", status: "executed" },
    } as any);
    expect(unknown.source).toBeUndefined();
    const live = mapAuditLogToAutonomousAction({
      ...baseEvent,
      payload: { symbol: "NVDA", status: "executed", executionId: "et_order_445566" },
    } as any);
    expect(live.source).toBe("live");
  });
});

// ===========================================================================
// Source-scan pins — the fabrication shapes cannot come back
// ===========================================================================
describe("#2389 source-scan pins", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it("no locally-minted execution reference survives anywhere in the trading surface", () => {
    const files = [
      "src/trading/etrade/client.ts",
      "src/trading/etrade/platform.ts",
      "src/trading/alpaca/platform.ts",
      "src/trading/channels/approval.ts",
      "src/services/etrade.ts",
      "src/client/components/AutopilotControlCenter.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      // The mapper's provenance denylist legitimately names the
      // fabricated prefixes; minting sites are what is banned, so the
      // scan targets the template-mint shape, not the bare prefix.
      expect(src, f).not.toMatch(/et_sim_\$\{/);
      expect(src, f).not.toMatch(/et_ref_\$\{/);
      expect(src, f).not.toMatch(/alp_exec_\$\{/);
      expect(src, f).not.toMatch(/alp_ref_\$\{/);
    }
    // The Alpaca stub's hardcoded order terms are gone.
    expect(read("src/trading/alpaca/platform.ts")).not.toContain("138.25");
  });

  it('status: "executed" is constructed only at broker-backed sites (enumerated)', () => {
    // Allowed constructions of the executed status, by file:
    //  - etrade/client.ts ×3: the Remote MCP return, the native
    //    PlaceOrderResponse return, and the preview-timeout retry
    //    return — each gated on a broker-issued order id.
    //  - routes/etradeBrokerOrders.ts ×1: the mas_trades update after
    //    a successful placeOrderRemote (the client's broker result).
    //  - mcp/etradeCommands.ts ×1: same, for the MCP execute door.
    //  - services/etrade.ts ×1: NOT a construction — the positions
    //    read filter (findMany where status = "executed").
    const allowed: Record<string, number> = {
      "src/trading/etrade/client.ts": 3,
      "src/trading/etrade/platform.ts": 0,
      "src/trading/alpaca/platform.ts": 0,
      "src/trading/channels/approval.ts": 0,
      "src/agents/routes/etradeBrokerOrders.ts": 1,
      "src/mcps/openaimp/etradeCommands.ts": 1,
      "src/services/etrade.ts": 1,
    };
    for (const [file, expected] of Object.entries(allowed)) {
      expect(count(read(file), 'status: "executed"'), file).toBe(expected);
    }
  });
});
