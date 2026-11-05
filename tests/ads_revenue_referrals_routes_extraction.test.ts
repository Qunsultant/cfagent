/**
 * ADAPTED for #2345 (step 3a): the handlers' marketplace access
 * moved behind the marketplace ports (orm.marketplacePorts) and
 * the raw mas_referrals/mas_ads statements were retired, so the
 * handler-B behaviour tests assert on the port surface instead
 * of the SQL exec log (same responses, same audit calls, same
 * record contents; the #730 bump-before-list contract is pinned
 * by port call order). The stub repositories double as the
 * ports — their sync vi.fn's are await-compatible.
 *
 * Issue #359-03: characterization for the ads / revenue / referrals route
 * extraction.
 *
 * The domain's blocks are NOT contiguous in routeRequest (inventory group
 * between /schema/query and /audit; community group between /memory and the
 * payments block), so the extraction produced TWO handlers in
 * src/agents/routes/adsRevenueReferrals.ts, each invoked at the exact
 * position its original blocks occupied. This pins (a) the route inventory
 * and relative order inside each handler, (b) the two call-site positions
 * in orchestrator.ts (route matching order is load-bearing), and (c) the
 * extracted handlers' behavior with a mock context: each moved path
 * responds as before, non-matching paths return null (the orchestrator
 * keeps routing).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  handleAdsRevenueReferralsRoutes,
  handleReferralsAdsRoutes,
  type AdsRevenueReferralsRouteContext,
} from "../src/agents/routes/adsRevenueReferrals";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeSql = (execImpl: (query: string, ...params: unknown[]) => unknown[] = () => []) =>
  ({ exec: vi.fn(execImpl) }) as any;

const makeOrm = (overrides: Record<string, any> = {}) => {
  const categories = {
    findMany: vi.fn(() => []),
    findById: vi.fn(() => null),
    update: vi.fn((id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn((rec: any) => rec),
    delete: vi.fn(),
    count: vi.fn(() => 0),
    ...overrides.categories,
  };
  const externalAds = {
    findMany: vi.fn(() => []),
    findById: vi.fn(() => null),
    update: vi.fn((id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn((rec: any) => rec),
    ...overrides.externalAds,
  };
  const referrals = {
    findMany: vi.fn(async () => []),
    findById: vi.fn(async () => null),
    update: vi.fn(async (id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn(async (rec: any) => rec),
    delete: vi.fn(async () => true),
    count: vi.fn(async () => 0),
    incrementCounter: vi.fn(async () => null),
    ...overrides.referrals,
  };
  const ads = {
    findMany: vi.fn(async () => []),
    findById: vi.fn(async () => null),
    update: vi.fn(async (id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn(async (rec: any) => rec),
    delete: vi.fn(async () => true),
    count: vi.fn(async () => 0),
    incrementCounter: vi.fn(async () => null),
    incrementAllImpressions: vi.fn(async () => undefined),
    ...overrides.ads,
  };
  return {
    categories,
    externalAds,
    referrals,
    ads,
    transactions: { findMany: vi.fn(() => []) },
    getRevenueSummary: vi.fn(() => ({ total: 0, currency: "USD" })),
    marketplacePorts: vi.fn(async () => ({ categories, externalAds, ads, referrals })),
    ...overrides.rest,
  };
};

const baseCtx = (
  overrides: Partial<AdsRevenueReferralsRouteContext> = {}
): AdsRevenueReferralsRouteContext =>
  ({
    getOrm: () => makeOrm() as any,
    ensureTables: () => makeSql(),
    audit: vi.fn(),
    ...overrides,
  }) as AdsRevenueReferralsRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });

const callA = (method: string, path: string, body?: unknown, ctx?: AdsRevenueReferralsRouteContext) => {
  const c = ctx ?? baseCtx();
  const url = new URL(`https://agent.internal${path}`);
  return handleAdsRevenueReferralsRoutes(req(method, path, body), url, path, "sess-1", c).then((res) => ({ res, ctx: c }));
};

const callB = (method: string, path: string, body?: unknown, ctx?: AdsRevenueReferralsRouteContext) => {
  const c = ctx ?? baseCtx();
  const url = new URL(`https://agent.internal${path}`);
  return handleReferralsAdsRoutes(req(method, path, body), url, path, "sess-1", c).then((res) => ({ res, ctx: c }));
};

describe("ads/revenue/referrals route inventory (extraction #366)", () => {
  const moduleSrc = () => src("agents/routes/adsRevenueReferrals.ts");

  it("handler A conditions appear in the module in the original relative order", () => {
    const srcText = moduleSrc();
    const markers = [
      'path.endsWith("/categories")',
      'path.endsWith("/revenue") && request.method === "GET"',
      'path.endsWith("/external-ads")',
      'path.endsWith("/external-ads/impression") && request.method === "POST"',
      'path.endsWith("/external-ads/click") && request.method === "POST"',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = srcText.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
    // Handler A must not swallow the community group's paths.
    const handlerAStart = srcText.indexOf("export async function handleAdsRevenueReferralsRoutes");
    const handlerBStart = srcText.indexOf("export async function handleReferralsAdsRoutes");
    const handlerABody = srcText.slice(handlerAStart, handlerBStart);
    expect(handlerABody).not.toContain('"/referrals"');
    expect(handlerABody).not.toContain('"/ads"');
  });

  it("handler B conditions appear in the module in the original relative order", () => {
    const srcText = moduleSrc();
    const handlerBStart = srcText.indexOf("export async function handleReferralsAdsRoutes");
    const handlerBBody = srcText.slice(handlerBStart);
    const markers = [
      'path.endsWith("/referrals")',
      'path.endsWith("/referrals/click") && request.method === "POST"',
      'path.endsWith("/ads")',
      'path.endsWith("/ads/click") && request.method === "POST"',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = handlerBBody.indexOf(marker);
      expect(idx, `expected route marker in handler B: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
    expect(handlerBBody).not.toContain('"/categories"');
    expect(handlerBBody).not.toContain('"/external-ads"');
    expect(handlerBBody).not.toContain('"/revenue"');
  });

  it("the original inline blocks are gone from orchestrator.ts; both delegations stand at the original positions", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(dispatchSrc).toContain("handleAdsRevenueReferralsRoutes(request, url, path, sessionId,");
    expect(dispatchSrc).toContain("handleReferralsAdsRoutes(request, url, path, sessionId,");
    // Distinctive comments that headed the original inline blocks.
    for (const comment of [
      "// Referral Categories ORM Management API",
      "// Revenue Management Summary API",
      "// External Ad Network Placements & Monetization API",
      "// Referrals & Affiliate Links endpoint",
      "// Sponsored Ads & Marketplace endpoint",
    ]) {
      expect(orchSrc, `inline block comment should be gone: ${comment}`).not.toContain(comment);
    }
    // No leftover inline conditions for these paths.
    for (const cond of [
      'if (path.endsWith("/categories"))',
      'if (path.endsWith("/revenue")',
      'if (path.endsWith("/external-ads"))',
      'if (path.endsWith("/referrals"))',
      'if (path.endsWith("/ads"))',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // Call-site A sits between the schema delegation and the /audit block.
    // Landmark rule (#405): anchor to DELEGATION CALLS, never to a
    // neighboring domain's inline comment or condition — slice 04 (#367)
    // moved the "// Audit logs endpoint" comment into routes/audit.ts,
    // which broke this assertion on main, and slice #359-17 moved the
    // inline /schema/query condition into routes/schema.ts, so the lower
    // bound anchors to the handleSchemaRoutes delegation call.
    // Delegation calls are the stable landmarks.
    const callAIdx = dispatchSrc.indexOf("handleAdsRevenueReferralsRoutes(request, url, path, sessionId,");
    expect(callAIdx).toBeGreaterThan(dispatchSrc.indexOf("handleSchemaRoutes(request, url, path, sessionId,"));
    expect(callAIdx).toBeLessThan(dispatchSrc.indexOf("handleAuditRoutes(request, url, path, sessionId,"));
    // Call-site B sits between the memory/reset handler and the payments block.
    // Landmark rule (#405): anchor to the DELEGATION CALL, never to a
    // neighboring domain's inline block — slice 06 (#369) moved the inline
    // `if (path.endsWith("/memory"))` block into
    // src/agents/routes/memoryReset.ts, so anchoring to the inline condition
    // would resolve to indexOf -1 (trivially true, meaningless).
    const callBIdx = dispatchSrc.indexOf("handleReferralsAdsRoutes(request, url, path, sessionId,");
    expect(callBIdx).toBeGreaterThan(dispatchSrc.indexOf("handleMemoryResetRoutes(request, url, path, sessionId,"));
    // Landmark swap (#370): slice 07 extracted the payments block into
    // src/agents/routes/payments.ts, so the "// Multi-Gateway Payments & DID
    // Management API" banner comment is gone from orchestrator.ts — anchoring
    // to it would resolve to indexOf -1. The payments DELEGATION CALL stands
    // at exactly the position the banner occupied.
    expect(callBIdx).toBeLessThan(dispatchSrc.indexOf("handlePaymentsRoutes(request, url, path, sessionId,"));
  });
});

describe("handleAdsRevenueReferralsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const { res: r1 } = await callA("GET", "/audit");
    expect(r1).toBeNull();
    const { res: r2 } = await callA("POST", "/referrals");
    expect(r2).toBeNull(); // community group belongs to handler B
    const { res: r3 } = await callA("GET", "/trading/options/scan");
    expect(r3).toBeNull();
  });

  it("GET /categories lists categories via the ORM", async () => {
    const orm = makeOrm({ categories: { findMany: vi.fn(() => [{ id: "cat_1", name: "AI" }]) } });
    const { res } = await callA("GET", "/categories", undefined, baseCtx({ getOrm: () => orm as any }));
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.categories[0].name).toBe("AI");
  });

  it("POST /categories validates name, audits, and creates", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const { res } = await callA("POST", "/categories", { name: "" }, baseCtx({ getOrm: () => orm as any, audit }));
    expect(res!.status).toBe(400);
    const { res: ok } = await callA("POST", "/categories", { name: "Finance" }, baseCtx({ getOrm: () => orm as any, audit }));
    const body = (await ok!.json()) as any;
    expect(body.success).toBe(true);
    expect(audit).toHaveBeenCalledWith("category.created", "orchestrator", expect.objectContaining({ name: "Finance" }));
  });

  it("DELETE /categories requires an id query param", async () => {
    const { res } = await callA("DELETE", "/categories");
    expect(res!.status).toBe(400);
  });

  it("GET /revenue returns the ORM revenue summary", async () => {
    // #2345 adaptation: the summary is computed from the ports
    // by the shared core (the stub's canned getRevenueSummary
    // value is no longer the source); the route still passes
    // the one computed summary through — here the all-zero
    // summary of the empty stub ports.
    const orm = makeOrm();
    const { res } = await callA("GET", "/revenue", undefined, baseCtx({ getOrm: () => orm as any }));
    expect((await res!.json()) as any).toEqual({
      grossRevenue: 0,
      adNetworkRevenue: 0,
      marketplaceRevenue: 0,
      paymentPlatformFees: 0,
      referralPayouts: 0,
      netRevenue: 0,
      totalImpressions: 0,
      totalAdClicks: 0,
      averageRPM: 18.5,
    });
  });

  it("POST /external-ads validates title/targetUrl, then creates and audits", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const bad = await callA("POST", "/external-ads", { title: "x" }, baseCtx({ getOrm: () => orm as any, audit }));
    expect(bad.res!.status).toBe(400);
    const ok = await callA(
      "POST",
      "/external-ads",
      { title: "Ad", targetUrl: "https://example.com", network: "direct" },
      baseCtx({ getOrm: () => orm as any, audit })
    );
    const body = (await ok.res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.ad.id).toMatch(/^ext_direct_/);
    expect(audit).toHaveBeenCalledWith("external_ad.created", "orchestrator", expect.objectContaining({ title: "Ad" }));
  });

  it("POST /external-ads/impression bumps impressions and earnings", async () => {
    const orm = makeOrm({
      externalAds: {
        findById: vi.fn(() => ({ id: "e1", impressions: 5, earnings: 0.075, cpmRate: 15 })),
        update: vi.fn(),
      },
    });
    const { res } = await callA("POST", "/external-ads/impression", { id: "e1" }, baseCtx({ getOrm: () => orm as any }));
    const body = (await res!.json()) as any;
    expect(body).toEqual({ success: true, impressions: 6, earnings: 0.09 });
    expect(orm.externalAds.update).toHaveBeenCalledWith("e1", { impressions: 6, earnings: 0.09 });
  });

  it("POST /external-ads/click bumps clicks, earnings, and audits", async () => {
    const orm = makeOrm({
      externalAds: {
        findById: vi.fn(() => ({ id: "e1", clicks: 2, earnings: 1.25, cpcRate: 1.25 })),
        update: vi.fn(),
      },
    });
    const audit = vi.fn();
    const { res } = await callA("POST", "/external-ads/click", { id: "e1" }, baseCtx({ getOrm: () => orm as any, audit }));
    const body = (await res!.json()) as any;
    expect(body).toEqual({ success: true, clicks: 3, earnings: 2.5 });
    expect(audit).toHaveBeenCalledWith("external_ad.clicked", "orchestrator", expect.objectContaining({ id: "e1", clicks: 3 }));
  });
});

describe("handleReferralsAdsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const { res: r1 } = await callB("GET", "/categories");
    expect(r1).toBeNull(); // inventory group belongs to handler A
    const { res: r2 } = await callB("GET", "/payments/gateways");
    expect(r2).toBeNull();
  });

  it("GET /referrals lists mapped rows", async () => {
    const orm = makeOrm({
      referrals: {
        findMany: vi.fn(async () => [
          { id: "ref_1", userLogin: "s1", title: "T", url: "https://u", category: "C", rewardText: "R", clicks: 3, signups: 1, createdAt: "2026-01-01" },
        ]),
      },
    });
    const { res } = await callB("GET", "/referrals", undefined, baseCtx({ getOrm: () => orm as any }));
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.referrals[0]).toMatchObject({ id: "ref_1", userLogin: "s1", clicks: 3, rewardText: "R" });
    expect(orm.referrals.findMany).toHaveBeenCalledWith({ orderBy: "created_at DESC", limit: 100 });
  });

  it("POST /referrals validates, inserts with the session id, and audits", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const bad = await callB("POST", "/referrals", { title: "x" }, baseCtx({ getOrm: () => orm as any, audit }));
    expect(bad.res!.status).toBe(400);
    const ok = await callB(
      "POST",
      "/referrals",
      { title: "T", url: "https://u" },
      baseCtx({ getOrm: () => orm as any, audit })
    );
    const body = (await ok.res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.referral.id).toMatch(/^ref_/);
    expect(body.referral.userLogin).toBe("sess-1");
    const created = (orm.referrals.create as any).mock.calls[0][0];
    expect(created.id).toMatch(/^ref_/);
    expect(created.userLogin).toBe("sess-1");
    expect(audit).toHaveBeenCalledWith("referral.created", "orchestrator", expect.objectContaining({ title: "T" }));
  });

  it("DELETE /referrals deletes by id and audits", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const url = new URL("https://agent.internal/referrals?id=ref_9");
    const ctx = baseCtx({ getOrm: () => orm as any, audit });
    const res = await handleReferralsAdsRoutes(
      new Request(url, { method: "DELETE" }),
      url,
      "/referrals",
      "sess-1",
      ctx
    );
    expect((await res!.json()) as any).toEqual({ success: true });
    expect(orm.referrals.delete).toHaveBeenCalledWith("ref_9");
    expect(audit).toHaveBeenCalledWith("referral.deleted", "orchestrator", { id: "ref_9" });
  });

  it("POST /referrals/click increments and returns success", async () => {
    const orm = makeOrm();
    const { res } = await callB("POST", "/referrals/click", { id: "ref_1" }, baseCtx({ getOrm: () => orm as any }));
    expect((await res!.json()) as any).toEqual({ success: true });
    expect(orm.referrals.incrementCounter).toHaveBeenCalledWith("ref_1", "clicks", 1);
  });

  it("GET /ads bumps impressions, then lists mapped rows", async () => {
    // #2345: the flow runs through the ads port — count (the
    // seeding probe; non-empty skips seeding) -> impression bump
    // -> listing.
    const orm = makeOrm({
      ads: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [
          { id: "ad_1", title: "T", tagline: "tg", sponsor: "S", badge: "PROMOTED", url: "https://u", ctaText: "Go", accentColor: "#fff", impressions: 11, clicks: 2, createdAt: "2026-01-01" },
        ]),
      },
    });
    const { res } = await callB("GET", "/ads", undefined, baseCtx({ getOrm: () => orm as any }));
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.ads[0]).toMatchObject({ id: "ad_1", ctaText: "Go", impressions: 11 });
    // Contract (#730): the impressions bump runs, and it runs BEFORE the
    // listing read so listed rows reflect post-bump counts. The position
    // of the seeding probe is not pinned — it is read-only.
    const bumpOrder = (orm.ads.incrementAllImpressions as any).mock.invocationCallOrder[0];
    const listOrder = (orm.ads.findMany as any).mock.invocationCallOrder[0];
    expect(bumpOrder).toBeGreaterThan(0);
    expect(listOrder).toBeGreaterThan(bumpOrder);
  });

  it("GET /ads seeds the default sponsor offers when the table is empty (362bcac)", async () => {
    const orm = makeOrm({
      ads: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => [
          { id: "ad_workers_ai", title: "Cloudflare Workers AI", tagline: "tg", sponsor: "Cloudflare", badge: "FLAGSHIP PARTNER", url: "https://u", ctaText: "Go", accentColor: "#f38020", impressions: 1, clicks: 0, createdAt: "2026-01-01" },
        ]),
      },
    });
    const { res } = await callB("GET", "/ads", undefined, baseCtx({ getOrm: () => orm as any }));
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.ads[0].id).toBe("ad_workers_ai");
    // The 4 default offers are created on read, and impressions still
    // bump on the same fetch.
    expect((orm.ads.create as any).mock.calls.length).toBe(4);
    expect((orm.ads.create as any).mock.calls.map((c: any[]) => c[0].id)).toEqual([
      "ad_workers_ai",
      "ad_ai_search",
      "ad_durable_objects",
      "ad_openaimp",
    ]);
    expect(orm.ads.incrementAllImpressions).toHaveBeenCalledWith(1);
  });

  it("POST /ads validates, inserts, and audits", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const bad = await callB("POST", "/ads", { title: "x" }, baseCtx({ getOrm: () => orm as any, audit }));
    expect(bad.res!.status).toBe(400);
    const ok = await callB("POST", "/ads", { title: "T", url: "https://u" }, baseCtx({ getOrm: () => orm as any, audit }));
    const body = (await ok.res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.ad.id).toMatch(/^ad_/);
    const created = (orm.ads.create as any).mock.calls[0][0];
    expect(created.id).toMatch(/^ad_/);
    expect(created.title).toBe("T");
    expect(audit).toHaveBeenCalledWith("ad.submitted", "orchestrator", expect.objectContaining({ title: "T" }));
  });

  it("POST /ads/click increments, audits, and returns success", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const { res } = await callB("POST", "/ads/click", { id: "ad_1" }, baseCtx({ getOrm: () => orm as any, audit }));
    expect((await res!.json()) as any).toEqual({ success: true });
    expect(orm.ads.incrementCounter).toHaveBeenCalledWith("ad_1", "clicks", 1);
    expect(audit).toHaveBeenCalledWith("ad.clicked", "orchestrator", { id: "ad_1" });
  });
});
