/**
 * Issue #359-17: characterization for the Cloudflare Agentic Payments
 * route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler
 * in src/agents/routes/agenticPayments.ts — the matching order in
 * routeRequest is load-bearing, so the module must handle the (path,
 * method) pairs in the same sequence as the original inline block; (b)
 * the delegation call site in orchestrator.ts — one call site, between
 * the payments handler and the premium handler; and (c) the extracted
 * entry point's behavior with a mocked ETradeAgenticPaymentService:
 * each moved path responds as before, non-matching paths return null
 * (the orchestrator keeps routing) — the handler ends with an explicit
 * `return null`, never undefined.
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS
 * (handlePaymentsRoutes / handlePremiumRoutes), never to a neighboring
 * domain's inline comments or blocks — those move when their domain is
 * extracted.
 *
 * Slice #359-07 deliberately left this block inline; slice #359-17 (the
 * FINAL slice of the #359 orchestrator breakup) extracted it. Two
 * original-code quirks are pinned exactly:
 *  - the auto-approve-limit condition has NO method pin: the service is
 *    constructed for any method on that path, and non-GET/POST methods
 *    fall through with no response (null);
 *  - the limit-update audit event (agentic_payment.limit_updated,
 *    agent "payments") fires only on a successful POST.
 *
 * The deep payment behavior (wallet ledger, x402 verification) stays
 * pinned by tests/agentic_payments.test.ts against the service itself.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const hoisted = vi.hoisted(() => ({
  instances: [] as any[],
  failWallet: false,
}));

vi.mock("../src/services/agenticPayments", () => ({
  ETradeAgenticPaymentService: class {
    args: unknown[];
    getWalletStatus = vi.fn(async () => {
      if (hoisted.failWallet) throw new Error("wallet boom");
      return { address: "0xabc", balanceUSD: 1.5 };
    });
    getAutoApproveLimit = vi.fn(() => 0.05);
    setAutoApproveLimit = vi.fn();
    constructor(...args: unknown[]) {
      this.args = args;
      hoisted.instances.push(this);
    }
  },
}));

import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (overrides: Partial<AgenticPaymentsRouteContext> = {}): AgenticPaymentsRouteContext =>
  ({
    env: {},
    getOrm: vi.fn(() => ({ orm: true })),
    audit: vi.fn(),
    ...overrides,
  }) as unknown as AgenticPaymentsRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.instances.length = 0;
  hoisted.failWallet = false;
});

describe("agentic payments route inventory (extraction #380)", () => {
  it("the route conditions appear in the module in the original relative order", () => {
    const moduleSrc = src("agents/routes/agenticPayments.ts");
    const markers = [
      'path.endsWith("/payments/agentic/wallet")',
      'path.includes("/payments/agentic/wallet")',
      'path.endsWith("/payments/agentic/auto-approve-limit")',
      'path.includes("/payments/agentic/auto-approve-limit")',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `marker missing from agenticPayments module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
    // The extracted module is the sole owner of this block now.
    expect(moduleSrc).toContain("// Cloudflare Agentic Payments (x402 & MPP)");
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(orchSrc).not.toContain('path.endsWith("/payments/agentic/wallet")');
    expect(orchSrc).not.toContain('path.endsWith("/payments/agentic/auto-approve-limit")');
    expect(orchSrc).not.toContain("new ETradeAgenticPaymentService");
    expect(orchSrc).not.toContain("ETradeAgenticPaymentService");
    // Single call site.
    const calls = [...dispatchSrc.matchAll(/handleAgenticPaymentsRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });

  it("the delegation sits between the payments handler and the premium handler", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const myIdx = dispatchSrc.indexOf("handleAgenticPaymentsRoutes(request, url, path, sessionId,");
    const paymentsIdx = dispatchSrc.indexOf("handlePaymentsRoutes(request, url, path, sessionId,");
    const premiumIdx = dispatchSrc.indexOf("handlePremiumRoutes(request, url, path, sessionId,");
    expect(paymentsIdx).toBeGreaterThan(-1);
    expect(premiumIdx).toBeGreaterThan(-1);
    expect(myIdx, "agentic delegation must follow the payments handler").toBeGreaterThan(paymentsIdx);
    expect(myIdx, "agentic delegation must precede the premium handler").toBeLessThan(premiumIdx);
  });
});

describe("handleAgenticPaymentsRoutes behavior", () => {
  it("returns null for paths it does not own, without constructing the service", async () => {
    const ctx = baseCtx();
    expect(await handleAgenticPaymentsRoutes(req("GET", "/api/payments/gateways"), urlOf("/api/payments/gateways"), "/api/payments/gateways", "s", ctx)).toBeNull();
    expect(await handleAgenticPaymentsRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)).toBeNull();
    expect(hoisted.instances).toHaveLength(0);
  });

  it("GET /payments/agentic/wallet returns the service wallet status", async () => {
    const ctx = baseCtx();
    const res = await handleAgenticPaymentsRoutes(req("GET", "/api/payments/agentic/wallet"), urlOf("/api/payments/agentic/wallet"), "/api/payments/agentic/wallet", "sess-1", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ address: "0xabc", balanceUSD: 1.5 });
    // The service is constructed per request with (orm, env, sessionId),
    // exactly as the inline block did.
    expect(hoisted.instances).toHaveLength(1);
    expect(hoisted.instances[0].args[0]).toEqual({ orm: true });
    expect(hoisted.instances[0].args[1]).toBe(ctx.env);
    expect(hoisted.instances[0].args[2]).toBe("sess-1");
  });

  it("GET /payments/agentic/wallet surfaces a service failure as a 500", async () => {
    hoisted.failWallet = true;
    const res = await handleAgenticPaymentsRoutes(req("GET", "/api/payments/agentic/wallet"), urlOf("/api/payments/agentic/wallet"), "/api/payments/agentic/wallet", "s", baseCtx());
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({ code: "FAILURE_UNEXPECTED_ERROR", error: "[FAILURE_UNEXPECTED_ERROR] An unexpected error occurred. Our team has been notified." });
  });

  it("POST /payments/agentic/wallet returns null (the wallet route is GET-only)", async () => {
    const res = await handleAgenticPaymentsRoutes(req("POST", "/api/payments/agentic/wallet"), urlOf("/api/payments/agentic/wallet"), "/api/payments/agentic/wallet", "s", baseCtx());
    expect(res).toBeNull();
    expect(hoisted.instances).toHaveLength(0);
  });

  it("GET /payments/agentic/auto-approve-limit returns the limit and the default network", async () => {
    const res = await handleAgenticPaymentsRoutes(req("GET", "/api/payments/agentic/auto-approve-limit"), urlOf("/api/payments/agentic/auto-approve-limit"), "/api/payments/agentic/auto-approve-limit", "s", baseCtx());
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ code: "SUCCESS_AUTO_APPROVE_LIMIT_READ", autoApproveLimitUSD: 0.05, network: "base-sepolia" });
  });

  it("GET /payments/agentic/auto-approve-limit honors the X402_NETWORK env override", async () => {
    const ctx = baseCtx({ env: { X402_NETWORK: "base" } as AgenticPaymentsRouteContext["env"] });
    const res = await handleAgenticPaymentsRoutes(req("GET", "/api/payments/agentic/auto-approve-limit"), urlOf("/api/payments/agentic/auto-approve-limit"), "/api/payments/agentic/auto-approve-limit", "s", ctx);
    expect(await res!.json()).toEqual({ code: "SUCCESS_AUTO_APPROVE_LIMIT_READ", autoApproveLimitUSD: 0.05, network: "base" });
  });

  it("POST /payments/agentic/auto-approve-limit updates the limit and audits the change", async () => {
    const ctx = baseCtx();
    const res = await handleAgenticPaymentsRoutes(req("POST", "/api/payments/agentic/auto-approve-limit", { limitUSD: 2.5 }), urlOf("/api/payments/agentic/auto-approve-limit"), "/api/payments/agentic/auto-approve-limit", "s", ctx);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ code: "SUCCESS_AUTO_APPROVE_LIMIT_UPDATED", success: true, autoApproveLimitUSD: 2.5 });
    expect(hoisted.instances[0].setAutoApproveLimit).toHaveBeenCalledWith(2.5);
    expect(ctx.audit).toHaveBeenCalledWith("agentic_payment.limit_updated", "payments", { limitUSD: 2.5 });
  });

  it("POST /payments/agentic/auto-approve-limit accepts the `limit` alias", async () => {
    const res = await handleAgenticPaymentsRoutes(req("POST", "/api/payments/agentic/auto-approve-limit", { limit: 1 }), urlOf("/api/payments/agentic/auto-approve-limit"), "/api/payments/agentic/auto-approve-limit", "s", baseCtx());
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ code: "SUCCESS_AUTO_APPROVE_LIMIT_UPDATED", success: true, autoApproveLimitUSD: 1 });
  });

  it("POST /payments/agentic/auto-approve-limit rejects a negative or missing limit with 400", async () => {
    const ctx = baseCtx();
    const neg = await handleAgenticPaymentsRoutes(req("POST", "/api/payments/agentic/auto-approve-limit", { limitUSD: -1 }), urlOf("/api/payments/agentic/auto-approve-limit"), "/api/payments/agentic/auto-approve-limit", "s", ctx);
    expect(neg!.status).toBe(400);
    expect(await neg!.json()).toEqual({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID", error: "Invalid limitUSD. Must be non-negative number." });
    const missing = await handleAgenticPaymentsRoutes(req("POST", "/api/payments/agentic/auto-approve-limit", {}), urlOf("/api/payments/agentic/auto-approve-limit"), "/api/payments/agentic/auto-approve-limit", "s", ctx);
    expect(missing!.status).toBe(400);
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("DELETE /payments/agentic/auto-approve-limit falls through (null) — the original condition has no method pin", async () => {
    const ctx = baseCtx();
    const res = await handleAgenticPaymentsRoutes(req("DELETE", "/api/payments/agentic/auto-approve-limit"), urlOf("/api/payments/agentic/auto-approve-limit"), "/api/payments/agentic/auto-approve-limit", "s", ctx);
    expect(res).toBeNull();
    // Quirk preserved: the service was still constructed on the way through.
    expect(hoisted.instances).toHaveLength(1);
    expect(ctx.audit).not.toHaveBeenCalled();
  });
});
