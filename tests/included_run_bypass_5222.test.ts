/**
 * Monetization Phase 2.26 (#5222, sub-issue of #2405, Goal 2):
 * Subscribed included-run bypass at the x402 HTTP-gated endpoints.
 *
 * RED-first pins: ETradeAgenticPaymentService.handleGatedEndpoint must
 * consult the included-run coverage probe BEFORE demanding a verified
 * x402/MPP payment — a Subscribed caller with included runs remaining
 * is served without a 402 challenge and the balance is decremented.
 * The bypass is payment-step only: tier checks, rate limits, and
 * metering stay; every served call still records a meter row; a
 * coverage-probe failure fails closed to demanding payment, never to
 * serving free. No new paidVia values (subscription_included), no new
 * outcome codes, no UX change.
 *
 * Rules pinned here:
 * - Covered (Subscribed + runs, session login, meter + port wired) →
 *   200, fulfill called, exactly one usage_event with
 *   paidVia subscription_included, NO payment receipt headers.
 * - Not covered (PayPerUse / exhausted runs) → 402, fulfill not
 *   called, nothing metered.
 * - Probe failure → 402 (fail closed), fulfill not called.
 * - Anonymous traffic (no x-user-login) never consults the bypass:
 *   the port is not called, 402 as before.
 * - No port wired / no meter configured → existing behavior (402);
 *   the port is not called when there is no meter.
 * - A covered call beats a presented payment: the payment is never
 *   verified (no receipt headers, coverage meter row).
 * - A meter failure on a covered call refuses with a typed 503 and
 *   serves nothing (same direction as the paid path).
 * - Premium wiring (consumePremiumIncludedRun): the effective tier
 *   at read time decides (a lapsed subscription stops covering);
 *   an active unlimited-free grant never burns an included run;
 *   unbound store → not covered.
 *
 * The claim verifier here is a stub standing in for on-chain
 * verification (the seam verifyOnChainClaim plugs into); the real
 * verifier is unit-covered by tests/x402_verifier.test.ts. A live
 * testnet smoke needs an owner Subscribed test account + HITL and
 * is NOT executed by this suite — see #5222 (explicit limitation).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi } from "vitest";
import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
} from "../src/services/agenticPayments";
import type { MeteredGateOptions } from "../src/services/meteredPaymentGate";
import { buildCoveredCallEvent } from "../src/services/meteredPaymentGate";
import { premiumMeteredGateOptions, type PremiumRouteContext } from "../src/agents/routes/premium";
import type { X402ClaimVerifier } from "../src/services/x402Verifier";
import type { UsageEventPort, InsertUsageEventRow } from "../src/data/canonicalReportStorePorts";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { APPROVED_PREMIUM_PRICES } from "./premiumPriceCatalogueFixture";

// #5609 (G-7): the gate takes its price as an argument — the caller
// resolves the APPROVED catalogue price. These tests drive the gate
// directly, so the price comes from the approved premium catalogue.
const OPTIONS_SCAN_PRICE = APPROVED_PREMIUM_PRICES["options-scan"];
import type { Env, X402PaymentProof } from "../src/types";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";

const PAYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x71C8363837918a211797E3c76A8B3C4258759550";
const LOGIN = "subscriber-1";

let txCounter = 0;
const nextTxHash = () => `0x${(++txCounter).toString(16).padStart(64, "0")}`;

const verifyingClaim: X402ClaimVerifier = async ({ proof }) => ({
  ok: true,
  payer: proof.payer,
  txHash: proof.txHash || "",
});

class CapturingMeter implements UsageEventPort {
  rows: InsertUsageEventRow[] = [];
  ensureSchema(): void {}
  insertEvent(row: InsertUsageEventRow): void {
    if (this.rows.some((r) => r.id === row.id)) {
      throw new Error(`UNIQUE constraint failed: usage_events.id`);
    }
    this.rows.push({ ...row });
  }
  listByUser(userLogin: string, limit: number) {
    return this.rows
      .filter((r) => r.userLogin === userLogin)
      .slice(-limit)
      .map(({ id, userLogin: u, runId, category, createdAt, tenantId }) => ({ id, userLogin: u, runId, category, createdAt, tenantId }));
  }
  listByTenant(tenantId: string, limit: number) {
    return this.rows
      .filter((r) => r.tenantId === tenantId)
      .slice(-limit)
      .map(({ id, userLogin, runId, category, createdAt, tenantId: t }) => ({ id, userLogin, runId, category, createdAt, tenantId: t }));
  }
}

/** A meter that throws on its next insert, then works (proves fail-closed + retry). */
class FailOnceMeter extends CapturingMeter {
  failNext = true;
  override insertEvent(row: InsertUsageEventRow): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("DO sqlite unavailable (test fault)");
    }
    super.insertEvent(row);
  }
}

