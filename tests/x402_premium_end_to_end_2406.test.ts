/**
 * Monetization Phase 1.1 (#2406, sub-issue of #2405): x402 end-to-end
 * verification on the 3 priced endpoints (testnet).
 *
 * RED-first pins: for every tier in TRADING_PAID_SERVICES, the production
 * gate (ETradeAgenticPaymentService.handleGatedEndpoint — the exact gate
 * handlePremiumRoutes uses) must prove charge → verified receipt →
 * served result → ledger row, and the 402 challenge + client price line
 * must label the payment path (testnet vs simulated). Prices are pinned
 * unchanged: they stand unless the owner changes them.
 *
 * The claim verifier here is a stub standing in for on-chain
 * verification (the seam verifyOnChainClaim plugs into); the real
 * verifier is unit-covered by tests/x402_verifier.test.ts. A live
 * testnet transfer needs an owner-funded wallet + HITL confirm and is
 * NOT executed by this suite — see #2406 (explicit limitation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
  payerScopeId,
} from "../src/services/agenticPayments";
import { createInMemoryCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import { describeX402PaymentPath } from "../src/services/x402PaymentPath";
import type { X402ClaimVerifier } from "../src/services/x402Verifier";
import { describeChallenge } from "../src/client/x402Pay";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env, X402PaymentProof } from "../src/types";
import { APPROVED_PREMIUM_PRICES } from "./premiumPriceCatalogueFixture";
import { PROPOSED_SEED_PRICES } from "../src/data/priceCataloguePorts";

// #5609 (G-7): the premium routes resolve their price from the
// catalogue (getApprovedPremiumPrice). This suite binds no D1, so
// the catalogue resolves from the approved in-memory fixture —
// the real port semantics, with the binding stubbed, never the price.
const OPTIONS_SCAN_PRICE = APPROVED_PREMIUM_PRICES["options-scan"];
const MARKET_RESEARCH_PRICE = APPROVED_PREMIUM_PRICES["market-research"];
const STOCK_SIGNALS_PRICE = APPROVED_PREMIUM_PRICES["stock-signals"];

vi.mock("../src/data/createPriceCataloguePorts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/data/createPriceCataloguePorts")>();
  const { approvedPremiumCatalogue } = await import("./premiumPriceCatalogueFixture");
  return {
    ...actual,
    getApprovedPremiumPrice: (_env: unknown, family: string) =>
      approvedPremiumCatalogue.getApprovedPrice(family),
  };
});

const PAYER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x71C8363837918a211797E3c76A8B3C4258759550";

let txCounter = 0;
const nextTxHash = () => `0x${(++txCounter).toString(16).padStart(64, "0")}`;

const verifyingClaim: X402ClaimVerifier = async ({ proof }) => ({
  ok: true,
  payer: proof.payer,
  txHash: proof.txHash || "",
});
const failingClaim: X402ClaimVerifier = async () => ({
  ok: false,
  reason: "No matching USDC transfer",
});

function makeService(claimVerifier: X402ClaimVerifier) {
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

// #5609 (G-7): tier prices are the APPROVED catalogue prices
// (owner seeds), resolved from the catalogue — never literals.
const TIERS = [
  { key: "OPTIONS_SCREENER", path: "/api/premium/options-scan", price: OPTIONS_SCAN_PRICE },
  { key: "MARKET_RESEARCH", path: "/api/premium/market-research", price: MARKET_RESEARCH_PRICE },
  { key: "STOCK_SIGNALS", path: "/api/premium/stock-signals", price: STOCK_SIGNALS_PRICE },
] as const;

describe("x402 end-to-end verification, Phase 1.1 (#2406)", () => {
  describe("price pins (prices stand unless the owner changes them)", () => {
    it("pins all three tier prices, resources, and rate limits", () => {
      // #5609 (G-7): prices live in the catalogue, not on the
      // descriptor — the approved price is the owner seed; the
      // descriptor keeps resource + rate limit.
      expect(APPROVED_PREMIUM_PRICES["options-scan"]).toBe(PROPOSED_SEED_PRICES["options-scan"]);
      expect(APPROVED_PREMIUM_PRICES["market-research"]).toBe(PROPOSED_SEED_PRICES["market-research"]);
      expect(APPROVED_PREMIUM_PRICES["stock-signals"]).toBe(PROPOSED_SEED_PRICES["stock-signals"]);
      expect("priceUSD" in TRADING_PAID_SERVICES.OPTIONS_SCREENER).toBe(false);
      expect("priceUSD" in TRADING_PAID_SERVICES.MARKET_RESEARCH).toBe(false);
      expect("priceUSD" in TRADING_PAID_SERVICES.STOCK_SIGNALS).toBe(false);
      expect(TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource).toBe("/api/premium/options-scan");
      expect(TRADING_PAID_SERVICES.OPTIONS_SCREENER.rateLimitPerMin).toBe(60);
      expect(TRADING_PAID_SERVICES.MARKET_RESEARCH.resource).toBe("/api/premium/market-research");
      expect(TRADING_PAID_SERVICES.MARKET_RESEARCH.rateLimitPerMin).toBe(30);
      expect(TRADING_PAID_SERVICES.STOCK_SIGNALS.resource).toBe("/api/premium/stock-signals");
      expect(TRADING_PAID_SERVICES.STOCK_SIGNALS.rateLimitPerMin).toBe(120);
    });
  });

  describe("per-tier gate: challenge → verified receipt → served result → ledger row", () => {
    for (const tier of TIERS) {
      it(`${tier.key}: unpaid request gets a labeled 402 at the tier price and serves nothing`, async () => {
        const { orm, service } = makeService(verifyingClaim);
        const def = { ...TRADING_PAID_SERVICES[tier.key], priceUSD: tier.price };
        const fulfill = vi.fn().mockResolvedValue({ served: true });
        const res = await service.handleGatedEndpoint(
          new Request(`https://agent.internal${tier.path}`, { method: "GET" }),
          def.resource,
          def.priceUSD,
          def.description,
          fulfill,
        );
        expect(res.status).toBe(402);
        expect(fulfill).not.toHaveBeenCalled();
        const body = (await res.json()) as any;
        expect(body.protocols.x402.challenge.amount).toBe(tier.price);
        expect(body.protocols.x402.challenge.network).toBe("base-sepolia");
        expect(body.paymentPath.testnet).toBe(true);
        expect(body.paymentPath.kind).toBe("onchain");
        expect(body.paymentPath.label).toMatch(/testnet/i);
        expect(body.paymentPath.label).toMatch(/no real money/i);
        const rows = orm.transactions.findMany().filter((r: any) => r.checkoutUrl === def.resource);
        expect(rows).toHaveLength(0);
      });

      it(`${tier.key}: verified payment serves the result with receipt headers and a completed ledger row`, async () => {
        const { orm, service } = makeService(verifyingClaim);
        const def = { ...TRADING_PAID_SERVICES[tier.key], priceUSD: tier.price };
        const txHash = nextTxHash();
        const fulfill = vi.fn().mockResolvedValue({ served: true, service: def.id });
        // Issue #2408: served calls are metered — the slice-1
        // served expectation now wires the in-memory usage port
        // and pins the meter row alongside the ledger row.
        const meter = createInMemoryCanonicalReportStorePorts().usage;
        const res = await service.handleGatedEndpoint(
          paidRequest(service, def, txHash),
          def.resource,
          def.priceUSD,
          def.description,
          fulfill,
          { meter, category: def.id },
        );
        expect(res.status).toBe(200);
        expect(fulfill).toHaveBeenCalledTimes(1);
        const served = (await res.json()) as any;
        expect(served.served).toBe(true);
        expect(served.service).toBe(def.id);
        const receiptHeader = res.headers.get("PAYMENT-RESPONSE");
        expect(receiptHeader).toBeDefined();
        const receipt = JSON.parse(Buffer.from(receiptHeader!, "base64").toString("utf-8"));
        expect(receipt.status).toBe("verified");
        expect(receipt.amount).toBe(tier.price);
        expect(receipt.txHash).toBe(txHash);
        expect(receipt.payer).toBe(PAYER);
        expect(res.headers.get("Payment-Receipt")).toContain(`tx=${txHash}`);
        const rows = orm.transactions.findMany().filter((r: any) => r.gatewayRef === txHash);
        expect(rows).toHaveLength(1);
        expect(rows[0].action).toBe("agentic_payment");
        expect(rows[0].gateway).toBe("x402");
        expect(rows[0].amount).toBe(tier.price);
        expect(rows[0].currency).toBe("USDC");
        expect(rows[0].status).toBe("completed");
        expect(rows[0].checkoutUrl).toBe(def.resource);
        // Issue #2408: the same served call meters exactly one usage_event.
        const metered = meter.listByUser(payerScopeId(PAYER), 10);
        expect(metered).toHaveLength(1);
        expect(metered[0].category).toBe(def.id);
      });
    }

    it("simulated proofs are refused with a typed error, serve nothing, and write no ledger row", async () => {
      const { orm, service } = makeService(verifyingClaim);
      const def = { ...TRADING_PAID_SERVICES.OPTIONS_SCREENER, priceUSD: OPTIONS_SCAN_PRICE };
      const challenge = service.createX402Challenge(def.resource, def.priceUSD);
      const proof: X402PaymentProof = {
        payer: PAYER,
        signature: "SIMULATED_UNSIGNED_PROOF_NO_SIGNATURE",
        txHash: nextTxHash(),
        nonce: challenge.nonce,
        timestamp: Date.now(),
        simulated: true,
      };
      const req = new Request(`https://agent.internal${def.resource}`, {
        method: "GET",
        headers: {
          "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64"),
        },
      });
      const fulfill = vi.fn().mockResolvedValue({ served: true });
      const res = await service.handleGatedEndpoint(req, def.resource, def.priceUSD, def.description, fulfill);
      expect(res.status).toBe(402);
      expect(fulfill).not.toHaveBeenCalled();
      const body = (await res.json()) as any;
      expect(body.reason).toMatch(/simulated/i);
      expect(orm.transactions.findMany()).toHaveLength(0);
    });

    it("a replayed transaction hash is refused and fulfills only once", async () => {
      const { service } = makeService(verifyingClaim);
      const def = { ...TRADING_PAID_SERVICES.STOCK_SIGNALS, priceUSD: STOCK_SIGNALS_PRICE };
      const txHash = nextTxHash();
      const fulfill = vi.fn().mockResolvedValue({ served: true });
      // Issue #2408: the first serve meters; the replay meters nothing more.
      const meter = createInMemoryCanonicalReportStorePorts().usage;
      const opts = { meter, category: def.id };
      const first = await service.handleGatedEndpoint(paidRequest(service, def, txHash), def.resource, def.priceUSD, def.description, fulfill, opts);
      expect(first.status).toBe(200);
      const second = await service.handleGatedEndpoint(paidRequest(service, def, txHash), def.resource, def.priceUSD, def.description, fulfill, opts);
      expect(second.status).toBe(402);
      expect(fulfill).toHaveBeenCalledTimes(1);
      const body = (await second.json()) as any;
      expect(body.reason).toMatch(/already been used/i);
      expect(meter.listByUser(payerScopeId(PAYER), 10)).toHaveLength(1);
    });

    it("failed claim verification is refused with a typed error and serves nothing", async () => {
      const { orm, service } = makeService(failingClaim);
      const def = { ...TRADING_PAID_SERVICES.MARKET_RESEARCH, priceUSD: MARKET_RESEARCH_PRICE };
      const fulfill = vi.fn().mockResolvedValue({ served: true });
      const res = await service.handleGatedEndpoint(paidRequest(service, def, nextTxHash()), def.resource, def.priceUSD, def.description, fulfill);
      expect(res.status).toBe(402);
      expect(fulfill).not.toHaveBeenCalled();
      const body = (await res.json()) as any;
      expect(body.reason).toMatch(/No matching USDC transfer/);
      expect(orm.transactions.findMany()).toHaveLength(0);
    });
  });

  describe("route level: each premium path challenges at its tier price with a testnet label", () => {
    it("unpaid requests to all three premium paths get labeled 402s at the right prices", async () => {
      const ctx = {
        env: {},
        getOrm: () => ({ storeCanonicalReport: vi.fn() }),
      } as unknown as PremiumRouteContext;
      for (const tier of TIERS) {
        const res = await handlePremiumRoutes(
          new Request(`https://agent.internal${tier.path}`, { method: "GET" }),
          new URL(`https://agent.internal${tier.path}`),
          tier.path,
          "s",
          ctx,
        );
        expect(res, `expected a Response for ${tier.path}`).not.toBeNull();
        expect(res!.status).toBe(402);
        const body = (await res!.json()) as any;
        expect(body.protocols.x402.challenge.amount).toBe(tier.price);
        expect(body.paymentPath.testnet).toBe(true);
        expect(body.paymentPath.label).toMatch(/testnet/i);
      }
    });
  });

  describe("payment-path labeling (real-vs-simulated, per path)", () => {
    it("labels base-sepolia as a testnet on-chain path and base mainnet as real funds", () => {
      const sepolia = describeX402PaymentPath("base-sepolia");
      expect(sepolia.kind).toBe("onchain");
      expect(sepolia.testnet).toBe(true);
      expect(sepolia.label).toMatch(/testnet/i);
      expect(sepolia.label).toMatch(/no real money/i);
      const mainnet = describeX402PaymentPath("base");
      expect(mainnet.kind).toBe("onchain");
      expect(mainnet.testnet).toBe(false);
      expect(mainnet.label).toMatch(/real funds/i);
    });

    it("labels the simulated path as simulated, never as a payment", () => {
      const simulated = describeX402PaymentPath("base-sepolia", { simulated: true });
      expect(simulated.kind).toBe("simulated");
      expect(simulated.label).toMatch(/simulated/i);
      expect(simulated.label).toMatch(/no real payment was collected/i);
    });

    it("does not claim testnet or mainnet status for an unrecognized network", () => {
      const unknown = describeX402PaymentPath("polygon");
      expect(unknown.testnet).toBe(false);
      expect(unknown.label).toMatch(/not recognized/i);
    });

    it("client challenge description carries the testnet label next to the price", () => {
      const described = describeChallenge({
        network: "base-sepolia",
        recipient: RECIPIENT,
        amount: 0.05,
        currency: "USDC",
        resource: "/api/premium/options-scan",
        nonce: "n_1",
      });
      expect(described.label).toBe("Base Sepolia USDC");
      expect(described.paymentPath.testnet).toBe(true);
      expect(described.paymentPath.shortLabel).toMatch(/testnet/i);
    });
  });
});
