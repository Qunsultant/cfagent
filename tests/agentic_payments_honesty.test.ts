/**
 * Issue #122 — agentic payments honesty (audit #115 finding F8).
 *
 * The payment GATEWAYS and the server-side verification path were already
 * honest (real on-chain claim verification via x402Verifier; mppx for MPP).
 * The defect was this service's balance/proof/receipt layer:
 *  - wallet balance = hard-coded $50.00 + local ledger, returned as
 *    `balanceUSD` with no simulated/local marker;
 *  - client "signatures" were `0x_sig_` + hex of plaintext, tx hashes were
 *    random UUIDs dressed as `0x_tx_…`;
 *  - receipts were synthesised locally claiming status "paid"/"verified";
 *  - the ledger fabricated `sig_<receiptId>` proof signatures;
 *  - NLQ paid services booked receipts with status "verified" and a
 *    timestamp-hex txHash for payments that never happened.
 *
 * These tests pin the corrected behaviour: everything local is labelled
 * simulated/local inseparably, fabricated cryptographic artefacts are gone,
 * simulated proofs are not redeemable, and "verified" is issued only after
 * an actual (here: mocked) claim verification.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
  AGENTIC_WALLET_STARTING_CREDIT_USD,
  SIMULATED_PROOF_SIGNATURE,
} from "../src/services/agenticPayments";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env, X402PaymentProof } from "../src/types";
import { AgenticWalletStatusCommand } from "../src/mcps/openaimp/agenticPaymentCommands";
import { executeNLQQuery, executeNLQQueryAsync } from "../src/agents/nlq";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";

// Stand-in for on-chain claim verification (the real verifier is covered in
// x402_verifier.test.ts): accepts any non-simulated claim.
vi.mock("../src/services/x402Verifier", () => ({
  verifyOnChainClaim: vi.fn(async ({ proof }: any) => ({
    ok: true,
    payer: proof.payer,
    txHash: proof.txHash,
  })),
}));

describe("Issue #122: agentic payments balance / proof / receipt honesty", () => {
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
    } as Env;

    paymentService = new ETradeAgenticPaymentService(orm, mockEnv, "trader_session_1");
  });

  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
    vi.restoreAllMocks();
  });

  describe("wallet balance labelling", () => {
    it("service-level balance carries the simulated / local-ledger markers and discloses the $50 seed", async () => {
      const status = await paymentService.getWalletStatus();
      expect(status.simulated).toBe(true);
      expect(status.source).toBe("local-ledger");
      expect(status.startingCreditUSD).toBe(AGENTIC_WALLET_STARTING_CREDIT_USD);
      expect(status.startingCreditUSD).toBe(50);
      expect(status.note).toContain("$50.00 local starting credit");
      expect(status.note).toContain("does not read any on-chain wallet balance");
      // With an empty ledger the balance IS the seed — now disclosed as such.
      expect(status.balanceUSD).toBe(50);
    });

    it("MCP wallet status result carries the same markers (consumer surface)", async () => {
      const cmd = new AgenticWalletStatusCommand();
      const res: any = await cmd.execute({}, {
        env: mockEnv,
        orm,
        sessionId: "mcp_client",
        audit: vi.fn(),
      });
      expect(res.simulated).toBe(true);
      expect(res.source).toBe("local-ledger");
      expect(res.startingCreditUSD).toBe(50);
      expect(res.note).toContain("starting credit");
    });

    it("NLQ wallet_status summary and rows disclose the simulated balance", () => {
      const plan = {
        domain: "agentic_payments" as const,
        operation: "list" as const,
        agenticPaymentsData: { action: "wallet_status" as const },
        terms: "wallet_status",
        role: "any" as const,
        since: null,
        limit: 1,
      };
      const result: any = executeNLQQuery(orm, "session_trader", plan, mockEnv);
      expect(result.summary).toContain("SIMULATED local-ledger balance");
      expect(result.summary).toContain("$50.00 local starting credit");
      expect(result.summary).toContain("not an on-chain wallet balance");
      expect(result.rows[0].simulated).toBe(true);
      expect(result.rows[0].source).toBe("local-ledger");
      expect(result.rows[0].status).toBe("SIMULATED");
    });
  });

  describe("proofs", () => {
    it("signPaymentProof produces no signature-shaped fabrication and marks the proof simulated", async () => {
      const challenge = paymentService.createX402Challenge("/feed/quote", 0.04, "Quote");
      const { x402Proof, headers } = await paymentService.signPaymentProof(challenge, "0xAgentWallet");

      expect(x402Proof).toBeDefined();
      expect(x402Proof!.simulated).toBe(true);
      expect(x402Proof!.signature).toBe(SIMULATED_PROOF_SIGNATURE);
      expect(x402Proof!.signature).not.toMatch(/^0x/);
      expect(x402Proof!.signature).not.toContain("0x_sig_");
      expect(x402Proof!.txHash).toBeUndefined();
      expect(x402Proof!.facilitatorToken).toBeUndefined();

      const decoded = JSON.parse(Buffer.from(headers["PAYMENT-SIGNATURE"], "base64").toString("utf-8"));
      expect(decoded.simulated).toBe(true);
      expect(decoded.signature).toBe(SIMULATED_PROOF_SIGNATURE);
      expect(decoded.txHash).toBeUndefined();
    });

    it("verifyPayment rejects a simulated proof even when the claim verifier would accept it", async () => {
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05);
      const { headers } = await paymentService.signPaymentProof(challenge, "0xAgentWallet");

      const verification = await paymentService.verifyPayment(headers, challenge);
      expect(verification.valid).toBe(false);
      expect(verification.receipt).toBeUndefined();
      expect(verification.reason).toContain("Simulated payment proofs are not accepted");
    });

    it("a verified receipt is still issued after an actual (mocked) claim verification", async () => {
      const challenge = paymentService.createX402Challenge("/api/premium/options-scan", 0.05);
      const proof: X402PaymentProof = {
        payer: "0xRealSubscriber",
        signature: "0x" + "ab".repeat(65),
        txHash: "0x" + "cd".repeat(32),
        nonce: challenge.nonce,
        timestamp: Date.now(),
      };
      const verification = await paymentService.verifyPayment(
        { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64") },
        challenge
      );
      expect(verification.valid).toBe(true);
      expect(verification.receipt?.status).toBe("verified");
      expect(verification.receipt?.simulated).toBeUndefined();
      expect(verification.receipt?.txHash).toBe(proof.txHash);
    });
  });

  describe("receipts", () => {
    it("outbound flow without a server receipt records a SIMULATED local receipt, never 'paid' with a fabricated txHash", async () => {
      const challenge = paymentService.createX402Challenge("/feed/quote", 0.04, "Stock Quote Micropayment");
      const initial402 = paymentService.createPaymentRequiredResponse(challenge);
      const paid200 = new Response(JSON.stringify({ quote: 125.5 }), { status: 200 }); // no PAYMENT-RESPONSE header

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(initial402)
        .mockResolvedValueOnce(paid200);

      const res = await paymentService.requestWithAgenticPayment("https://external-feed.com/feed/quote");
      expect(res.success).toBe(true);
      expect(res.receipt).toBeDefined();
      expect(res.receipt!.status).toBe("simulated");
      expect(res.receipt!.simulated).toBe(true);
      expect(res.receipt!.txHash).toBeUndefined();
      expect(res.receipt!.note).toContain("SIMULATED");
      expect(res.receipt!.note).toContain("no on-chain settlement was made or verified");

      // The ledger entry inherits the honesty: simulated status, no sig_ fabrication.
      const txs = orm.transactions.findMany();
      const recorded = txs.find((t) => t.id === `tx_${res.receipt!.receiptId}`);
      expect(recorded).toBeDefined();
      expect(recorded!.status).toBe("simulated");
      expect(recorded!.proofSignature).not.toMatch(/^sig_/);
      expect(recorded!.proofSignature).toContain("simulated");
      expect(recorded!.note).toContain("no real payment was made or verified");

      fetchSpy.mockRestore();
    });

    it("a complete server-issued receipt in PAYMENT-RESPONSE is used as-is (not re-labelled simulated)", async () => {
      const challenge = paymentService.createX402Challenge("/feed/quote", 0.04, "Stock Quote Micropayment");
      const initial402 = paymentService.createPaymentRequiredResponse(challenge);
      const serverReceipt = {
        receiptId: "rcpt_server_1",
        protocol: "x402",
        resource: "/feed/quote",
        amount: 0.04,
        currency: "USDC",
        network: "base-sepolia",
        payer: "0xAgentWallet",
        recipient: challenge.recipient,
        status: "verified",
        txHash: "0x" + "ef".repeat(32),
        timestamp: new Date().toISOString(),
        proposerDid: "did:agent:openaimp:trading",
      };
      const paid200 = new Response(JSON.stringify({ quote: 99.0 }), {
        status: 200,
        headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(serverReceipt)).toString("base64") },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(initial402)
        .mockResolvedValueOnce(paid200);

      const res = await paymentService.requestWithAgenticPayment("https://external-feed.com/feed/quote");
      expect(res.success).toBe(true);
      expect(res.receipt!.receiptId).toBe("rcpt_server_1");
      expect(res.receipt!.status).toBe("verified");
      expect(res.receipt!.simulated).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it("recordPaymentTransaction never fabricates a sig_ proof signature for verified receipts either", async () => {
      const tx = await paymentService.recordPaymentTransaction(
        {
          receiptId: "rcpt_no_sig",
          protocol: "x402",
          resource: "/api/premium/stock-signals",
          amount: 0.02,
          currency: "USDC",
          network: "base-sepolia",
          payer: "0xBuyer",
          recipient: "0xAgent",
          status: "verified",
          timestamp: new Date().toISOString(),
          proposerDid: "did:agent:openaimp:trading",
        },
        "inbound"
      );
      expect(tx.status).toBe("completed");
      expect(tx.proofSignature).not.toMatch(/^sig_/);
      expect(tx.proofSignature).toContain("no signature recorded");
    });
  });

  describe("NLQ paid services", () => {
    it("paid_scan is refused (G3, #2396): no verified payment channel in NLQ — nothing executed, no simulated receipt recorded", async () => {
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

      const result: any = await executeNLQQueryAsync(orm, "session_trader", plan, mockEnv, "session_trader");
      expect(result.status).toBe("error");
      expect(result.summary).toContain("Paid Options Screener ($0.05 USDC)");
      expect(result.summary).toContain("requires a verified x402 payment");
      expect(result.summary).toContain("nothing was executed and nothing was recorded");
      expect(result.summary).toContain("/api/premium/options-scan");
      expect(result.rows).toHaveLength(0);

      // The G3 retirement: the executor mints no receipt of any status —
      // simulated receipts are no longer recorded at all (pre-existing
      // simulated rows from before this change stay in the ledger,
      // labelled simulated; see the wallet-aggregation pin in
      // tests/mesh_g3_paid_nlq_2396.test.ts).
      const txs = orm.transactions.findMany();
      const recorded = txs.find((t) => t.gateway === "x402" && t.action === "agentic_payment");
      expect(recorded).toBeUndefined();
    });

    it("source pins: no fabricated signature/hash formats remain in the payments layer or NLQ paid paths", () => {
      const serviceSrc = readFileSync(new URL("../src/services/agenticPayments.ts", import.meta.url), "utf-8");
      expect(serviceSrc).not.toContain("0x_sig_");
      expect(serviceSrc).not.toContain("0x_tx_");
      expect(serviceSrc).not.toContain("fac_tok_");
      expect(serviceSrc).not.toMatch(/proofSignature: receipt\.signature \|\| `sig_/);

      const nlqSrc = readFileSync(new URL("../src/agents/nlq.ts", import.meta.url), "utf-8");
      expect(nlqSrc).not.toContain('status: "verified",\n        txHash: `0x_');
      expect(nlqSrc).not.toMatch(/txHash: `0x_\$\{Date\.now\(\)/);
    });
  });

  describe("paid service catalogue sanity", () => {
    it("tiers unchanged (the defect was never the pricing)", () => {
      expect(TRADING_PAID_SERVICES.OPTIONS_SCREENER.priceUSD).toBe(0.05);
      expect(TRADING_PAID_SERVICES.MARKET_RESEARCH.priceUSD).toBe(0.10);
      expect(TRADING_PAID_SERVICES.STOCK_SIGNALS.priceUSD).toBe(0.02);
    });
  });
});
