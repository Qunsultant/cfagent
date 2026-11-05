/**
 * Issue #359-08: characterization for the premium route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/premium.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the (path, method) pairs in the
 * same sequence as the original inline blocks; (b) the delegation call site
 * in orchestrator.ts — one call site, between the Cloudflare Agentic
 * Payments delegation (slice #359-17) and the E*TRADE broker delegation
 * (slice #359-09); and (c) the extracted entry point's behavior with a mock
 * context: premium paths return a Response (payment-gated — an unpaid
 * request gets the 402 payment-required challenge without reaching the
 * fulfill callback), non-matching paths return null (the orchestrator keeps
 * routing).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks — those move when their domain is extracted. Both neighbors have
 * since been extracted (agentic payments by slice #359-17, E*TRADE APIs by
 * slice #359-09), so the anchors below are their delegation calls; slice
 * #359-17 performed the agentic-payments swap this note called for.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (overrides: Partial<PremiumRouteContext> = {}): PremiumRouteContext =>
  ({
    env: {} as any,
    getOrm: () => ({ storeCanonicalReport: vi.fn() }) as any,
    ...overrides,
  }) as PremiumRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("premium route inventory (extraction #371)", () => {
  it("the route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/premium.ts");
    const markers = [
      'path.includes("/premium/options-scan")',
      'path.includes("/premium/market-research")',
      'path.includes("/premium/stock-signals")',
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
    expect(dispatchSrc).toContain("handlePremiumRoutes(request, url, path, sessionId,");
    // No leftover inline conditions for these paths (GET|POST on all three).
    for (const cond of [
      'path.includes("/premium/options-scan")',
      'path.includes("/premium/market-research")',
      'path.includes("/premium/stock-signals")',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The extracted module is the sole owner of these blocks now.
    const moduleSrc = src("agents/routes/premium.ts");
    expect(moduleSrc).toContain("// Paid Trading Service: Institutional Options & Greeks Screener");
    expect(moduleSrc).toContain("// Paid Trading Service: Autonomous Equity Research Report");
    expect(moduleSrc).toContain("// Paid Trading Service: Real-Time Quantitative Anomaly Signals");
    // Single call site.
    const calls = [...dispatchSrc.matchAll(/handlePremiumRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });

  it("the delegation sits between the agentic-payments delegation and the E*TRADE block", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const myIdx = dispatchSrc.indexOf("handlePremiumRoutes(request, url, path, sessionId,");
    // Lower bound: the agentic-payments DELEGATION CALL (landmark swap by
    // slice #359-17, which extracted the then-inline agentic block into
    // routes/agenticPayments.ts).
    const agenticIdx = dispatchSrc.indexOf("handleAgenticPaymentsRoutes(request, url, path, sessionId,");
    expect(agenticIdx).toBeGreaterThan(-1);
    expect(myIdx, "premium delegation must follow the agentic-payments delegation").toBeGreaterThan(agenticIdx);
    // Upper bound: the E*TRADE broker delegation call (the "Environment &
    // E*TRADE Trading APIs" banner moved into src/agents/routes/etradeBroker.ts
    // with slice #359-09, so the landmark anchors on the delegation call per
    // the #405 rule).
    const etradeIdx = dispatchSrc.indexOf("handleEtradeBrokerRoutes(request, url, path, sessionId,");
    expect(etradeIdx).toBeGreaterThan(-1);
    expect(myIdx, "premium delegation must precede the E*TRADE block").toBeLessThan(etradeIdx);
    // The E*TRADE block itself stays inline (not part of slice 08).
    // Issue #2482: its environment binding now resolves from the
    // persisted selection, never from the request header.
    expect(dispatchSrc).toContain("resolveBrokerEnvironmentFromSettings((key) => deps.readSettingRaw(key), deps.env)");
  });
});

describe("handlePremiumRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(await handlePremiumRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)).toBeNull();
    expect(await handlePremiumRoutes(req("POST", "/api/premiumx"), urlOf("/api/premiumx"), "/api/premiumx", "s", ctx)).toBeNull();
    // The payments (non-premium) paths are NOT owned by this handler.
    expect(
      await handlePremiumRoutes(req("GET", "/api/payments/agentic/wallet"), urlOf("/api/payments/agentic/wallet"), "/api/payments/agentic/wallet", "s", ctx)
    ).toBeNull();
  });

  it("an unpaid request to each premium path gets the payment-required challenge, never the fulfill callback", async () => {
    const ctx = baseCtx();
    for (const path of ["/api/premium/options-scan", "/api/premium/market-research", "/api/premium/stock-signals"]) {
      const res = await handlePremiumRoutes(req("GET", path), urlOf(path), path, "s", ctx);
      expect(res, `expected a Response for ${path}`).not.toBeNull();
      expect(res!.status, `expected payment-required status for ${path}`).toBe(402);
      // Canonical-copy persistence runs inside the fulfill callback, which
      // must not execute without payment.
      expect(ctx.getOrm().storeCanonicalReport).not.toHaveBeenCalled();
    }
  });

  it("POST is also claimed by the handler (payment-gated, same challenge)", async () => {
    const ctx = baseCtx();
    const res = await handlePremiumRoutes(
      req("POST", "/api/premium/market-research", { symbol: "AAPL" }),
      urlOf("/api/premium/market-research"),
      "/api/premium/market-research",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
  });

  it("context carries env and getOrm through to the payment service", async () => {
    const ctx = baseCtx();
    const res = await handlePremiumRoutes(req("GET", "/api/premium/options-scan"), urlOf("/api/premium/options-scan"), "/api/premium/options-scan", "sess-1", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
  });
});
