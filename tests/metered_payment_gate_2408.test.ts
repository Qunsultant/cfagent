/**
 * Monetization Phase 1.2 (#2408, sub-issue of #2405): metering
 * enforcement for the single user.
 *
 * RED-first pins: the paid gate (ETradeAgenticPaymentService.
 * handleGatedEndpoint — the exact gate handlePremiumRoutes uses)
 * must meter every SERVED paid call and consult the meter at the
 * gate, and must check the tier attribute with a fail-closed
 * default. The previously advisory posture ("metering must not
 * break the run", "the published result stands either way" in
 * researchPublish.ts) is replaced by enforcement ON PAID PATHS
 * ONLY — ungated/free paths keep their existing behavior and are
 * untouched by this suite.
 *
 * Rules pinned here:
 * - Served paid call → exactly one usage_event (category = paid
 *   service id, runId = receipt id, tier recorded). Refused calls
 *   (unpaid / failed / simulated / replayed) meter nothing.
 * - Meter failure → typed refusal, nothing served (x402 tx hash
 *   released, as on fulfill failure, so a retry can succeed).
 * - Missing meter → typed refusal, nothing served: an unmetered
 *   paid serve through the gate is impossible after this slice.
 * - Tier: no resolver / resolver-null / unbound store → Free
 *   (implicit per #1076, grants nothing by itself); resolved tier
 *   recorded; invalid tier → typed refusal; tier-store failure →
 *   typed refusal. Tier NEVER bypasses payment in this slice.
 * - MPP branch meters the same way as the x402 branch.
 *
 * The claim verifier here is a stub standing in for on-chain
 * verification (the seam verifyOnChainClaim plugs into); the real
 * verifier is unit-covered by tests/x402_verifier.test.ts. A live
 * testnet transfer needs an owner-funded wallet + HITL confirm and
 * is NOT executed by this suite — see #2408 (explicit limitation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
  payerScopeId,
} from "../src/services/agenticPayments";
import {
  buildMeteredCallEvent,
  meteredGateRefusal,
  resolveMeteredTier,
  type MeteredGateOptions,
} from "../src/services/meteredPaymentGate";
import { premiumMeteredGateOptions } from "../src/agents/routes/premium";
import type { X402ClaimVerifier } from "../src/services/x402Verifier";
import type { UsageEventPort, InsertUsageEventRow } from "../src/data/canonicalReportStorePorts";
import type { StoreTier } from "../src/data/commercialPorts";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { APPROVED_PREMIUM_PRICES } from "./premiumPriceCatalogueFixture";

// #5609 (G-7): the gate takes its price as an argument — the caller
// resolves the APPROVED catalogue price. These tests drive the gate
// directly, so the price comes from the approved premium catalogue.
const OPTIONS_SCAN_PRICE = APPROVED_PREMIUM_PRICES["options-scan"];
import type { Env, X402PaymentProof, AgenticPaymentReceipt } from "../src/types";

// ---------------------------------------------------------------------------
// MPP fakes (mirrors tests/agentic_payments_mpp_payer_binding.test.ts:
// no deterministic local fixture can produce a real tempo verification)
// ---------------------------------------------------------------------------
const mppFake = vi.hoisted(() => ({
  mode: "verified" as "verified" | "challenge",
  source: undefined as string | undefined,
}));

vi.mock("mppx/server", () => ({
  Mppx: {
    create: (_config: unknown) => ({
      charge: (_options: unknown) => async (_req: Request) => {
        if (mppFake.mode === "challenge") {
          return {
            status: 402,
            challenge: new Response("Payment required", {
              status: 402,
              headers: { "WWW-Authenticate": 'Payment id="fake-challenge", realm="test"' },
            }),
          };
        }
        return { status: 200, withReceipt: (res: Response) => res };
      },
    }),
  },
  tempo: { charge: (_config: unknown) => ({}) },
}));

vi.mock("mppx", () => ({
  Credential: {
    fromRequest: (_req: Request) => ({
      challenge: {},
      payload: {},
      ...(mppFake.source ? { source: mppFake.source } : {}),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const PAYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x71C8363837918a211797E3c76A8B3C4258759550";
const MPP_PAYER = "0x700C0FFEE700C0FFEE700C0FFEE700C0FFEE7001";

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

function makeService(claimVerifier: X402ClaimVerifier = verifyingClaim, extraEnv: Record<string, unknown> = {}) {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("trader_session_1");
  const env = {
    X402_NETWORK: "base-sepolia",
    X402_RECIPIENT_ADDRESS: RECIPIENT,
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    ...extraEnv,
  } as unknown as Env;
  const service = new ETradeAgenticPaymentService(orm, env, "trader_session_1", claimVerifier);
  return { orm, service };
}

function paidRequest(service: ETradeAgenticPaymentService, tier: { resource: string; priceUSD: number }, txHash: string) {
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
      "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64"),
    },
  });
}

function meteredOptions(meter: UsageEventPort, category: string, resolveTier?: MeteredGateOptions["resolveTier"]): MeteredGateOptions {
  return { meter, category, ...(resolveTier ? { resolveTier } : {}) };
}

function sampleReceipt(): AgenticPaymentReceipt {
  return {
    receiptId: "rcpt_x402_test_1",
    protocol: "x402",
    resource: "/api/premium/options-scan",
    amount: OPTIONS_SCAN_PRICE,
    currency: "USDC",
    network: "base-sepolia",
    payer: PAYER,
    recipient: RECIPIENT,
    status: "verified",
    txHash: nextTxHash(),
    timestamp: new Date().toISOString(),
  };
}

beforeEach(() => {
  mppFake.mode = "verified";
  mppFake.source = undefined;
});

describe("metered-gate pure helpers (#2408)", () => {
  it("defaults the tier to Free when no resolver is wired", async () => {
    await expect(resolveMeteredTier(undefined, "someone")).resolves.toBe("Free");
  });

  it("defaults the tier to Free when the resolver finds no stored tier", async () => {
    await expect(resolveMeteredTier(async () => null, "someone")).resolves.toBe("Free");
  });

  it("passes a resolved tier through unchanged", async () => {
    await expect(resolveMeteredTier(async () => "Subscribed", "someone")).resolves.toBe("Subscribed");
    await expect(resolveMeteredTier(async () => "PayPerUse", "someone")).resolves.toBe("PayPerUse");
  });

  it("rejects an invalid tier value instead of defaulting it away", async () => {
    await expect(resolveMeteredTier(async () => "Gold" as unknown as StoreTier, "someone")).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
  });

  it("builds the meter row from the receipt: runId = receipt id, category = service id", () => {
    const receipt = sampleReceipt();
    const row = buildMeteredCallEvent({ receipt, userLogin: payerScopeId(PAYER), category: "options_screener", priceUSD: OPTIONS_SCAN_PRICE, tier: "Free", tenantId: null });
    expect(row.id).toBe(`use_${receipt.receiptId}`);
    expect(row.runId).toBe(receipt.receiptId);
    expect(row.category).toBe("options_screener");
    expect(row.userLogin).toBe(payerScopeId(PAYER));
    // Issue #3185: anonymous x402 traffic stamps NULL.
    expect(row.tenantId).toBeNull();
    const detail = JSON.parse(row.detailJson ?? "{}") as Record<string, unknown>;
    expect(detail.receiptId).toBe(receipt.receiptId);
    expect(detail.priceUSD).toBe(OPTIONS_SCAN_PRICE);
    expect(detail.tier).toBe("Free");
    expect(detail.protocol).toBe("x402");
  });

  it("refusals are typed JSON with error + statusCode + message", async () => {
    const res = meteredGateRefusal(503, "MeteringUnavailable", "The usage meter is unavailable.");
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBe("MeteringUnavailable");
    expect(body.statusCode).toBe(503);
    expect(body.message).toMatch(/meter/i);
  });
});

describe("x402 branch: served calls are metered, refused calls are not (#2408)", () => {
  const def = { ...TRADING_PAID_SERVICES.OPTIONS_SCREENER, priceUSD: OPTIONS_SCAN_PRICE };

  it("verified payment serves AND records exactly one usage_event", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const res = await service.handleGatedEndpoint(
      paidRequest(service, def, nextTxHash()),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id),
    );
    expect(res.status).toBe(200);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(meter.rows).toHaveLength(1);
    expect(meter.rows[0].category).toBe("options_screener");
    expect(meter.rows[0].userLogin).toBe(payerScopeId(PAYER));
    expect(meter.rows[0].runId).toMatch(/^rcpt_x402_/);
    const detail = JSON.parse(meter.rows[0].detailJson ?? "{}") as any;
    expect(detail.tier).toBe("Free");
    expect(detail.priceUSD).toBe(OPTIONS_SCAN_PRICE);
  });

  it("records the resolved tier on the usage_event (session traffic)", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const req = paidRequest(service, def, nextTxHash());
    req.headers.set("x-user-login", "owner-login");
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const res = await service.handleGatedEndpoint(
      req,
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id, async (login) => {
        expect(login).toBe("owner-login");
        return "Subscribed";
      }),
    );
    expect(res.status).toBe(200);
    expect(meter.rows).toHaveLength(1);
    expect(meter.rows[0].userLogin).toBe("owner-login");
    expect(JSON.parse(meter.rows[0].detailJson ?? "{}").tier).toBe("Subscribed");
  });

  it("unpaid request gets 402 and meters nothing", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const res = await service.handleGatedEndpoint(
      new Request(`https://agent.internal${def.resource}`, { method: "GET" }),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id),
    );
    expect(res.status).toBe(402);
    expect(fulfill).not.toHaveBeenCalled();
    expect(meter.rows).toHaveLength(0);
  });

  it("replayed transaction is refused and meters only the first serve", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const txHash = nextTxHash();
    const first = await service.handleGatedEndpoint(paidRequest(service, def, txHash), def.resource, def.priceUSD, def.description, fulfill, meteredOptions(meter, def.id));
    expect(first.status).toBe(200);
    const second = await service.handleGatedEndpoint(paidRequest(service, def, txHash), def.resource, def.priceUSD, def.description, fulfill, meteredOptions(meter, def.id));
    expect(second.status).toBe(402);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(meter.rows).toHaveLength(1);
  });

  it("missing meter refuses a verified payment with a typed error and serves nothing", async () => {
    const { service } = makeService();
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const txHash = nextTxHash();
    const refused = await service.handleGatedEndpoint(
      paidRequest(service, def, txHash),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
    );
    expect(refused.status).toBe(503);
    expect(fulfill).not.toHaveBeenCalled();
    const body = (await refused.json()) as any;
    expect(body.error).toBe("MeteringUnavailable");
    // The tx hash is released on the refusal, so a retry with a meter serves.
    const meter = new CapturingMeter();
    const retry = await service.handleGatedEndpoint(
      paidRequest(service, def, txHash),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id),
    );
    expect(retry.status).toBe(200);
    expect(meter.rows).toHaveLength(1);
  });

  it("meter failure refuses with a typed error, serves nothing, and releases the tx for retry", async () => {
    const { service } = makeService();
    const meter = new FailOnceMeter();
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const txHash = nextTxHash();
    const refused = await service.handleGatedEndpoint(
      paidRequest(service, def, txHash),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id),
    );
    expect(refused.status).toBe(503);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect((await refused.json()) as any).toMatchObject({ error: "MeteringUnavailable" });
    expect(meter.rows).toHaveLength(0);
    const retry = await service.handleGatedEndpoint(
      paidRequest(service, def, txHash),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id),
    );
    expect(retry.status).toBe(200);
    expect(meter.rows).toHaveLength(1);
  });

  it("tier-store failure refuses with a typed error and serves nothing", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const req = paidRequest(service, def, nextTxHash());
    req.headers.set("x-user-login", "owner-login");
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const res = await service.handleGatedEndpoint(
      req,
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id, async () => {
        throw new Error("D1 unavailable (test fault)");
      }),
    );
    expect(res.status).toBe(503);
    expect(fulfill).not.toHaveBeenCalled();
    expect((await res.json()) as any).toMatchObject({ error: "TierUnavailable" });
    expect(meter.rows).toHaveLength(0);
  });

  it("invalid tier value refuses with a typed error and serves nothing", async () => {
    const { service } = makeService();
    const meter = new CapturingMeter();
    const req = paidRequest(service, def, nextTxHash());
    req.headers.set("x-user-login", "owner-login");
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const res = await service.handleGatedEndpoint(
      req,
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id, async () => "Gold" as unknown as StoreTier),
    );
    expect(res.status).toBe(500);
    expect(fulfill).not.toHaveBeenCalled();
    expect((await res.json()) as any).toMatchObject({ error: "TierInvalid" });
    expect(meter.rows).toHaveLength(0);
  });
});

describe("MPP branch: served calls are metered the same way (#2408)", () => {
  const def = { ...TRADING_PAID_SERVICES.OPTIONS_SCREENER, priceUSD: OPTIONS_SCAN_PRICE };

  function mppService() {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("mpp_payer_test");
    const env = {
      X402_NETWORK: "base-sepolia",
      X402_RECIPIENT_ADDRESS: RECIPIENT,
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      MPP_SECRET_KEY: "test-mpp-secret-700",
    } as unknown as Env;
    return new ETradeAgenticPaymentService(orm, env, "gateway-instance-id", undefined, { payerBound: true });
  }

  it("verified MPP payment serves AND records exactly one usage_event", async () => {
    mppFake.source = `did:pkh:eip155:8453:${MPP_PAYER}`;
    const service = mppService();
    const meter = new CapturingMeter();
    const fulfill = vi.fn().mockResolvedValue({ data: "paid" });
    const res = await service.handleGatedEndpoint(
      new Request(`https://agent.test${def.resource}`, { method: "GET", headers: { Authorization: 'Payment id="cred-700"' } }),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
      meteredOptions(meter, def.id),
    );
    expect(res.status).toBe(200);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(meter.rows).toHaveLength(1);
    expect(meter.rows[0].category).toBe("options_screener");
    expect(meter.rows[0].userLogin).toBe(payerScopeId(MPP_PAYER));
  });

  it("MPP payment without a meter is refused and serves nothing", async () => {
    mppFake.source = `did:pkh:eip155:8453:${MPP_PAYER}`;
    const service = mppService();
    const fulfill = vi.fn().mockResolvedValue({ data: "paid" });
    const res = await service.handleGatedEndpoint(
      new Request(`https://agent.test${def.resource}`, { method: "GET", headers: { Authorization: 'Payment id="cred-700"' } }),
      def.resource,
      def.priceUSD,
      def.description,
      fulfill,
    );
    expect(res.status).toBe(503);
    expect(fulfill).not.toHaveBeenCalled();
    expect((await res.json()) as any).toMatchObject({ error: "MeteringUnavailable" });
  });
});

describe("premium-route wiring (#2408)", () => {
  it("wires a meter from ctx.sql and no tier resolver for anonymous traffic", () => {
    const sql = new MockSqlStorage();
    const ctx = { env: {}, sql, getOrm: () => ({}) } as any;
    const req = new Request("https://agent.internal/api/premium/options-scan", { method: "GET" });
    const opts = premiumMeteredGateOptions(ctx, req, "options_screener");
    expect(opts.category).toBe("options_screener");
    expect(opts.meter).toBeDefined();
    expect(opts.resolveTier).toBeUndefined();
  });

  it("wires no meter without ctx.sql (fail-closed at the gate) and a tier resolver for session traffic", () => {
    const ctx = { env: {}, getOrm: () => ({}) } as any;
    const req = new Request("https://agent.internal/api/premium/options-scan", {
      method: "GET",
      headers: { "x-user-login": "owner-login" },
    });
    const opts = premiumMeteredGateOptions(ctx, req, "options_screener");
    expect(opts.meter).toBeUndefined();
    expect(opts.resolveTier).toBeDefined();
  });

  it("tier resolver returns null when AGENT_DB is unbound (Free default, no reads)", async () => {
    const ctx = { env: {}, getOrm: () => ({}) } as any;
    const req = new Request("https://agent.internal/api/premium/options-scan", {
      method: "GET",
      headers: { "x-user-login": "owner-login" },
    });
    const opts = premiumMeteredGateOptions(ctx, req, "options_screener");
    await expect(opts.resolveTier!("owner-login")).resolves.toBeNull();
  });

  it("the route-wired DO usage port round-trips a row (write path + read path agree)", () => {
    const sql = new MockSqlStorage();
    const ctx = { env: {}, sql, getOrm: () => ({}) } as any;
    const req = new Request("https://agent.internal/api/premium/options-scan", { method: "GET" });
    const opts = premiumMeteredGateOptions(ctx, req, "options_screener");
    expect(opts.meter).toBeDefined();
    opts.meter!.ensureSchema();
    opts.meter!.insertEvent({
      id: "use_roundtrip_1",
      userLogin: "owner-login",
      runId: "rcpt_x402_roundtrip",
      category: "options_screener",
      createdAt: new Date().toISOString(),
      detailJson: JSON.stringify({ receiptId: "rcpt_x402_roundtrip", priceUSD: OPTIONS_SCAN_PRICE, tier: "Free", protocol: "x402" }),
      tenantId: "tenant-roundtrip",
    });
    const rows = opts.meter!.listByUser("owner-login", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe("rcpt_x402_roundtrip");
    expect(rows[0].category).toBe("options_screener");
    // Issue #3185: the stamp round-trips on the login read…
    expect(rows[0].tenantId).toBe("tenant-roundtrip");
    // …and the tenant read finds the same row.
    expect(opts.meter!.listByTenant("tenant-roundtrip", 10).map((r) => r.id)).toEqual(["use_roundtrip_1"]);
    expect(opts.meter!.listByTenant("other-tenant", 10)).toEqual([]);
  });
});
