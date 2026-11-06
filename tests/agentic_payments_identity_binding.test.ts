/**
 * Issue #183: agentic wallet / premium identity binding.
 *
 * Before #183, src/server.ts routed /api/premium/* and
 * /api/payments/agentic/* with
 *   session?.githubLogin || x-user-id || "agentic_consumer"
 * selecting the Durable Object instance. Signed-in users were already
 * correct; the anonymous/asserted path was the exposure:
 *  - an asserted x-user-id selected ANY user's agent instance;
 *  - verified x402 payments were recorded into the shared
 *    "agentic_consumer" instance's ledger, pooled across every payer;
 *  - premium fulfillment ran its E*TRADE work under the asserted login;
 *  - the wallet status summed the whole (shared) instance's rows.
 * And an adjacent defect: setAutoApproveLimit mutated a per-request
 * service object, so the HITL auto-approve limit NEVER persisted —
 * every read re-derived it from env.X402_AUTO_APPROVE_LIMIT.
 *
 * The decided design (posted on #183), pinned here:
 *  - /api/payments/agentic/* is session-required (#154 pattern): no
 *    session → 401 at the worker, agent never invoked; the identity is
 *    the session login only.
 *  - /api/premium/* keeps anonymous paid access (x402 payment is the
 *    access control) but asserts NO identity: without a session the
 *    worker strips caller identity headers and forwards to the
 *    dedicated "premium-gateway" instance; downstream, persisted
 *    payment state is scoped by the VERIFIED payer (x402:<payer>) and
 *    fulfillment runs under that payer scope — an identity holding no
 *    stored E*TRADE tokens — never under an asserted app login.
 *  - Wallet status counts only rows stamped with the caller's own
 *    identity.
 *  - The auto-approve limit persists per identity (mas_memory), so a
 *    POST then a later GET — across service instances, as routes
 *    construct one per request — round-trips.
 *
 * Harnesses: transport tests reuse the tests/fallback_identity_session_gate
 * pattern (real worker fetch + recording ORCHESTRATOR_AGENT stub + fake
 * SessionStore); service/route tests reuse the
 * tests/agentic_payments.test.ts pattern (MockSqlStorage ORM + stubbed
 * on-chain claim verifier).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (transport part): same stand-ins as the #154 gate tests —
// src/server.ts re-exports agent classes whose module graph the node
// loader cannot resolve.
// ---------------------------------------------------------------------------
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

// On-chain verification is covered in x402_verifier.test.ts; here the
// verifier accepts any claim (same stub as agentic_payments.test.ts).
vi.mock("../src/services/x402Verifier", () => ({
  verifyOnChainClaim: vi.fn(async ({ proof }: any) => ({
    ok: true,
    payer: proof.payer,
    txHash: proof.txHash,
  })),
}));

// Capture the identity premium fulfillment constructs ETradeService
// with, and keep the screeners off the network.
const etradeCapture = vi.hoisted(() => ({ logins: [] as Array<{ userLogin: unknown; overrideEnv: unknown }> }));
vi.mock("../src/services/etrade", () => ({
  ETradeService: class FakeETradeService {
    client = {};
    constructor(_orm: unknown, _env: unknown, userLogin: unknown, overrideEnv: unknown) {
      etradeCapture.logins.push({ userLogin, overrideEnv });
    }
  },
}));
// Partial mock: keep the real trading index (other modules in the
// worker graph need its exports) and replace only the two screeners
// premium.ts uses, so fulfillment stays off the network.
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

import worker from "../src/server";
import { PREMIUM_GATEWAY_INSTANCE } from "../src/server";
import type { Env, X402PaymentProof } from "../src/types";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  ETradeAgenticPaymentService,
  payerScopeId,
} from "../src/services/agenticPayments";
import { AGENT_DIDS } from "../src/agents/did";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";

// ===========================================================================
// Part 1 — worker transport (src/server.ts)
// ===========================================================================

const LOGIN = "octocat-183";
const SESSION_ID = "0d9a1830-1c2b-4e3f-8a5b-183000000001";

interface ForwardedCall {
  id: string;
  pathname: string;
  userLogin: string | null;
  userId: string | null;
}

function makeTransportEnv() {
  const forwarded: ForwardedCall[] = [];
  const kv = new Map<string, string>();
  kv.set(`sessions:${SESSION_ID}`, JSON.stringify({ githubLogin: LOGIN, userId: "183", login: LOGIN }));
  const env: any = {
    SESSION_STORE: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = (await req.json()) as { op: string; ns: string; key: string; value?: string };
          const k = `${body.ns}:${body.key}`;
          if (body.op === "get") return Response.json({ value: kv.get(k) ?? null });
          if (body.op === "put") {
            kv.set(k, body.value ?? "");
            return Response.json({ ok: true });
          }
          if (body.op === "delete") {
            kv.delete(k);
            return Response.json({ ok: true });
          }
          return Response.json({ error: "unknown op" }, { status: 400 });
        },
      }),
    },
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            userLogin: req.headers.get("x-user-login"),
            userId: req.headers.get("x-user-id"),
          });
          return Response.json({ ok: true });
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
}

const treq = (
  path: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
) =>
  new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.cookie ? { Cookie: `session_id=${opts.cookie}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

describe("worker /api/payments/agentic/* — session required (#183)", () => {
  it("GET wallet unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeTransportEnv();
    const res = await worker.fetch(treq("/api/payments/agentic/wallet"), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("GET wallet with only an asserted x-user-id → 401 (header no longer asserts identity)", async () => {
    const { env, forwarded } = makeTransportEnv();
    const res = await worker.fetch(
      treq("/api/payments/agentic/wallet", { headers: { "x-user-id": "victim-user" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST auto-approve-limit unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeTransportEnv();
    const res = await worker.fetch(
      treq("/api/payments/agentic/auto-approve-limit", { method: "POST", body: { limitUSD: 9.99 } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("GET wallet with a session → forwarded to the SESSION user's instance only", async () => {
    const { env, forwarded } = makeTransportEnv();
    const res = await worker.fetch(
      treq("/api/payments/agentic/wallet", {
        cookie: SESSION_ID,
        headers: { "x-user-id": "victim-user" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/payments/agentic/wallet");
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });
});

describe("worker /api/premium/* — paid access, no asserted identity (#183)", () => {
  it("anonymous request → forwarded to the premium-gateway instance with identity headers stripped", async () => {
    const { env, forwarded } = makeTransportEnv();
    const res = await worker.fetch(
      treq("/api/premium/options-scan", {
        headers: { "x-user-id": "victim-user", "x-user-login": "victim-user" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(PREMIUM_GATEWAY_INSTANCE);
    expect(forwarded[0].id).toBe("premium-gateway");
    expect(forwarded[0].pathname).toBe("/premium/options-scan");
    // Neither asserted header survives the worker.
    expect(forwarded[0].userLogin).toBeNull();
    expect(forwarded[0].userId).toBeNull();
  });

  it("anonymous request without any identity header → same gateway instance", async () => {
    const { env, forwarded } = makeTransportEnv();
    const res = await worker.fetch(treq("/api/premium/stock-signals"), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe("premium-gateway");
    expect(forwarded[0].userLogin).toBeNull();
  });

  it("session request → forwarded to the SESSION user's instance, spoofed headers overridden", async () => {
    const { env, forwarded } = makeTransportEnv();
    const res = await worker.fetch(
      treq("/api/premium/options-scan", {
        cookie: SESSION_ID,
        headers: { "x-user-id": "victim-user", "x-user-login": "victim-user" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });

  it("OPTIONS preflight for both families still answers without a session and never forwards", async () => {
    const { env, forwarded } = makeTransportEnv();
    for (const path of ["/api/premium/options-scan", "/api/payments/agentic/wallet"]) {
      const res = await worker.fetch(treq(path, { method: "OPTIONS" }), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    expect(forwarded).toHaveLength(0);
  });
});

// ===========================================================================
// Part 2 — payment service: wallet isolation + auto-approve persistence
// ===========================================================================

function makeOrm() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("identity_test");
  return orm;
}

const mockEnv = {
  AI: {} as any,
  AI_SEARCH_ENDPOINT: "https://mock.search",
  ORCHESTRATOR_AGENT: {} as any,
  AGENT_SESSIONS: {} as any,
  X402_NETWORK: "base-sepolia",
  X402_RECIPIENT_ADDRESS: "0x71C8363837918a211797E3c76A8B3C4258759550",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  X402_AUTO_APPROVE_LIMIT: "0.05",
  X402_AGENT_WALLET_KEY: "test-agent-wallet-183",
} as unknown as Env;

const receipt = (overrides: Record<string, unknown> = {}) => ({
  receiptId: `rcpt_183_${Math.random().toString(36).slice(2, 8)}`,
  protocol: "x402",
  resource: "/api/premium/options-scan",
  amount: 0.05,
  currency: "USDC",
  network: "base-sepolia",
  payer: "0xBuyer183",
  recipient: "0xAgent183",
  status: "verified",
  txHash: "0x_hash_183",
  timestamp: new Date().toISOString(),
  proposerDid: AGENT_DIDS.TRADING,
  ...overrides,
});

describe("wallet status is per-identity (#183)", () => {
  it("one identity's rows never appear in another identity's status, even on a shared store", async () => {
    const orm = makeOrm();
    const svcA = new ETradeAgenticPaymentService(orm, mockEnv, "user-a");
    const svcB = new ETradeAgenticPaymentService(orm, mockEnv, "user-b");

    await svcA.recordPaymentTransaction(receipt({ receiptId: "rcpt_183_a_in", amount: 0.05 }) as any, "inbound");
    await svcA.recordPaymentTransaction(
      receipt({ receiptId: "rcpt_183_a_out", amount: 0.03, payer: "0xAgent183", recipient: "0xFeed183" }) as any,
      "outbound",
    );

    const statusB = await svcB.getWalletStatus();
    expect(statusB.transactionCount).toBe(0);
    expect(statusB.totalEarnedUSD).toBe(0);
    expect(statusB.totalSpentUSD).toBe(0);
    expect(statusB.balanceUSD).toBe(50);

    const statusA = await svcA.getWalletStatus();
    expect(statusA.transactionCount).toBe(2);
    expect(statusA.totalEarnedUSD).toBe(0.05);
    expect(statusA.totalSpentUSD).toBe(0.03);
    expect(statusA.balanceUSD).toBe(50 + 0.05 - 0.03);

    // The rows themselves carry the recording identity's stamp.
    const rows = orm.transactions.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.sessionId).toBe("user-a");
  });
});

describe("auto-approve limit persists per identity (#183)", () => {
  it("a limit set on one service instance is read back by a fresh instance (the per-request route shape)", () => {
    const orm = makeOrm();
    const first = new ETradeAgenticPaymentService(orm, mockEnv, "user-a");
    expect(first.getAutoApproveLimit()).toBe(0.05); // env default before any set
    first.setAutoApproveLimit(0.25);

    // Routes construct the service per request: a NEW instance must see it.
    const second = new ETradeAgenticPaymentService(orm, mockEnv, "user-a");
    expect(second.getAutoApproveLimit()).toBe(0.25);
    expect(second.getWalletStatusSync().autoApproveLimitUSD).toBe(0.25);
  });

  it("limits are per-identity: B's default and B's own set never leak into A's", () => {
    const orm = makeOrm();
    new ETradeAgenticPaymentService(orm, mockEnv, "user-a").setAutoApproveLimit(0.25);

    const svcB = new ETradeAgenticPaymentService(orm, mockEnv, "user-b");
    expect(svcB.getAutoApproveLimit()).toBe(0.05);
    svcB.setAutoApproveLimit(0.5);

    expect(new ETradeAgenticPaymentService(orm, mockEnv, "user-a").getAutoApproveLimit()).toBe(0.25);
    expect(new ETradeAgenticPaymentService(orm, mockEnv, "user-b").getAutoApproveLimit()).toBe(0.5);
  });

  it("route-level round-trip: POST then GET persists, per identity, with the audit event intact", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const ctx: AgenticPaymentsRouteContext = {
      env: mockEnv,
      getOrm: () => orm,
      audit,
    } as AgenticPaymentsRouteContext;
    const url = new URL("https://agent.internal/payments/agentic/auto-approve-limit");
    const path = "/payments/agentic/auto-approve-limit";

    const postRes = await handleAgenticPaymentsRoutes(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limitUSD: 0.33 }),
      }),
      url,
      path,
      "user-a",
      ctx,
    );
    expect(postRes?.status).toBe(200);
    expect(await postRes!.json()).toEqual({ success: true, autoApproveLimitUSD: 0.33 });
    expect(audit).toHaveBeenCalledWith("agentic_payment.limit_updated", "payments", { limitUSD: 0.33 });

    // A later request (fresh service inside the handler) reads it back.
    const getRes = await handleAgenticPaymentsRoutes(new Request(url, { method: "GET" }), url, path, "user-a", ctx);
    expect(((await getRes!.json()) as any).autoApproveLimitUSD).toBe(0.33);

    // Another identity still sees the env default.
    const getB = await handleAgenticPaymentsRoutes(new Request(url, { method: "GET" }), url, path, "user-b", ctx);
    expect(((await getB!.json()) as any).autoApproveLimitUSD).toBe(0.05);
  });
});

// ===========================================================================
// Part 3 — premium routes: payer-bound persistence + fulfillment identity
// ===========================================================================

describe("premium routes bind persisted state to the verified payer (#183)", () => {
  let orm: DatabaseORM;
  let ctx: PremiumRouteContext;

  beforeEach(() => {
    orm = makeOrm();
    etradeCapture.logins.length = 0;
    // Issue #2408: the route meters served calls through ctx.sql —
    // the production host always supplies it (makePremiumRouteContext),
    // so this route-level served expectation supplies it too.
    ctx = { env: mockEnv, sql: new MockSqlStorage(), getOrm: () => orm } as unknown as PremiumRouteContext;
  });

  const premiumUrl = new URL("https://agent.internal/premium/options-scan");

  /** First (unpaid) call → parse the issued challenge nonce. */
  async function issueNonce(headers: Record<string, string> = {}): Promise<string> {
    const res = await handlePremiumRoutes(
      new Request(premiumUrl, { method: "GET", headers }),
      premiumUrl,
      "/premium/options-scan",
      "gateway-instance-id",
      ctx,
    );
    expect(res?.status).toBe(402);
    const body = (await res!.json()) as any;
    return body.protocols.x402.challenge.nonce as string;
  }

  async function paidScan(opts: {
    payer: string;
    txHash: string;
    headers?: Record<string, string>;
    sessionId?: string;
    url?: URL;
  }): Promise<Response> {
    const nonce = await issueNonce();
    const proof: X402PaymentProof = {
      payer: opts.payer,
      signature: "0x_sig_183_valid",
      txHash: opts.txHash,
      nonce,
      timestamp: Date.now(),
    } as X402PaymentProof;
    const scanUrl = opts.url || premiumUrl;
    const res = await handlePremiumRoutes(
      new Request(scanUrl, {
        method: "GET",
        headers: {
          "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64"),
          ...(opts.headers || {}),
        },
      }),
      scanUrl,
      "/premium/options-scan",
      opts.sessionId || "gateway-instance-id",
      ctx,
    );
    return res!;
  }

  it("anonymous paid scan: transaction + events are payer-scoped; an asserted x-user-id changes nothing", async () => {
    const payer = "0xPayer183";
    const res1 = await paidScan({ payer, txHash: "0x_tx_183_c1", headers: { "x-user-id": "victim-login" } });
    expect(res1.status).toBe(200);
    const res2 = await paidScan({ payer, txHash: "0x_tx_183_c2" }); // no asserted header
    expect(res2.status).toBe(200);

    const txs = orm.transactions.findMany();
    expect(txs).toHaveLength(2);
    for (const tx of txs) {
      expect(tx.sessionId).toBe(payerScopeId(payer));
      expect(tx.sessionId).toBe("x402:0xPayer183");
      expect(tx.customer).toBe(payer);
      expect(tx.action).toBe("agentic_payment");
      expect(tx.status).toBe("completed");
    }

    const collected = orm.events.findMany({ where: { type: "AGENTIC_PAYMENT_COLLECTED" } });
    expect(collected).toHaveLength(2);
    for (const evt of collected) expect((evt as any).sessionId).toBe("x402:0xPayer183");

    // Challenge events are keyed by their challenge nonce in gateway
    // mode — never by an asserted login, the gateway instance id, or a
    // shared consumer identity.
    const challenges = orm.events.findMany({ where: { type: "AGENTIC_PAYMENT_CHALLENGE" } });
    expect(challenges.length).toBeGreaterThanOrEqual(2);
    for (const evt of challenges) {
      expect((evt as any).sessionId).toMatch(/^x402:challenge:/);
    }

    // Nothing anywhere is stamped with the asserted login or the
    // gateway instance identity.
    for (const row of [...txs, ...collected, ...challenges]) {
      expect((row as any).sessionId).not.toBe("victim-login");
      expect((row as any).sessionId).not.toBe("gateway-instance-id");
      expect((row as any).sessionId).not.toBe("agentic_consumer");
    }
  });

  it("anonymous fulfillment constructs E*TRADE under the payer scope, never an asserted login", async () => {
    // Since #982 the paid scan executes through UnifiedOptionsService,
    // whose result cache (#986: keyed by user, environment, filter and
    // the other result-changing fields) correctly serves a TRULY
    // IDENTICAL repeat scan by the same payer from cache — no E*TRADE
    // construction occurs, legitimately. The preceding test's scans are
    // this payer's identical default scan, so this witness's scan is
    // made distinct (a limit the default scan doesn't carry) to observe
    // the construction its assertions are about. Assertions unchanged.
    const res = await paidScan({
      payer: "0xPayer183",
      txHash: "0x_tx_183_d1",
      headers: { "x-user-id": "victim-login" },
      url: new URL("https://agent.internal/premium/options-scan?limit=7"),
    });
    expect(res.status).toBe(200);
    expect(etradeCapture.logins).toHaveLength(1);
    expect(etradeCapture.logins[0].userLogin).toBe("x402:0xPayer183");
    expect(etradeCapture.logins[0].userLogin).not.toBe("victim-login");
  });

  it("session paid scan: fulfillment identity is the session login and rows keep the instance stamp (unchanged behaviour)", async () => {
    const res = await paidScan({
      payer: "0xPayer183",
      txHash: "0x_tx_183_s1",
      headers: { "x-user-login": "octocat-183" },
      sessionId: "user-instance-id",
    });
    expect(res.status).toBe(200);
    expect(etradeCapture.logins).toHaveLength(1);
    expect(etradeCapture.logins[0].userLogin).toBe("octocat-183");

    const txs = orm.transactions.findMany();
    expect(txs).toHaveLength(1);
    expect(txs[0].sessionId).toBe("user-instance-id");
  });

  it("payerBound service: simulated proofs are still rejected (the #122 gate is unchanged)", async () => {
    const svc = new ETradeAgenticPaymentService(orm, mockEnv, "gateway-instance-id", undefined, { payerBound: true });
    const challenge = svc.createX402Challenge("/api/premium/options-scan", 0.05);
    const proof = {
      payer: "0xSimulated183",
      signature: "SIMULATED_UNSIGNED_PROOF_NO_SIGNATURE",
      txHash: "0x_tx_183_sim",
      nonce: challenge.nonce,
      timestamp: Date.now(),
      simulated: true,
    };
    const verification = await svc.verifyPayment(
      { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64") },
      challenge,
    );
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("Simulated payment proofs are not accepted");
    expect(orm.transactions.findMany()).toHaveLength(0);
  });
});

