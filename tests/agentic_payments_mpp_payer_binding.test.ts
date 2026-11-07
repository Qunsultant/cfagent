/**
 * Issue #700 (point 3): MPP receipts bind to the VERIFIED payer.
 *
 * Before this change, handleMppRequest built its receipt reading nothing
 * from the mppx verification: every MPP receipt carried
 * payer: "mpp-credential" / authorizerDid: "did:mpp:credential", so the
 * #183 payer-bound machinery scoped every anonymous MPP payment into
 * ONE pooled identity (x402:mpp-credential) — persisted rows, audit
 * events, and premium fulfillment alike.
 *
 * The verified credential DOES carry a payer: its `source` is a did:pkh
 * DID, cryptographically bound by the tempo verifier (proof credentials
 * must include a source and their signature is checked against it;
 * transaction credentials have their source cross-checked against the
 * on-chain sender). The typed mppx.charge result does not expose the
 * credential; the supported retrieval is Credential.fromRequest(req)
 * from the mppx root, called after charge has succeeded — a forged
 * source cannot reach that code path.
 *
 * Pinned here:
 *  (a) a source-bearing verified MPP payment stamps its receipt,
 *      ledger rows and audit events under x402:<bare address> — the
 *      same vocabulary as x402 rows — never the pooled scope;
 *  (b) premium fulfillment for an MPP-paid anonymous request runs
 *      E*TRADE under that payer scope;
 *  (c) the pooled fallback survives ONLY where no payer is exposed:
 *      a source-less credential, an unparseable source, or a credential
 *      that fails to deserialize (extraction must never fail an
 *      already-verified payment);
 *  (d) the fail-closed paths are unchanged: header-only MPP credentials
 *      are refused by verifyPayment, an unverified credential (charge
 *      still 402) fulfills and records nothing, and unconfigured MPP
 *      stays 402.
 *
 * Harness: mppx is replaced with full-fake factories (the house
 * vi.mock pattern) because no deterministic local fixture can produce
 * a real successful tempo verification — the existing
 * agentic_payments.test.ts "3b" block covers the real SDK's challenge
 * issuance and forgery rejection. These mocks are file-scoped; the
 * module-level lazy-import caches in agenticPayments.ts resolve them
 * only inside this file's module graph.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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


// ---------------------------------------------------------------------------
// mppx fakes (hoisted, controllable per test)
// ---------------------------------------------------------------------------
const mppFake = vi.hoisted(() => ({
  /** "verified": charge succeeds (non-402). "challenge": charge still demands payment. */
  mode: "verified" as "verified" | "challenge",
  /** The verified credential's source DID, or undefined for a source-less credential. */
  source: undefined as string | undefined,
  /** When set, Credential.fromRequest throws (deserialization failure). */
  fromRequestError: null as Error | null,
  chargeCalls: 0,
}));

vi.mock("mppx/server", () => ({
  Mppx: {
    create: (_config: unknown) => ({
      charge: (_options: unknown) => async (_req: Request) => {
        mppFake.chargeCalls++;
        if (mppFake.mode === "challenge") {
          return {
            status: 402,
            challenge: new Response("Payment required", {
              status: 402,
              headers: { "WWW-Authenticate": 'Payment id="fake-challenge", realm="test"' },
            }),
          };
        }
        return {
          status: 200,
          withReceipt: (res: Response) => res,
        };
      },
    }),
  },
  tempo: { charge: (_config: unknown) => ({}) },
}));

vi.mock("mppx", () => ({
  Credential: {
    fromRequest: (_req: Request) => {
      if (mppFake.fromRequestError) throw mppFake.fromRequestError;
      return {
        challenge: {},
        payload: {},
        ...(mppFake.source ? { source: mppFake.source } : {}),
      };
    },
  },
}));

// On-chain x402 verification is covered in x402_verifier.test.ts; here
// the verifier accepts any claim (same stub as the sibling suites).
vi.mock("../src/services/x402Verifier", () => ({
  verifyOnChainClaim: vi.fn(async ({ proof }: any) => ({
    ok: true,
    payer: proof.payer,
    txHash: proof.txHash,
  })),
}));

