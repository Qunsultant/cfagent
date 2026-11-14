/**
 * #1728 (parent #1717, slice (h)): agentic payments + premium gating
 * unification — RED pins first.
 *
 * Each divergent pair keeps BOTH paths behind ONE scoped config switch
 * (run > session > user > global env > built-in surface legacy;
 * invalid fails closed + `payment.config_error` audit). Unset switches
 * change NOTHING on either surface.
 *
 * Deliberately NOT pinned here: the P-2 shared gap (neither layer
 * checks the facade createCheckout/executeRefund success flag before
 * writing status "completed") — it is recorded as a follow-up in the
 * #1728 §15, not fixed and not re-described as fixed by this slice.
 * No test below asserts the buggy completed-marking as correct.
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


// On-chain verification is covered in x402_verifier.test.ts; here the
// verifier accepts any claim except from a known-bad payer (the
// agentic_payments.test.ts pattern).
vi.mock("../src/services/x402Verifier", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  verifyOnChainClaim: vi.fn(async ({ proof }: any) =>
    proof.payer === "0xBadPayer"
      ? { ok: false, reason: "No matching USDC transfer" }
      : { ok: true, payer: proof.payer, txHash: proof.txHash },
  ),
}));

// Paid research fulfillment needs no live market data for an envelope
// test: keep every other marketDataResearch export intact, stub only the
// report builder (the envelope, not the engine, is this slice's scope).
vi.mock("../src/services/marketDataResearch", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  MarketDataResearchService: class {
    constructor(_env: unknown) {}
    async generateResearchReport(symbol: string) {
      return { symbol, headline: "canned research", sections: [] };
    }
  },
}));

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { InMemoryAuditPolicyAdapter } from "../src/data/inMemoryAuditPolicyAdapter";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  DraftPaymentCommand,
  ConfirmPaymentDraftCommand,
  GetTransactionsCommand,
  GetPaymentGatewaysCommand,
} from "../src/mcps/openaimp/commands";
import {
  PaidOptionsScreenerCommand,
  PaidMarketResearchCommand,
  AgenticWalletStatusCommand,
} from "../src/mcps/openaimp/agenticPaymentCommands";
import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
} from "../src/services/agenticPayments";
import {
  SUPPORTED_GATEWAYS,
} from "../src/services/payments";
import {
  resolvePaymentsCreateMode,
  resolvePaymentsConfirmMode,
  resolvePaymentsTransactionsMode,
  resolveAgenticWalletMode,
  resolvePremiumScreenerMode,
  resolvePremiumResearchMode,
  levelsForPaymentsSwitch,
  paymentsConfigErrorEvent,
  PAYMENTS_CREATE_MODE_SWITCH,
  PAYMENTS_CONFIRM_MODE_SWITCH,
  PAYMENTS_TRANSACTIONS_MODE_SWITCH,
  AGENTIC_WALLET_MODE_SWITCH,
  PREMIUM_SCREENER_MODE_SWITCH,
  PREMIUM_RESEARCH_MODE_SWITCH,
} from "../src/config/agenticPaymentsModes";
import { handlePaymentsRoutes } from "../src/agents/routes/payments";
import { handleAgenticPaymentsRoutes } from "../src/agents/routes/agenticPayments";
import { handlePremiumRoutes } from "../src/agents/routes/premium";
import type { Env } from "../src/types";

const mockEnv: any = {
  APP_BASE_URL: "https://agent.openaimp.com",
  AI_SEARCH_ENDPOINT: "https://mock.search",
  ORCHESTRATOR_AGENT: {},
  X402_NETWORK: "base-sepolia",
  X402_RECIPIENT_ADDRESS: "0x71C8363837918a211797E3c76A8B3C4258759550",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  X402_AUTO_APPROVE_LIMIT: "0.05",
  X402_AGENT_WALLET_KEY: "0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B",
};

function makeOrm(sessionId: string) {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema(sessionId);
  return { sql, orm };
}

function makeCtx(orm: DatabaseORM, sessionId: string, env: any = mockEnv) {
  const auditMock = vi.fn();
  const context: any = { env, orm, sessionId, audit: auditMock };
  return { auditMock, context };
}

const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function paidProof(nonce: string, txHash: string, payer = "0xPaidPayer") {
  const proof = { payer, signature: "0x_sig_paid", txHash, nonce, timestamp: Date.now() };
  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

async function seedDraft(context: any, overrides: Record<string, unknown> = {}) {
  return new DraftPaymentCommand().execute(
    { amount: 25, customer: "Acme Corp", gateway: "sandbox", description: "", ...overrides } as any,
    context,
  );
}

function seedTxRow(orm: DatabaseORM, row: Record<string, unknown>) {
  return orm.transactions.create({
    id: row.id,
    sessionId: row.sessionId,
    action: row.action ?? "charge",
    amount: row.amount ?? 25,
    currency: "USD",
    customer: "Acme Corp",
    gateway: "stripe",
    gatewayRef: "",
    status: row.status,
    checkoutUrl: "",
    proposerDid: "did:example:payments",
    authorizerDid: undefined,
    proofSignature: "",
    note: "",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  } as any);
}

describe("#1728 switch resolution (run > session > user > env > built-in)", () => {
  it("resolves run first, then session, user, env, built-in", () => {
    const scoped = { session: { create: "rest" }, user: { create: "mcp" } };
    expect(resolvePaymentsCreateMode(levelsForPaymentsSwitch(scoped, "create", "mcp", "rest"), "mcp").mode).toBe("mcp");
    expect(resolvePaymentsCreateMode(levelsForPaymentsSwitch(scoped, "create", undefined, "rest"), "mcp").mode).toBe("rest");
    expect(resolvePaymentsCreateMode(levelsForPaymentsSwitch({ session: {}, user: { create: "rest" } }, "create", undefined, "mcp"), "mcp").mode).toBe("rest");
    expect(resolvePaymentsCreateMode(levelsForPaymentsSwitch(undefined, "create", undefined, "rest"), "mcp").mode).toBe("rest");
    expect(resolvePaymentsCreateMode(levelsForPaymentsSwitch(undefined, "create", undefined, undefined), "mcp").mode).toBe("mcp");
  });

  it("fails closed to the surface legacy on an invalid value, without falling through", () => {
    const resolved = resolvePaymentsConfirmMode(levelsForPaymentsSwitch(undefined, "confirm", "bogus", "rest"), "mcp");
    expect(resolved.mode).toBe("mcp");
    expect(resolved.invalid).toBe(true);
    expect(resolved.level).toBe("run");
    expect(paymentsConfigErrorEvent()).toBe("payment.config_error");
  });

  it("normalizes case and surrounding whitespace for every switch", () => {
    expect(resolvePaymentsTransactionsMode(levelsForPaymentsSwitch(undefined, "transactions", "  REST ", undefined), "mcp").mode).toBe("rest");
    expect(resolveAgenticWalletMode(levelsForPaymentsSwitch(undefined, "wallet", undefined, "REST"), "mcp").mode).toBe("rest");
    expect(resolvePremiumScreenerMode(levelsForPaymentsSwitch(undefined, "screener", undefined, undefined), "mcp").mode).toBe("mcp");
    expect(resolvePremiumResearchMode(levelsForPaymentsSwitch(undefined, "research", "Rest", undefined), "mcp").mode).toBe("rest");
    expect(PAYMENTS_CREATE_MODE_SWITCH).toBe("PAYMENTS_CREATE_MODE");
    expect(PAYMENTS_CONFIRM_MODE_SWITCH).toBe("PAYMENTS_CONFIRM_MODE");
    expect(PAYMENTS_TRANSACTIONS_MODE_SWITCH).toBe("PAYMENTS_TRANSACTIONS_MODE");
    expect(AGENTIC_WALLET_MODE_SWITCH).toBe("AGENTIC_WALLET_MODE");
    expect(PREMIUM_SCREENER_MODE_SWITCH).toBe("PREMIUM_SCREENER_MODE");
    expect(PREMIUM_RESEARCH_MODE_SWITCH).toBe("PREMIUM_RESEARCH_MODE");
  });
});

describe("#1728 P-1 draft_payment: gateway validation + description default", () => {
  it("mcp legacy: no gateway validation; omitted description → generic default", async () => {
    const { orm, context } = (() => {
      const { orm } = makeOrm("p1-legacy");
      return { orm, ...makeCtx(orm, "p1-legacy") };
    })();
    const out = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "bogus-gateway" } as any, context,
    );
    expect(out.transaction.gateway).toBe("bogus-gateway");
    expect(out.transaction.note).toBe("Payment intent for Acme Corp");
  });

  it("rest mode: unsupported gateway throws the REST UNSUPPORTED_GATEWAY wording before any row write", async () => {
    const { orm, context } = (() => {
      const { orm } = makeOrm("p1-rest");
      return { orm, ...makeCtx(orm, "p1-rest") };
    })();
    const err = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "bogus-gateway", mode: "rest" } as any, context,
    ).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Unsupported payment gateway: "bogus-gateway"');
    expect(err.message).toContain(SUPPORTED_GATEWAYS.join(", "));
    expect(orm.transactions.findMany().length).toBe(0);
  });

  it("rest mode: omitted description stores empty (the #514 route pin), not the generic default", async () => {
    const { context } = (() => {
      const { orm } = makeOrm("p1-rest-desc");
      return { orm, ...makeCtx(orm, "p1-rest-desc") };
    })();
    const out = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "stripe", mode: "rest" } as any, context,
    );
    expect(out.transaction.note).toBe("");
  });

  it("invalid mode fails closed to mcp legacy and audits payment.config_error", async () => {
    const { context, auditMock } = (() => {
      const { orm } = makeOrm("p1-invalid");
      return { orm, ...makeCtx(orm, "p1-invalid") };
    })();
    const out = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "bogus-gateway", mode: "bogus" } as any, context,
    );
    expect(out.transaction.gateway).toBe("bogus-gateway");
    const configErr = auditMock.mock.calls.find((c: any[]) => c[0] === "payment.config_error");
    expect(configErr).toBeDefined();
    expect(configErr[2]).toMatchObject({ setting: "PAYMENTS_CREATE_MODE", resolved: "mcp" });
  });

  it("route guard is NOT switchable: route create still 400s on an unsupported gateway even in mcp mode", async () => {
    const auditMock = vi.fn();
    const res = await handlePaymentsRoutes(
      req("POST", "/payments/create", { amount: 25, customer: "Acme Corp", gateway: "bogus-gateway" }),
      urlOf("/payments/create"), "/payments/create", "p1-route",
      { env: { PAYMENTS_CREATE_MODE: "mcp" } as any, ensureTables: () => ({ exec: () => [] }) as any, audit: auditMock },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body: any = await res!.json();
    expect(body.code).toBe("UNSUPPORTED_GATEWAY");
  });
});

describe("#1728 P-2 confirm_payment_draft: envelope unification", () => {
  const facade = {
    createCheckout: async () => ({ checkoutUrl: "https://checkout.test/x", gatewayRef: "ref_test" }),
    executeRefund: async () => ({ refundId: "ref_test_refund" }),
  };

  it("mcp legacy: full envelope with executorDid / decision / executedAt / transaction", async () => {
    const { orm, context } = (() => {
      const { orm } = makeOrm("p2-legacy");
      return { orm, ...makeCtx(orm, "p2-legacy") };
    })();
    const draft = await seedDraft({ ...context, facade });
    const out = await new ConfirmPaymentDraftCommand().execute(
      { draftId: draft.draftId, decision: "approved" }, { ...context, facade },
    );
    expect(out.status).toBe("completed");
    expect(out.decision).toBe("approved");
    expect(out.executorDid).toBeDefined();
    expect(out.executedAt).toBeDefined();
    expect(out.transaction).toBeDefined();
    expect(out.checkoutUrl).toBe("https://checkout.test/x");
  });

  it("rest mode: approved returns exactly the REST subset envelope", async () => {
    const { context } = (() => {
      const { orm } = makeOrm("p2-rest");
      return { orm, ...makeCtx(orm, "p2-rest") };
    })();
    const draft = await seedDraft({ ...context, facade });
    const out = await new ConfirmPaymentDraftCommand().execute(
      { draftId: draft.draftId, decision: "approved", mode: "rest" }, { ...context, facade },
    );
    expect(Object.keys(out).sort()).toEqual(
      ["authorizerDid", "checkoutUrl", "draftId", "gatewayRef", "status", "success"].sort(),
    );
    expect(out).toMatchObject({ success: true, status: "completed", checkoutUrl: "https://checkout.test/x", gatewayRef: "ref_test" });
  });

  it("rest mode: rejected returns exactly the REST rejected envelope", async () => {
    const { context } = (() => {
      const { orm } = makeOrm("p2-rest-rej");
      return { orm, ...makeCtx(orm, "p2-rest-rej") };
    })();
    const draft = await seedDraft({ ...context, facade });
    const out = await new ConfirmPaymentDraftCommand().execute(
      { draftId: draft.draftId, decision: "rejected", mode: "rest" }, { ...context, facade },
    );
    expect(out).toEqual({ success: true, status: "rejected", draftId: draft.draftId });
  });

  it("invalid mode fails closed to the full envelope and audits payment.config_error", async () => {
    const { context, auditMock } = (() => {
      const { orm } = makeOrm("p2-invalid");
      return { orm, ...makeCtx(orm, "p2-invalid") };
    })();
    const draft = await seedDraft({ ...context, facade });
    const out = await new ConfirmPaymentDraftCommand().execute(
      { draftId: draft.draftId, decision: "approved", mode: "bogus" }, { ...context, facade },
    );
    expect(out.executorDid).toBeDefined();
    const configErr = auditMock.mock.calls.find((c: any[]) => c[0] === "payment.config_error");
    expect(configErr).toBeDefined();
    expect(configErr[2]).toMatchObject({ setting: "PAYMENTS_CONFIRM_MODE", resolved: "mcp" });
  });

  it("route confirm: mode=mcp returns the full envelope; unset returns the REST subset; invalid fails closed + audits", async () => {
    const { sql, orm } = makeOrm("p2-route");
    const auditMock = vi.fn();
    const routeCtx: any = {
      env: mockEnv,
      ensureTables: () => sql,
      getOrm: () => orm,
      // #3156: the money-path audit gate needs a reachable policy
      // store, or it fails closed (503). The in-memory adapter
      // stands in for the orchestrator's D1 port here.
      getAuditPolicyPort: async () => new InMemoryAuditPolicyAdapter(),
      audit: auditMock,
    };
    const draftCtx: any = { env: mockEnv, orm, sessionId: "p2-route", audit: vi.fn() };
    const draft = await seedDraft(draftCtx);
    const resMcp = await handlePaymentsRoutes(
      req("POST", "/payments/confirm", { draftId: draft.draftId, decision: "approved", mode: "mcp" }),
      urlOf("/payments/confirm"), "/payments/confirm", "p2-route", routeCtx,
    );
    const bodyMcp: any = await resMcp!.json();
    expect(bodyMcp.success).toBe(true);
    expect(bodyMcp.decision).toBe("approved");
    expect(bodyMcp.executorDid).toBeDefined();
    expect(bodyMcp.transaction).toBeDefined();

    const draft2 = await seedDraft(draftCtx);
    const resRest = await handlePaymentsRoutes(
      req("POST", "/payments/confirm", { draftId: draft2.draftId, decision: "approved" }),
      urlOf("/payments/confirm"), "/payments/confirm", "p2-route", routeCtx,
    );
    const bodyRest: any = await resRest!.json();
    expect(Object.keys(bodyRest).sort()).toEqual(
      ["authorizerDid", "checkoutUrl", "draftId", "gatewayRef", "status", "success"].sort(),
    );
    expect("executorDid" in bodyRest).toBe(false);

    const draft3 = await seedDraft(draftCtx);
    const resBogus = await handlePaymentsRoutes(
      req("POST", "/payments/confirm", { draftId: draft3.draftId, decision: "approved", mode: "bogus" }),
      urlOf("/payments/confirm"), "/payments/confirm", "p2-route", routeCtx,
    );
    const bodyBogus: any = await resBogus!.json();
    expect("executorDid" in bodyBogus).toBe(false);
    const configErr = auditMock.mock.calls.find((c: any[]) => c[0] === "payment.config_error");
    expect(configErr).toBeDefined();
    expect(configErr[2]).toMatchObject({ setting: "PAYMENTS_CONFIRM_MODE", resolved: "rest" });
  });
});

describe("#1728 P-3 get_transactions: query surface + presentation", () => {
  function seedLedger() {
    const { orm } = makeOrm("p3");
    seedTxRow(orm, { id: "tx_done", sessionId: "p3", status: "completed", amount: 25 });
    seedTxRow(orm, { id: "tx_wait", sessionId: "p3", status: "awaiting_confirmation", amount: 10 });
    seedTxRow(orm, { id: "tx_rej", sessionId: "p3", status: "rejected", amount: 5 });
    return orm;
  }

  it("mcp legacy: limit + status honored; raw rows + count, no summary", async () => {
    const orm = seedLedger();
    const { context } = makeCtx(orm, "p3");
    const out = await new GetTransactionsCommand().execute({ limit: 1, status: "completed" }, context);
    expect(out.count).toBe(1);
    expect(out.transactions.length).toBe(1);
    expect("summary" in out).toBe(false);
  });

  it("rest mode: limit fixed at 50 and status ignored; coerced rows + summary", async () => {
    const orm = seedLedger();
    const { context } = makeCtx(orm, "p3");
    const out = await new GetTransactionsCommand().execute({ limit: 1, status: "completed", mode: "rest" }, context);
    expect(out.count).toBe(3);
    expect(out.transactions.length).toBe(3);
    expect(out.summary).toMatchObject({ totalVolume: 25, completedCount: 1, pendingCount: 1, verifiedDidCount: 3 });
    expect(typeof out.transactions[0].id).toBe("string");
    expect(out.transactions[0].gateway).toBe("stripe");
  });

  it("route transactions: mode=mcp honors limit/status raw; rest legacy remaps + summarizes identically to the command rest shape", async () => {
    const orm = seedLedger();
    const { sql } = (() => {
      const s = new MockSqlStorage();
      return { sql: s };
    })();
    // Route harness needs the same ORM the rows live in; ensureTables
    // is only a fallback (getOrm wins), so pass a throwaway sql.
    const auditMock = vi.fn();
    const routeCtx: any = {
      env: mockEnv,
      ensureTables: () => sql,
      getOrm: () => orm,
      audit: auditMock,
    };
    const resMcp = await handlePaymentsRoutes(
      req("GET", "/payments/transactions?limit=1&status=completed&mode=mcp"),
      urlOf("/payments/transactions?limit=1&status=completed&mode=mcp"),
      "/payments/transactions", "p3", routeCtx,
    );
    const bodyMcp: any = await resMcp!.json();
    expect(bodyMcp.count).toBe(1);
    expect("summary" in bodyMcp).toBe(false);

    const resRest = await handlePaymentsRoutes(
      req("GET", "/payments/transactions"),
      urlOf("/payments/transactions"), "/payments/transactions", "p3", routeCtx,
    );
    const bodyRest: any = await resRest!.json();
    expect(bodyRest.count).toBe(3);
    expect(bodyRest.summary).toMatchObject({ totalVolume: 25, completedCount: 1, pendingCount: 1, verifiedDidCount: 3 });

    const { context } = makeCtx(orm, "p3");
    const cmdRest = await new GetTransactionsCommand().execute({ mode: "rest" }, context);
    expect(bodyRest.transactions).toEqual(cmdRest.transactions);
    expect(bodyRest.summary).toEqual(cmdRest.summary);
  });
});

describe("#1728 P-4 gateways: IDENTICAL, pin only", () => {
  it("command returns count; route drops it and returns exactly 3 fields", async () => {
    const { orm, context } = (() => {
      const { orm } = makeOrm("p4");
      return { orm, ...makeCtx(orm, "p4") };
    })();
    const facade = { getGatewayStatuses: () => [{ id: "stripe", name: "Stripe" }] };
    const cmdOut = await new GetPaymentGatewaysCommand().execute({}, { ...context, facade });
    expect(cmdOut.count).toBe(1);

    const auditMock = vi.fn();
    const res = await handlePaymentsRoutes(
      req("GET", "/payments/gateways"), urlOf("/payments/gateways"), "/payments/gateways", "p4",
      { env: mockEnv, ensureTables: () => new MockSqlStorage() as any, getOrm: () => orm, audit: auditMock },
    );
    const body: any = await res!.json();
    expect(Object.keys(body).sort()).toEqual(["agentDids", "gateways", "userDid"]);
    expect("count" in body).toBe(false);
  });
});

describe("#1728 P-5 agentic wallet: input, validation, audit, shape", () => {
  it("mcp legacy status wraps with success; rest status is raw", async () => {
    const { context } = (() => {
      const { orm } = makeOrm("p5-status");
      return { orm, ...makeCtx(orm, "p5-status") };
    })();
    const legacy = await new AgenticWalletStatusCommand().execute({}, context);
    expect(legacy.success).toBe(true);
    expect(legacy.balanceUSD).toBe(50);
    expect(legacy.simulated).toBe(true);
    const rest = await new AgenticWalletStatusCommand().execute({ mode: "rest" }, context);
    expect("success" in rest).toBe(false);
    expect(rest.balanceUSD).toBe(50);
    expect(rest.autoApproveLimitUSD).toBe(0.05);
  });

  it("mcp legacy set_limit: message shape, no audit, missing limit falls through to a status read", async () => {
    const { context, auditMock } = (() => {
      const { orm } = makeOrm("p5-legacy-set");
      return { orm, ...makeCtx(orm, "p5-legacy-set") };
    })();
    const out = await new AgenticWalletStatusCommand().execute({ action: "set_limit", limitUSD: 0.2 }, context);
    expect(out).toMatchObject({ success: true, autoApproveLimitUSD: 0.2 });
    expect(out.message).toBe("Agentic payment auto-approval limit set to $0.20 USD.");
    expect(auditMock.mock.calls.some((c: any[]) => c[0] === "agentic_payment.limit_updated")).toBe(false);
    const fallthrough = await new AgenticWalletStatusCommand().execute({ action: "set_limit" }, context);
    expect(fallthrough.balanceUSD).toBeDefined();
  });

  it("rest set_limit: limit alias honored, route shape, audits limit_updated; missing/negative/NaN throw the route message", async () => {
    const { context, auditMock } = (() => {
      const { orm } = makeOrm("p5-rest-set");
      return { orm, ...makeCtx(orm, "p5-rest-set") };
    })();
    const out = await new AgenticWalletStatusCommand().execute({ action: "set_limit", limit: 0.3, mode: "rest" }, context);
    expect(out).toEqual({ success: true, autoApproveLimitUSD: 0.3 });
    const audit = auditMock.mock.calls.find((c: any[]) => c[0] === "agentic_payment.limit_updated");
    expect(audit).toBeDefined();
    expect(audit[2]).toMatchObject({ limitUSD: 0.3 });
    for (const bad of [{ action: "set_limit", mode: "rest" }, { action: "set_limit", limitUSD: -1, mode: "rest" }, { action: "set_limit", limitUSD: NaN, mode: "rest" }]) {
      await expect(new AgenticWalletStatusCommand().execute(bad as any, context)).rejects.toThrow(
        "Invalid limitUSD. Must be non-negative number.",
      );
    }
  });

  it("route wallet: mode=mcp wraps/shapes like MCP; rest legacy keeps route shapes; POST validation + audit are NOT switchable", async () => {
    const { orm } = makeOrm("p5-route");
    const auditMock = vi.fn();
    const routeCtx: any = { env: mockEnv, getOrm: () => orm, audit: auditMock };
    const getWallet = (path: string) =>
      handleAgenticPaymentsRoutes(req("GET", path), urlOf(path), path.split("?")[0], "p5-route", routeCtx);
    const postLimit = (body: unknown) =>
      handleAgenticPaymentsRoutes(req("POST", "/payments/agentic/auto-approve-limit", body), urlOf("/payments/agentic/auto-approve-limit"), "/payments/agentic/auto-approve-limit", "p5-route", routeCtx);

    const wrapped: any = await (await getWallet("/payments/agentic/wallet?mode=mcp"))!.json();
    expect(wrapped.success).toBe(true);
    expect(wrapped.balanceUSD).toBe(50);
    const raw: any = await (await getWallet("/payments/agentic/wallet"))!.json();
    expect("success" in raw).toBe(false);
    expect(raw.balanceUSD).toBe(50);

    const limitMcp: any = await (await getWallet("/payments/agentic/auto-approve-limit?mode=mcp"))!.json();
    expect(limitMcp.success).toBe(true);
    expect(limitMcp.balanceUSD).toBeDefined();
    const limitRest: any = await (await getWallet("/payments/agentic/auto-approve-limit"))!.json();
    expect(Object.keys(limitRest).sort()).toEqual(["autoApproveLimitUSD", "code", "network"]);

    const postMcp: any = await (await postLimit({ limitUSD: 0.4, mode: "mcp" }))!.json();
    expect(postMcp.message).toBe("Agentic payment auto-approval limit set to $0.40 USD.");
    expect(postMcp.autoApproveLimitUSD).toBe(0.4);
    const postRest: any = await (await postLimit({ limitUSD: 0.4 }))!.json();
    expect("message" in postRest).toBe(false);
    expect(postRest).toEqual({ code: "SUCCESS_AUTO_APPROVE_LIMIT_UPDATED", success: true, autoApproveLimitUSD: 0.4 });
    expect(auditMock.mock.calls.some((c: any[]) => c[0] === "agentic_payment.limit_updated")).toBe(true);

    const postBad = await postLimit({ limitUSD: -1, mode: "mcp" });
    expect(postBad!.status).toBe(400);
  });
});

describe("#1728 P-6 premium gating: tiers, envelopes, and the boundaries that do NOT move", () => {
  it("tier catalogue is shared: screener $0.05, research $0.10, signals $0.02; no paid_stock_signals command exists", () => {
    expect(TRADING_PAID_SERVICES.OPTIONS_SCREENER.priceUSD).toBe(0.05);
    expect(TRADING_PAID_SERVICES.MARKET_RESEARCH.priceUSD).toBe(0.10);
    expect(TRADING_PAID_SERVICES.STOCK_SIGNALS.priceUSD).toBe(0.02);
    const names = McpToolFactory.getAllTools().map((t) => t.name);
    expect(names).toContain("paid_options_screener");
    expect(names).toContain("paid_market_research");
    expect(names).not.toContain("paid_stock_signals");
  });

  it("MPP-from-headers stays rejected in every mode (mppx gateway only)", async () => {
    const { orm } = makeOrm("p6-mpp");
    const service = new ETradeAgenticPaymentService(orm, mockEnv, "p6-mpp");
    const challenge = service.createX402Challenge("/api/premium/options-scan", 0.05, "Options Screener");
    const verification = await service.verifyPayment({ Authorization: "Payment tempo-credential" }, challenge);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("mppx gateway");
  });

  it("screener command: mcp legacy flat envelope vs rest REST envelope; underlyingSymbols + symbol aliases accepted", async () => {
    const { orm, context } = (() => {
      const { orm } = makeOrm("p6-screener");
      return { orm, ...makeCtx(orm, "p6-screener") };
    })();
    let n = 0;
    const sig = () => paidProof("n_screener", `0xscreen${n++}`);
    const legacy = await new PaidOptionsScreenerCommand().execute({ underlying: "NVDA", paymentSignature: sig() }, context);
    expect(legacy.status).toBe(200);
    expect(legacy.paid).toBe(true);
    expect(legacy.matchesCount).toBeDefined();
    expect(legacy.contracts).toBeDefined();
    expect("screenResult" in legacy).toBe(false);
    expect("service" in legacy).toBe(false);

    const rest = await new PaidOptionsScreenerCommand().execute({ underlying: "NVDA", paymentSignature: sig(), mode: "rest" }, context);
    // REST success mirrors the screen outcome (success = !failed);
    // in this sandbox the screen errors upstream, so success is
    // false here — the shape, not a successful screen, is the pin.
    expect(rest.success).toBe(rest.screenResult.status !== "error");
    expect(rest.service).toBe(TRADING_PAID_SERVICES.OPTIONS_SCREENER.name);
    expect(rest.receipt).toBeDefined();
    expect(rest.screenResult).toBeDefined();
    expect("matchesCount" in rest).toBe(false);
    expect("paid" in rest).toBe(false);

    const alias = await new PaidOptionsScreenerCommand().execute({ underlyingSymbols: ["NVDA"], paymentSignature: sig() }, context);
    expect(alias.paid).toBe(true);
    const aliasSym = await new PaidOptionsScreenerCommand().execute({ symbol: "NVDA", paymentSignature: sig() }, context);
    expect(aliasSym.paid).toBe(true);
  });

  it("research command: mcp legacy flat envelope vs rest REST envelope", async () => {
    const { context } = (() => {
      const { orm } = makeOrm("p6-research");
      return { orm, ...makeCtx(orm, "p6-research") };
    })();
    let n = 0;
    const sig = () => paidProof("n_research", `0xresearch${n++}`);
    const legacy = await new PaidMarketResearchCommand().execute({ symbol: "NVDA", paymentSignature: sig() }, context);
    expect(legacy).toMatchObject({ status: 200, paid: true });
    expect(legacy.report).toMatchObject({ symbol: "NVDA", headline: "canned research" });
    expect("service" in legacy).toBe(false);
    const rest = await new PaidMarketResearchCommand().execute({ symbol: "NVDA", paymentSignature: sig(), mode: "rest" }, context);
    expect(rest).toMatchObject({ success: true, service: TRADING_PAID_SERVICES.MARKET_RESEARCH.name });
    expect(rest.report).toMatchObject({ symbol: "NVDA", headline: "canned research" });
    expect("paid" in rest).toBe(false);
  });

  it("REST premium routes: mode=mcp returns the MCP envelope; unset returns the REST envelope", async () => {
    const { orm } = makeOrm("p6-route");
    // Issue #2408: the route meters served calls through ctx.sql —
    // the production host always supplies it (makePremiumRouteContext),
    // so this route-level served expectation supplies it too.
    const routeCtx: any = {
      env: mockEnv,
      sql: new MockSqlStorage(),
      getOrm: () => orm,
      getScreenerAgent: () => ({}) as any,
      persistScreenerReportCanonical: vi.fn(),
    };
    let n = 0;
    const headers = () => ({ "PAYMENT-SIGNATURE": paidProof("n_route", `0xroute${n++}`) });

    const resMcp = await handlePremiumRoutes(
      req("GET", "/premium/options-scan?mode=mcp&symbol=NVDA", undefined, headers()),
      urlOf("/premium/options-scan?mode=mcp&symbol=NVDA"), "/premium/options-scan", "p6-route", routeCtx,
    );
    const bodyMcp: any = await resMcp!.json();
    expect(bodyMcp.status).toBe(200);
    expect(bodyMcp.paid).toBe(true);
    expect(bodyMcp.matchesCount).toBeDefined();
    expect(bodyMcp.contracts).toBeDefined();
    expect("screenResult" in bodyMcp).toBe(false);

    const resRest = await handlePremiumRoutes(
      req("GET", "/premium/options-scan?symbol=NVDA", undefined, headers()),
      urlOf("/premium/options-scan?symbol=NVDA"), "/premium/options-scan", "p6-route", routeCtx,
    );
    const bodyRest: any = await resRest!.json();
    // Same success-mirrors-screen rule as the command rest envelope
    // (see the command test above): the shape is the pin here.
    expect(bodyRest.success).toBe(bodyRest.screenResult.status !== "error");
    expect(bodyRest.service).toBe(TRADING_PAID_SERVICES.OPTIONS_SCREENER.name);
    expect(bodyRest.screenResult).toBeDefined();
    expect("matchesCount" in bodyRest).toBe(false);

    const resResMcp = await handlePremiumRoutes(
      req("GET", "/premium/market-research?mode=mcp&symbol=NVDA", undefined, headers()),
      urlOf("/premium/market-research?mode=mcp&symbol=NVDA"), "/premium/market-research", "p6-route", routeCtx,
    );
    const bodyResMcp: any = await resResMcp!.json();
    expect(bodyResMcp.status).toBe(200);
    expect(bodyResMcp.paid).toBe(true);
    expect(bodyResMcp.report).toMatchObject({ symbol: "NVDA", headline: "canned research" });

    const resResRest = await handlePremiumRoutes(
      req("GET", "/premium/market-research?symbol=NVDA", undefined, headers()),
      urlOf("/premium/market-research?symbol=NVDA"), "/premium/market-research", "p6-route", routeCtx,
    );
    const bodyResRest: any = await resResRest!.json();
    expect(bodyResRest.success).toBe(true);
    expect(bodyResRest.service).toBe(TRADING_PAID_SERVICES.MARKET_RESEARCH.name);
    expect(bodyResRest.report).toMatchObject({ symbol: "NVDA", headline: "canned research" });
  });

  it("PAYMENTS_FLOW_MODE is untouched by this slice (still hitl | immediate, default hitl)", async () => {
    const routes = (await import("node:fs")).readFileSync("src/agents/routes/payments.ts", "utf8");
    expect(routes).toContain("PAYMENTS_FLOW_MODE");
    expect(routes).toContain('resolvePaymentsFlowMode');
  });
});