describe("agent wallet fails closed without a configured identity (#691)", () => {
  // Gitleaks gate: the hardcoded synthetic wallet fallback is gone. Without
  // X402_AGENT_WALLET_KEY the service has no wallet identity and the action
  // paths refuse instead of minting proofs under a default address.
  const envWithoutWallet = { ...mockEnv } as unknown as Env;
  delete (envWithoutWallet as Record<string, unknown>).X402_AGENT_WALLET_KEY;

  it("signPaymentProof without an explicit payer throws when X402_AGENT_WALLET_KEY is unset", async () => {
    const svc = new ETradeAgenticPaymentService(makeOrm(), envWithoutWallet, "user-a");
    const challenge = svc.createX402Challenge("/api/premium/options-scan", 0.05);
    await expect(svc.signPaymentProof(challenge)).rejects.toThrow(/X402_AGENT_WALLET_KEY/);
  });

  it("signPaymentProof with an explicit payer address does not need the env wallet", async () => {
    const svc = new ETradeAgenticPaymentService(makeOrm(), envWithoutWallet, "user-a");
    const challenge = svc.createX402Challenge("/api/premium/options-scan", 0.05);
    const { x402Proof } = await svc.signPaymentProof(challenge, "0xExplicitPayer");
    expect(x402Proof?.payer).toBe("0xExplicitPayer");
  });

  it("wallet status reports an empty address — never a placeholder — when unconfigured", async () => {
    const svc = new ETradeAgenticPaymentService(makeOrm(), envWithoutWallet, "user-a");
    const status = await svc.getWalletStatus();
    expect(status.walletAddress).toBe("");
  });
});