// Capture the identity premium fulfillment constructs ETradeService
// with, and keep the screeners off the network (the #183 suite's fakes).
const etradeCapture = vi.hoisted(() => ({ logins: [] as Array<{ userLogin: unknown; overrideEnv: unknown }> }));
vi.mock("../src/services/etrade", () => ({
  ETradeService: class FakeETradeService {
    client = {};
    constructor(_orm: unknown, _env: unknown, userLogin: unknown, overrideEnv: unknown) {
      etradeCapture.logins.push({ userLogin, overrideEnv });
    }
  },
}));
vi.mock("../src/trading", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DynamicOptionsScreener: class FakeScreener {
      constructor(_client: unknown) {}
      async screenOptions() {
        return { status: "ok", results: [] };
      }
    },
    YFinanceMarketScreener: class FakeYFinance {
      async screenMarkets() {
        return { stocks: [] };
      }
    },
  };
});
vi.mock("../src/services/marketDataResearch", () => ({
  MarketDataResearchService: class FakeMarketData {
    constructor(_env: unknown) {}
    async generateResearchReport(symbol: string) {
      return { symbol, summary: "stub report" };
    }
  },
}));

import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
  payerScopeId,
} from "../src/services/agenticPayments";
import { createInMemoryCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MPP_PAYER = "0x700C0FFEE700C0FFEE700C0FFEE700C0FFEE7001";
const MPP_PAYER_2 = "0x700Beef700Beef700Beef700Beef700Beef70022".slice(0, 42);
const SOURCE_DID = `did:pkh:eip155:8453:${MPP_PAYER}`;
const SOURCE_DID_2 = `did:pkh:eip155:8453:${MPP_PAYER_2}`;
const POOLED_PAYER = "mpp-credential";
const POOLED_DID = "did:mpp:credential";

const mockEnv = {
  AI: {} as any,
  AI_SEARCH_ENDPOINT: "https://mock.search",
  ORCHESTRATOR_AGENT: {} as any,
  AGENT_SESSIONS: {} as any,
  X402_NETWORK: "base-sepolia",
  X402_RECIPIENT_ADDRESS: "0x71C8363837918a211797E3c76A8B3C4258759550",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  X402_AUTO_APPROVE_LIMIT: "0.05",
  X402_AGENT_WALLET_KEY: "test-agent-wallet-700",
  MPP_SECRET_KEY: "test-mpp-secret-700",
} as unknown as Env;

function makeOrm() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("mpp_payer_test");
  return orm;
}

const RESOURCE = TRADING_PAID_SERVICES.OPTIONS_SCREENER.resource;

/** A request carrying an MPP Payment credential (content is opaque to the fakes). */
function mppRequest(extraHeaders: Record<string, string> = {}): Request {
  return new Request(`https://agent.test${RESOURCE}`, {
    method: "GET",
    headers: { Authorization: 'Payment id="cred-700"', ...extraHeaders },
  });
}

/** Run one gated MPP payment through a payer-bound service, capturing the receipt. */
async function payWithMpp(orm: DatabaseORM, env: Env = mockEnv) {
  const service = new ETradeAgenticPaymentService(orm, env, "gateway-instance-id", undefined, {
    payerBound: true,
  });
  const seen: { receipt?: any } = {};
  const fulfill = vi.fn(async (receipt: any) => {
    seen.receipt = receipt;
    return { data: "paid" };
  });
  // Issue #2408: the gate meters served calls — the MPP served
  // expectations wire the in-memory usage port.
  const meter = createInMemoryCanonicalReportStorePorts().usage;
  const res = await service.handleGatedEndpoint(
    mppRequest(),
    RESOURCE,
    TRADING_PAID_SERVICES.OPTIONS_SCREENER.priceUSD,
    TRADING_PAID_SERVICES.OPTIONS_SCREENER.description,
    fulfill,
    { meter, category: TRADING_PAID_SERVICES.OPTIONS_SCREENER.id },
  );
  return { res, fulfill, seen, meter };
}

beforeEach(() => {
  mppFake.mode = "verified";
  mppFake.source = undefined;
  mppFake.fromRequestError = null;
  mppFake.chargeCalls = 0;
  etradeCapture.logins.length = 0;
});

