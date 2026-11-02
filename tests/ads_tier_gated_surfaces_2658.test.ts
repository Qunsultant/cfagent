/**
 * Issue #2658 (Phase 2 slice 2.3) — server-side tier-gated ads:
 * verification + gap-closure pins for the #2405 Phase 2 acceptance
 * line "Paid (Subscribed) callers receive no ads on any gated
 * surface, enforced server-side; Free callers receive ads by
 * default."
 *
 * What the #2022 suites already pin (not duplicated here): ctx-tier
 * resolution, the client AND, stored-tier suppression, tenant-off,
 * fail-open, and the subscription overlay in the abstract. What
 * THIS suite pins, through the store path with real D1 adapters:
 * - a PayPerUse account tier is served (a pay-per-use purchase
 *   buys calls, not a tier — at the store layer, not just the
 *   ctx-tier layer);
 * - a 2.1 Billing-shaped subscription row (provider "stripe" +
 *   provider subscription id + future periodEnd, exactly as
 *   billingService.createSubscription writes it) suppresses ads
 *   even with a Free/absent account — the post-2.1 wiring proof;
 * - one composed Subscribed display contract: banner-config denies
 *   all four flags AND both lists are empty AND all three tracking
 *   POSTs fail AND zero port writes happen;
 * - tenant-off beats a live 2.1 subscription;
 * - Free callers are served by default on BOTH lists.
 * Control pairs (Free serves / Subscribed suppressed under the
 * identical harness) prove these pins are non-vacuous.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  handleAdsRevenueReferralsRoutes,
  handleReferralsAdsRoutes,
  type AdsRevenueReferralsRouteContext,
} from "../src/agents/routes/adsRevenueReferrals";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

interface SubSeed {
  periodStartMs: number;
  periodEndMs: number;
  provider?: string;
  providerSubscriptionId?: string;
  providerStatus?: string;
}

async function setup(
  tier: "Free" | "PayPerUse" | "Subscribed" | null,
  tenantAdsEnabled: boolean | null,
  subsSeed?: SubSeed[],
) {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
  // Migration 0008 alters the accounts table (tier_source), so
  // the commercial mapping requires 0008 applied after 0007 —
  // the same order the money routes ensure at runtime.
  const subsDb0 = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb0);
  const store = new D1CommercialAdapter(db);
  if (tier !== null) {
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier, creditsUSD: 0, includedRuns: 0 });
    if (tenantAdsEnabled !== null) await store.setTenantAdsEnabled("t1", tenantAdsEnabled);
  }
  if (subsSeed) {
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    const subs = new D1SubscriptionAdapter(subsDb);
    for (let i = 0; i < subsSeed.length; i++) {
      await subs.createSubscription({
        id: `s-seed-${i}`,
        userId: "u1",
        tenantId: "t1",
        planId: "pro",
        provider: subsSeed[i].provider ?? "cfpay",
        providerPaymentRef: subsSeed[i].providerSubscriptionId ?? `sub-seed-${i}`,
        providerSubscriptionId: subsSeed[i].providerSubscriptionId ?? null,
        providerStatus: subsSeed[i].providerStatus ?? null,
        periodStartMs: subsSeed[i].periodStartMs,
        periodEndMs: subsSeed[i].periodEndMs,
      });
    }
  }
  const adsSql = { exec: vi.fn(() => []) } as never;
  const adsPort = {
    findMany: vi.fn(async () => [{
      id: "ad_workers_ai",
      title: "Cloudflare Workers AI",
      tagline: "Run models on serverless GPUs.",
      sponsor: "Cloudflare",
      badge: "FLAGSHIP PARTNER",
      url: "https://developers.cloudflare.com/workers-ai/",
      ctaText: "Deploy in 60s →",
      accentColor: "#f38020",
      impressions: 5,
      clicks: 2,
      createdAt: "2026-10-28T00:00:00Z",
    }]),
    findById: vi.fn(async () => null),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    create: vi.fn(async (rec: any) => rec),
    delete: vi.fn(async () => true),
    count: vi.fn(async () => 1),
    incrementCounter: vi.fn(async () => null),
    incrementAllImpressions: vi.fn(async () => undefined),
  };
  const externalAdsPort = {
    findMany: vi.fn(async () => [{ id: "e1", title: "Ext", impressions: 3, clicks: 1 }]),
    findById: vi.fn(async () => ({ id: "e1", impressions: 3, clicks: 1, earnings: 0, cpmRate: 1, cpcRate: 1 })),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    create: vi.fn(async (rec: any) => rec),
  };
  const adsOrm = {
    externalAds: externalAdsPort,
    ads: adsPort,
    marketplacePorts: vi.fn(async () => ({
      categories: { findMany: vi.fn(async () => []) },
      externalAds: externalAdsPort,
      ads: adsPort,
      referrals: { findMany: vi.fn(async () => []) },
    })),
  };
  const adsCtx = {
    getOrm: () => adsOrm,
    ensureTables: () => adsSql,
    audit: vi.fn(),
    env: { AGENT_DB: mock },
  } as unknown as AdsRevenueReferralsRouteContext;
  return { adsCtx, adsPort, externalAdsPort };
}

const req = (method: string, path: string, login: string | null, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const callA = (ctx: AdsRevenueReferralsRouteContext, method: string, path: string, login: string | null, body?: unknown) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAdsRevenueReferralsRoutes(req(method, path, login, body), url, path, "sess-1", ctx);
};

const callB = (ctx: AdsRevenueReferralsRouteContext, method: string, path: string, login: string | null, body?: unknown) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleReferralsAdsRoutes(req(method, path, login, body), url, path, "sess-1", ctx);
};

const NOW = Date.now();
const LIVE = { periodStartMs: NOW - 1000, periodEndMs: NOW + 30 * 86_400_000 };
const LAPSED = { periodStartMs: NOW - 60 * 86_400_000, periodEndMs: NOW - 1000 };
/** Exactly the row shape billingService.createSubscription writes (#2656). */
const BILLING_ROW: SubSeed = {
  ...LIVE,
  provider: "stripe",
  providerSubscriptionId: "sub_2_1_test",
  providerStatus: "active",
};

