import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
} from "../src/services/agenticPayments";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { createInMemoryCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import type { Env, X402PaymentProof } from "../src/types";
import { AGENT_DIDS } from "../src/agents/did";
import {
  PaidOptionsScreenerCommand,
  PaidMarketResearchCommand,
  AgenticWalletStatusCommand,
} from "../src/mcps/openaimp/agenticPaymentCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync } from "../src/agents/nlq";
import { ETradeVoiceTradingService } from "../src/trading/voice/agent";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";

// On-chain verification is covered in x402_verifier.test.ts; here the verifier accepts any claim except from a known-bad payer.
vi.mock("../src/services/x402Verifier", () => ({
  verifyOnChainClaim: vi.fn(async ({ proof }: any) =>
    proof.payer === "0xBadPayer"
      ? { ok: false, reason: "No matching USDC transfer" }
      : { ok: true, payer: proof.payer, txHash: proof.txHash },
  ),
}));

describe("Cloudflare Agentic Payments (x402 & MPP Standards)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let mockEnv: Env;
  let paymentService: ETradeAgenticPaymentService;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("trader_session_1");

    mockEnv = {
      AI: {} as any,
      AI_SEARCH_ENDPOINT: "https://mock.search",
      ORCHESTRATOR_AGENT: {} as any,
      AGENT_SESSIONS: {} as any,
      X402_NETWORK: "base-sepolia",
      X402_RECIPIENT_ADDRESS: "0x71C8363837918a211797E3c76A8B3C4258759550",
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      X402_AUTO_APPROVE_LIMIT: "0.05",
      X402_AGENT_WALLET_KEY: "0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B",
    };

    paymentService = new ETradeAgenticPaymentService(orm, mockEnv, "trader_session_1");
  });

  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  describe("1. HTTP 402 Protocol Engine & Challenge Generation", () => {
    it("generates valid x402 payment challenge with standard fields", () => {
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05, "Options Screener");
      expect(challenge.version).toBe("1.0");
      expect(challenge.network).toBe("base-sepolia");
      expect(challenge.amount).toBe(0.05);
      expect(challenge.currency).toBe("USDC");
      expect(challenge.recipient).toBe("0x71C8363837918a211797E3c76A8B3C4258759550");
      expect(challenge.facilitator).toBe("https://x402.org/facilitator");
      expect(challenge.nonce).toMatch(/^n_\d+_/);
      expect(challenge.expiresAt).toBeGreaterThan(Date.now());
    });

    it("generates valid MPP challenge with standard fields", () => {
      const challenge = paymentService.createMppChallenge("/api/premium/market-research", 0.10, "Market Research");
      expect(challenge.protocol).toBe("mpp");
      expect(challenge.method).toBe("tempo");
      expect(challenge.amount).toBe("0.10");
      expect(challenge.currency).toBe("0x20c0000000000000000000000000000000000000");
      expect(challenge.recipient).toBe("0x71C8363837918a211797E3c76A8B3C4258759550");
      expect(challenge.testnet).toBe(true);
    });

    it("encodes challenges into standard HTTP 402 headers", () => {
      const x402Ch = paymentService.createX402Challenge("/api/premium/stock-signals", 0.02);
      const encodedX402 = paymentService.formatX402ChallengeHeader(x402Ch);
      expect(typeof encodedX402).toBe("string");
      const decoded = JSON.parse(Buffer.from(encodedX402, "base64").toString("utf-8"));
      expect(decoded.amount).toBe(0.02);

      const mppCh = paymentService.createMppChallenge("/api/premium/stock-signals", 0.02);
      const mppHeader = paymentService.formatMppChallengeHeader(mppCh);
      expect(mppHeader).toContain('Payment method="tempo"');
      expect(mppHeader).toContain('amount="0.02"');
    });

    it("returns HTTP 402 Response with both x402 and MPP headers and CORS exposure", () => {
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05);
      const res = paymentService.createPaymentRequiredResponse(challenge);

      expect(res.status).toBe(402);
      expect(res.statusText).toBe("Payment Required");
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeDefined();
      expect(res.headers.get("WWW-Authenticate")).toContain("Payment method=");
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-REQUIRED");
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
    });
  });

  describe("2. Verification of Payment Signatures & Settlement", () => {
    it("verifies valid base64 x402 PAYMENT-SIGNATURE proof and returns receipt", async () => {
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05);
      const proof: X402PaymentProof = {
        payer: "0xConsumerWallet123",
        signature: "0x_sig_mock_valid_hash",
        txHash: "0x_tx_abc_123",
        nonce: challenge.nonce,
        timestamp: Date.now(),
      };
      const headerVal = Buffer.from(JSON.stringify(proof)).toString("base64");

      const verification = await paymentService.verifyPayment(
        { "PAYMENT-SIGNATURE": headerVal },
        challenge
      );

      expect(verification.valid).toBe(true);
      expect(verification.receipt).toBeDefined();
      expect(verification.receipt?.protocol).toBe("x402");
      expect(verification.receipt?.amount).toBe(0.05);
      expect(verification.receipt?.payer).toBe("0xConsumerWallet123");
      expect(verification.receipt?.status).toBe("verified");
    });

    it("rejects unverified MPP Authorization headers (fail closed)", async () => {
      const challenge = paymentService.createMppChallenge("/api/premium/market-research", 0.10);
      const authHeader = 'Payment method="tempo", payer="0xMppPayer456", txHash="0x_tx_mpp_789", sig="0x_sig_mpp"';

      const verification = await paymentService.verifyPayment({ Authorization: authHeader }, challenge);

      expect(verification.valid).toBe(false);
      expect(verification.receipt).toBeUndefined();
      expect(verification.reason).toContain("mppx");
    });
    it("rejects a failed on-chain claim and a replayed transaction hash", async () => {
      const challenge = paymentService.createX402Challenge("/api/premium/stock-signals", 0.02);
      const mk = (payer: string, txHash: string) => ({
        "PAYMENT-SIGNATURE": JSON.stringify({ payer, signature: "0xsig", txHash, nonce: challenge.nonce, timestamp: Date.now() }),
      });

      const bad = await paymentService.verifyPayment(mk("0xBadPayer", "0xreplay1"), challenge);
      expect(bad.valid).toBe(false);
      expect(bad.reason).toContain("USDC transfer");

      expect((await paymentService.verifyPayment(mk("0xGood", "0xreplay2"), challenge)).valid).toBe(true);
      const replay = await paymentService.verifyPayment(mk("0xGood", "0xreplay2"), challenge);
      expect(replay.valid).toBe(false);
      expect(replay.reason).toContain("already been used");
    });

    it("rejects PAYMENT-SIGNATURE with mismatched challenge nonce", async () => {
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05);
      const proof: X402PaymentProof = {
        payer: "0xConsumerWallet123",
        signature: "0x_sig_mock",
        nonce: "wrong_nonce_replay",
        timestamp: Date.now(),
      };

      const verification = await paymentService.verifyPayment(
        { "PAYMENT-SIGNATURE": JSON.stringify(proof) },
        challenge
      );

      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("Invalid nonce");
    });

    it("rejects malformed or empty payment headers", async () => {
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05);
      const verification = await paymentService.verifyPayment({}, challenge);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("No payment credentials provided");
    });
  });

  describe("3b. MPP via mppx", () => {
    const resource = TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource;

    it("issues a signed mppx WWW-Authenticate challenge when MPP_SECRET_KEY is set", async () => {
      const service = new ETradeAgenticPaymentService(orm, { ...mockEnv, MPP_SECRET_KEY: "test-secret-key-test-secret-key-0123456789" }, "trader_session_1");
      const req = new Request("https://agent.openaimp.com/api/premium/options-scan");
      const res = await service.handleGatedEndpoint(req, resource, 0.05, "Options Screener", async () => ({}));

      expect(res.status).toBe(402);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
      expect(res.headers.get("WWW-Authenticate")).toContain('id="');
    }, 60_000);

    it("does not fulfill a forged MPP credential", async () => {
      const service = new ETradeAgenticPaymentService(orm, { ...mockEnv, MPP_SECRET_KEY: "test-secret-key-test-secret-key-0123456789" }, "trader_session_1");
      const fulfill = vi.fn().mockResolvedValue({ data: "paid" });
      const req = new Request("https://agent.openaimp.com/api/premium/options-scan", {
        headers: { Authorization: 'Payment method="tempo", payer="0xForged", txHash="0xabc"' },
      });
      const res = await service.handleGatedEndpoint(req, resource, 0.05, "Options Screener", fulfill);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(fulfill).not.toHaveBeenCalled();
    });

    it("rejects MPP credentials when MPP_SECRET_KEY is not configured", async () => {
      const fulfill = vi.fn();
      const req = new Request("https://agent.openaimp.com/api/premium/options-scan", {
        headers: { Authorization: 'Payment method="tempo"' },
      });
      const res = await paymentService.handleGatedEndpoint(req, resource, 0.05, "Options Screener", fulfill);

      expect(res.status).toBe(402);
      expect(fulfill).not.toHaveBeenCalled();
    });
  });
  describe("3. Server-Side Provider: handleGatedEndpoint", () => {
    it("returns HTTP 402 challenge when request lacks payment header", async () => {
      const req = new Request("https://agent.openaimp.com/api/premium/options-scan", {
        method: "GET",
      });

      const res = await paymentService.handleGatedEndpoint(
        req,
        TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource,
        TRADING_PAID_SERVICES.OPTIONS_SCREENER.priceUSD,
        TRADING_PAID_SERVICES.OPTIONS_SCREENER.description,
        async () => ({ data: "should_not_be_reached" })
      );

      expect(res.status).toBe(402);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeDefined();
      const body = await res.json() as any;
      expect(body.statusCode).toBe(402);
      expect(body.protocols.x402).toBeDefined();
    });

    it("fulfills request with HTTP 200 and receipt headers when payment signature is valid", async () => {
      const challenge = paymentService.createX402Challenge(
        TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource,
        0.05
      );
      // Issue #122: this test previously built its "valid" payment via the
      // service's own signPaymentProof — the client-fabricates/server-accepts
      // loop that #122 removes (simulated proofs are now rejected outright).
      // Like the sibling tests above, it now presents a subscriber proof
      // directly; the mocked claim verifier stands in for on-chain
      // verification, which is what handleGatedEndpoint actually gates on.
      const subscriberProof: X402PaymentProof = {
        payer: "0xSubscriberWallet",
        signature: "0x_sig_mock_valid_hash",
        txHash: "0x_tx_subscriber",
        nonce: challenge.nonce,
        timestamp: Date.now(),
      };
      const headers = {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(subscriberProof)).toString("base64"),
      };

      const req = new Request("https://agent.openaimp.com/api/premium/options-scan", {
        method: "GET",
        headers,
      });

      const fulfillMock = vi.fn().mockResolvedValue({
        scannedEquities: 20,
        topPicks: ["NVDA", "AAPL"],
      });

      // Issue #2408: the gate meters served calls — a served
      // expectation now wires the in-memory usage port (the same
      // port family the production gate meters through).
      const meter = createInMemoryCanonicalReportStorePorts().usage;
      const res = await paymentService.handleGatedEndpoint(
        req,
        TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource,
        0.05,
        "Options Screener",
        fulfillMock,
        { meter, category: TRADING_PAID_SERVICES.OPTIONS_SCREENER.id }
      );

      expect(res.status).toBe(200);
      expect(fulfillMock).toHaveBeenCalled();
      expect(res.headers.get("PAYMENT-RESPONSE")).toBeDefined();
      expect(res.headers.get("Payment-Receipt")).toContain("id=rcpt_");
      expect(meter.listByUser("x402:0xSubscriberWallet", 10)).toHaveLength(1);

      const body = await res.json() as any;
      expect(body.scannedEquities).toBe(20);
      expect(body.topPicks).toContain("NVDA");
    });
  });

  describe("4. Client-Side Consumer: Autonomous Outbound Spending & HITL", () => {
    it("passes through non-402 free requests seamlessly", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ freeData: true }), { status: 200 })
      );

      const res = await paymentService.requestWithAgenticPayment("https://external-feed.com/free-api");
      expect(res.success).toBe(true);
      expect(res.status).toBe(200);
      expect(res.data.freeData).toBe(true);

      fetchSpy.mockRestore();
    });

    it("auto-approves outbound micropayment when cost is <= autoApproveLimitUSD ($0.05)", async () => {
      const challenge = paymentService.createX402Challenge("/feed/quote", 0.04, "Stock Quote Micropayment");
      const initial402 = paymentService.createPaymentRequiredResponse(challenge);
      const paid200 = new Response(JSON.stringify({ quote: 125.50 }), {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ receiptId: "rcpt_feed_1" })).toString("base64"),
        },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(initial402)
        .mockResolvedValueOnce(paid200);

      const hitlCallback = vi.fn();
      const res = await paymentService.requestWithAgenticPayment(
        "https://external-feed.com/feed/quote",
        {},
        hitlCallback
      );

      expect(res.success).toBe(true);
      expect(res.status).toBe(200);
      expect(hitlCallback).not.toHaveBeenCalled(); // Auto-approved without disturbing user
      expect(res.data.quote).toBe(125.50);

      fetchSpy.mockRestore();
    });

    it("triggers HITL confirmation and aborts when payment > autoApproveLimitUSD is rejected", async () => {
      // Cost is $0.15, which exceeds default $0.05 limit
      const challenge = paymentService.createX402Challenge("/feed/deep-analysis", 0.15, "Deep Quant Analysis");
      const initial402 = paymentService.createPaymentRequiredResponse(challenge);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(initial402);

      const hitlCallback = vi.fn().mockResolvedValue(false); // Trader rejects payment
      const res = await paymentService.requestWithAgenticPayment(
        "https://external-feed.com/feed/deep-analysis",
        {},
        hitlCallback
      );

      expect(hitlCallback).toHaveBeenCalled();
      expect(res.success).toBe(false);
      expect(res.status).toBe(402);
      expect(res.error).toContain("rejected by Human Authorization (HITL safety rule)");

      fetchSpy.mockRestore();
    });

    it("triggers HITL confirmation and proceeds when payment > autoApproveLimitUSD is approved", async () => {
      const challenge = paymentService.createX402Challenge("/feed/deep-analysis", 0.15, "Deep Quant Analysis");
      const initial402 = paymentService.createPaymentRequiredResponse(challenge);
      const paid200 = new Response(JSON.stringify({ quantAlpha: 0.94 }), {
        status: 200,
        headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ receiptId: "rcpt_feed_99" })).toString("base64") },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(initial402)
        .mockResolvedValueOnce(paid200);

      const hitlCallback = vi.fn().mockResolvedValue(true); // Trader explicitly approves
      const res = await paymentService.requestWithAgenticPayment(
        "https://external-feed.com/feed/deep-analysis",
        {},
        hitlCallback
      );

      expect(hitlCallback).toHaveBeenCalled();
      expect(res.success).toBe(true);
      expect(res.data.quantAlpha).toBe(0.94);

      fetchSpy.mockRestore();
    });
  });

  describe("5. Financial Ledger & Wallet Status Persistence", () => {
    it("persists inbound agentic payments in mas_transactions and mas_events", async () => {
      const challenge = paymentService.createX402Challenge("/api/premium/stock-signals", 0.02);
      const proof: X402PaymentProof = {
        payer: "0xClientA",
        signature: "0x_sig_a",
        txHash: "0x_tx_a",
        nonce: challenge.nonce,
        timestamp: Date.now(),
      };

      await paymentService.verifyPayment(
        { "PAYMENT-SIGNATURE": JSON.stringify(proof) },
        challenge
      );

      const txs = orm.transactions.findMany();
      expect(txs.length).toBeGreaterThan(0);
      const lastTx = txs[0];
      expect(lastTx.action).toBe("agentic_payment");
      expect(lastTx.gateway).toBe("x402");
      expect(lastTx.amount).toBe(0.02);
      expect(lastTx.currency).toBe("USDC");
      expect(lastTx.status).toBe("completed");

      const events = orm.events.findMany({ where: { type: "AGENTIC_PAYMENT_COLLECTED" } });
      expect(events.length).toBe(1);
    });

    it("calculates accurate wallet metrics and auto-approve limits", async () => {
      // Inbound payment ($0.05 earned)
      await paymentService.recordPaymentTransaction(
        {
          receiptId: "rcpt_earn_1",
          protocol: "x402",
          resource: "/api/premium/options-scan",
          amount: 0.05,
          currency: "USDC",
          network: "base-sepolia",
          payer: "0xBuyer",
          recipient: "0xAgent",
          status: "verified",
          txHash: "0x_hash_1",
          timestamp: new Date().toISOString(),
          proposerDid: AGENT_DIDS.TRADING,
        },
        "inbound"
      );

      // Outbound micropayment ($0.03 spent)
      await paymentService.recordPaymentTransaction(
        {
          receiptId: "rcpt_spend_1",
          protocol: "x402",
          resource: "/feed/quote",
          amount: 0.03,
          currency: "USDC",
          network: "base-sepolia",
          payer: "0xAgent",
          recipient: "0xFeed",
          status: "paid",
          txHash: "0x_hash_2",
          timestamp: new Date().toISOString(),
          proposerDid: AGENT_DIDS.TRADING,
        },
        "outbound"
      );

      const status = await paymentService.getWalletStatus();
      expect(status.walletAddress).toBe("0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B");
      expect(status.network).toBe("base-sepolia");
      expect(status.totalEarnedUSD).toBe(0.05);
      expect(status.totalSpentUSD).toBe(0.03);
      expect(status.transactionCount).toBe(2);
      expect(status.balanceUSD).toBe(50.0 + 0.05 - 0.03);
    });

    it("allows dynamically adjusting HITL auto-approval limit", () => {
      expect(paymentService.getAutoApproveLimit()).toBe(0.05);
      paymentService.setAutoApproveLimit(0.12);
      expect(paymentService.getAutoApproveLimit()).toBe(0.12);
      expect(() => paymentService.setAutoApproveLimit(-0.01)).toThrow("cannot be negative");
    });
  });

  describe("6. Paid MCP Tools Integration", () => {
    it("registers paid MCP commands in McpToolFactory", () => {
      const tools = McpToolFactory.getAllTools();
      const names = tools.map((t) => t.name);

      expect(names).toContain("paid_options_screener");
      expect(names).toContain("paid_market_research");
      expect(names).toContain("agentic_wallet_status");
    });

    it("PaidOptionsScreenerCommand returns 402 challenge when unpaid", async () => {
      const cmd = new PaidOptionsScreenerCommand();
      const res = await cmd.execute({ underlying: "NVDA" }, {
        env: mockEnv,
        orm,
        sessionId: "mcp_client",
        audit: vi.fn(),
      });

      expect(res.status).toBe(402);
      expect(res.paid).toBe(false);
      expect(res.priceUSD).toBe(0.05);
      expect(res.challenge).toBeDefined();
      expect(res.challenge.resource).toBe("/api/premium/options-scan");
    });

    it("PaidOptionsScreenerCommand executes screening when valid paymentSignature is supplied", async () => {
      const cmd = new PaidOptionsScreenerCommand();
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05);
      const proof: X402PaymentProof = {
        payer: "0xMcpSubscriber",
        signature: "0x_sig_mcp_options",
        txHash: "0xmcpoptions",
        nonce: challenge.nonce,
        timestamp: Date.now(),
      };
      const b64Proof = Buffer.from(JSON.stringify(proof)).toString("base64");

      const res = await cmd.execute({ underlying: "NVDA", paymentSignature: b64Proof }, {
        env: mockEnv,
        orm,
        sessionId: "mcp_client",
        audit: vi.fn(),
      });

      expect(res.status).toBe(200);
      expect(res.paid).toBe(true);
      expect(res.receipt).toBeDefined();
      expect(res.contracts).toBeDefined();
    });

    it("PaidMarketResearchCommand returns 402 when unpaid and reports when paid", async () => {
      const cmd = new PaidMarketResearchCommand();
      const unpaidRes = await cmd.execute({ symbol: "NVDA" }, {
        env: mockEnv,
        orm,
        sessionId: "mcp_client",
        audit: vi.fn(),
      });

      expect(unpaidRes.status).toBe(402);
      expect(unpaidRes.priceUSD).toBe(0.10);

      const challenge = paymentService.createX402Challenge("/api/premium/market-research", 0.10);
      const proof: X402PaymentProof = {
        payer: "0xMcpResearchSubscriber",
        signature: "0x_sig_mcp_research",
        txHash: "0xmcpresearch",
        nonce: challenge.nonce,
        timestamp: Date.now(),
      };
      const b64Proof = Buffer.from(JSON.stringify(proof)).toString("base64");

      // #923: the paid report is built from live market data — the old
      // test passed only because the provider served fallback profiles
      // with no network. Stub realistic live Yahoo payloads (chart for
      // quote + bars, crumb + quoteSummary for fundamentals) so the
      // paid path still exercises a real live report.
      const closes = Array.from({ length: 30 }, (_, i) => 170 + i);
      const timestamps = closes.map((_, i) => 1767225600 + i * 86400);
      const jsonRes = (body: unknown) => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
        headers: { get: (h: string) => (h === "set-cookie" ? "A1=dummy; path=/" : null) },
      });
      // Exact-hostname check (CodeQL js/incomplete-url-substring-sanitization).
      const isFcYahoo = (u: string) => {
        try {
          return new URL(u).hostname === "fc.yahoo.com";
        } catch {
          return false;
        }
      };
      vi.stubGlobal("fetch", vi.fn(async (input: any) => {
        const url = String(input);
        if (isFcYahoo(url)) return jsonRes({});
        if (url.includes("getcrumb")) return jsonRes("dummy-crumb");
        if (url.includes("/v10/finance/quoteSummary/")) {
          return jsonRes({
            quoteSummary: {
              result: [
                {
                  price: { longName: "NVIDIA Corporation", marketCap: { raw: 3e12 } },
                  summaryDetail: {
                    trailingPE: { raw: 50 },
                    forwardPE: { raw: 40 },
                    marketCap: { raw: 3e12 },
                    fiftyTwoWeekHigh: { raw: 210 },
                    fiftyTwoWeekLow: { raw: 100 },
                    dividendYield: { raw: 0.001 },
                  },
                  defaultKeyStatistics: {
                    enterpriseValue: { raw: 3.1e12 },
                    pegRatio: { raw: 1.1 },
                    priceToBook: { raw: 40 },
                    beta: { raw: 1.7 },
                  },
                  financialData: {
                    targetMeanPrice: { raw: 220 },
                    targetHighPrice: { raw: 260 },
                    targetLowPrice: { raw: 170 },
                    recommendationKey: "strong_buy",
                    recommendationMean: { raw: 1.4 },
                    numberOfAnalystOpinions: { raw: 42 },
                    profitMargins: { raw: 0.55 },
                    operatingMargins: { raw: 0.6 },
                    returnOnEquity: { raw: 1.1 },
                    totalRevenue: { raw: 1.3e11 },
                    grossProfits: { raw: 9e10 },
                    ebitda: { raw: 8e10 },
                    freeCashflow: { raw: 6e10 },
                  },
                },
              ],
            },
          });
        }
        return jsonRes({
          chart: {
            result: [
              {
                meta: {
                  symbol: "NVDA",
                  longName: "NVIDIA Corporation",
                  currency: "USD",
                  regularMarketPrice: 199,
                  regularMarketPreviousClose: 198,
                  chartPreviousClose: 198,
                  regularMarketVolume: 1234567,
                  regularMarketDayHigh: 201,
                  regularMarketDayLow: 197,
                  fiftyTwoWeekHigh: 210,
                  fiftyTwoWeekLow: 100,
                  bid: 198.9,
                  ask: 199.1,
                },
                timestamp: timestamps,
                indicators: {
                  quote: [
                    {
                      close: closes,
                      open: closes,
                      high: closes,
                      low: closes,
                      volume: closes.map(() => 1000),
                    },
                  ],
                },
              },
            ],
          },
        });
      }));
      try {
        const paidRes = await cmd.execute({ symbol: "NVDA", paymentSignature: b64Proof }, {
          env: mockEnv,
          orm,
          sessionId: "mcp_client",
          audit: vi.fn(),
        });

        expect(paidRes.status).toBe(200);
        expect(paidRes.paid).toBe(true);
        expect(paidRes.report).toBeDefined();
        expect(paidRes.report.symbol).toBe("NVDA");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("AgenticWalletStatusCommand returns wallet status and transaction aggregates", async () => {
      const cmd = new AgenticWalletStatusCommand();
      const res = await cmd.execute({}, {
        env: mockEnv,
        orm,
        sessionId: "mcp_client",
        audit: vi.fn(),
      });

      expect(res.walletAddress).toBe("0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B");
      expect(res.balanceUSD).toBeGreaterThanOrEqual(0);
      expect(res.autoApproveLimitUSD).toBe(0.05);
    });
  });

  describe("7. Natural Language Query (NLQ) Integration", () => {
    it("plans wallet status query intent via planNLQ", async () => {
      const plan = await planNLQ(mockEnv, "Show agent wallet balance and status");
      expect(plan.domain).toBe("agentic_payments");
      expect(plan.operation).toBe("list");
      expect(plan.agenticPaymentsData?.action).toBe("wallet_status");
    });

    it("plans auto-approval limit adjustment via planNLQ", async () => {
      const plan = await planNLQ(mockEnv, "Set auto approve limit to $0.15");
      expect(plan.domain).toBe("agentic_payments");
      expect(plan.operation).toBe("update");
      expect(plan.agenticPaymentsData?.action).toBe("set_limit");
      expect(plan.agenticPaymentsData?.limitUSD).toBe(0.15);
    });

    it("plans micropayment ledger query via planNLQ", async () => {
      const plan = await planNLQ(mockEnv, "Show all micropayment transactions");
      expect(plan.domain).toBe("agentic_payments");
      expect(plan.operation).toBe("list");
      expect(plan.agenticPaymentsData?.action).toBe("micropayments_list");
    });

    it("executes wallet status query via executeNLQQuery", () => {
      const plan = {
        domain: "agentic_payments" as const,
        operation: "list" as const,
        agenticPaymentsData: { action: "wallet_status" as const },
        terms: "wallet_status",
        role: "any" as const,
        since: null,
        limit: 1,
      };

      const result = executeNLQQuery(orm, "session_trader", plan, mockEnv);
      expect(result.domain).toBe("agentic_payments");
      expect(result.summary).toContain("Agentic Wallet: Balance");
      expect(result.rows.length).toBe(1);
    });

    it("refuses paid options screen via executeNLQQueryAsync — no verified x402 payment channel in NLQ (G3, #2396)", async () => {
      const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const quoteTimestamp = Date.now();
      DynamicOptionsScreener.setTestChainsFixture({
        NVDA: {
          symbol: "NVDA",
          underlyingPrice: 100,
          selectedExpiry: {
            year: expiryDate.getUTCFullYear(),
            month: expiryDate.getUTCMonth() + 1,
            day: expiryDate.getUTCDate(),
          },
          pairs: [{
            call: {
              timeStamp: quoteTimestamp,
              adjustedFlag: false,
              optionType: "CALL",
              strikePrice: 100,
              symbol: "NVDATESTC100",
              bid: 2,
              ask: 2.2,
              lastPrice: 2.1,
              volume: 500,
              openInterest: 1000,
              delta: 0.52,
              impliedVolatility: 0.38,
            },
          }],
        },
      });
      const plan = {
        domain: "agentic_payments" as const,
        operation: "create" as const,
        agenticPaymentsData: { action: "paid_scan" as const, symbol: "NVDA" },
        terms: "NVDA",
        role: "any" as const,
        since: null,
        limit: 10,
      };

      const result = await executeNLQQueryAsync(orm, "session_trader", plan, mockEnv, "session_trader");
      expect(result.domain).toBe("agentic_payments");
      expect(result.status).toBe("error");
      expect(result.summary).toContain("Paid Options Screener ($0.05 USDC)");
      expect(result.summary).toContain("requires a verified x402 payment");
      expect(result.summary).toContain("/api/premium/options-scan");
      expect(result.rows.length).toBe(0);
      // G3: no simulated receipt is minted or recorded for the refusal.
      expect(orm.transactions.findMany().filter((t) => t.gateway === "x402" || t.gateway === "mpp")).toHaveLength(0);
    });
  });

  describe("8. Voice Trading Desk Integration", () => {
    it("handles verbal wallet inquiry and returns spoken audio script", async () => {
      const voiceService = new ETradeVoiceTradingService(mockEnv, orm, "voice_user");
      const turn = await voiceService.processVoiceTurn({
        rawTranscript: "What is my agent wallet balance and status?",
        sessionId: "voice_user",
        userLogin: "voice_user",
      });

      expect(turn.success).toBe(true);
      expect(turn.actionType).toBe("agentic_payment");
      expect(turn.spokenText).toContain("Agentic Wallet");
      expect(turn.displayMarkdown).toContain("Agentic Micropayments");
    });

    it("tunes financial pronunciation for wallet receipts and amounts", () => {
      const voiceService = new ETradeVoiceTradingService(mockEnv, orm, "voice_user");
      const greeting = voiceService.getWelcomeGreeting();
      expect(greeting.spokenText).toBeDefined();
      expect(greeting.spokenText).toContain("Welcome to the E*TRADE Voice Trading Desk");
    });
  });
});