function makeService(claimVerifier: X402ClaimVerifier = verifyingClaim) {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("trader_session_1");
  const env = {
    X402_NETWORK: "base-sepolia",
    X402_RECIPIENT_ADDRESS: RECIPIENT,
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
  } as unknown as Env;
  const service = new ETradeAgenticPaymentService(orm, env, "trader_session_1", claimVerifier);
  return { orm, service };
}

function sessionRequest(resource: string, extraHeaders: Record<string, string> = {}) {
  return new Request(`https://agent.internal${resource}`, {
    method: "GET",
    headers: { "x-user-login": LOGIN, ...extraHeaders },
  });
}

function paidSessionRequest(service: ETradeAgenticPaymentService, tier: { resource: string; priceUSD: number }, txHash: string) {
  const challenge = service.createX402Challenge(tier.resource, tier.priceUSD);
  const proof: X402PaymentProof = {
    payer: PAYER,
    signature: `0x${"b".repeat(64)}`,
    txHash,
    nonce: challenge.nonce,
    timestamp: Date.now(),
  };
  return new Request(`https://agent.internal${tier.resource}`, {
    method: "GET",
    headers: {
      "x-user-login": LOGIN,
      "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64"),
    },
  });
}

function meterDetail(row: InsertUsageEventRow) {
  return JSON.parse(row.detailJson ?? "{}") as Record<string, unknown>;
}

describe("buildCoveredCallEvent (#5222) — pure helper", () => {
  it("builds the coverage meter row: runId = coverage id, paidVia subscription_included, no protocol claim", () => {
    const row = buildCoveredCallEvent({
      coverageId: "cov_abc123",
      userLogin: LOGIN,
      category: "options_screener",
      priceUSD: OPTIONS_SCAN_PRICE,
      tier: "Subscribed",
      tenantId: "tenant-5222",
    });
    expect(row.id).toBe("use_cov_abc123");
    expect(row.runId).toBe("cov_abc123");
    expect(row.category).toBe("options_screener");
    expect(row.userLogin).toBe(LOGIN);
    // Issue #3185: the covered path carries the resolved account tenant.
    expect(row.tenantId).toBe("tenant-5222");
    const detail = meterDetail(row);
    expect(detail.coverageId).toBe("cov_abc123");
    expect(detail.paidVia).toBe("subscription_included");
    expect(detail.priceUSD).toBe(OPTIONS_SCAN_PRICE);
    expect(detail.tier).toBe("Subscribed");
    expect(detail.protocol).toBeUndefined();
    expect(detail.receiptId).toBeUndefined();
  });
});