// ---------------------------------------------------------------------------
// (a) Source-bearing payments bind to the verified payer
// ---------------------------------------------------------------------------

describe("MPP receipts bind to the verified payer (#700 point 3)", () => {
  it("stamps the receipt, ledger rows and audit events under x402:<address>", async () => {
    mppFake.source = SOURCE_DID;
    const orm = makeOrm();
    const { res, fulfill, seen } = await payWithMpp(orm);

    expect(res.status).toBe(200);
    expect(fulfill).toHaveBeenCalledTimes(1);

    // The receipt itself carries the verified payer, in x402 vocabulary.
    expect(seen.receipt.protocol).toBe("mpp");
    expect(seen.receipt.payer).toBe(MPP_PAYER);
    expect(seen.receipt.authorizerDid).toBe(SOURCE_DID);
    expect(seen.receipt.status).toBe("verified");

    // Ledger row: payer-scoped, never pooled.
    const txs = orm.transactions.findMany();
    expect(txs).toHaveLength(1);
    expect(txs[0].sessionId).toBe(payerScopeId(MPP_PAYER));
    expect(txs[0].sessionId).toBe(`x402:${MPP_PAYER}`);
    expect(txs[0].sessionId).not.toBe(`x402:${POOLED_PAYER}`);
    expect(txs[0].customer).toBe(MPP_PAYER);
    expect(txs[0].gateway).toBe("mpp");
    expect(txs[0].authorizerDid).toBe(SOURCE_DID);
    expect(txs[0].status).toBe("completed");

    // Audit event: same scope, payer in the payload.
    const events = orm.events.findMany({ where: { type: "AGENTIC_PAYMENT_COLLECTED" } });
    expect(events).toHaveLength(1);
    expect((events[0] as any).sessionId).toBe(`x402:${MPP_PAYER}`);
    // #2178 S1: stored payload is JSON text — parse the stored form.
    expect((JSON.parse((events[0] as any).payload as string) as any).payer).toBe(MPP_PAYER);
  });

  it("two MPP payers sharing one store land in distinct scopes — nothing pools", async () => {
    const orm = makeOrm();

    mppFake.source = SOURCE_DID;
    const first = await payWithMpp(orm);
    expect(first.res.status).toBe(200);

    mppFake.source = SOURCE_DID_2;
    const second = await payWithMpp(orm);
    expect(second.res.status).toBe(200);

    const txs = orm.transactions.findMany();
    expect(txs).toHaveLength(2);
    const scopes = txs.map((tx) => tx.sessionId).sort();
    expect(scopes).toEqual([`x402:${MPP_PAYER}`, `x402:${MPP_PAYER_2}`].sort());
    for (const tx of txs) expect(tx.sessionId).not.toBe(`x402:${POOLED_PAYER}`);
  });
});

// ---------------------------------------------------------------------------
// (b) Premium fulfillment identity derives from the MPP payer scope
// ---------------------------------------------------------------------------

describe("premium fulfillment for MPP-paid requests (#700 point 3)", () => {
  it("runs E*TRADE under x402:<mpp payer> for anonymous gateway traffic", async () => {
    mppFake.source = SOURCE_DID;
    const orm = makeOrm();
    // Issue #2408: the route meters served calls through ctx.sql —
    // the production host always supplies it (makePremiumRouteContext),
    // so this route-level served expectation supplies it too.
    const ctx = { env: mockEnv, sql: new MockSqlStorage(), getOrm: () => orm } as unknown as PremiumRouteContext;
    const url = new URL("https://agent.internal/premium/options-scan");

    const res = await handlePremiumRoutes(mppRequest(), url, "/premium/options-scan", "gateway-instance-id", ctx);

    expect(res?.status).toBe(200);
    expect(etradeCapture.logins).toHaveLength(1);
    expect(etradeCapture.logins[0].userLogin).toBe(`x402:${MPP_PAYER}`);
    expect(etradeCapture.logins[0].userLogin).not.toBe(`x402:${POOLED_PAYER}`);

    const txs = orm.transactions.findMany();
    expect(txs).toHaveLength(1);
    expect(txs[0].sessionId).toBe(`x402:${MPP_PAYER}`);
    expect(txs[0].gateway).toBe("mpp");
  });
});

