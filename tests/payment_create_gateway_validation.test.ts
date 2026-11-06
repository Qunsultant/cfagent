/**
 * Issue #156 (filed from #148): the orchestrator's `/payments/create` route
 * stored the caller-supplied `gateway` string into `mas_transactions`
 * unvalidated. Since #148 a garbage-gateway row fails loudly at confirm
 * time (the strategy factory throws) instead of silently settling via
 * sandbox — but validation belongs where the input enters: creation.
 *
 * The fix:
 * - the create route validates the gateway with #148's shared allow-list
 *   (`isSupportedGateway` / `SUPPORTED_GATEWAYS` / `normalizeGateway`)
 *   BEFORE any checkout attempt and BEFORE any row is written: an
 *   unsupported gateway gets a 400 naming the supported list, in the
 *   route's existing `{success, error, code}` shape;
 * - `PaymentGatewayService.createCheckout` validates at the service seam
 *   too, so every caller (create/confirm routes, facade, MCP commands)
 *   gets the same explicit rejection instead of depending on the factory
 *   throw — and no DID attestation is minted for an unresolvable gateway.
 *
 * Sibling creation paths were surveyed: the MCP `draft_payment` command
 * and the NLQ `draftPayment` tool constrain `gateway` with a zod enum at
 * the tool boundary (wired as the AI SDK input schema via mcpAdapter),
 * and the confirm paths only read the gateway from the stored row. The
 * create route was the one path persisting a caller-supplied gateway
 * unvalidated.
 *
 * Harness mirrors tests/payment_webhook_default_deny.test.ts (#148):
 * agent-SDK module mocks, MockSqlStorage, and fetch stubbed at the real
 * gateway endpoints so supported gateways create exactly as before.
 *
 * UPDATE (#1690, owner HITL-draft decision 2026-10-26): POST
 * /payments/create no longer checks out at create — it drafts via
 * draft_payment. The expectations below changed WITH that decision,
 * not silently: a supported gateway now yields an awaiting_confirmation
 * row with "" gateway_ref/checkout_url and a payment.awaiting_
 * confirmation audit (never payment.created, never pending_checkout),
 * and the stubbed gateway fetch is never called at create. The
 * validation pins themselves (#156: 400 before any row write, supported
 * list named, normalization) are unchanged; only the row-write owner
 * moved (route INSERT -> command via ORM), so the source pin now
 * anchors validation before the draft_payment call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

// src/agents/orchestrator.ts pulls in `cloudflare:`-adjacent SDK entry
// points the node test loader cannot resolve. Mock them with plain
// stand-ins (same pattern as tests/payment_webhook_default_deny.test.ts).
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
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { PaymentGatewayService, type SupportedGateway } from "../src/services/payments";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

// Source pins read via cwd-relative paths (vitest runs at the repo root).
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock",
    PAYPAL_CLIENT_ID: "paypal-client-id-156",
    PAYPAL_CLIENT_SECRET: "paypal-secret-156",
    LEMONSQUEEZY_API_KEY: "ls-api-key-156",
    LEMONSQUEEZY_STORE_ID: "store-156",
    ...overrides,
  }) as Env;

/** Fetch stubbed at the gateways' real endpoints, as in the #148 tests. */
function stubGatewayFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/checkout/sessions")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "cs_test_156", url: "https://checkout.stripe.com/c/pay/cs_test_156" }),
        } as any;
      }
      if (url.includes("/v1/oauth2/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok-156" }) } as any;
      }
      if (url.includes("/v2/checkout/orders")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "PP-ORDER-156",
            links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-156" }],
          }),
        } as any;
      }
      if (url.includes("api.lemonsqueezy.com/v1/checkouts")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { id: "ls_156", attributes: { url: "https://checkout.lemonsqueezy.com/ls_156" } },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    })
  );
}