describe("handleGatedEndpoint: Subscribed included-run bypass (#5222)", () => {
  const def = { ...TRADING_PAID_SERVICES.OPTIONS_SCREENER, priceUSD: OPTIONS_SCAN_PRICE };

  it("serves a Subscribed caller with included runs without a 402 and records exactly one coverage meter row", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const consumeIncludedRun = vi.fn(async () => true);
    const fulfill = vi.fn(async (receipt: unknown) => ({ served: true, receipt }));
    const res = await service.handleGatedEndpoint(
      sessionRequest(def.resource),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter, category: def.id, consumeIncludedRun },
    );

    expect(res.status).toBe(200);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(consumeIncludedRun).toHaveBeenCalledTimes(1);
    expect(consumeIncludedRun).toHaveBeenCalledWith(LOGIN);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(res.headers.get("Payment-Receipt")).toBeNull();
    expect(meter.rows).toHaveLength(1);
    const row = meter.rows[0];
    expect(row.userLogin).toBe(LOGIN);
    expect(row.category).toBe(def.id);
    expect(row.id).toBe(`use_${row.runId}`);
    const detail = meterDetail(row);
    expect(detail.paidVia).toBe("subscription_included");
    expect(detail.tier).toBe("Subscribed");
    expect(detail.priceUSD).toBe(OPTIONS_SCAN_PRICE);
    expect(detail.coverageId).toBe(row.runId);
    const body = (await res.json()) as any;
    expect(body.served).toBe(true);
    expect(body.receipt.status).toBe("simulated");
    expect(body.receipt.simulated).toBe(true);
    expect(body.receipt.receiptId).toBe(row.runId);
    expect(body.receipt.txHash).toBeUndefined();
  });

  it("demands payment when the caller has no included runs", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const consumeIncludedRun = vi.fn(async () => false);
    const fulfill = vi.fn(async () => ({ served: true }));
    const res = await service.handleGatedEndpoint(
      sessionRequest(def.resource),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter, category: def.id, consumeIncludedRun },
    );

    expect(res.status).toBe(402);
    expect(fulfill).not.toHaveBeenCalled();
    expect(meter.rows).toHaveLength(0);
  });

  it("demands payment when the coverage probe throws (fail closed)", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const consumeIncludedRun = vi.fn(async () => {
      throw new Error("commercial store unavailable (test fault)");
    });
    const fulfill = vi.fn(async () => ({ served: true }));
    const res = await service.handleGatedEndpoint(
      sessionRequest(def.resource),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter, category: def.id, consumeIncludedRun },
    );

    expect(res.status).toBe(402);
    expect(fulfill).not.toHaveBeenCalled();
    expect(meter.rows).toHaveLength(0);
  });

  it("never consults the bypass for anonymous traffic (no session login)", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const consumeIncludedRun = vi.fn(async () => true);
    const fulfill = vi.fn(async () => ({ served: true }));
    const req = new Request(`https://agent.internal${def.resource}`, { method: "GET" });
    const res = await service.handleGatedEndpoint(
      req,
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter, category: def.id, consumeIncludedRun },
    );

    expect(res.status).toBe(402);
    expect(consumeIncludedRun).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
    expect(meter.rows).toHaveLength(0);
  });

  it("demands payment when no bypass port is wired (existing behavior)", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const fulfill = vi.fn(async () => ({ served: true }));
    const res = await service.handleGatedEndpoint(
      sessionRequest(def.resource),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter, category: def.id },
    );

    expect(res.status).toBe(402);
    expect(fulfill).not.toHaveBeenCalled();
    expect(meter.rows).toHaveLength(0);
  });

  it("does not consult the bypass when no meter is configured", async () => {
    const { service } = makeService();
    const consumeIncludedRun = vi.fn(async () => true);
    const fulfill = vi.fn(async () => ({ served: true }));
    const res = await service.handleGatedEndpoint(
      sessionRequest(def.resource),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter: undefined, category: def.id, consumeIncludedRun } as MeteredGateOptions,
    );

    expect(res.status).toBe(402);
    expect(consumeIncludedRun).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
  });

  it("a covered call beats a presented payment: serves via coverage, payment never verified", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const consumeIncludedRun = vi.fn(async () => true);
    const fulfill = vi.fn(async (receipt: unknown) => ({ served: true, receipt }));
    const res = await service.handleGatedEndpoint(
      paidSessionRequest(service, def, nextTxHash()),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter, category: def.id, consumeIncludedRun },
    );

    expect(res.status).toBe(200);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(meter.rows).toHaveLength(1);
    expect(meterDetail(meter.rows[0]).paidVia).toBe("subscription_included");
  });

  it("a meter failure on a covered call refuses with a typed 503 and serves nothing", async () => {
    const { service } = makeService();
    const meter = new FailOnceMeter();
    const consumeIncludedRun = vi.fn(async () => true);
    const fulfill = vi.fn(async () => ({ served: true }));
    const res = await service.handleGatedEndpoint(
      sessionRequest(def.resource),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      { meter, category: def.id, consumeIncludedRun },
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBe("MeteringUnavailable");
    expect(body.served).toBeUndefined();
    expect(meter.rows).toHaveLength(0);
  });
});

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors the slice0 pattern in tests/ads_commercial_enforcement.test.ts). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function setupStores() {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subscriptionDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subscriptionDb);
  const store = new D1CommercialAdapter(commercialDb);
  const subs = new D1SubscriptionAdapter(subscriptionDb);
  return { mock, store, subs };
}

async function seedSubscription(
  subs: D1SubscriptionAdapter,
  userId: string,
  periodStartMs: number,
  periodEndMs: number,
) {
  await subs.createSubscription({
    id: `s-${userId}-${periodStartMs}`,
    userId,
    tenantId: "t1",
    planId: "pro",
    provider: "stripe",
    providerPaymentRef: `sub-${userId}-${periodStartMs}`,
    periodStartMs,
    periodEndMs,
  });
}