// ---------------------------------------------------------------------------
// (c) The pooled fallback — only where no payer is exposed
// ---------------------------------------------------------------------------

describe("MPP pooled fallback is confined to payer-less credentials (#700 point 3)", () => {
  it("source-less verified credential keeps the pooled identity", async () => {
    mppFake.source = undefined;
    const orm = makeOrm();
    const { res, seen } = await payWithMpp(orm);

    expect(res.status).toBe(200);
    expect(seen.receipt.payer).toBe(POOLED_PAYER);
    expect(seen.receipt.authorizerDid).toBe(POOLED_DID);

    const txs = orm.transactions.findMany();
    expect(txs).toHaveLength(1);
    expect(txs[0].sessionId).toBe(`x402:${POOLED_PAYER}`);
    expect(txs[0].customer).toBe(POOLED_PAYER);
  });

  it("a non-pkh source DID keeps the pooled identity", async () => {
    mppFake.source = "did:web:payments.example";
    const orm = makeOrm();
    const { res, seen } = await payWithMpp(orm);

    expect(res.status).toBe(200);
    expect(seen.receipt.payer).toBe(POOLED_PAYER);
    expect(seen.receipt.authorizerDid).toBe(POOLED_DID);
  });

  it("a pkh source whose account is not an address keeps the pooled identity", async () => {
    mppFake.source = "did:pkh:eip155:8453:not-an-address";
    const orm = makeOrm();
    const { res, seen } = await payWithMpp(orm);

    expect(res.status).toBe(200);
    expect(seen.receipt.payer).toBe(POOLED_PAYER);
    expect(seen.receipt.authorizerDid).toBe(POOLED_DID);
  });

  it("a credential that fails to deserialize never fails the verified payment", async () => {
    mppFake.fromRequestError = new Error("Invalid credential encoding");
    const orm = makeOrm();
    const { res, fulfill, seen } = await payWithMpp(orm);

    expect(res.status).toBe(200);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(seen.receipt.payer).toBe(POOLED_PAYER);
    expect(seen.receipt.authorizerDid).toBe(POOLED_DID);
  });
});

// ---------------------------------------------------------------------------
// (d) Fail-closed paths are unchanged
// ---------------------------------------------------------------------------

describe("MPP fail-closed paths unchanged (#700 point 3)", () => {
  it("verifyPayment still refuses MPP credentials presented as headers alone", async () => {
    const orm = makeOrm();
    const service = new ETradeAgenticPaymentService(orm, mockEnv, "gateway-instance-id", undefined, {
      payerBound: true,
    });
    const challenge = service.createX402Challenge(RESOURCE, 0.05);
    const verification = await service.verifyPayment(
      { Authorization: 'Payment id="cred-700"' },
      challenge,
    );

    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("must be verified through the mppx gateway");
    expect(orm.transactions.findMany()).toHaveLength(0);
  });

  it("an unverified credential (charge still 402) fulfills nothing and records nothing", async () => {
    mppFake.mode = "challenge";
    mppFake.source = SOURCE_DID; // even a source-shaped header changes nothing pre-verification
    const orm = makeOrm();
    const { res, fulfill } = await payWithMpp(orm);

    expect(res.status).toBe(402);
    expect(fulfill).not.toHaveBeenCalled();
    expect(orm.transactions.findMany()).toHaveLength(0);
    expect(orm.events.findMany({ where: { type: "AGENTIC_PAYMENT_COLLECTED" } })).toHaveLength(0);
  });

  it("MPP unconfigured (no MPP_SECRET_KEY) stays 402 and fulfills nothing", async () => {
    const envNoMpp = { ...(mockEnv as any) } as any;
    delete envNoMpp.MPP_SECRET_KEY;
    const orm = makeOrm();
    const { res, fulfill } = await payWithMpp(orm, envNoMpp as Env);

    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toContain("MPP payments are not configured");
    expect(fulfill).not.toHaveBeenCalled();
    expect(mppFake.chargeCalls).toBe(0);
    expect(orm.transactions.findMany()).toHaveLength(0);
  });
});