describe("POST /payments/create — gateway validated at creation (#156)", () => {
  beforeEach(stubGatewayFetch);
  afterEach(() => vi.unstubAllGlobals());

  const makeAgent = (env: Env) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "payments-creator-156" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as any, env);
    return { agent, sql };
  };

  const postCreate = (agent: OrchestratorAgent, body: Record<string, unknown>) =>
    agent.onRequest(
      new Request("https://agent.internal/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  const allTx = (sql: MockSqlStorage) =>
    Array.from(sql.exec("SELECT * FROM mas_transactions")) as any[];

  // #1690: the create audit is now the draft command's
  // payment.awaiting_confirmation (payment.created no longer exists).
  const createdAudits = (sql: MockSqlStorage) =>
    Array.from(sql.exec("SELECT * FROM mas_events WHERE type = ?", "payment.awaiting_confirmation")) as any[];

  // The agent lazily seeds two ledger rows on its first request
  // (pay_init_stripe / pay_init_paypal — #175's territory), so assertions
  // diff against the baseline captured after construction and exclude the
  // seed ids: "no row written" means no NEW row, and "created" means
  // exactly one new row.
  const SEED_IDS = new Set(["pay_init_stripe", "pay_init_paypal"]);
  const baseline = (sql: MockSqlStorage) => ({
    txIds: new Set(allTx(sql).map((r) => r.id as string)),
    audits: createdAudits(sql).length,
  });
  const newTx = (sql: MockSqlStorage, base: { txIds: Set<string> }) =>
    allTx(sql).filter((r) => !base.txIds.has(r.id) && !SEED_IDS.has(r.id));

  it("unknown gateway: 400 naming the supported list, and NO transaction row is written", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "boguspay" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.code).toBe("UNSUPPORTED_GATEWAY");
    expect(json.error).toContain('Unsupported payment gateway: "boguspay"');
    expect(json.error).toContain("stripe, paypal, lemonsqueezy, sandbox");
    expect(newTx(sql, base)).toHaveLength(0);
    expect(createdAudits(sql)).toHaveLength(base.audits);
  });

  it("uppercase garbage is still garbage after normalization: 400, no row", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "BOGUSPAY" });
    expect(res.status).toBe(400);
    expect(newTx(sql, base)).toHaveLength(0);
  });

  it("a non-string gateway is rejected, not crashed on: 400, no row", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: 123 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.code).toBe("UNSUPPORTED_GATEWAY");
    expect(newTx(sql, base)).toHaveLength(0);
  });

  it("explicit sandbox drafts as before, stored as sandbox (awaiting_confirmation, no checkout at create)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "sandbox" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.gateway).toBe("sandbox");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("sandbox");
    expect(rows[0].status).toBe("awaiting_confirmation");
    expect(rows[0].checkout_url).toBe("");
    expect(rows[0].gateway_ref).toBe("");
    expect(createdAudits(sql)).toHaveLength(base.audits + 1);
  });

  it("stripe drafts without checkout (#1690: stubbed endpoint never fires at create)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "stripe" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.gateway).toBe("stripe");
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.gatewayRef).toBe("");
    expect(json.transaction.checkoutUrl).toBe("");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("stripe");
    expect(rows[0].status).toBe("awaiting_confirmation");
    expect(rows[0].gateway_ref).toBe("");
    expect(rows[0].checkout_url).toBe("");
  });

  it("paypal drafts without checkout (#1690: stubbed endpoints never fire at create)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "paypal" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.gateway).toBe("paypal");
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.gatewayRef).toBe("");
    expect(json.transaction.checkoutUrl).toBe("");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("paypal");
    expect(rows[0].status).toBe("awaiting_confirmation");
    expect(rows[0].gateway_ref).toBe("");
    expect(rows[0].checkout_url).toBe("");
  });

  it("lemonsqueezy drafts without checkout (#1690: stubbed endpoint never fires at create)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "lemonsqueezy" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.gateway).toBe("lemonsqueezy");
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.gatewayRef).toBe("");
    expect(json.transaction.checkoutUrl).toBe("");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("lemonsqueezy");
    expect(rows[0].status).toBe("awaiting_confirmation");
    expect(rows[0].gateway_ref).toBe("");
    expect(rows[0].checkout_url).toBe("");
  });

  it("case/whitespace normalization: ' Stripe ' creates a 'stripe' row, matching the webhook verifier", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: " Stripe " });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.gateway).toBe("stripe");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("stripe");
  });

  it("omitted gateway still defaults to stripe, as before", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.gateway).toBe("stripe");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("stripe");
  });
});

describe("PaymentGatewayService.createCheckout — validation at the service seam (#156)", () => {
  beforeEach(stubGatewayFetch);
  afterEach(() => vi.unstubAllGlobals());

  it("an unknown gateway is rejected with the supported list named", async () => {
    const service = new PaymentGatewayService(makeEnv());
    await expect(
      service.createCheckout({
        draftId: "pay_bogus_156",
        amount: 10,
        currency: "USD",
        customer: "Acme",
        gateway: "boguspay" as SupportedGateway,
        userLogin: "tester",
      })
    ).rejects.toThrow(/Unsupported payment gateway: boguspay\. Supported gateways: stripe, paypal, lemonsqueezy, sandbox\./);
  });

  it("normalization matches the route/verifier: ' Sandbox ' resolves the sandbox harness", async () => {
    const service = new PaymentGatewayService(makeEnv());
    const result = await service.createCheckout({
      draftId: "pay_sandbox_156",
      amount: 10,
      currency: "USD",
      customer: "Acme",
      gateway: " Sandbox " as SupportedGateway,
      userLogin: "tester",
    });
    expect(result.success).toBe(true);
    expect(result.gateway).toBe("sandbox");
  });
});

describe("Source pins (#156)", () => {
  it("the create route validates the gateway before the draft_payment call (row write moved into the command, #1690)", () => {
    // Slice 07 (#370): the /payments/create route moved from
    // src/agents/orchestrator.ts to src/agents/routes/payments.ts — the pin
    // follows the ownership. #1690 moved the row write from a route
    // INSERT into the draft_payment command (ORM), so the pin now
    // anchors validation before the executeMCPTool("draft_payment")
    // call — the same guarantee (400 before any row is written), with
    // the new owner. The route's gateway 400 still precedes the call
    // because the draft command does not validate the gateway itself.
    const routes = src("agents/routes/payments.ts");
    const start = routes.indexOf('"/payments/create"');
    const callIdx = routes.indexOf('executeMCPTool("draft_payment"', start);
    expect(callIdx).toBeGreaterThan(start);
    const block = routes.slice(start, callIdx);
    expect(block).toContain("isSupportedGateway(gatewayInput)");
    expect(block).toContain("UNSUPPORTED_GATEWAY");
  });

  it("the service validates before minting the DID attestation", () => {
    const payments = src("services/payments.ts");
    const start = payments.indexOf("async createCheckout");
    const attestationIdx = payments.indexOf("createDidAttestation({", start);
    expect(payments.slice(start, attestationIdx)).toContain("isSupportedGateway(gateway)");
  });
});