function premiumOptions(env: Env, request: Request) {
  const ctx = { env, sql: undefined, getOrm: () => undefined } as unknown as PremiumRouteContext;
  return premiumMeteredGateOptions(ctx, request, TRADING_PAID_SERVICES.OPTIONS_SCREENER.id);
}

describe("premium wiring: consumePremiumIncludedRun (#5222)", () => {
  const now = Date.now();

  it("consumes one included run for a Subscribed caller and decrements the balance", async () => {
    const { mock, store, subs } = await setupStores();
    await store.upsertAccount({ userId: LOGIN, tenantId: "t1", tier: "Subscribed", tierSource: "subscription", creditsUSD: 0, includedRuns: 2 });
    await seedSubscription(subs, LOGIN, now - 86_400_000, now + 86_400_000);
    const env = { AGENT_DB: mock } as unknown as Env;
    const options = premiumOptions(env, sessionRequest(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource));

    expect(options.consumeIncludedRun).toBeDefined();
    await expect(options.consumeIncludedRun!(LOGIN)).resolves.toBe(true);
    const after = await store.getAccount(LOGIN);
    expect(after?.includedRuns).toBe(1);
  });

  it("does not cover a caller whose subscription lapsed (effective tier at read time)", async () => {
    const { mock, store, subs } = await setupStores();
    await store.upsertAccount({ userId: LOGIN, tenantId: "t1", tier: "Subscribed", tierSource: "subscription", creditsUSD: 0, includedRuns: 2 });
    await seedSubscription(subs, LOGIN, now - 2 * 86_400_000, now - 86_400_000);
    const env = { AGENT_DB: mock } as unknown as Env;
    const options = premiumOptions(env, sessionRequest(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource));

    await expect(options.consumeIncludedRun!(LOGIN)).resolves.toBe(false);
    const after = await store.getAccount(LOGIN);
    expect(after?.includedRuns).toBe(2);
  });

  it("does not cover a PayPerUse caller even with included runs on the row", async () => {
    const { mock, store } = await setupStores();
    await store.upsertAccount({ userId: LOGIN, tenantId: "t1", tier: "PayPerUse", creditsUSD: 0, includedRuns: 2 });
    const env = { AGENT_DB: mock } as unknown as Env;
    const options = premiumOptions(env, sessionRequest(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource));

    await expect(options.consumeIncludedRun!(LOGIN)).resolves.toBe(false);
    const after = await store.getAccount(LOGIN);
    expect(after?.includedRuns).toBe(2);
  });

  it("does not cover a Subscribed caller with zero included runs", async () => {
    const { mock, store, subs } = await setupStores();
    await store.upsertAccount({ userId: LOGIN, tenantId: "t1", tier: "Subscribed", tierSource: "subscription", creditsUSD: 0, includedRuns: 0 });
    await seedSubscription(subs, LOGIN, now - 86_400_000, now + 86_400_000);
    const env = { AGENT_DB: mock } as unknown as Env;
    const options = premiumOptions(env, sessionRequest(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource));

    await expect(options.consumeIncludedRun!(LOGIN)).resolves.toBe(false);
  });

  it("does not cover a caller with no account row", async () => {
    const { mock } = await setupStores();
    const env = { AGENT_DB: mock } as unknown as Env;
    const options = premiumOptions(env, sessionRequest(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource));

    await expect(options.consumeIncludedRun!(LOGIN)).resolves.toBe(false);
  });

  it("never burns an included run for an active unlimited-free grant (grant covers first)", async () => {
    const { mock, store, subs } = await setupStores();
    await store.upsertAccount({
      userId: LOGIN,
      tenantId: "t1",
      tier: "Subscribed",
      tierSource: "subscription",
      creditsUSD: 0,
      includedRuns: 2,
      unlimitedFreeGrant: { grantedBy: "operator-1", reason: "test grant", expiresAtMs: null },
    });
    await seedSubscription(subs, LOGIN, now - 86_400_000, now + 86_400_000);
    const env = { AGENT_DB: mock } as unknown as Env;
    const options = premiumOptions(env, sessionRequest(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource));

    await expect(options.consumeIncludedRun!(LOGIN)).resolves.toBe(false);
    const after = await store.getAccount(LOGIN);
    expect(after?.includedRuns).toBe(2);
  });

  it("is not covered when the commercial store is unbound", async () => {
    const env = {} as unknown as Env;
    const options = premiumOptions(env, sessionRequest(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource));

    await expect(options.consumeIncludedRun!(LOGIN)).resolves.toBe(false);
  });
});
