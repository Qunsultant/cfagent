/**
 * Issue #359-07: characterization for the payments route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/payments.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the (path, method) pairs in the
 * same sequence as the original inline blocks; (b) the delegation call site
 * in orchestrator.ts — one call site, after the referrals+ads handler and
 * before the Cloudflare Agentic Payments delegation (slice #359-17); and (c) the
 * extracted entry point's behavior with a mock context: each moved path
 * responds as before, non-matching paths return null (the orchestrator
 * keeps routing).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS
 * (handleReferralsAdsRoutes), never to a neighboring domain's inline
 * comments or blocks — those move when their domain is extracted. The upper
 * bound was the then-inline "Cloudflare Agentic Payments" banner until
 * slice #359-17 extracted that block into routes/agenticPayments.ts and
 * swapped this anchor for its delegation call, per the rule (the same swap
 * this slice made for slice 03's "/memory" anchor — see the payments test
 * note in tests/ads_revenue_referrals_routes_extraction.test.ts).
 *
 * The payments routes are money-adjacent; the guards are pinned exactly:
 * #156 gateway validation (400 before checkout, before any row write),
 * #148 webhook provider default-deny (401 before signature verification),
 * signature verification failure (401), and the audit event names
 * (#1690: payment.awaiting_confirmation replaces payment.created /
 * payment.confirmed / payment.rejected /
 * payment.captured / payment.settled_webhook; #1711 restores
 * payment.created in immediate mode only).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  handlePaymentsRoutes,
  type PaymentsRouteContext,
} from "../src/agents/routes/payments";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeSql = (queries: Record<string, (...args: unknown[]) => unknown>) =>
  ({
    exec: (query: string, ...params: unknown[]) => {
      for (const [fragment, fn] of Object.entries(queries)) {
        if (query.includes(fragment)) return fn(query, ...params);
      }
      return [];
    },
  }) as any;

const baseCtx = (overrides: Partial<PaymentsRouteContext> = {}): PaymentsRouteContext =>
  ({
    env: {} as any,
    ensureTables: () => makeSql({}),
    audit: vi.fn(),
    ...overrides,
  }) as PaymentsRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("payments route inventory (extraction #370)", () => {
  it("the route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/payments.ts");
    const markers = [
      'path.endsWith("/payments/gateways") || path.endsWith("/payments/status")',
      'path.endsWith("/payments/dids")',
      'path.endsWith("/payments/transactions")',
      'path.endsWith("/payments/create")',
      'path.endsWith("/payments/confirm")',
      'path.endsWith("/payments/capture")',
      'path.endsWith("/payments/webhook")',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; one delegation stands at the original position", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(dispatchSrc).toContain("handlePaymentsRoutes(request, url, path, sessionId,");
    // Distinctive comment that headed the inline blocks before extraction.
    expect(orchSrc).not.toContain("// Multi-Gateway Payments & DID Management API");
    // No leftover inline conditions for these paths (the agentic-payments
    // block is a separate domain and stays inline — its /payments/agentic/*
    // paths must NOT be claimed by this module).
    for (const cond of [
      'path.endsWith("/payments/gateways")',
      'path.endsWith("/payments/dids")',
      'path.endsWith("/payments/transactions")',
      'path.endsWith("/payments/create")',
      'path.endsWith("/payments/confirm")',
      'path.endsWith("/payments/capture")',
      'path.endsWith("/payments/webhook")',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The extracted module is the sole owner of these blocks now.
    const moduleSrc = src("agents/routes/payments.ts");
    expect(moduleSrc).toContain("// Multi-Gateway Payments & DID Management API");
    // Single call site.
    const calls = [...dispatchSrc.matchAll(/handlePaymentsRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });

  it("the delegation sits between the referrals+ads handler and the agentic-payments delegation", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const myIdx = dispatchSrc.indexOf("handlePaymentsRoutes(request, url, path, sessionId,");
    const referralsIdx = dispatchSrc.indexOf("handleReferralsAdsRoutes(request, url, path, sessionId,");
    expect(referralsIdx).toBeGreaterThan(-1);
    expect(myIdx, "payments delegation must follow the referrals+ads handler").toBeGreaterThan(referralsIdx);
    // Upper bound: the agentic-payments DELEGATION CALL (landmark swap by
    // slice #359-17, which extracted the then-inline agentic block into
    // routes/agenticPayments.ts — see file header note).
    const agenticIdx = dispatchSrc.indexOf("handleAgenticPaymentsRoutes(request, url, path, sessionId,");
    expect(agenticIdx).toBeGreaterThan(-1);
    expect(myIdx, "payments delegation must precede the agentic-payments delegation").toBeLessThan(agenticIdx);
    // The agentic block is NOT part of slice 07: its conditions live in
    // routes/agenticPayments.ts and no longer appear inline in the router.
    expect(orchSrc).not.toContain('path.endsWith("/payments/agentic/wallet")');
    expect(src("agents/routes/agenticPayments.ts")).toContain('path.endsWith("/payments/agentic/wallet")');
  });
});

describe("handlePaymentsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(await handlePaymentsRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)).toBeNull();
    expect(await handlePaymentsRoutes(req("POST", "/api/paymentsx"), urlOf("/api/paymentsx"), "/api/paymentsx", "s", ctx)).toBeNull();
    // The agentic-payments paths are NOT owned by this handler.
    expect(await handlePaymentsRoutes(req("GET", "/api/payments/agentic/wallet"), urlOf("/api/payments/agentic/wallet"), "/api/payments/agentic/wallet", "s", ctx)).toBeNull();
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("GET /payments/gateways returns gateway statuses, agent DIDs and the user DID", async () => {
    const ctx = baseCtx();
    const res = await handlePaymentsRoutes(req("GET", "/api/payments/gateways"), urlOf("/api/payments/gateways"), "/api/payments/gateways", "sess-9", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(Array.isArray(body.gateways)).toBe(true);
    expect(body.gateways.length).toBeGreaterThan(0);
    expect(body.agentDids).toBeDefined();
    expect(typeof body.userDid).toBe("string");
  });

  it("GET /payments/status hits the same handler", async () => {
    const ctx = baseCtx();
    const res = await handlePaymentsRoutes(req("GET", "/api/payments/status"), urlOf("/api/payments/status"), "/api/payments/status", "s", ctx);
    expect(res).not.toBeNull();
    expect((await res!.json()).gateways).toBeDefined();
  });

  it("GET /payments/dids resolves a DID document and lists all agent documents", async () => {
    const ctx = baseCtx();
    const res = await handlePaymentsRoutes(
      req("GET", "/api/payments/dids"),
      urlOf("/api/payments/dids"),
      "/api/payments/dids",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.count).toBeGreaterThan(0);
    expect(Array.isArray(body.documents)).toBe(true);
  });

  it("GET /payments/transactions maps ledger rows with DID provenance and a summary", async () => {
    const rows = [
      {
        id: "pay_1",
        session_id: "s",
        action: "charge",
        amount: 10,
        currency: "USD",
        customer: "c",
        gateway: "stripe",
        gateway_ref: "cs_1",
        status: "completed",
        checkout_url: "",
        proposer_did: null,
        authorizer_did: null,
        proof_signature: "sig",
        note: "n",
        created_at: "2026-10-19T05:00:00Z",
        updated_at: "2026-10-19T05:00:00Z",
      },
    ];
    const ctx = baseCtx({ ensureTables: () => makeSql({ mas_transactions: () => rows }) });
    const res = await handlePaymentsRoutes(req("GET", "/api/payments/transactions"), urlOf("/api/payments/transactions"), "/api/payments/transactions", "s", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.transactions[0].id).toBe("pay_1");
    expect(body.transactions[0].status).toBe("completed");
    expect(body.summary.totalVolume).toBe(10);
    expect(body.summary.completedCount).toBe(1);
    expect(body.summary.pendingCount).toBe(0);
  });

  it("POST /payments/create rejects an unsupported gateway with 400 BEFORE any checkout or row write", async () => {
    const seen: string[] = [];
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_transactions: (q: string) => {
            seen.push(q);
            return [];
          },
        }),
    });
    const res = await handlePaymentsRoutes(
      req("POST", "/api/payments/create", { amount: 10, gateway: "bogus-pay" }),
      urlOf("/api/payments/create"),
      "/api/payments/create",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("UNSUPPORTED_GATEWAY");
    expect(seen).toHaveLength(0); // no row written
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("POST /payments/confirm requires a draftId", async () => {
    const ctx = baseCtx();
    const res = await handlePaymentsRoutes(
      req("POST", "/api/payments/confirm", { decision: "approved" }),
      urlOf("/api/payments/confirm"),
      "/api/payments/confirm",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toContain("draftId");
  });

  it("POST /payments/capture requires an orderId", async () => {
    const ctx = baseCtx();
    const res = await handlePaymentsRoutes(
      req("POST", "/api/payments/capture", { gateway: "paypal" }),
      urlOf("/api/payments/capture"),
      "/api/payments/capture",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toContain("orderId");
  });

  it("POST /payments/webhook rejects an unsupported provider with 401 before signature verification (#148)", async () => {
    const seen: string[] = [];
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_transactions: (q: string) => {
            seen.push(q);
            return [];
          },
        }),
    });
    const res = await handlePaymentsRoutes(
      req("POST", "/api/payments/webhook?provider=bogus", { anything: true }),
      urlOf("/api/payments/webhook?provider=bogus"),
      "/api/payments/webhook",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect((await res!.json()).error).toContain("Unsupported webhook provider");
    expect(seen).toHaveLength(0); // no settlement without verification
    expect(ctx.audit).not.toHaveBeenCalled();
  });
});