describe("tier-gated ads, store path (#2658)", () => {
  it("a PayPerUse account tier is served: a purchase buys calls, not ad-free", async () => {
    const { adsCtx, adsPort } = await setup("PayPerUse", true);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    const body = (await res?.json()) as { count: number; ads: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.ads[0].id).toBe("ad_workers_ai");
    expect(adsPort.incrementAllImpressions).toHaveBeenCalledWith(1);
    const cfg = (await (await callB(adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(cfg.tier).toBe("Free");
    expect(cfg.adsAllowed).toBe(true);
  });

  it("a PayPerUse tier plus a lapsed subscription is served", async () => {
    const { adsCtx, adsPort } = await setup("PayPerUse", true, [LAPSED]);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(((await res?.json()) as { count: number }).count).toBe(1);
    expect(adsPort.incrementAllImpressions).toHaveBeenCalledWith(1);
  });

  it("a 2.1 Billing-shaped subscription suppresses ads with a Free account", async () => {
    const { adsCtx, adsPort } = await setup("Free", true, [BILLING_ROW]);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(adsPort.incrementAllImpressions).not.toHaveBeenCalled();
    expect(adsPort.findMany).not.toHaveBeenCalled();
    const cfg = (await (await callB(adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(cfg.tier).toBe("Subscribed");
    expect(cfg.adsAllowed).toBe(false);
  });

  it("a 2.1 Billing-shaped subscription suppresses ads with no account row", async () => {
    const { adsCtx } = await setup(null, null, [BILLING_ROW]);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    const ext = await callA(adsCtx, "GET", "/external-ads", "u1");
    expect(await ext?.json()).toEqual({ count: 0, ads: [] });
  });

  it("Subscribed display contract: every gated surface denies, zero writes", async () => {
    const { adsCtx, adsPort, externalAdsPort } = await setup("Subscribed", true);
    const cfg = (await (await callB(adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(cfg.tier).toBe("Subscribed");
    expect(cfg.adsAllowed).toBe(false);
    expect(cfg.googleUnitsAllowed).toBe(false);
    expect(cfg.sponsorSpotlightAllowed).toBe(false);
    expect(cfg.adNetworkStripAllowed).toBe(false);
    expect(await (await callB(adsCtx, "GET", "/ads", "u1"))?.json()).toEqual({ count: 0, ads: [] });
    expect(await (await callA(adsCtx, "GET", "/external-ads", "u1"))?.json()).toEqual({ count: 0, ads: [] });
    expect(await (await callB(adsCtx, "POST", "/ads/click", "u1", { id: "ad_workers_ai" }))?.json()).toEqual({ success: false });
    expect(await (await callA(adsCtx, "POST", "/external-ads/impression", "u1", { id: "e1" }))?.json()).toEqual({ success: false });
    expect(await (await callA(adsCtx, "POST", "/external-ads/click", "u1", { id: "e1" }))?.json()).toEqual({ success: false });
    expect(adsPort.findMany).not.toHaveBeenCalled();
    expect(adsPort.incrementAllImpressions).not.toHaveBeenCalled();
    expect(adsPort.incrementCounter).not.toHaveBeenCalled();
    expect(externalAdsPort.findMany).not.toHaveBeenCalled();
    expect(externalAdsPort.update).not.toHaveBeenCalled();
  });

  it("tenant-off beats a live 2.1 subscription", async () => {
    const { adsCtx } = await setup("Free", false, [BILLING_ROW]);
    expect(await (await callB(adsCtx, "GET", "/ads", "u1"))?.json()).toEqual({ count: 0, ads: [] });
    const cfg = (await (await callB(adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(cfg.adsAllowed).toBe(false);
  });

  it("Free callers are served by default on both lists", async () => {
    const { adsCtx, adsPort, externalAdsPort } = await setup("Free", true);
    const sponsored = (await (await callB(adsCtx, "GET", "/ads", "u1"))?.json()) as { count: number };
    expect(sponsored.count).toBe(1);
    expect(adsPort.incrementAllImpressions).toHaveBeenCalledWith(1);
    const ext = (await (await callA(adsCtx, "GET", "/external-ads", "u1"))?.json()) as { count: number };
    expect(ext.count).toBe(1);
    expect(externalAdsPort.findMany).toHaveBeenCalled();
  });
});
